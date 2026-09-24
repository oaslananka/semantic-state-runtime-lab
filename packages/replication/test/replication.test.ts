import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  resolveTemporalState,
  type TemporalObservation,
} from "@ssrl/core";
import {
  normalizeArtifactMutation,
  resolveArtifact,
  type ArtifactMutation,
  type ArtifactStore,
} from "@ssrl/artifact-store";
import { resolveSourceChange } from "@ssrl/ingestion";
import { MarkdownAuthoritativeIngestionAdapter } from "@ssrl/connector-markdown-fs";
import { LocalArtifactStore } from "@ssrl/storage-local-artifacts";
import { SQLiteSemanticStateStore } from "@ssrl/storage-sqlite";
import { temporalObservationJson } from "@ssrl/state-store";
import {
  ReplicationRecordCollisionError,
  applyArtifactReplicationRecords,
  applySemanticReplicationRecords,
  assertCollisionFreeReplicationDiff,
  copyMissingArtifactBlobs,
  createReplicationRecord,
  diffReplicationInventories,
  exportArtifactReplicationRecords,
  exportSemanticReplicationRecords,
  mergeReplicationRecordSets,
  missingArtifactBlobs,
  recordsByKeys,
  replicationInventory,
} from "../src/index.js";

const roots: string[] = [];
const project = "entity://project/atlas" as const;
const alice = "entity://person/alice" as const;

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function semanticStore(prefix: string): Promise<SQLiteSemanticStateStore> {
  const root = await tempRoot(prefix);
  return new SQLiteSemanticStateStore({ path: join(root, "state.sqlite") });
}

async function artifactStore(prefix: string): Promise<LocalArtifactStore> {
  return new LocalArtifactStore({ root: await tempRoot(prefix) });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function observation(
  id: string,
  property: string,
  value: string,
  recordedAt: string,
): TemporalObservation {
  return {
    id,
    entityId: project,
    property,
    value,
    source: { provider: "fixture", externalId: "atlas", revision: id },
    validFrom: recordedAt,
    recordedAt,
  };
}

async function observationRecord(value: TemporalObservation) {
  return createReplicationRecord({
    kind: "semantic-observation",
    recordId: value.id,
    payload: temporalObservationJson(value),
  });
}

function markdownManifest() {
  return {
    schemaVersion: "0.1" as const,
    id: "markdown-ingestion",
    displayName: "Markdown ingestion",
    capabilities: {
      read: true,
      write: false,
      observe: true,
      subscribe: false,
      revisions: "opaque" as const,
      idempotency: "none" as const,
    },
    entities: [{
      canonicalType: "Project",
      externalType: "markdown-note",
      fields: [{ canonical: "Project.status", external: "status", access: ["read" as const] }],
    }],
  };
}

function markdownAdapter() {
  return new MarkdownAuthoritativeIngestionAdapter({
    root: ".",
    manifest: markdownManifest(),
    externalType: "markdown-note",
    entityIdForExternalId: () => project,
  });
}

describe("portable immutable replication records", () => {
  it("rejects same-key same-digest descriptors with inconsistent immutable metadata", async () => {
    const base = await observationRecord(observation(
      "metadata-mismatch",
      "Project.status",
      "active",
      "2026-01-01T00:00:00Z",
    ));
    const tampered = { ...base, payloadBytes: base.payloadBytes + 1 };
    const local = await replicationInventory([base]);
    const remote = await replicationInventory([tampered]);

    await expect(diffReplicationInventories(local, remote))
      .rejects.toThrow(/inconsistent descriptor metadata/);
  });

  it("canonicalizes equivalent payload JSON before hashing", async () => {
    const canonical = temporalObservationJson(observation(
      "obs-canonical",
      "Project.status",
      "active",
      "2026-09-24T00:00:00Z",
    ));
    const pretty = JSON.stringify(JSON.parse(canonical), null, 2);

    const first = await createReplicationRecord({
      kind: "semantic-observation",
      recordId: "obs-canonical",
      payload: canonical,
    });
    const second = await createReplicationRecord({
      kind: "semantic-observation",
      recordId: "obs-canonical",
      payload: pretty,
    });

    expect(second).toEqual(first);
  });

  it("builds the same inventory root regardless of record order", async () => {
    const records = [
      await observationRecord(observation("a", "Project.a", "A", "2026-01-01T00:00:00Z")),
      await observationRecord(observation("b", "Project.b", "B", "2026-01-02T00:00:00Z")),
      await observationRecord(observation("c", "Project.c", "C", "2026-01-03T00:00:00Z")),
    ];
    const forward = await replicationInventory(records);
    const reverse = await replicationInventory([...records].reverse());

    expect(reverse.rootDigest).toBe(forward.rootDigest);
    expect(reverse.records).toEqual(forward.records);
  });

  it("projects inventories to descriptors only and never carries canonical payload bodies", async () => {
    const record = await observationRecord(observation(
      "descriptor-only",
      "Project.status",
      "active",
      "2026-01-01T00:00:00Z",
    ));
    const inventory = await replicationInventory([record]);
    const descriptor = inventory.records[0];

    expect(descriptor).toBeDefined();
    expect(Object.hasOwn(descriptor!, "payload")).toBe(false);
    expect(descriptor?.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("treats identical duplicate descriptors as set membership and rejects tampered fingerprints", async () => {
    const record = await observationRecord(observation(
      "descriptor-integrity",
      "Project.status",
      "active",
      "2026-01-01T00:00:00Z",
    ));
    const deduplicated = await replicationInventory([record, record]);
    expect(deduplicated.records).toHaveLength(1);

    await expect(replicationInventory([{
      ...record,
      fingerprint: `sha256:${"0".repeat(64)}`,
    }])).rejects.toThrow(/fingerprint mismatch/);
  });

  it("verifies inventory roots before using the equal-root fast path", async () => {
    const record = await observationRecord(observation(
      "root-integrity",
      "Project.status",
      "active",
      "2026-01-01T00:00:00Z",
    ));
    const inventory = await replicationInventory([record]);
    const tampered = {
      ...inventory,
      rootDigest: `sha256:${"0".repeat(64)}`,
    };

    await expect(diffReplicationInventories(tampered, inventory))
      .rejects.toThrow(/root digest mismatch/);
  });

  it("rejects malformed wire inventory kinds instead of trusting TypeScript shapes", async () => {
    const record = await observationRecord(observation(
      "wire-kind",
      "Project.status",
      "active",
      "2026-01-01T00:00:00Z",
    ));
    const inventory = await replicationInventory([record]);
    const malformed = {
      ...inventory,
      records: [{ ...inventory.records[0]!, kind: "unknown-wire-kind" }],
    } as unknown as typeof inventory;

    await expect(diffReplicationInventories(malformed, inventory))
      .rejects.toThrow(/Unsupported replication record kind/);
  });

  it("obeys identity, commutativity, and associativity for non-conflicting record sets", async () => {
    const a = [await observationRecord(observation("a", "Project.a", "A", "2026-01-01T00:00:00Z"))];
    const b = [await observationRecord(observation("b", "Project.b", "B", "2026-01-02T00:00:00Z"))];
    const c = [await observationRecord(observation("c", "Project.c", "C", "2026-01-03T00:00:00Z"))];

    expect(await mergeReplicationRecordSets(a, a)).toEqual(a);
    expect(await mergeReplicationRecordSets(a, b)).toEqual(await mergeReplicationRecordSets(b, a));
    const left = await mergeReplicationRecordSets(await mergeReplicationRecordSets(a, b), c);
    const right = await mergeReplicationRecordSets(a, await mergeReplicationRecordSets(b, c));
    expect(left).toEqual(right);
  });

  it("diffs small deltas and rejects same-key/different-payload collisions without LWW", async () => {
    const shared = await observationRecord(observation(
      "shared",
      "Project.status",
      "active",
      "2026-01-01T00:00:00Z",
    ));
    const local = await observationRecord(observation(
      "local",
      "Project.local",
      "L",
      "2026-01-02T00:00:00Z",
    ));
    const remote = await observationRecord(observation(
      "remote",
      "Project.remote",
      "R",
      "2026-01-03T00:00:00Z",
    ));
    const localInventory = await replicationInventory([shared, local]);
    const remoteInventory = await replicationInventory([shared, remote]);
    const delta = await diffReplicationInventories(localInventory, remoteInventory);

    expect(delta.collisions).toEqual([]);
    expect(recordsByKeys([shared, remote], delta.remoteOnly)).toEqual([remote]);
    expect(recordsByKeys([shared, local], delta.localOnly)).toEqual([local]);

    const divergent = await observationRecord(observation(
      "shared",
      "Project.status",
      "inactive",
      "2026-01-01T00:00:00Z",
    ));
    const collision = await diffReplicationInventories(
      localInventory,
      await replicationInventory([divergent, remote]),
    );
    expect(collision.collisions).toHaveLength(1);
    expect(() => assertCollisionFreeReplicationDiff(collision))
      .toThrow(ReplicationRecordCollisionError);
    await expect(mergeReplicationRecordSets([shared], [divergent]))
      .rejects.toBeInstanceOf(ReplicationRecordCollisionError);
    expect(() => recordsByKeys([shared, divergent], [shared.key]))
      .toThrow(ReplicationRecordCollisionError);
  });

  it("converges two semantic stores with disjoint immutable evidence", async () => {
    const first = await semanticStore("ssrl-repl-sem-a-");
    const second = await semanticStore("ssrl-repl-sem-b-");
    await first.append({
      entities: [{ entityId: project, entityType: "Project" }],
      aliases: [{
        id: "alias-atlas",
        entityId: project,
        value: "Atlas",
        recordedAt: "2026-01-01T00:00:00Z",
      }],
      observations: [observation("status-a", "Project.status", "active", "2026-01-01T00:00:00Z")],
    });
    await second.append({
      entities: [{ entityId: project, entityType: "Project" }],
      observations: [observation("deadline-b", "Project.deadline", "2026-12-01", "2026-01-02T00:00:00Z")],
    });

    const firstBefore = await exportSemanticReplicationRecords(first);
    const secondBefore = await exportSemanticReplicationRecords(second);
    const firstInventory = await replicationInventory(firstBefore);
    const secondInventory = await replicationInventory(secondBefore);
    const diff = await diffReplicationInventories(firstInventory, secondInventory);
    assertCollisionFreeReplicationDiff(diff);

    await applySemanticReplicationRecords(first, recordsByKeys(secondBefore, diff.remoteOnly));
    await applySemanticReplicationRecords(second, recordsByKeys(firstBefore, diff.localOnly));

    const firstAfter = await exportSemanticReplicationRecords(first);
    const secondAfter = await exportSemanticReplicationRecords(second);
    expect((await replicationInventory(firstAfter)).rootDigest)
      .toBe((await replicationInventory(secondAfter)).rootDigest);
    expect(canonicalJson(await first.snapshot())).toBe(canonicalJson(await second.snapshot()));
    first.close();
    second.close();
  });

  it("rejects semantic apply batches above the configured bound before mutating the store", async () => {
    const target = await semanticStore("ssrl-repl-bounded-apply-");
    const entityRecord = await createReplicationRecord({
      kind: "semantic-entity",
      recordId: project,
      payload: canonicalJson({ entityId: project, entityType: "Project" }),
    });

    await expect(applySemanticReplicationRecords(
      target,
      [entityRecord, entityRecord],
      { maxRecords: 1 },
    )).rejects.toThrow(/maxRecords/);
    expect((await target.snapshot()).entities).toEqual([]);
    target.close();
  });

  it("imports semantic retractions and preserves existing temporal truth semantics", async () => {
    const source = await semanticStore("ssrl-repl-retract-source-");
    const target = await semanticStore("ssrl-repl-retract-target-");
    const base = observation("status-open", "Project.status", "active", "2026-01-01T00:00:00Z");
    await source.append({
      entities: [{ entityId: project, entityType: "Project" }],
      observations: [base],
      retractions: [{
        id: "status-retracted",
        targetKind: "observation",
        targetId: base.id,
        effectiveFrom: "2026-08-01T00:00:00Z",
        recordedAt: "2026-08-02T00:00:00Z",
      }],
    });

    await applySemanticReplicationRecords(target, await exportSemanticReplicationRecords(source));
    const state = resolveTemporalState({
      entityId: project,
      observations: await target.observationsForEntity(project),
      retractions: await target.retractionsForEntity(project),
      validAt: "2026-09-01T00:00:00Z",
      knownAt: "2026-09-01T00:00:00Z",
      authority: [{ property: "Project.status", strategy: { kind: "provider", provider: "fixture" } }],
    });
    expect(state.canonical.properties["Project.status"]).toBeUndefined();
    expect(state.appliedRetractions.map((item) => item.id)).toEqual(["status-retracted"]);
    source.close();
    target.close();
  });

  it("copies each missing artifact blob once, then converges immutable mutation history", async () => {
    const source = await artifactStore("ssrl-repl-art-source-");
    const target = await artifactStore("ssrl-repl-art-target-");
    const bytesOne = new TextEncoder().encode("shared immutable bytes");
    const bytesTwo = new TextEncoder().encode("updated bytes");
    const blobOne = await source.putBlob(bytesOne, "text/plain");
    const blobTwo = await source.putBlob(bytesTwo, "text/plain");
    const mutations: ArtifactMutation[] = [
      normalizeArtifactMutation({
        id: "artifact-a-v1",
        resource: { sourceKey: "source", externalType: "markdown", externalId: "a.md" },
        kind: "upsert",
        effectiveAt: "2026-01-01T00:00:00Z",
        recordedAt: "2026-01-01T00:00:00Z",
        blob: blobOne,
      }),
      normalizeArtifactMutation({
        id: "artifact-b-v1",
        resource: { sourceKey: "source", externalType: "markdown", externalId: "b.md" },
        kind: "upsert",
        effectiveAt: "2026-01-01T00:00:00Z",
        recordedAt: "2026-01-01T00:00:00Z",
        blob: blobOne,
      }),
      normalizeArtifactMutation({
        id: "artifact-a-v2",
        resource: { sourceKey: "source", externalType: "markdown", externalId: "a.md" },
        kind: "upsert",
        effectiveAt: "2026-02-01T00:00:00Z",
        recordedAt: "2026-02-01T00:00:00Z",
        blob: blobTwo,
      }),
      normalizeArtifactMutation({
        id: "artifact-a-delete",
        resource: { sourceKey: "source", externalType: "markdown", externalId: "a.md" },
        kind: "delete",
        effectiveAt: "2026-03-01T00:00:00Z",
        recordedAt: "2026-03-01T00:00:00Z",
      }),
    ];
    await source.append(mutations);
    const records = await exportArtifactReplicationRecords(source);

    expect((await missingArtifactBlobs(target, records)).map((blob) => blob.digest).toSorted())
      .toEqual([blobOne.digest, blobTwo.digest].toSorted());
    const copied = await copyMissingArtifactBlobs({ source, target, records });
    expect(copied.transferredDigests.toSorted()).toEqual([blobOne.digest, blobTwo.digest].toSorted());
    expect(copied.transferredBytes).toBe(bytesOne.byteLength + bytesTwo.byteLength);
    expect((await copyMissingArtifactBlobs({ source, target, records })).transferredBytes).toBe(0);

    expect(await applyArtifactReplicationRecords(target, records)).toBe(4);
    expect((await replicationInventory(await exportArtifactReplicationRecords(target))).rootDigest)
      .toBe((await replicationInventory(records)).rootDigest);
    const resolved = resolveArtifact({
      resource: { sourceKey: "source", externalType: "markdown", externalId: "a.md" },
      mutations: (await target.snapshot()).mutations,
      validAt: "2026-04-01T00:00:00Z",
      knownAt: "2026-04-01T00:00:00Z",
    });
    expect(resolved.status).toBe("deleted");
    source.close();
    target.close();
  });

  it("reproduces the active-active source receipt clock collision that v0 must reject", async () => {
    const adapter = markdownAdapter();
    const draft = {
      changeId: "markdown-change:stable-content",
      externalType: "markdown-note",
      externalId: "Atlas.md",
      kind: "upsert" as const,
      revision: "sha256:stable-content",
      payload: { values: { status: "active" } },
    };
    const firstChange = resolveSourceChange(draft, "2026-09-24T10:00:00Z");
    const secondChange = resolveSourceChange(draft, "2026-09-24T10:05:00Z");
    const firstObservation = adapter.project(firstChange).slots[0];
    const secondObservation = adapter.project(secondChange).slots[0];
    if (firstObservation?.kind !== "observation" || secondObservation?.kind !== "observation") {
      throw new Error("expected Markdown observation slots");
    }
    const firstRecord = await observationRecord(firstObservation.record);
    const secondRecord = await observationRecord(secondObservation.record);

    expect(firstRecord.key).toBe(secondRecord.key);
    expect(firstRecord.payloadDigest).not.toBe(secondRecord.payloadDigest);
    const diff = await diffReplicationInventories(
      await replicationInventory([firstRecord]),
      await replicationInventory([secondRecord]),
    );
    expect(diff.collisions).toHaveLength(1);
    expect(() => assertCollisionFreeReplicationDiff(diff))
      .toThrow(ReplicationRecordCollisionError);
  });

  it("keeps provider-owned source clocks replica-stable across independent receipt times", async () => {
    const adapter = markdownAdapter();
    const draft = {
      changeId: "markdown-change:provider-clock",
      externalType: "markdown-note",
      externalId: "Atlas.md",
      kind: "upsert" as const,
      revision: "sha256:provider-clock",
      payload: { values: { status: "active" } },
      effectiveAt: "2026-09-20T12:00:00Z",
      recordedAt: "2026-09-20T12:00:00Z",
    };
    const first = adapter.project(resolveSourceChange(draft, "2026-09-24T10:00:00Z")).slots[0];
    const second = adapter.project(resolveSourceChange(draft, "2026-09-24T10:05:00Z")).slots[0];
    if (first?.kind !== "observation" || second?.kind !== "observation") {
      throw new Error("expected Markdown observation slots");
    }
    const firstRecord = await observationRecord(first.record);
    const secondRecord = await observationRecord(second.record);

    expect(secondRecord).toEqual(firstRecord);
    expect((await diffReplicationInventories(
      await replicationInventory([firstRecord]),
      await replicationInventory([secondRecord]),
    )).equal).toBe(true);
  });

  it("verifies source blob bytes before installing them into the target CAS", async () => {
    const source = await artifactStore("ssrl-repl-art-corrupt-source-");
    const target = await artifactStore("ssrl-repl-art-corrupt-target-");
    const blob = await source.putBlob(new TextEncoder().encode("expected bytes"), "text/plain");
    await source.append([normalizeArtifactMutation({
      id: "artifact-corrupt-source",
      resource: { sourceKey: "source", externalType: "markdown", externalId: "corrupt.md" },
      kind: "upsert",
      effectiveAt: "2026-01-01T00:00:00Z",
      recordedAt: "2026-01-01T00:00:00Z",
      blob,
    })]);
    const records = await exportArtifactReplicationRecords(source);
    const corruptSource: ArtifactStore = {
      putBlob: (bytes, mediaType) => source.putBlob(bytes, mediaType),
      headBlob: (digest) => source.headBlob(digest),
      readBlobRange: async () => ({
        digest: blob.digest,
        size: blob.size,
        offset: 0,
        bytes: new Uint8Array(blob.size).fill(1),
        complete: true,
      }),
      append: (mutations) => source.append(mutations),
      mutation: (id) => source.mutation(id),
      mutationsForResource: (resource) => source.mutationsForResource(resource),
      snapshot: () => source.snapshot(),
    };

    await expect(copyMissingArtifactBlobs({ source: corruptSource, target, records }))
      .rejects.toThrow(/content digest verification/);
    expect(await target.headBlob(blob.digest)).toBeUndefined();
    source.close();
    target.close();
  });

  it("rejects applying artifact metadata before its referenced blob is available", async () => {
    const source = await artifactStore("ssrl-repl-art-missing-source-");
    const target = await artifactStore("ssrl-repl-art-missing-target-");
    const blob = await source.putBlob(new TextEncoder().encode("blob"), "text/plain");
    await source.append([normalizeArtifactMutation({
      id: "artifact-missing-blob",
      resource: { sourceKey: "source", externalType: "markdown", externalId: "a.md" },
      kind: "upsert",
      effectiveAt: "2026-01-01T00:00:00Z",
      recordedAt: "2026-01-01T00:00:00Z",
      blob,
    })]);
    const records = await exportArtifactReplicationRecords(source);

    await expect(applyArtifactReplicationRecords(target, records)).rejects.toThrow(/missing blob/i);
    expect(await missingArtifactBlobs(target, records)).toHaveLength(1);
    source.close();
    target.close();
  });
});
