import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccessPrincipal } from "@ssrl/access";
import { artifactMutationJson } from "@ssrl/artifact-store";
import {
  BoundedReconciliationSession,
  FrozenPrefixMerkleView,
} from "@ssrl/replication/sync";
import { buildPrefixMerkleIndex } from "@ssrl/replication/merkle";
import {
  createReplicationRecord,
  replicationDescriptor,
  replicationRecordKey,
  type ReplicationRecord,
} from "@ssrl/replication";
import {
  semanticEntityJson,
  temporalObservationJson,
} from "@ssrl/state-store";
import { LocalArtifactStore } from "@ssrl/storage-local-artifacts";
import { SQLiteSemanticStateStore } from "@ssrl/storage-sqlite";
import {
  MutableReplicationRecordSource,
  ReplicationAccessGateway,
  ReplicationAccessLimitError,
  ReplicationApplyDeniedError,
  ReplicationAuthorizationViewError,
  ReplicationRecordUnavailableError,
  type ReplicationAccessOperation,
  type ReplicationAccessPolicy,
} from "../src/index.js";

const roots: string[] = [];
const alice: AccessPrincipal = { subject: "user:alice", scopes: ["replication:read"] };
const bob: AccessPrincipal = { subject: "user:bob", scopes: ["replication:read"] };
const reader: AccessPrincipal = { subject: "device:reader", scopes: ["replication:read"] };
const writer: AccessPrincipal = { subject: "device:writer", scopes: ["replication:write"] };
const project = "entity://project/atlas" as const;

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function semanticStore(prefix: string): Promise<SQLiteSemanticStateStore> {
  return new SQLiteSemanticStateStore({ path: join(await tempRoot(prefix), "state.sqlite") });
}

async function artifactStore(prefix: string): Promise<LocalArtifactStore> {
  return new LocalArtifactStore({ root: await tempRoot(prefix) });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function observationRecord(id: string, value: string): Promise<ReplicationRecord> {
  return createReplicationRecord({
    kind: "semantic-observation",
    recordId: id,
    payload: temporalObservationJson({
      id,
      entityId: project,
      property: "Project.status",
      value,
      source: { provider: "fixture", externalId: id },
      validFrom: "2026-01-01T00:00:00Z",
      recordedAt: "2026-01-01T00:00:00Z",
    }),
  });
}

async function entityRecord(): Promise<ReplicationRecord> {
  return createReplicationRecord({
    kind: "semantic-entity",
    recordId: project,
    payload: semanticEntityJson({ entityId: project, entityType: "Project" }),
  });
}

async function artifactDeleteRecord(id: string): Promise<ReplicationRecord> {
  return createReplicationRecord({
    kind: "artifact-mutation",
    recordId: id,
    payload: artifactMutationJson({
      id,
      kind: "delete",
      resource: {
        sourceKey: "fixture",
        externalType: "note",
        externalId: id,
      },
      effectiveAt: "2026-01-01T00:00:00Z",
      recordedAt: "2026-01-01T00:00:00Z",
    }),
  });
}

class MutablePolicy implements ReplicationAccessPolicy {
  version = "policy-v1";
  readonly projection = new Map<string, Set<string>>();
  readonly reads = new Map<string, Set<string>>();
  readonly applies = new Map<string, Set<string>>();
  evaluations = 0;

  allow(
    operation: ReplicationAccessOperation,
    subject: string,
    ...recordIds: readonly string[]
  ): void {
    const table = operation === "projection:read"
      ? this.projection
      : operation === "record:read"
        ? this.reads
        : this.applies;
    table.set(subject, new Set(recordIds));
  }

  evaluate(request: Parameters<ReplicationAccessPolicy["evaluate"]>[0]) {
    this.evaluations += 1;
    const table = request.operation === "projection:read"
      ? this.projection
      : request.operation === "record:read"
        ? this.reads
        : this.applies;
    return table.get(request.principal.subject)?.has(request.record.recordId)
      ? { effect: "allow" as const }
      : { effect: "deny" as const, code: "not-granted" };
  }
}

function gateway(
  source: MutableReplicationRecordSource,
  policy: MutablePolicy,
  options: Partial<ConstructorParameters<typeof ReplicationAccessGateway>[0]> = {},
) {
  return new ReplicationAccessGateway({
    source,
    policy,
    policyVersion: () => policy.version,
    projectionIds: ["personal", "empty", "mixed", "one", "two"],
    ...options,
  });
}

describe("policy-scoped replication projections", () => {
  it("builds roots only from records authorized for that principal", async () => {
    const aliceRecord = await observationRecord("alice-visible", "active");
    const bobRecord = await observationRecord("bob-private", "secret");
    const source = new MutableReplicationRecordSource([aliceRecord, bobRecord]);
    const policy = new MutablePolicy();
    policy.allow("projection:read", alice.subject, aliceRecord.recordId);
    policy.allow("projection:read", bob.subject, bobRecord.recordId);
    const access = gateway(source, policy);

    const aliceView = await access.openProjection({ principal: alice, projectionId: "personal", prefixBits: 8 });
    const bobView = await access.openProjection({ principal: bob, projectionId: "personal", prefixBits: 8 });
    const cleanAlice = await buildPrefixMerkleIndex([replicationDescriptor(aliceRecord)], { prefixBits: 8 });

    expect(aliceView.view.rootDigest).toBe(cleanAlice.rootDigest);
    expect(aliceView.view.recordCount).toBe(1);
    expect(bobView.view.recordCount).toBe(1);
    expect(bobView.view.rootDigest).not.toBe(aliceView.view.rootDigest);

    const localEmpty = await FrozenPrefixMerkleView.open(await buildPrefixMerkleIndex([], { prefixBits: 8 }));
    const session = await BoundedReconciliationSession.start(
      localEmpty,
      access.endpoint(alice, "personal"),
      aliceView.view.viewId,
    );
    const result = await session.runToCompletion(localEmpty, access.endpoint(alice, "personal"));
    expect(result.remoteOnly).toEqual([aliceRecord.key]);
    expect(JSON.stringify(result)).not.toContain(bobRecord.key);
  });

  it("keeps Alice root stable when only Bob-private global records change", async () => {
    const aliceRecord = await observationRecord("alice-visible", "active");
    const bobOne = await observationRecord("bob-private-1", "secret-1");
    const bobTwo = await observationRecord("bob-private-2", "secret-2");
    const source = new MutableReplicationRecordSource([aliceRecord, bobOne]);
    const policy = new MutablePolicy();
    policy.allow("projection:read", alice.subject, aliceRecord.recordId);
    policy.allow("projection:read", bob.subject, bobOne.recordId, bobTwo.recordId);
    const access = gateway(source, policy);

    const before = await access.openProjection({ principal: alice, projectionId: "personal", prefixBits: 8 });
    source.replace([aliceRecord, bobOne, bobTwo]);
    const after = await access.openProjection({ principal: alice, projectionId: "personal", prefixBits: 8 });
    const bobAfter = await access.openProjection({ principal: bob, projectionId: "personal", prefixBits: 8 });

    expect(after.view.rootDigest).toBe(before.view.rootDigest);
    expect(after.view.recordCount).toBe(1);
    expect(bobAfter.view.recordCount).toBe(2);
  });

  it("changes a fresh projection root when an authorized record is added", async () => {
    const first = await observationRecord("alice-visible-1", "active");
    const second = await observationRecord("alice-visible-2", "paused");
    const source = new MutableReplicationRecordSource([first]);
    const policy = new MutablePolicy();
    policy.allow("projection:read", alice.subject, first.recordId, second.recordId);
    const access = gateway(source, policy);
    const before = await access.openProjection({ principal: alice, projectionId: "personal", prefixBits: 8 });

    source.replace([first, second]);
    const after = await access.openProjection({ principal: alice, projectionId: "personal", prefixBits: 8 });
    expect(after.view.rootDigest).not.toBe(before.view.rootDigest);
    expect(after.view.recordCount).toBe(2);
  });

  it("is deterministic under source ordering and supports a legitimate empty projection", async () => {
    const records = [
      await observationRecord("z-record", "z"),
      await observationRecord("a-record", "a"),
      await observationRecord("m-record", "m"),
    ];
    const policy = new MutablePolicy();
    policy.allow("projection:read", alice.subject, "z-record", "m-record");
    const firstSource = new MutableReplicationRecordSource(records);
    const secondSource = new MutableReplicationRecordSource([...records].reverse());
    const first = gateway(firstSource, policy);
    const second = gateway(secondSource, policy);

    const left = await first.openProjection({ principal: alice, projectionId: "personal", prefixBits: 8 });
    const right = await second.openProjection({ principal: alice, projectionId: "personal", prefixBits: 8 });
    expect(right.view.rootDigest).toBe(left.view.rootDigest);
    expect(right.view.recordCount).toBe(2);

    const nobody = gateway(firstSource, new MutablePolicy());
    const empty = await nobody.openProjection({ principal: alice, projectionId: "empty", prefixBits: 8 });
    const cleanEmpty = await buildPrefixMerkleIndex([], { prefixBits: 8 });
    expect(empty.view.rootDigest).toBe(cleanEmpty.rootDigest);
    expect(empty.view.recordCount).toBe(0);
  });

  it("never exposes payload bodies through Merkle node or leaf protocol responses", async () => {
    const record = await observationRecord("secret-visible", "top-secret-value");
    const source = new MutableReplicationRecordSource([record]);
    const policy = new MutablePolicy();
    policy.allow("projection:read", alice.subject, record.recordId);
    const access = gateway(source, policy);
    const opened = await access.openProjection({ principal: alice, projectionId: "personal", prefixBits: 8 });
    const endpoint = access.endpoint(alice, "personal");
    const root = endpoint.nodeHashes(opened.view.viewId, [{ level: 8, index: 0 }]);
    const index = await buildPrefixMerkleIndex([replicationDescriptor(record)], { prefixBits: 8 });
    const leafId = index.snapshot().nonEmptyLeaves[0]?.leafId;
    if (leafId === undefined) throw new Error("expected non-empty leaf");
    const leaf = await endpoint.leafPage(opened.view.viewId, {
      leafId,
      maxDescriptors: 10,
      maxBytes: 65_536,
    });

    const serialized = JSON.stringify({ root, leaf });
    expect(serialized).not.toContain("top-secret-value");
    expect(serialized).not.toContain(record.payload);
    expect(leaf.descriptors).toEqual([replicationDescriptor(record)]);
  });

  it("supports one authorized projection containing semantic and artifact records", async () => {
    const semantic = await observationRecord("semantic-visible", "active");
    const artifact = await artifactDeleteRecord("artifact-visible");
    const source = new MutableReplicationRecordSource([artifact, semantic]);
    const policy = new MutablePolicy();
    policy.allow("projection:read", alice.subject, semantic.recordId, artifact.recordId);
    const access = gateway(source, policy);
    const opened = await access.openProjection({ principal: alice, projectionId: "mixed", prefixBits: 8 });
    const localEmpty = await FrozenPrefixMerkleView.open(await buildPrefixMerkleIndex([], { prefixBits: 8 }));
    const endpoint = access.endpoint(alice, "mixed");
    const session = await BoundedReconciliationSession.start(
      localEmpty,
      endpoint,
      opened.view.viewId,
    );
    const result = await session.runToCompletion(localEmpty, endpoint);

    expect(opened.view.recordCount).toBe(2);
    expect(result.remoteOnly).toEqual([artifact.key, semantic.key].toSorted((a, b) => a.localeCompare(b)));
  });

  it("binds pinned views to principal, projection id, policy version and lease", async () => {
    const record = await observationRecord("visible", "active");
    const source = new MutableReplicationRecordSource([record]);
    const policy = new MutablePolicy();
    policy.allow("projection:read", alice.subject, record.recordId);
    let now = "2026-09-25T00:00:00Z";
    const access = gateway(source, policy, { now: () => now, maxLeaseMs: 1_000 });
    const opened = await access.openProjection({
      principal: alice,
      projectionId: "one",
      prefixBits: 8,
      leaseMs: 1_000,
    });

    expect(() => access.endpoint(alice, "two").viewInfo(opened.view.viewId))
      .toThrow(ReplicationAuthorizationViewError);
    expect(() => access.endpoint(bob, "one").viewInfo(opened.view.viewId))
      .toThrow(ReplicationAuthorizationViewError);

    now = "2026-09-25T00:00:00.999Z";
    expect(access.endpoint(alice, "one").viewInfo(opened.view.viewId)).toEqual(opened.view);
    now = "2026-09-25T00:00:01.000Z";
    expect(() => access.endpoint(alice, "one").viewInfo(opened.view.viewId))
      .toThrowError(expect.objectContaining({ code: "expired" }));

    now = "2026-09-25T00:00:02.000Z";
    const fresh = await access.openProjection({ principal: alice, projectionId: "one", prefixBits: 8 });
    policy.version = "policy-v2";
    expect(() => access.endpoint(alice, "one").viewInfo(fresh.view.viewId))
      .toThrowError(expect.objectContaining({ code: "revoked" }));
  });

  it("rejects projection ids that were not configured by the server before policy work", async () => {
    const record = await observationRecord("visible", "active");
    const source = new MutableReplicationRecordSource([record]);
    const policy = new MutablePolicy();
    policy.allow("projection:read", alice.subject, record.recordId);
    const access = gateway(source, policy);

    await expect(access.openProjection({
      principal: alice,
      projectionId: "client-invented",
      prefixBits: 8,
    })).rejects.toBeInstanceOf(ReplicationAuthorizationViewError);
    expect(policy.evaluations).toBe(0);
  });

  it("does not treat equal roots under different projection ids as the same authorization context", async () => {
    const record = await observationRecord("visible", "active");
    const source = new MutableReplicationRecordSource([record]);
    const policy = new MutablePolicy();
    policy.allow("projection:read", alice.subject, record.recordId);
    const access = gateway(source, policy);
    const one = await access.openProjection({ principal: alice, projectionId: "one", prefixBits: 8 });
    const two = await access.openProjection({ principal: alice, projectionId: "two", prefixBits: 8 });
    expect(two.view.rootDigest).toBe(one.view.rootDigest);
    expect(() => access.endpoint(alice, "one").viewInfo(two.view.viewId))
      .toThrow(ReplicationAuthorizationViewError);
  });
});

describe("principal-aware replication transfer", () => {
  it("reauthorizes discovered records at transfer time", async () => {
    const record = await observationRecord("visible", "active");
    const source = new MutableReplicationRecordSource([record]);
    const policy = new MutablePolicy();
    policy.allow("projection:read", alice.subject, record.recordId);
    policy.allow("record:read", alice.subject, record.recordId);
    const access = gateway(source, policy);
    const opened = await access.openProjection({ principal: alice, projectionId: "personal", prefixBits: 8 });

    expect(await access.readRecords({
      principal: alice,
      projectionId: "personal",
      viewId: opened.view.viewId,
      keys: [record.key],
    })).toEqual([record]);

    policy.allow("record:read", alice.subject);
    await expect(access.readRecords({
      principal: alice,
      projectionId: "personal",
      viewId: opened.view.viewId,
      keys: [record.key],
    })).rejects.toBeInstanceOf(ReplicationRecordUnavailableError);
  });

  it("uses the same public unavailable error for hidden and globally missing keys", async () => {
    const visible = await observationRecord("visible", "active");
    const hidden = await observationRecord("hidden", "private");
    const source = new MutableReplicationRecordSource([visible, hidden]);
    const policy = new MutablePolicy();
    policy.allow("projection:read", alice.subject, visible.recordId);
    policy.allow("record:read", alice.subject, visible.recordId);
    const access = gateway(source, policy);
    const opened = await access.openProjection({ principal: alice, projectionId: "personal", prefixBits: 8 });
    const missing = replicationRecordKey("semantic-observation", "missing");

    for (const key of [hidden.key, missing]) {
      let error: unknown;
      try {
        await access.readRecords({
          principal: alice,
          projectionId: "personal",
          viewId: opened.view.viewId,
          keys: [key],
        });
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(ReplicationRecordUnavailableError);
      expect((error as Error).message).toBe("Requested replication record is unavailable");
    }
  });

  it("enforces transfer count and payload-byte bounds", async () => {
    const one = await observationRecord("one", "a");
    const two = await observationRecord("two", "b");
    const source = new MutableReplicationRecordSource([one, two]);
    const policy = new MutablePolicy();
    policy.allow("projection:read", alice.subject, one.recordId, two.recordId);
    policy.allow("record:read", alice.subject, one.recordId, two.recordId);
    const access = gateway(source, policy, { maxReadRecords: 2, maxReadBytes: 1_000_000 });
    const opened = await access.openProjection({ principal: alice, projectionId: "personal", prefixBits: 8 });

    await expect(access.readRecords({
      principal: alice,
      projectionId: "personal",
      viewId: opened.view.viewId,
      keys: [one.key, two.key],
      maxRecords: 1,
    })).rejects.toBeInstanceOf(ReplicationAccessLimitError);
    await expect(access.readRecords({
      principal: alice,
      projectionId: "personal",
      viewId: opened.view.viewId,
      keys: [one.key],
      maxBytes: 1,
    })).rejects.toBeInstanceOf(ReplicationAccessLimitError);
  });
});

describe("principal-aware inbound apply", () => {
  it("denies a semantic batch before any store mutation when one record is not writable", async () => {
    const entity = await entityRecord();
    const observation = await observationRecord("apply-observation", "active");
    const source = new MutableReplicationRecordSource([]);
    const policy = new MutablePolicy();
    policy.allow("record:apply", writer.subject, entity.recordId);
    const access = gateway(source, policy);
    const store = await semanticStore("replication-access-semantic-deny-");
    const before = await store.snapshot();

    await expect(access.applySemantic(store, {
      principal: writer,
      projectionId: "personal",
      records: [entity, observation],
    })).rejects.toBeInstanceOf(ReplicationApplyDeniedError);
    expect(await store.snapshot()).toEqual(before);
    store.close();
  });

  it("allows an authorized semantic batch through existing immutable apply semantics", async () => {
    const entity = await entityRecord();
    const observation = await observationRecord("apply-observation", "active");
    const policy = new MutablePolicy();
    policy.allow("record:apply", writer.subject, entity.recordId, observation.recordId);
    const access = gateway(new MutableReplicationRecordSource([]), policy);
    const store = await semanticStore("replication-access-semantic-allow-");

    await access.applySemantic(store, {
      principal: writer,
      projectionId: "personal",
      records: [observation, entity],
    });
    expect(await store.entity(project)).toEqual({ entityId: project, entityType: "Project" });
    expect((await store.observationsForEntity(project)).map((item) => item.id))
      .toEqual(["apply-observation"]);
    store.close();
  });

  it("preserves immutable semantic collision behavior for authorized records", async () => {
    const first = await createReplicationRecord({
      kind: "semantic-entity",
      recordId: project,
      payload: semanticEntityJson({ entityId: project, entityType: "Project" }),
    });
    const conflicting = await createReplicationRecord({
      kind: "semantic-entity",
      recordId: project,
      payload: semanticEntityJson({ entityId: project, entityType: "Person" }),
    });
    const policy = new MutablePolicy();
    policy.allow("record:apply", writer.subject, project);
    const access = gateway(new MutableReplicationRecordSource([]), policy);
    const store = await semanticStore("replication-access-collision-");

    await access.applySemantic(store, {
      principal: writer,
      projectionId: "personal",
      records: [first],
    });
    await expect(access.applySemantic(store, {
      principal: writer,
      projectionId: "personal",
      records: [conflicting],
    })).rejects.toThrow(/already exists with different content|collision/i);
    expect(await store.entity(project)).toEqual({ entityId: project, entityType: "Project" });
    store.close();
  });

  it("denies artifact apply for a read-only principal and allows an explicitly writable principal", async () => {
    const record = await artifactDeleteRecord("artifact-delete");
    const policy = new MutablePolicy();
    policy.allow("record:apply", writer.subject, record.recordId);
    const access = gateway(new MutableReplicationRecordSource([]), policy);
    const denied = await artifactStore("replication-access-artifact-deny-");
    const allowed = await artifactStore("replication-access-artifact-allow-");
    const before = await denied.snapshot();

    await expect(access.applyArtifacts(denied, {
      principal: reader,
      projectionId: "personal",
      records: [record],
    })).rejects.toBeInstanceOf(ReplicationApplyDeniedError);
    expect(await denied.snapshot()).toEqual(before);

    expect(await access.applyArtifacts(allowed, {
      principal: writer,
      projectionId: "personal",
      records: [record],
    })).toBe(1);
    expect((await allowed.snapshot()).mutations.map((item) => item.id)).toEqual(["artifact-delete"]);
  });

  it("preserves existing integrity failure semantics before apply policy sees a tampered record", async () => {
    const entity = await entityRecord();
    const tampered = { ...entity, payloadBytes: entity.payloadBytes + 1 };
    const policy = new MutablePolicy();
    policy.allow("record:apply", writer.subject, entity.recordId);
    const access = gateway(new MutableReplicationRecordSource([]), policy);
    const store = await semanticStore("replication-access-integrity-");

    await expect(access.applySemantic(store, {
      principal: writer,
      projectionId: "personal",
      records: [tampered],
    })).rejects.toThrow(/payload integrity mismatch|inconsistent descriptor metadata/);
    expect(policy.evaluations).toBe(0);
    expect((await store.snapshot()).entities).toEqual([]);
    store.close();
  });

  it("does not mutate a semantic store when the configured allow-audit sink fails", async () => {
    const entity = await entityRecord();
    const policy = new MutablePolicy();
    policy.allow("record:apply", writer.subject, entity.recordId);
    const access = gateway(new MutableReplicationRecordSource([]), policy, {
      events: {
        emit(event) {
          if (event.operation === "record.apply" && event.outcome === "allow") {
            throw new Error("audit unavailable");
          }
        },
      },
    });
    const store = await semanticStore("replication-access-audit-fail-");

    await expect(access.applySemantic(store, {
      principal: writer,
      projectionId: "personal",
      records: [entity],
    })).rejects.toThrow(/audit unavailable/);
    expect((await store.snapshot()).entities).toEqual([]);
    store.close();
  });

  it("enforces apply byte/count bounds before mutating stores", async () => {
    const entity = await entityRecord();
    const policy = new MutablePolicy();
    policy.allow("record:apply", writer.subject, entity.recordId);
    const access = gateway(new MutableReplicationRecordSource([]), policy, {
      maxApplyRecords: 2,
      maxApplyBytes: 1_000_000,
    });
    const store = await semanticStore("replication-access-apply-bounds-");

    await expect(access.applySemantic(store, {
      principal: writer,
      projectionId: "personal",
      records: [entity],
      maxBytes: 1,
    })).rejects.toBeInstanceOf(ReplicationAccessLimitError);
    expect((await store.snapshot()).entities).toEqual([]);
    store.close();
  });
});

describe("replication access bounds and audit", () => {
  it("fails before unbounded source scan/policy work", async () => {
    const one = await observationRecord("one", "a");
    const two = await observationRecord("two", "b");
    const source = new MutableReplicationRecordSource([one, two]);
    const policy = new MutablePolicy();
    policy.allow("projection:read", alice.subject, one.recordId, two.recordId);

    await expect(gateway(source, policy, { maxSourceRecords: 1, maxProjectionRecords: 1 })
      .openProjection({ principal: alice, projectionId: "personal", prefixBits: 8 }))
      .rejects.toBeInstanceOf(ReplicationAccessLimitError);
    expect(policy.evaluations).toBe(0);

    const secondPolicy = new MutablePolicy();
    secondPolicy.allow("projection:read", alice.subject, one.recordId, two.recordId);
    await expect(gateway(source, secondPolicy, {
      maxSourceRecords: 2,
      maxProjectionRecords: 2,
      maxPolicyEvaluations: 1,
    }).openProjection({ principal: alice, projectionId: "personal", prefixBits: 8 }))
      .rejects.toBeInstanceOf(ReplicationAccessLimitError);
    expect(secondPolicy.evaluations).toBe(0);
  });

  it("normalizes principals so credential-like extra fields never enter policy or audit events", async () => {
    const record = await observationRecord("credential-test", "active");
    const source = new MutableReplicationRecordSource([record]);
    const seenPrincipals: AccessPrincipal[] = [];
    const events: unknown[] = [];
    const policy: ReplicationAccessPolicy = {
      evaluate(request) {
        seenPrincipals.push(request.principal);
        return { effect: "allow" };
      },
    };
    const credentialBearing = {
      subject: " user:alice ",
      scopes: ["replication:read", "replication:read"],
      bearer: "never-copy-this-token",
      deviceSecret: "never-copy-this-device-secret",
    } as AccessPrincipal & { bearer: string; deviceSecret: string };
    const access = new ReplicationAccessGateway({
      source,
      policy,
      policyVersion: () => "policy-v1",
      projectionIds: ["personal"],
      events: { emit(event) { events.push(event); } },
      now: () => "2026-09-25T00:00:00Z",
    });

    await access.openProjection({
      principal: credentialBearing,
      projectionId: "personal",
      prefixBits: 8,
    });
    expect(seenPrincipals).toEqual([{
      subject: "user:alice",
      scopes: ["replication:read"],
    }]);
    const serialized = JSON.stringify({ seenPrincipals, events });
    expect(serialized).not.toContain("never-copy-this-token");
    expect(serialized).not.toContain("never-copy-this-device-secret");
  });

  it("emits metadata-only audit events without record payload bodies", async () => {
    const record = await observationRecord("visible", "super-secret-payload-value");
    const source = new MutableReplicationRecordSource([record]);
    const policy = new MutablePolicy();
    policy.allow("projection:read", alice.subject, record.recordId);
    policy.allow("record:read", alice.subject, record.recordId);
    const events: unknown[] = [];
    const access = gateway(source, policy, {
      events: { emit(event) { events.push(event); } },
      now: () => "2026-09-25T00:00:00Z",
    });
    const opened = await access.openProjection({ principal: alice, projectionId: "personal", prefixBits: 8 });
    await access.readRecords({
      principal: alice,
      projectionId: "personal",
      viewId: opened.view.viewId,
      keys: [record.key],
    });

    const serialized = JSON.stringify(events);
    expect(events).toContainEqual(expect.objectContaining({
      operation: "record.read",
      outcome: "allow",
      subject: alice.subject,
      recordKey: record.key,
    }));
    expect(serialized).not.toContain("super-secret-payload-value");
    expect(serialized).not.toContain(record.payload);
  });
});
