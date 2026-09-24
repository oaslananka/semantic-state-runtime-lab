import { canonicalJson } from "@ssrl/core";
import {
  InvalidReplicationRecordError,
  ReplicationRecordCollisionError,
  assertSameReplicationDescriptor,
  diffReplicationDescriptors,
  normalizeReplicationDescriptors,
  replicationDescriptor,
  type ReplicationRecordCollision,
  type ReplicationRecordDescriptor,
  type ReplicationRecordKey,
} from "./index.js";

export const PREFIX_MERKLE_SCHEMA = "ssrl-prefix-merkle-v1" as const;
export const DEFAULT_PREFIX_MERKLE_BITS = 12 as const;
export const SUPPORTED_PREFIX_MERKLE_BITS = [8, 12, 16] as const;

export type PrefixMerkleBits = (typeof SUPPORTED_PREFIX_MERKLE_BITS)[number];
export type PrefixMerkleAddResult = "inserted" | "unchanged";

export interface PrefixMerkleBuildOptions {
  readonly prefixBits?: PrefixMerkleBits;
}

export interface PrefixMerkleLeafSnapshot {
  readonly leafId: number;
  readonly hash: string;
  readonly recordCount: number;
  readonly descriptors: readonly ReplicationRecordDescriptor[];
}

export interface PrefixMerkleSnapshot {
  readonly schema: typeof PREFIX_MERKLE_SCHEMA;
  readonly prefixBits: PrefixMerkleBits;
  readonly recordCount: number;
  readonly rootDigest: string;
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

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function sha256Bytes(value: Uint8Array): Promise<Uint8Array> {
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes.buffer));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Digest(value: string): Promise<string> {
  return `sha256:${hex(await sha256Bytes(utf8Bytes(value)))}`;
}

function prefixBits(options: PrefixMerkleBuildOptions): PrefixMerkleBits {
  const value = options.prefixBits ?? DEFAULT_PREFIX_MERKLE_BITS;
  if (!SUPPORTED_PREFIX_MERKLE_BITS.includes(value)) {
    throw new RangeError(`prefixBits must be one of ${SUPPORTED_PREFIX_MERKLE_BITS.join(", ")}`);
  }
  return value;
}

function descriptorOrder(left: ReplicationRecordDescriptor, right: ReplicationRecordDescriptor): number {
  return left.key.localeCompare(right.key);
}



async function leafIdForKey(key: ReplicationRecordKey, bits: PrefixMerkleBits): Promise<number> {
  const digest = await sha256Bytes(utf8Bytes(key));
  const first16 = ((digest[0] ?? 0) << 8) | (digest[1] ?? 0);
  return first16 >>> (16 - bits);
}

async function leafHash(records: readonly ReplicationRecordDescriptor[]): Promise<string> {
  return sha256Digest(canonicalJson([
    "ssrl-prefix-merkle-leaf-v1",
    records.map(replicationDescriptor),
  ]));
}

async function parentHash(level: number, left: string, right: string): Promise<string> {
  return sha256Digest(canonicalJson([
    "ssrl-prefix-merkle-node-v1",
    level,
    left,
    right,
  ]));
}

async function mapInBatches<T, U>(
  values: readonly T[],
  mapper: (value: T) => Promise<U>,
  batchSize = 256,
): Promise<U[]> {
  const result: U[] = [];
  for (let offset = 0; offset < values.length; offset += batchSize) {
    result.push(...await Promise.all(values.slice(offset, offset + batchSize).map(mapper)));
  }
  return result;
}

function sameDescriptor(
  left: ReplicationRecordDescriptor,
  right: ReplicationRecordDescriptor,
): boolean {
  return left.key === right.key
    && left.kind === right.kind
    && left.recordId === right.recordId
    && left.payloadDigest === right.payloadDigest
    && left.fingerprint === right.fingerprint
    && left.payloadBytes === right.payloadBytes;
}



async function buildLevels(
  leafHashes: readonly string[],
  prefixBitCount: PrefixMerkleBits,
): Promise<string[][]> {
  const levels: string[][] = [[...leafHashes]];
  for (let level = 1; level <= prefixBitCount; level += 1) {
    const previous = levels[level - 1]!;
    const parents = await Promise.all(Array.from(
      { length: previous.length / 2 },
      (_, index) => parentHash(level, previous[index * 2]!, previous[index * 2 + 1]!),
    ));
    levels.push(parents);
  }
  return levels;
}

function descriptorJsonBytes(records: readonly ReplicationRecordDescriptor[]): number {
  return utf8Bytes(canonicalJson(records.map(replicationDescriptor))).byteLength;
}

export class PrefixMerkleIndex {
  readonly prefixBits: PrefixMerkleBits;
  readonly #leaves: Map<number, Map<ReplicationRecordKey, ReplicationRecordDescriptor>>;
  readonly #levels: string[][];
  #recordCount: number;

  private constructor(input: {
    readonly prefixBits: PrefixMerkleBits;
    readonly leaves: Map<number, Map<ReplicationRecordKey, ReplicationRecordDescriptor>>;
    readonly levels: string[][];
    readonly recordCount: number;
  }) {
    this.prefixBits = input.prefixBits;
    this.#leaves = input.leaves;
    this.#levels = input.levels;
    this.#recordCount = input.recordCount;
  }

  static async build(
    descriptors: readonly ReplicationRecordDescriptor[],
    options: PrefixMerkleBuildOptions = {},
  ): Promise<PrefixMerkleIndex> {
    const bits = prefixBits(options);
    const normalized = await normalizeReplicationDescriptors(descriptors);
    const leaves = new Map<number, Map<ReplicationRecordKey, ReplicationRecordDescriptor>>();
    const leafIds = await mapInBatches(
      normalized,
      (descriptor) => leafIdForKey(descriptor.key, bits),
    );
    normalized.forEach((descriptor, index) => {
      const leafId = leafIds[index]!;
      const records = leaves.get(leafId) ?? new Map();
      records.set(descriptor.key, replicationDescriptor(descriptor));
      leaves.set(leafId, records);
    });

    const emptyHash = await leafHash([]);
    const hashes = Array<string>(2 ** bits).fill(emptyHash);
    await Promise.all([...leaves.entries()].map(async ([leafId, records]) => {
      hashes[leafId] = await leafHash([...records.values()].toSorted(descriptorOrder));
    }));
    const levels = await buildLevels(hashes, bits);
    return new PrefixMerkleIndex({
      prefixBits: bits,
      leaves,
      levels,
      recordCount: normalized.length,
    });
  }

  get recordCount(): number {
    return this.#recordCount;
  }

  get leafCount(): number {
    return 2 ** this.prefixBits;
  }

  get rootDigest(): string {
    return this.#levels[this.prefixBits]?.[0]
      ?? "";
  }

  nodeHash(level: number, index: number): string {
    if (!Number.isInteger(level) || level < 0 || level > this.prefixBits) {
      throw new RangeError(`Merkle level must be between 0 and ${this.prefixBits}`);
    }
    const nodes = this.#levels[level]!;
    if (!Number.isInteger(index) || index < 0 || index >= nodes.length) {
      throw new RangeError(`Merkle node index ${index} is outside level ${level}`);
    }
    return nodes[index]!;
  }

  leafDescriptors(leafId: number): readonly ReplicationRecordDescriptor[] {
    if (!Number.isInteger(leafId) || leafId < 0 || leafId >= this.leafCount) {
      throw new RangeError(`Merkle leaf ${leafId} is outside the tree`);
    }
    return [...(this.#leaves.get(leafId)?.values() ?? [])]
      .toSorted(descriptorOrder)
      .map(replicationDescriptor);
  }

  snapshot(): PrefixMerkleSnapshot {
    const nonEmptyLeaves = [...this.#leaves.entries()]
      .filter(([, records]) => records.size > 0)
      .toSorted(([left], [right]) => left - right)
      .map(([leafId, records]) => ({
        leafId,
        hash: this.nodeHash(0, leafId),
        recordCount: records.size,
        descriptors: [...records.values()].toSorted(descriptorOrder).map(replicationDescriptor),
      }));
    return {
      schema: PREFIX_MERKLE_SCHEMA,
      prefixBits: this.prefixBits,
      recordCount: this.recordCount,
      rootDigest: this.rootDigest,
      nonEmptyLeaves,
    };
  }

  async add(descriptor: ReplicationRecordDescriptor): Promise<PrefixMerkleAddResult> {
    const normalized = (await normalizeReplicationDescriptors([descriptor]))[0];
    if (normalized === undefined) throw new InvalidReplicationRecordError("Missing normalized descriptor");
    const leafId = await leafIdForKey(normalized.key, this.prefixBits);
    const records = this.#leaves.get(leafId) ?? new Map();
    const existing = records.get(normalized.key);
    if (existing !== undefined) {
      assertSameReplicationDescriptor(existing, normalized);
      return "unchanged";
    }

    const nextRecords = new Map(records);
    nextRecords.set(normalized.key, replicationDescriptor(normalized));
    const pathHashes = new Map<number, { readonly index: number; readonly hash: string }>();
    let childIndex = leafId;
    let childHash = await leafHash([...nextRecords.values()].toSorted(descriptorOrder));
    pathHashes.set(0, { index: childIndex, hash: childHash });

    for (let level = 1; level <= this.prefixBits; level += 1) {
      const parentIndex = Math.floor(childIndex / 2);
      const children = this.#levels[level - 1]!;
      const leftIndex = parentIndex * 2;
      const rightIndex = leftIndex + 1;
      const leftHash = childIndex === leftIndex ? childHash : children[leftIndex]!;
      const rightHash = childIndex === rightIndex ? childHash : children[rightIndex]!;
      childHash = await parentHash(level, leftHash, rightHash);
      pathHashes.set(level, { index: parentIndex, hash: childHash });
      childIndex = parentIndex;
    }

    this.#leaves.set(leafId, nextRecords);
    this.#recordCount += 1;
    for (const [level, update] of pathHashes) {
      this.#levels[level]![update.index] = update.hash;
    }
    return "inserted";
  }
}

export async function buildPrefixMerkleIndex(
  descriptors: readonly ReplicationRecordDescriptor[],
  options: PrefixMerkleBuildOptions = {},
): Promise<PrefixMerkleIndex> {
  return PrefixMerkleIndex.build(descriptors, options);
}


function assertSnapshotShape(snapshot: PrefixMerkleSnapshot): void {
  if (snapshot.schema !== PREFIX_MERKLE_SCHEMA) {
    throw new InvalidReplicationRecordError("Unsupported prefix Merkle snapshot schema");
  }
  prefixBits({ prefixBits: snapshot.prefixBits });
  if (!Number.isSafeInteger(snapshot.recordCount) || snapshot.recordCount < 0) {
    throw new InvalidReplicationRecordError("Prefix Merkle snapshot recordCount is invalid");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(snapshot.rootDigest)) {
    throw new InvalidReplicationRecordError("Prefix Merkle snapshot rootDigest is invalid");
  }
}

export async function restorePrefixMerkleIndex(
  snapshot: PrefixMerkleSnapshot,
): Promise<PrefixMerkleIndex> {
  assertSnapshotShape(snapshot);
  const descriptors: ReplicationRecordDescriptor[] = [];
  let previousLeafId = -1;
  for (const leaf of snapshot.nonEmptyLeaves) {
    if (!Number.isInteger(leaf.leafId) || leaf.leafId < 0 || leaf.leafId >= 2 ** snapshot.prefixBits) {
      throw new InvalidReplicationRecordError(`Invalid prefix Merkle leaf id ${leaf.leafId}`);
    }
    if (leaf.leafId <= previousLeafId) {
      throw new InvalidReplicationRecordError("Prefix Merkle snapshot leaves must be strictly ordered");
    }
    previousLeafId = leaf.leafId;
    if (leaf.recordCount !== leaf.descriptors.length) {
      throw new InvalidReplicationRecordError(`Prefix Merkle leaf ${leaf.leafId} recordCount mismatch`);
    }
    descriptors.push(...leaf.descriptors);
  }
  if (descriptors.length !== snapshot.recordCount) {
    throw new InvalidReplicationRecordError("Prefix Merkle snapshot total recordCount mismatch");
  }

  const rebuilt = await PrefixMerkleIndex.build(descriptors, { prefixBits: snapshot.prefixBits });
  const rebuiltSnapshot = rebuilt.snapshot();
  if (rebuiltSnapshot.rootDigest !== snapshot.rootDigest) {
    throw new InvalidReplicationRecordError("Prefix Merkle snapshot root digest mismatch");
  }
  if (canonicalJson(rebuiltSnapshot) !== canonicalJson(snapshot)) {
    throw new InvalidReplicationRecordError("Prefix Merkle snapshot leaf metadata mismatch");
  }
  return rebuilt;
}

function diffLeafDescriptors(
  local: readonly ReplicationRecordDescriptor[],
  remote: readonly ReplicationRecordDescriptor[],
  localOnly: ReplicationRecordKey[],
  remoteOnly: ReplicationRecordKey[],
  collisions: ReplicationRecordCollision[],
): void {
  const diff = diffReplicationDescriptors(local, remote);
  localOnly.push(...diff.localOnly);
  remoteOnly.push(...diff.remoteOnly);
  collisions.push(...diff.collisions);
}

export function comparePrefixMerkleIndexes(
  local: PrefixMerkleIndex,
  remote: PrefixMerkleIndex,
): PrefixMerkleDiff {
  if (local.prefixBits !== remote.prefixBits) {
    throw new InvalidReplicationRecordError(
      `Merkle prefixBits mismatch: ${local.prefixBits} != ${remote.prefixBits}`,
    );
  }

  let internalHashComparisons = 1;
  if (local.rootDigest === remote.rootDigest) {
    return {
      rootEqual: true,
      internalHashComparisons,
      mismatchedLeafIds: [],
      localOnly: [],
      remoteOnly: [],
      collisions: [],
      leafDescriptorsExamined: 0,
      estimatedLeafDescriptorBytesExchanged: 0,
    };
  }

  const mismatchedLeafIds: number[] = [];
  const stack: { readonly level: number; readonly index: number }[] = [{
    level: local.prefixBits,
    index: 0,
  }];
  internalHashComparisons = 0;
  while (stack.length > 0) {
    const node = stack.pop()!;
    internalHashComparisons += 1;
    if (local.nodeHash(node.level, node.index) === remote.nodeHash(node.level, node.index)) continue;
    if (node.level === 0) {
      mismatchedLeafIds.push(node.index);
      continue;
    }
    stack.push(
      { level: node.level - 1, index: node.index * 2 + 1 },
      { level: node.level - 1, index: node.index * 2 },
    );
  }

  const localOnly: ReplicationRecordKey[] = [];
  const remoteOnly: ReplicationRecordKey[] = [];
  const collisions: ReplicationRecordCollision[] = [];
  let leafDescriptorsExamined = 0;
  let estimatedLeafDescriptorBytesExchanged = 0;
  for (const leafId of mismatchedLeafIds.toSorted((left, right) => left - right)) {
    const localLeaf = local.leafDescriptors(leafId);
    const remoteLeaf = remote.leafDescriptors(leafId);
    leafDescriptorsExamined += localLeaf.length + remoteLeaf.length;
    estimatedLeafDescriptorBytesExchanged += descriptorJsonBytes(localLeaf) + descriptorJsonBytes(remoteLeaf);
    diffLeafDescriptors(localLeaf, remoteLeaf, localOnly, remoteOnly, collisions);
  }

  return {
    rootEqual: false,
    internalHashComparisons,
    mismatchedLeafIds: mismatchedLeafIds.toSorted((left, right) => left - right),
    localOnly: localOnly.toSorted((left, right) => left.localeCompare(right)),
    remoteOnly: remoteOnly.toSorted((left, right) => left.localeCompare(right)),
    collisions: collisions.toSorted((left, right) => left.key.localeCompare(right.key)),
    leafDescriptorsExamined,
    estimatedLeafDescriptorBytesExchanged,
  };
}

export function prefixMerkleSnapshotJson(index: PrefixMerkleIndex): string {
  return canonicalJson(index.snapshot());
}
