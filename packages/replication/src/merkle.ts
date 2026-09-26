import {
  InvalidReplicationRecordError,
  ReplicationRecordCollisionError,
  assertSameReplicationDescriptor,
  normalizeReplicationDescriptors,
  replicationDescriptor,
  type ReplicationRecordCollision,
  type ReplicationRecordDescriptor,
  type ReplicationRecordKey,
} from "./index.js";
import {
  createMerkleProtocolRuntime,
  merkleCoreSnapshot,
  merkleSnapshotBase,
  validateMerkleSnapshotBase,
  type MerkleLeafSnapshotBase,
  type MerkleSnapshotBase,
} from "./merkle-adapter.js";
import {
  DEFAULT_PREFIX_MERKLE_BITS,
  SUPPORTED_PREFIX_MERKLE_BITS,
  resolvePrefixMerkleBits,
  type PrefixMerkleBits,
} from "./merkle-common.js";
import { genericPrefixMerkleLeafIdForKey, type MerkleDescriptorCodec } from "./merkle-core.js";

export const PREFIX_MERKLE_SCHEMA = "ssrl-prefix-merkle-v1" as const;
export const PLAINTEXT_RECONCILIATION_SCOPE = "ssrl-plaintext-replication-v1";
export { DEFAULT_PREFIX_MERKLE_BITS, SUPPORTED_PREFIX_MERKLE_BITS };
export type { PrefixMerkleBits };

export type PrefixMerkleAddResult = "inserted" | "unchanged";

export interface PrefixMerkleBuildOptions {
  readonly prefixBits?: PrefixMerkleBits;
}

export interface PrefixMerkleLeafSnapshot
extends MerkleLeafSnapshotBase<ReplicationRecordDescriptor> {}

export interface PrefixMerkleSnapshot
extends MerkleSnapshotBase<ReplicationRecordDescriptor> {
  readonly schema: typeof PREFIX_MERKLE_SCHEMA;
  readonly nonEmptyLeaves: readonly PrefixMerkleLeafSnapshot[];
}

export interface PrefixMerkleDiff {
  readonly rootEqual: boolean;
  readonly internalHashComparisons: number;
  readonly mismatchedLeafIds: readonly number[];
  readonly localOnly: readonly ReplicationRecordKey[];
  readonly remoteOnly: readonly ReplicationRecordKey[];
  readonly collisions: readonly ReplicationRecordCollision[];
  readonly leafDescriptorsExamined: number;
  readonly estimatedLeafDescriptorBytesExchanged: number;
}

export const plaintextMerkleCodec: MerkleDescriptorCodec<
  ReplicationRecordDescriptor,
  ReplicationRecordKey,
  ReplicationRecordCollision
> = {
  defaultScope: PLAINTEXT_RECONCILIATION_SCOPE,
  async normalize(descriptor) {
    const normalized = await normalizeReplicationDescriptors([descriptor]);
    const value = normalized[0];
    if (value === undefined) throw new InvalidReplicationRecordError("Missing normalized descriptor");
    return value;
  },
  key: (descriptor) => descriptor.key,
  scope: () => PLAINTEXT_RECONCILIATION_SCOPE,
  canonicalValue: replicationDescriptor,
  compareSameKey(left, right) {
    if (left.payloadDigest !== right.payloadDigest) {
      return {
        collision: {
          key: left.key,
          localDigest: left.payloadDigest,
          remoteDigest: right.payloadDigest,
        },
      };
    }
    assertSameReplicationDescriptor(left, right);
    return {};
  },
  collisionError: (collision) => new ReplicationRecordCollisionError(collision),
  invalid: (message) => new InvalidReplicationRecordError(message),
  scopeMismatch: (left, right) => new InvalidReplicationRecordError(
    `Reconciliation scope mismatch: ${left} != ${right}`,
  ),
  collisionKey: (collision) => collision.key,
};

const runtime = createMerkleProtocolRuntime<
  ReplicationRecordDescriptor,
  ReplicationRecordKey,
  ReplicationRecordCollision,
  PrefixMerkleSnapshot,
  PrefixMerkleBuildOptions
>({
  codec: plaintextMerkleCodec,
  buildOptions: (options) => ({ prefixBits: resolvePrefixMerkleBits(options.prefixBits) }),
  publicSnapshot: (snapshot) => ({
    schema: PREFIX_MERKLE_SCHEMA,
    ...merkleSnapshotBase({
      ...snapshot,
      nonEmptyLeaves: snapshot.nonEmptyLeaves.map((leaf) => ({
        ...leaf,
        descriptors: leaf.descriptors.map(replicationDescriptor),
      })),
    }),
  }),
  coreSnapshot: (snapshot) => merkleCoreSnapshot(PLAINTEXT_RECONCILIATION_SCOPE, snapshot),
  validateSnapshot(snapshot) {
    if (snapshot.schema !== PREFIX_MERKLE_SCHEMA) {
      throw new InvalidReplicationRecordError("Unsupported prefix Merkle snapshot schema");
    }
    resolvePrefixMerkleBits(snapshot.prefixBits);
    validateMerkleSnapshotBase(snapshot, (message) => new InvalidReplicationRecordError(message));
  },
});

export const PrefixMerkleIndex = runtime.Index;
export type PrefixMerkleIndex = Awaited<ReturnType<typeof PrefixMerkleIndex.build>>;

export async function prefixMerkleLeafIdForKey(
  key: ReplicationRecordKey,
  bits: PrefixMerkleBits,
): Promise<number> {
  return genericPrefixMerkleLeafIdForKey(key, bits);
}

export function buildPrefixMerkleIndex(
  descriptors: readonly ReplicationRecordDescriptor[],
  options: PrefixMerkleBuildOptions = {},
): Promise<PrefixMerkleIndex> {
  return runtime.build(descriptors, options);
}

export function restorePrefixMerkleIndex(
  snapshot: PrefixMerkleSnapshot,
): Promise<PrefixMerkleIndex> {
  return runtime.restore(snapshot);
}

export function comparePrefixMerkleIndexes(
  local: PrefixMerkleIndex,
  remote: PrefixMerkleIndex,
): PrefixMerkleDiff {
  return runtime.compare(local, remote);
}

export function prefixMerkleSnapshotJson(index: PrefixMerkleIndex): string {
  return runtime.snapshotJson(index);
}
