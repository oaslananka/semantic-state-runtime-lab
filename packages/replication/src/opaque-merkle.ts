import { normalizeVaultEpochId, type VaultEpochId } from "@ssrl/e2e";
import {
  EncryptedReplicationValidationError,
  OpaqueReplicationCollisionError,
  assertSameOpaqueReplicationDescriptor,
  normalizeOpaqueReplicationDescriptor,
  type OpaqueReplicationCollision,
  type OpaqueReplicationDescriptor,
  type OpaqueReplicationTag,
} from "./encrypted.js";
import {
  createMerkleProtocolRuntime,
  merkleCoreSnapshot,
  merkleSnapshotBase,
  validateMerkleSnapshotBase,
  type MerkleLeafSnapshotBase,
  type MerkleSnapshotBase,
} from "./merkle-adapter.js";
import {
  resolvePrefixMerkleBits,
  type PrefixMerkleBits,
} from "./merkle-common.js";
import type { MerkleDescriptorCodec } from "./merkle-core.js";

export const OPAQUE_PREFIX_MERKLE_SCHEMA = "ssrl-opaque-prefix-merkle-v1" as const;

export interface OpaquePrefixMerkleBuildOptions {
  readonly prefixBits?: PrefixMerkleBits;
  /** Required when descriptors is empty. When non-empty, must match every descriptor epoch. */
  readonly epochId?: VaultEpochId;
}

export interface OpaquePrefixMerkleLeafSnapshot
extends MerkleLeafSnapshotBase<OpaqueReplicationDescriptor> {}

export interface OpaquePrefixMerkleSnapshot
extends MerkleSnapshotBase<OpaqueReplicationDescriptor> {
  readonly schema: typeof OPAQUE_PREFIX_MERKLE_SCHEMA;
  readonly epochId: VaultEpochId;
  readonly nonEmptyLeaves: readonly OpaquePrefixMerkleLeafSnapshot[];
}

export interface OpaquePrefixMerkleDiff {
  readonly rootEqual: boolean;
  readonly internalHashComparisons: number;
  readonly mismatchedLeafIds: readonly number[];
  readonly localOnly: readonly OpaqueReplicationTag[];
  readonly remoteOnly: readonly OpaqueReplicationTag[];
  readonly collisions: readonly OpaqueReplicationCollision[];
  readonly leafDescriptorsExamined: number;
  readonly estimatedLeafDescriptorBytesExchanged: number;
}

export class OpaqueReplicationEpochMismatchError extends EncryptedReplicationValidationError {
  constructor(readonly localEpochId: string, readonly remoteEpochId: string) {
    super(`Opaque reconciliation epoch mismatch: ${localEpochId} != ${remoteEpochId}`);
    this.name = "OpaqueReplicationEpochMismatchError";
  }
}

export const opaqueMerkleCodec: MerkleDescriptorCodec<
  OpaqueReplicationDescriptor,
  OpaqueReplicationTag,
  OpaqueReplicationCollision
> = {
  normalize: normalizeOpaqueReplicationDescriptor,
  key: (descriptor) => descriptor.opaqueKey,
  scope: (descriptor) => descriptor.epochId,
  canonicalValue: (descriptor) => descriptor,
  compareSameKey(left, right) {
    if (left.opaqueContentTag !== right.opaqueContentTag) {
      return {
        collision: {
          epochId: left.epochId,
          opaqueKey: left.opaqueKey,
          localContentTag: left.opaqueContentTag,
          remoteContentTag: right.opaqueContentTag,
        },
      };
    }
    assertSameOpaqueReplicationDescriptor(left, right);
    return {};
  },
  collisionError: (collision) => new OpaqueReplicationCollisionError(collision),
  invalid: (message) => new EncryptedReplicationValidationError(message),
  scopeMismatch: (left, right) => new OpaqueReplicationEpochMismatchError(left, right),
  collisionKey: (collision) => collision.opaqueKey,
};

const runtime = createMerkleProtocolRuntime<
  OpaqueReplicationDescriptor,
  OpaqueReplicationTag,
  OpaqueReplicationCollision,
  OpaquePrefixMerkleSnapshot,
  OpaquePrefixMerkleBuildOptions
>({
  codec: opaqueMerkleCodec,
  buildOptions: (options) => ({
    prefixBits: resolvePrefixMerkleBits(options.prefixBits),
    ...(options.epochId === undefined ? {} : { scopeId: normalizeVaultEpochId(options.epochId) }),
  }),
  publicSnapshot: (snapshot) => ({
    schema: OPAQUE_PREFIX_MERKLE_SCHEMA,
    epochId: normalizeVaultEpochId(snapshot.scopeId),
    ...merkleSnapshotBase(snapshot),
  }),
  coreSnapshot: (snapshot) => merkleCoreSnapshot(normalizeVaultEpochId(snapshot.epochId), snapshot),
  validateSnapshot(snapshot) {
    if (snapshot.schema !== OPAQUE_PREFIX_MERKLE_SCHEMA) {
      throw new EncryptedReplicationValidationError("Unsupported opaque prefix Merkle snapshot schema");
    }
    normalizeVaultEpochId(snapshot.epochId);
    resolvePrefixMerkleBits(snapshot.prefixBits);
    validateMerkleSnapshotBase(
      snapshot,
      (message) => new EncryptedReplicationValidationError(message),
    );
  },
});

export const OpaquePrefixMerkleIndex = runtime.Index;
export type OpaquePrefixMerkleIndex = Awaited<
  ReturnType<typeof OpaquePrefixMerkleIndex.build>
>;

export function buildOpaquePrefixMerkleIndex(
  descriptors: readonly OpaqueReplicationDescriptor[],
  options: OpaquePrefixMerkleBuildOptions = {},
): Promise<OpaquePrefixMerkleIndex> {
  return runtime.build(descriptors, options);
}

export function restoreOpaquePrefixMerkleIndex(
  snapshot: OpaquePrefixMerkleSnapshot,
): Promise<OpaquePrefixMerkleIndex> {
  return runtime.restore(snapshot);
}

export function compareOpaquePrefixMerkleIndexes(
  local: OpaquePrefixMerkleIndex,
  remote: OpaquePrefixMerkleIndex,
): OpaquePrefixMerkleDiff {
  return runtime.compare(local, remote);
}

export function opaquePrefixMerkleSnapshotJson(index: OpaquePrefixMerkleIndex): string {
  return runtime.snapshotJson(index);
}

export type { PrefixMerkleBits };
