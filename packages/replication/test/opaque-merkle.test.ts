import { describe, expect, it } from "vitest";
import { generateVaultEpoch } from "@ssrl/e2e";
import { temporalObservationJson } from "@ssrl/state-store";
import {
  createReplicationRecord,
  type ReplicationRecord,
} from "../src/index.js";
import {
  OpaqueReplicationCollisionError,
  encryptReplicationRecord,
  normalizeOpaqueReplicationTag,
  opaqueReplicationRecordDescriptor,
  type OpaqueReplicationDescriptor,
  type OpaqueReplicationTag,
} from "../src/encrypted.js";
import {
  OpaqueReplicationEpochMismatchError,
  buildOpaquePrefixMerkleIndex,
  compareOpaquePrefixMerkleIndexes,
  compareOpaqueReplicationTags,
  opaquePrefixMerkleEmptyHashes,
  opaquePrefixMerkleLeafHash,
  opaquePrefixMerkleLeafId,
  opaquePrefixMerkleParentHash,
  opaquePrefixMerkleSnapshotJson,
  opaqueReplicationTagOrderKey,
  restoreOpaquePrefixMerkleIndex,
} from "../src/opaque-merkle.js";

const project = "entity://project/opaque-merkle" as const;

async function record(id: string, value = id): Promise<ReplicationRecord> {
  return createReplicationRecord({
    kind: "semantic-observation",
    recordId: id,
    payload: temporalObservationJson({
      id,
      entityId: project,
      property: "Project.secret",
      value,
      source: { provider: "opaque-merkle-test", externalId: id, revision: id },
      validFrom: "2026-09-01T00:00:00Z",
      recordedAt: "2026-09-01T00:00:00Z",
    }),
  });
}

async function descriptors(
  epoch: ReturnType<typeof generateVaultEpoch>,
  count: number,
  start = 0,
): Promise<OpaqueReplicationDescriptor[]> {
  const result: OpaqueReplicationDescriptor[] = [];
  for (let offset = 0; offset < count; offset += 128) {
    const length = Math.min(128, count - offset);
    result.push(...await Promise.all(Array.from({ length }, async (_, index) => {
      const ordinal = start + offset + index;
      const item = await record(
        `opaque-${String(ordinal).padStart(6, "0")}`,
        `secret-${ordinal}`,
      );
      return opaqueReplicationRecordDescriptor({
        epochId: epoch.epochId,
        epochSecret: epoch.secret,
        record: item,
      });
    })));
  }
  return result;
}

function exhaustiveOpaqueOrderTags(): OpaqueReplicationTag[] {
  return Array.from({ length: 4096 }, (_, value) => {
    const bytes = Buffer.alloc(32);
    bytes[0] = value >> 4;
    bytes[1] = (value & 0x0f) << 4;
    return normalizeOpaqueReplicationTag(`hmac-sha256:${bytes.toString("base64url")}`);
  });
}

describe("opaque prefix Merkle reconciliation", () => {
  it("preserves the established v1 opaque-tag order with an explicit deterministic SQL-sortable key", () => {
    const tags = exhaustiveOpaqueOrderTags();
    const legacy = [...tags].sort((left, right) => left.localeCompare(right));
    const explicit = [...tags].sort(compareOpaqueReplicationTags);
    const byPersistedKey = [...tags].sort((left, right) => {
      const leftKey = opaqueReplicationTagOrderKey(left);
      const rightKey = opaqueReplicationTagOrderKey(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });

    expect(explicit).toEqual(legacy);
    expect(byPersistedKey).toEqual(explicit);
    expect(new Set(tags.map(opaqueReplicationTagOrderKey)).size).toBe(tags.length);
  });

  it("builds deterministic relay-safe roots and snapshots independent of input order", async () => {
    const epoch = generateVaultEpoch();
    const source = await descriptors(epoch, 128);
    const forward = await buildOpaquePrefixMerkleIndex(source, { prefixBits: 8 });
    const reverse = await buildOpaquePrefixMerkleIndex([...source].reverse(), { prefixBits: 8 });

    expect(reverse.rootDigest).toBe(forward.rootDigest);
    expect(opaquePrefixMerkleSnapshotJson(reverse)).toBe(opaquePrefixMerkleSnapshotJson(forward));

    const serialized = opaquePrefixMerkleSnapshotJson(forward);
    expect(serialized).toContain(epoch.epochId);
    expect(serialized).not.toContain("opaque-000000");
    expect(serialized).not.toContain(project);
    expect(serialized).not.toContain("secret-0");
    expect(serialized).not.toContain('"recordId"');
    expect(serialized).not.toContain('"payloadDigest"');
    expect(serialized).not.toContain('"payload"');
    expect(serialized).not.toContain('"ciphertext"');
  });

  it("restores an opaque snapshot with the same epoch scope and exact root", async () => {
    const epoch = generateVaultEpoch();
    const original = await buildOpaquePrefixMerkleIndex(
      await descriptors(epoch, 64),
      { prefixBits: 8 },
    );
    const restored = await restoreOpaquePrefixMerkleIndex(original.snapshot());

    expect(restored.snapshot().epochId).toBe(epoch.epochId);
    expect(restored.rootDigest).toBe(original.rootDigest);
    expect(opaquePrefixMerkleSnapshotJson(restored))
      .toBe(opaquePrefixMerkleSnapshotJson(original));
  });

  it("requires an explicit epoch for an empty opaque index and compares equal empty scopes", async () => {
    await expect(buildOpaquePrefixMerkleIndex([], { prefixBits: 8 }))
      .rejects.toThrow(/scope is required/);
    const epoch = generateVaultEpoch();
    const first = await buildOpaquePrefixMerkleIndex([], {
      prefixBits: 8,
      epochId: epoch.epochId,
    });
    const second = await buildOpaquePrefixMerkleIndex([], {
      prefixBits: 8,
      epochId: epoch.epochId,
    });

    expect(compareOpaquePrefixMerkleIndexes(first, second)).toEqual({
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

  it("exposes hash primitives that reproduce index leaves, parents, and empty roots exactly", async () => {
    const epoch = generateVaultEpoch();
    const source = await descriptors(epoch, 32);
    const index = await buildOpaquePrefixMerkleIndex(source, { prefixBits: 8 });
    const snapshot = index.snapshot();
    const leaf = snapshot.nonEmptyLeaves[0];
    if (leaf === undefined) throw new Error("expected non-empty leaf");

    expect(await opaquePrefixMerkleLeafId(leaf.descriptors[0]!.opaqueKey, 8)).toBe(leaf.leafId);
    expect(await opaquePrefixMerkleLeafHash(leaf.descriptors)).toBe(index.nodeHash(0, leaf.leafId));

    const parentIndex = Math.floor(leaf.leafId / 2);
    const left = index.nodeHash(0, parentIndex * 2);
    const right = index.nodeHash(0, parentIndex * 2 + 1);
    expect(await opaquePrefixMerkleParentHash(1, left, right)).toBe(index.nodeHash(1, parentIndex));

    const empty = await opaquePrefixMerkleEmptyHashes(8);
    const emptyIndex = await buildOpaquePrefixMerkleIndex([], { prefixBits: 8, epochId: epoch.epochId });
    expect(empty).toHaveLength(9);
    expect(empty[8]).toBe(emptyIndex.rootDigest);
    expect(empty[0]).toBe(emptyIndex.nodeHash(0, 0));
  });

  it("treats exact incremental replay as unchanged", async () => {
    const epoch = generateVaultEpoch();
    const item = (await descriptors(epoch, 1))[0]!;
    const index = await buildOpaquePrefixMerkleIndex([item], { prefixBits: 8 });
    const root = index.rootDigest;

    expect(await index.add(item)).toBe("unchanged");
    expect(index.rootDigest).toBe(root);
    expect(index.recordCount).toBe(1);
  });

  it("rejects same-key divergent opaque content without mutating the root", async () => {
    const epoch = generateVaultEpoch();
    const firstRecord = await record("opaque-collision", "active1");
    const secondRecord = await record("opaque-collision", "paused1");
    const [first, second] = await Promise.all([
      opaqueReplicationRecordDescriptor({
        epochId: epoch.epochId,
        epochSecret: epoch.secret,
        record: firstRecord,
      }),
      opaqueReplicationRecordDescriptor({
        epochId: epoch.epochId,
        epochSecret: epoch.secret,
        record: secondRecord,
      }),
    ]);
    expect(second.opaqueKey).toBe(first.opaqueKey);
    expect(second.opaqueContentTag).not.toBe(first.opaqueContentTag);
    const index = await buildOpaquePrefixMerkleIndex([first], { prefixBits: 8 });
    const root = index.rootDigest;

    await expect(index.add(second)).rejects.toBeInstanceOf(OpaqueReplicationCollisionError);
    expect(index.rootDigest).toBe(root);
    expect(index.recordCount).toBe(1);
  });

  it("rejects a descriptor from another epoch before mutating the index", async () => {
    const firstEpoch = generateVaultEpoch();
    const secondEpoch = generateVaultEpoch();
    const item = await record("epoch-add", "private");
    const first = await opaqueReplicationRecordDescriptor({
      epochId: firstEpoch.epochId,
      epochSecret: firstEpoch.secret,
      record: item,
    });
    const second = await opaqueReplicationRecordDescriptor({
      epochId: secondEpoch.epochId,
      epochSecret: secondEpoch.secret,
      record: item,
    });
    const index = await buildOpaquePrefixMerkleIndex([first], { prefixBits: 8 });
    const root = index.rootDigest;

    await expect(index.add(second)).rejects.toBeInstanceOf(OpaqueReplicationEpochMismatchError);
    expect(index.rootDigest).toBe(root);
    expect(index.recordCount).toBe(1);
  });

  it("compares same-epoch indexes using only opaque keys and content tags", async () => {
    const epoch = generateVaultEpoch();
    const shared = await descriptors(epoch, 16);
    const localExtra = await descriptors(epoch, 2, 10_000);
    const remoteExtra = await descriptors(epoch, 3, 20_000);
    const local = await buildOpaquePrefixMerkleIndex([...shared, ...localExtra], { prefixBits: 8 });
    const remote = await buildOpaquePrefixMerkleIndex([...shared, ...remoteExtra], { prefixBits: 8 });
    const diff = compareOpaquePrefixMerkleIndexes(local, remote);

    expect(diff.collisions).toEqual([]);
    expect(diff.localOnly).toEqual(
      localExtra.map((value) => value.opaqueKey).toSorted((a, b) => a.localeCompare(b)),
    );
    expect(diff.remoteOnly).toEqual(
      remoteExtra.map((value) => value.opaqueKey).toSorted((a, b) => a.localeCompare(b)),
    );
  });

  it("fails explicitly instead of producing a cross-epoch full delta", async () => {
    const firstEpoch = generateVaultEpoch();
    const secondEpoch = generateVaultEpoch();
    const first = await buildOpaquePrefixMerkleIndex(
      await descriptors(firstEpoch, 8),
      { prefixBits: 8 },
    );
    const second = await buildOpaquePrefixMerkleIndex(
      await descriptors(secondEpoch, 8),
      { prefixBits: 8 },
    );

    expect(() => compareOpaquePrefixMerkleIndexes(first, second))
      .toThrow(OpaqueReplicationEpochMismatchError);
  });

  it("detects opaque collisions during tree comparison without plaintext metadata", async () => {
    const epoch = generateVaultEpoch();
    const firstRecord = await record("compare-collision", "active1");
    const secondRecord = await record("compare-collision", "paused1");
    const [first, second] = await Promise.all([
      opaqueReplicationRecordDescriptor({
        epochId: epoch.epochId,
        epochSecret: epoch.secret,
        record: firstRecord,
      }),
      opaqueReplicationRecordDescriptor({
        epochId: epoch.epochId,
        epochSecret: epoch.secret,
        record: secondRecord,
      }),
    ]);
    const local = await buildOpaquePrefixMerkleIndex([first], { prefixBits: 8 });
    const remote = await buildOpaquePrefixMerkleIndex([second], { prefixBits: 8 });
    const diff = compareOpaquePrefixMerkleIndexes(local, remote);

    expect(diff.localOnly).toEqual([]);
    expect(diff.remoteOnly).toEqual([]);
    expect(diff.collisions).toEqual([{
      epochId: epoch.epochId,
      opaqueKey: first.opaqueKey,
      localContentTag: first.opaqueContentTag,
      remoteContentTag: second.opaqueContentTag,
    }]);
  });

  it("opaque Merkle input comes from encrypted descriptors without storing ciphertext in the tree", async () => {
    const epoch = generateVaultEpoch();
    const item = await record("ciphertext-separated", "very-private-value");
    const encrypted = await encryptReplicationRecord({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      record: item,
    });
    const index = await buildOpaquePrefixMerkleIndex([encrypted.descriptor], { prefixBits: 8 });
    const serialized = opaquePrefixMerkleSnapshotJson(index);

    expect(serialized).toContain(encrypted.descriptor.opaqueKey);
    expect(serialized).not.toContain(encrypted.envelope.ciphertext);
    expect(serialized).not.toContain("ciphertext-separated");
    expect(serialized).not.toContain("very-private-value");
  });
});
