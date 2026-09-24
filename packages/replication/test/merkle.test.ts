import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, type TemporalObservation } from "@ssrl/core";
import { artifactMutationJson, normalizeArtifactMutation } from "@ssrl/artifact-store";
import { SQLiteSemanticStateStore } from "@ssrl/storage-sqlite";
import { temporalObservationJson } from "@ssrl/state-store";
import {
  ReplicationRecordCollisionError,
  createReplicationRecord,
  diffReplicationInventories,
  exportSemanticReplicationRecords,
  replicationInventory,
  type ReplicationRecord,
} from "../src/index.js";
import {
  buildPrefixMerkleIndex,
  comparePrefixMerkleIndexes,
  prefixMerkleSnapshotJson,
  restorePrefixMerkleIndex,
} from "../src/merkle.js";

const roots: string[] = [];
const project = "entity://project/merkle" as const;

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function observation(id: string, value: string): TemporalObservation {
  return {
    id,
    entityId: project,
    property: "Benchmark.value",
    value,
    source: { provider: "merkle-test", externalId: id, revision: id },
    validFrom: "2026-01-01T00:00:00Z",
    recordedAt: "2026-01-01T00:00:00Z",
  };
}

async function observationRecord(id: string, value = id): Promise<ReplicationRecord> {
  return createReplicationRecord({
    kind: "semantic-observation",
    recordId: id,
    payload: temporalObservationJson(observation(id, value)),
  });
}

async function records(count: number, start = 0): Promise<ReplicationRecord[]> {
  const result: ReplicationRecord[] = [];
  for (let offset = 0; offset < count; offset += 256) {
    const length = Math.min(256, count - offset);
    result.push(...await Promise.all(Array.from({ length }, (_, index) => {
      const ordinal = start + offset + index;
      return observationRecord(`record-${String(ordinal).padStart(6, "0")}`, `value-${ordinal}`);
    })));
  }
  return result;
}

function keyStrings(values: readonly { readonly key: string }[]): string[] {
  return values.map((value) => value.key).toSorted((left, right) => left.localeCompare(right));
}

describe("prefix Merkle reconciliation", () => {
  it("builds the same root and snapshot independent of descriptor input order", async () => {
    const source = await records(256);
    const forward = await buildPrefixMerkleIndex(source);
    const reverse = await buildPrefixMerkleIndex([...source].reverse());

    expect(reverse.rootDigest).toBe(forward.rootDigest);
    expect(prefixMerkleSnapshotJson(reverse)).toBe(prefixMerkleSnapshotJson(forward));
  });

  it("restores a deterministic payload-free snapshot into an equivalent index", async () => {
    const source = await records(512);
    const original = await buildPrefixMerkleIndex(source);
    const snapshot = original.snapshot();
    const restored = await restorePrefixMerkleIndex(snapshot);

    expect(restored.rootDigest).toBe(original.rootDigest);
    expect(prefixMerkleSnapshotJson(restored)).toBe(prefixMerkleSnapshotJson(original));
    expect(comparePrefixMerkleIndexes(original, restored)).toEqual({
      rootEqual: true,
      internalHashComparisons: 1,
      mismatchedLeafIds: [],
      localOnly: [],
      remoteOnly: [],
      collisions: [],
      leafDescriptorsExamined: 0,
      estimatedLeafDescriptorBytesExchanged: 0,
    });
    expect(canonicalJson(snapshot)).not.toContain('"payload":');
  });

  it("rejects tampered snapshot root or leaf metadata", async () => {
    const source = await records(32);
    const index = await buildPrefixMerkleIndex(source);
    const snapshot = index.snapshot();
    const firstLeaf = snapshot.nonEmptyLeaves[0];
    if (firstLeaf === undefined) throw new Error("expected non-empty Merkle leaf");

    await expect(restorePrefixMerkleIndex({
      ...snapshot,
      rootDigest: `sha256:${"0".repeat(64)}`,
    })).rejects.toThrow(/root digest mismatch/);

    await expect(restorePrefixMerkleIndex({
      ...snapshot,
      nonEmptyLeaves: [
        { ...firstLeaf, recordCount: firstLeaf.recordCount + 1 },
        ...snapshot.nonEmptyLeaves.slice(1),
      ],
    })).rejects.toThrow(/recordCount mismatch/);
  });

  it("decides equal prebuilt indexes with one root comparison and zero leaf exchange", async () => {
    const source = await records(512);
    const first = await buildPrefixMerkleIndex(source);
    const second = await buildPrefixMerkleIndex([...source].reverse());
    const diff = comparePrefixMerkleIndexes(first, second);

    expect(diff).toEqual({
      rootEqual: true,
      internalHashComparisons: 1,
      mismatchedLeafIds: [],
      localOnly: [],
      remoteOnly: [],
      collisions: [],
      leafDescriptorsExamined: 0,
      estimatedLeafDescriptorBytesExchanged: 0,
    });
  });

  it("drills into only a small set of leaves for a small delta", async () => {
    const localRecords = await records(4_096);
    const extras = await records(10, 10_000);
    const remoteRecords = [...localRecords.slice(10), ...extras];
    const local = await buildPrefixMerkleIndex(localRecords);
    const remote = await buildPrefixMerkleIndex(remoteRecords);
    const diff = comparePrefixMerkleIndexes(local, remote);

    expect(diff.rootEqual).toBe(false);
    expect(diff.localOnly).toHaveLength(10);
    expect(diff.remoteOnly).toHaveLength(10);
    expect(diff.collisions).toEqual([]);
    expect(diff.mismatchedLeafIds.length).toBeLessThanOrEqual(20);
    expect(diff.leafDescriptorsExamined).toBeLessThan(256);
    expect(diff.internalHashComparisons).toBeLessThan(local.leafCount / 8);
  });

  it("detects same-key/different-payload collision in the mismatched leaf", async () => {
    const shared = await observationRecord("shared", "left");
    const divergent = await observationRecord("shared", "right");
    const local = await buildPrefixMerkleIndex([shared]);
    const remote = await buildPrefixMerkleIndex([divergent]);
    const diff = comparePrefixMerkleIndexes(local, remote);

    expect(diff.localOnly).toEqual([]);
    expect(diff.remoteOnly).toEqual([]);
    expect(diff.collisions).toEqual([{
      key: shared.key,
      localDigest: shared.payloadDigest,
      remoteDigest: divergent.payloadDigest,
    }]);
  });

  it("incremental add yields the same root as a clean rebuild", async () => {
    const base = await records(128);
    const extra = await observationRecord("incremental-extra", "extra");
    const incremental = await buildPrefixMerkleIndex(base);

    expect(await incremental.add(extra)).toBe("inserted");
    const rebuilt = await buildPrefixMerkleIndex([...base, extra]);
    expect(incremental.rootDigest).toBe(rebuilt.rootDigest);
    expect(prefixMerkleSnapshotJson(incremental)).toBe(prefixMerkleSnapshotJson(rebuilt));
  });

  it("treats exact incremental replay as a no-op", async () => {
    const item = await observationRecord("idempotent", "same");
    const index = await buildPrefixMerkleIndex([item]);
    const root = index.rootDigest;

    expect(await index.add(item)).toBe("unchanged");
    expect(index.rootDigest).toBe(root);
    expect(index.recordCount).toBe(1);
  });

  it("rejects an incremental collision without mutating the root", async () => {
    const first = await observationRecord("collision", "left");
    const second = await observationRecord("collision", "right");
    const index = await buildPrefixMerkleIndex([first]);
    const root = index.rootDigest;

    await expect(index.add(second)).rejects.toBeInstanceOf(ReplicationRecordCollisionError);
    expect(index.rootDigest).toBe(root);
    expect(index.recordCount).toBe(1);
  });

  it("never carries payload bodies in leaf descriptors or snapshots", async () => {
    const item = await observationRecord("no-payload", "secret-ish-body");
    const index = await buildPrefixMerkleIndex([item]);
    const snapshot = index.snapshot();
    const leaves = snapshot.nonEmptyLeaves;

    expect(leaves).toHaveLength(1);
    expect(canonicalJson(snapshot)).not.toContain("secret-ish-body");
    const descriptors = Array.from({ length: index.leafCount }, (_, leafId) => index.leafDescriptors(leafId))
      .flat();
    expect(descriptors).toHaveLength(1);
    expect(Object.hasOwn(descriptors[0]!, "payload")).toBe(false);
  });

  it("matches the flat v0 delta for semantic store exports", async () => {
    const firstRoot = await tempRoot("ssrl-merkle-sem-a-");
    const secondRoot = await tempRoot("ssrl-merkle-sem-b-");
    const first = new SQLiteSemanticStateStore({ path: join(firstRoot, "state.sqlite") });
    const second = new SQLiteSemanticStateStore({ path: join(secondRoot, "state.sqlite") });
    await first.append({
      entities: [{ entityId: project, entityType: "Project" }],
      observations: [observation("semantic-a", "A")],
    });
    await second.append({
      entities: [{ entityId: project, entityType: "Project" }],
      observations: [observation("semantic-b", "B")],
    });
    const firstRecords = await exportSemanticReplicationRecords(first);
    const secondRecords = await exportSemanticReplicationRecords(second);
    const flat = await diffReplicationInventories(
      await replicationInventory(firstRecords),
      await replicationInventory(secondRecords),
    );
    const merkle = comparePrefixMerkleIndexes(
      await buildPrefixMerkleIndex(firstRecords),
      await buildPrefixMerkleIndex(secondRecords),
    );

    expect(merkle.localOnly).toEqual(flat.localOnly);
    expect(merkle.remoteOnly).toEqual(flat.remoteOnly);
    expect(merkle.collisions).toEqual(flat.collisions);
    first.close();
    second.close();
  });

  it("matches flat v0 reconciliation for artifact mutation descriptors", async () => {
    const resource = { sourceKey: "source", externalType: "markdown", externalId: "a.md" } as const;
    const sharedMutation = normalizeArtifactMutation({
      id: "artifact-shared",
      resource,
      kind: "delete",
      effectiveAt: "2026-01-01T00:00:00Z",
      recordedAt: "2026-01-01T00:00:00Z",
    });
    const localMutation = normalizeArtifactMutation({
      id: "artifact-local",
      resource,
      kind: "delete",
      effectiveAt: "2026-02-01T00:00:00Z",
      recordedAt: "2026-02-01T00:00:00Z",
    });
    const remoteMutation = normalizeArtifactMutation({
      id: "artifact-remote",
      resource,
      kind: "delete",
      effectiveAt: "2026-03-01T00:00:00Z",
      recordedAt: "2026-03-01T00:00:00Z",
    });
    const makeRecord = (mutation: typeof sharedMutation) => createReplicationRecord({
      kind: "artifact-mutation",
      recordId: mutation.id,
      payload: artifactMutationJson(mutation),
    });
    const shared = await makeRecord(sharedMutation);
    const localOnly = await makeRecord(localMutation);
    const remoteOnly = await makeRecord(remoteMutation);
    const localRecords = [shared, localOnly];
    const remoteRecords = [shared, remoteOnly];
    const flat = await diffReplicationInventories(
      await replicationInventory(localRecords),
      await replicationInventory(remoteRecords),
    );
    const merkle = comparePrefixMerkleIndexes(
      await buildPrefixMerkleIndex(localRecords),
      await buildPrefixMerkleIndex(remoteRecords),
    );

    expect(merkle.localOnly).toEqual(flat.localOnly);
    expect(merkle.remoteOnly).toEqual(flat.remoteOnly);
    expect(merkle.collisions).toEqual(flat.collisions);
  });

  it("rejects comparing indexes built with different prefix widths", async () => {
    const source = await records(4);
    const narrow = await buildPrefixMerkleIndex(source, { prefixBits: 8 });
    const wide = await buildPrefixMerkleIndex(source, { prefixBits: 12 });
    expect(() => comparePrefixMerkleIndexes(narrow, wide)).toThrow(/prefixBits mismatch/);
  });
});
