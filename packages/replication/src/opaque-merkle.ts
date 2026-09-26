import { normalizeVaultEpochId, type VaultEpochId } from "@ssrl/e2e";
import {
  EncryptedReplicationValidationError,
  OpaqueReplicationCollisionError,
  assertSameOpaqueReplicationDescriptor,
  normalizeOpaqueReplicationDescriptor,
  normalizeOpaqueReplicationTag,
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
import {
  genericPrefixMerkleEmptyHashes,
  genericPrefixMerkleLeafHash,
  genericPrefixMerkleLeafIdForKey,
  genericPrefixMerkleParentHash,
  type MerkleDescriptorCodec,
} from "./merkle-core.js";

export const OPAQUE_PREFIX_MERKLE_SCHEMA = "ssrl-opaque-prefix-merkle-v1" as const;


const OPAQUE_TAG_PREFIX = "hmac-sha256:";

function opaqueTagPrimaryRank(character: string): number {
  if (character === "_") return 0;
  if (character === "-") return 1;
  const code = character.charCodeAt(0);
  if (code >= 48 && code <= 57) return 2 + code - 48;
  const lower = character.toLowerCase().charCodeAt(0);
  if (lower >= 97 && lower <= 122) return 12 + lower - 97;
  throw new EncryptedReplicationValidationError("Opaque replication tag contains an invalid base64url character");
}

function opaqueTagCaseRank(character: string): number {
  const code = character.charCodeAt(0);
  return code >= 65 && code <= 90 ? 1 : 0;
}

/**
 * Deterministic v1 opaque-tag collation key.
 *
 * Opaque tags use a fixed prefix and a 43-character base64url suffix. The v1
 * implementation historically used JavaScript localeCompare(), whose default
 * locale is not a wire-safe ordering contract. This explicit two-level key
 * preserves the established base64url ordering (primary case-insensitive,
 * lower-case before upper-case on tertiary ties) while making it stable across
 * runtimes and directly sortable with SQLite BINARY collation.
 */
export function opaqueReplicationTagOrderKey(value: OpaqueReplicationTag): string {
  const normalized = normalizeOpaqueReplicationTag(value, "opaque replication tag order key");
  const suffix = normalized.slice(OPAQUE_TAG_PREFIX.length);
  const primary = [...suffix]
    .map((character) => opaqueTagPrimaryRank(character).toString(16).padStart(2, "0"))
    .join("");
  const tertiary = [...suffix].map((character) => String(opaqueTagCaseRank(character))).join("");
  return `${primary}ff${tertiary}`;
}

export function compareOpaqueReplicationTags(
  left: OpaqueReplicationTag,
  right: OpaqueReplicationTag,
): number {
  const leftSuffix = left.slice(OPAQUE_TAG_PREFIX.length);
  const rightSuffix = right.slice(OPAQUE_TAG_PREFIX.length);
  for (let index = 0; index < leftSuffix.length; index += 1) {
    const primary = opaqueTagPrimaryRank(leftSuffix[index]!)
      - opaqueTagPrimaryRank(rightSuffix[index]!);
    if (primary !== 0) return primary;
  }
  for (let index = 0; index < leftSuffix.length; index += 1) {
    const tertiary = opaqueTagCaseRank(leftSuffix[index]!)
      - opaqueTagCaseRank(rightSuffix[index]!);
    if (tertiary !== 0) return tertiary;
  }
  return 0;
}

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
  compareKeys: compareOpaqueReplicationTags,
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


export function opaquePrefixMerkleLeafId(
  opaqueKey: OpaqueReplicationTag,
  prefixBits: PrefixMerkleBits,
): Promise<number> {
  return genericPrefixMerkleLeafIdForKey(opaqueKey, prefixBits);
}

export async function opaquePrefixMerkleLeafHash(
  descriptors: readonly OpaqueReplicationDescriptor[],
): Promise<string> {
  const normalized = await Promise.all(descriptors.map((descriptor) => (
    normalizeOpaqueReplicationDescriptor(descriptor)
  )));
  return genericPrefixMerkleLeafHash(opaqueMerkleCodec, normalized);
}

export function opaquePrefixMerkleParentHash(
  level: number,
  left: string,
  right: string,
): Promise<string> {
  return genericPrefixMerkleParentHash(level, left, right);
}

export function opaquePrefixMerkleEmptyHashes(
  prefixBits: PrefixMerkleBits,
): Promise<readonly string[]> {
  return genericPrefixMerkleEmptyHashes(opaqueMerkleCodec, prefixBits);
}
