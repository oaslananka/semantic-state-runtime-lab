import { canonicalJson } from "@ssrl/core";
import type { PrefixMerkleBits } from "./merkle-common.js";

export interface DescriptorComparison<C> {
  readonly collision?: C;
}

export interface MerkleDescriptorCodec<D, K extends string, C> {
  readonly defaultScope?: string;
  normalize(descriptor: D): Promise<D>;
  key(descriptor: D): K;
  compareKeys?(left: K, right: K): number;
  scope(descriptor: D): string;
  canonicalValue(descriptor: D): unknown;
  compareSameKey(left: D, right: D): DescriptorComparison<C>;
  collisionError(collision: C): Error;
  invalid(message: string): Error;
  scopeMismatch(left: string, right: string): Error;
  collisionKey(collision: C): K;
}

export interface CoreMerkleBuildOptions {
  readonly prefixBits: PrefixMerkleBits;
  readonly scopeId?: string;
}

export interface CoreMerkleLeafSnapshot<D> {
  readonly leafId: number;
  readonly hash: string;
  readonly recordCount: number;
  readonly descriptors: readonly D[];
}

export interface CoreMerkleSnapshot<D> {
  readonly scopeId: string;
  readonly prefixBits: PrefixMerkleBits;
  readonly recordCount: number;
  readonly rootDigest: string;
  readonly nonEmptyLeaves: readonly CoreMerkleLeafSnapshot<D>[];
}

export interface CoreMerkleDiff<K extends string, C> {
  readonly rootEqual: boolean;
  readonly internalHashComparisons: number;
  readonly mismatchedLeafIds: readonly number[];
  readonly localOnly: readonly K[];
  readonly remoteOnly: readonly K[];
  readonly collisions: readonly C[];
  readonly leafDescriptorsExamined: number;
  readonly estimatedLeafDescriptorBytesExchanged: number;
}

const encoder = new TextEncoder();

function utf8Bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

async function sha256Bytes(value: Uint8Array): Promise<Uint8Array> {
  const copy = Uint8Array.from(value);
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy.buffer));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Digest(value: string): Promise<string> {
  return `sha256:${hex(await sha256Bytes(utf8Bytes(value)))}`;
}

export async function genericPrefixMerkleLeafIdForKey(
  key: string,
  bits: PrefixMerkleBits,
): Promise<number> {
  const digest = await sha256Bytes(utf8Bytes(key));
  const first16 = ((digest[0] ?? 0) << 8) | (digest[1] ?? 0);
  return first16 >>> (16 - bits);
}

export async function genericPrefixMerkleParentHash(
  level: number,
  left: string,
  right: string,
): Promise<string> {
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

function descriptorOrder<D, K extends string, C>(codec: MerkleDescriptorCodec<D, K, C>) {
  return (left: D, right: D): number => {
    const leftKey = codec.key(left);
    const rightKey = codec.key(right);
    return codec.compareKeys?.(leftKey, rightKey) ?? leftKey.localeCompare(rightKey);
  };
}

function descriptorJsonBytes<D, K extends string, C>(
  codec: MerkleDescriptorCodec<D, K, C>,
  descriptors: readonly D[],
): number {
  return utf8Bytes(canonicalJson(descriptors.map((descriptor) => codec.canonicalValue(descriptor))))
    .byteLength;
}

export async function genericPrefixMerkleLeafHash<D, K extends string, C>(
  codec: MerkleDescriptorCodec<D, K, C>,
  descriptors: readonly D[],
): Promise<string> {
  const ordered = [...descriptors].toSorted(descriptorOrder(codec));
  return sha256Digest(canonicalJson([
    "ssrl-prefix-merkle-leaf-v1",
    ordered.map((descriptor) => codec.canonicalValue(descriptor)),
  ]));
}

export async function genericPrefixMerkleEmptyHashes<D, K extends string, C>(
  codec: MerkleDescriptorCodec<D, K, C>,
  prefixBits: PrefixMerkleBits,
): Promise<readonly string[]> {
  const hashes: string[] = [await genericPrefixMerkleLeafHash(codec, [])];
  for (let level = 1; level <= prefixBits; level += 1) {
    const child = hashes[level - 1]!;
    hashes.push(await genericPrefixMerkleParentHash(level, child, child));
  }
  return hashes;
}

async function buildLevels(
  leafHashes: readonly string[],
  prefixBits: PrefixMerkleBits,
): Promise<string[][]> {
  const levels: string[][] = [[...leafHashes]];
  for (let level = 1; level <= prefixBits; level += 1) {
    const previous = levels[level - 1]!;
    const parents = await Promise.all(Array.from(
      { length: previous.length / 2 },
      (_, index) => genericPrefixMerkleParentHash(level, previous[index * 2]!, previous[index * 2 + 1]!),
    ));
    levels.push(parents);
  }
  return levels;
}

export async function normalizeMerkleDescriptors<D, K extends string, C>(
  codec: MerkleDescriptorCodec<D, K, C>,
  descriptors: readonly D[],
  requestedScope?: string,
): Promise<{ readonly descriptors: D[]; readonly scopeId: string }> {
  const normalized = (await mapInBatches(
    descriptors,
    (descriptor) => codec.normalize(descriptor),
  )).toSorted(descriptorOrder(codec));
  let scopeId = requestedScope ?? codec.defaultScope;
  const unique: D[] = [];
  const seen = new Map<K, D>();
  for (const descriptor of normalized) {
    const descriptorScope = codec.scope(descriptor);
    if (scopeId === undefined) scopeId = descriptorScope;
    else if (scopeId !== descriptorScope) throw codec.scopeMismatch(scopeId, descriptorScope);
    const key = codec.key(descriptor);
    const existing = seen.get(key);
    if (existing !== undefined) {
      const comparison = codec.compareSameKey(existing, descriptor);
      if (comparison.collision !== undefined) throw codec.collisionError(comparison.collision);
      continue;
    }
    seen.set(key, descriptor);
    unique.push(descriptor);
  }
  if (scopeId === undefined || scopeId.length === 0) {
    throw codec.invalid("A reconciliation scope is required for an empty descriptor set");
  }
  return { descriptors: unique, scopeId };
}

export class GenericPrefixMerkleIndex<D, K extends string, C> {
  readonly prefixBits: PrefixMerkleBits;
  readonly scopeId: string;
  readonly #codec: MerkleDescriptorCodec<D, K, C>;
  readonly #leaves: Map<number, Map<K, D>>;
  readonly #levels: string[][];
  #recordCount: number;

  private constructor(input: {
    readonly codec: MerkleDescriptorCodec<D, K, C>;
    readonly prefixBits: PrefixMerkleBits;
    readonly scopeId: string;
    readonly leaves: Map<number, Map<K, D>>;
    readonly levels: string[][];
    readonly recordCount: number;
  }) {
    this.#codec = input.codec;
    this.prefixBits = input.prefixBits;
    this.scopeId = input.scopeId;
    this.#leaves = input.leaves;
    this.#levels = input.levels;
    this.#recordCount = input.recordCount;
  }

  static async build<D, K extends string, C>(
    codec: MerkleDescriptorCodec<D, K, C>,
    descriptors: readonly D[],
    options: CoreMerkleBuildOptions,
  ): Promise<GenericPrefixMerkleIndex<D, K, C>> {
    const normalized = await normalizeMerkleDescriptors(codec, descriptors, options.scopeId);
    const leaves = new Map<number, Map<K, D>>();
    const leafIds = await mapInBatches(
      normalized.descriptors,
      (descriptor) => genericPrefixMerkleLeafIdForKey(codec.key(descriptor), options.prefixBits),
    );
    normalized.descriptors.forEach((descriptor, index) => {
      const leafId = leafIds[index]!;
      const records = leaves.get(leafId) ?? new Map<K, D>();
      records.set(codec.key(descriptor), descriptor);
      leaves.set(leafId, records);
    });

    const emptyHash = await genericPrefixMerkleLeafHash(codec, []);
    const hashes = new Array<string>(2 ** options.prefixBits).fill(emptyHash);
    await Promise.all([...leaves.entries()].map(async ([leafId, records]) => {
      hashes[leafId] = await genericPrefixMerkleLeafHash(codec, [...records.values()].toSorted(descriptorOrder(codec)));
    }));
    return new GenericPrefixMerkleIndex({
      codec,
      prefixBits: options.prefixBits,
      scopeId: normalized.scopeId,
      leaves,
      levels: await buildLevels(hashes, options.prefixBits),
      recordCount: normalized.descriptors.length,
    });
  }

  get recordCount(): number {
    return this.#recordCount;
  }

  get leafCount(): number {
    return 2 ** this.prefixBits;
  }

  get rootDigest(): string {
    return this.#levels[this.prefixBits]?.[0] ?? "";
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

  leafDescriptors(leafId: number): readonly D[] {
    if (!Number.isInteger(leafId) || leafId < 0 || leafId >= this.leafCount) {
      throw new RangeError(`Merkle leaf ${leafId} is outside the tree`);
    }
    return [...(this.#leaves.get(leafId)?.values() ?? [])]
      .toSorted(descriptorOrder(this.#codec));
  }

  snapshot(): CoreMerkleSnapshot<D> {
    return {
      scopeId: this.scopeId,
      prefixBits: this.prefixBits,
      recordCount: this.recordCount,
      rootDigest: this.rootDigest,
      nonEmptyLeaves: [...this.#leaves.entries()]
        .filter(([, records]) => records.size > 0)
        .toSorted(([left], [right]) => left - right)
        .map(([leafId, records]) => ({
          leafId,
          hash: this.nodeHash(0, leafId),
          recordCount: records.size,
          descriptors: [...records.values()].toSorted(descriptorOrder(this.#codec)),
        })),
    };
  }

  async add(descriptor: D): Promise<"inserted" | "unchanged"> {
    const normalized = await this.#codec.normalize(descriptor);
    const descriptorScope = this.#codec.scope(normalized);
    if (descriptorScope !== this.scopeId) throw this.#codec.scopeMismatch(this.scopeId, descriptorScope);
    const key = this.#codec.key(normalized);
    const leafId = await genericPrefixMerkleLeafIdForKey(key, this.prefixBits);
    const records = this.#leaves.get(leafId) ?? new Map<K, D>();
    const existing = records.get(key);
    if (existing !== undefined) {
      const comparison = this.#codec.compareSameKey(existing, normalized);
      if (comparison.collision !== undefined) throw this.#codec.collisionError(comparison.collision);
      return "unchanged";
    }

    const nextRecords = new Map(records);
    nextRecords.set(key, normalized);
    const updates = new Map<number, { readonly index: number; readonly hash: string }>();
    let childIndex = leafId;
    let childHash = await genericPrefixMerkleLeafHash(
      this.#codec,
      [...nextRecords.values()].toSorted(descriptorOrder(this.#codec)),
    );
    updates.set(0, { index: childIndex, hash: childHash });
    for (let level = 1; level <= this.prefixBits; level += 1) {
      const parentIndex = Math.floor(childIndex / 2);
      const children = this.#levels[level - 1]!;
      const leftIndex = parentIndex * 2;
      const rightIndex = leftIndex + 1;
      const leftHash = childIndex === leftIndex ? childHash : children[leftIndex]!;
      const rightHash = childIndex === rightIndex ? childHash : children[rightIndex]!;
      childHash = await genericPrefixMerkleParentHash(level, leftHash, rightHash);
      updates.set(level, { index: parentIndex, hash: childHash });
      childIndex = parentIndex;
    }

    this.#leaves.set(leafId, nextRecords);
    this.#recordCount += 1;
    for (const [level, update] of updates) this.#levels[level]![update.index] = update.hash;
    return "inserted";
  }

  descriptorBytes(descriptors: readonly D[]): number {
    return descriptorJsonBytes(this.#codec, descriptors);
  }

  #assertComparable(remote: GenericPrefixMerkleIndex<D, K, C>): void {
    if (this.scopeId !== remote.scopeId) {
      throw this.#codec.scopeMismatch(this.scopeId, remote.scopeId);
    }
    if (this.prefixBits !== remote.prefixBits) {
      throw this.#codec.invalid(
        `Merkle prefixBits mismatch: ${this.prefixBits} != ${remote.prefixBits}`,
      );
    }
  }

  #mismatchedLeaves(remote: GenericPrefixMerkleIndex<D, K, C>): {
    readonly leafIds: readonly number[];
    readonly internalHashComparisons: number;
  } {
    const leafIds: number[] = [];
    const stack: { readonly level: number; readonly index: number }[] = [{
      level: this.prefixBits,
      index: 0,
    }];
    let internalHashComparisons = 0;
    while (stack.length > 0) {
      const node = stack.pop()!;
      internalHashComparisons += 1;
      if (this.nodeHash(node.level, node.index) === remote.nodeHash(node.level, node.index)) continue;
      if (node.level === 0) {
        leafIds.push(node.index);
        continue;
      }
      stack.push(
        { level: node.level - 1, index: node.index * 2 + 1 },
        { level: node.level - 1, index: node.index * 2 },
      );
    }
    return {
      leafIds: leafIds.toSorted((left, right) => left - right),
      internalHashComparisons,
    };
  }

  #compareLeaves(
    remote: GenericPrefixMerkleIndex<D, K, C>,
    leafIds: readonly number[],
  ): {
    readonly localOnly: readonly K[];
    readonly remoteOnly: readonly K[];
    readonly collisions: readonly C[];
    readonly leafDescriptorsExamined: number;
    readonly estimatedLeafDescriptorBytesExchanged: number;
  } {
    const localOnly: K[] = [];
    const remoteOnly: K[] = [];
    const collisions: C[] = [];
    let leafDescriptorsExamined = 0;
    let estimatedLeafDescriptorBytesExchanged = 0;

    for (const leafId of leafIds) {
      const localLeaf = this.leafDescriptors(leafId);
      const remoteLeaf = remote.leafDescriptors(leafId);
      leafDescriptorsExamined += localLeaf.length + remoteLeaf.length;
      estimatedLeafDescriptorBytesExchanged += this.descriptorBytes(localLeaf)
        + remote.descriptorBytes(remoteLeaf);
      const localMap = new Map(localLeaf.map((descriptor) => [this.#codec.key(descriptor), descriptor]));
      const remoteMap = new Map(remoteLeaf.map((descriptor) => [this.#codec.key(descriptor), descriptor]));
      const keys = [...new Set([...localMap.keys(), ...remoteMap.keys()])]
        .toSorted((left, right) => left.localeCompare(right));
      for (const key of keys) {
        const left = localMap.get(key);
        const right = remoteMap.get(key);
        if (left === undefined) remoteOnly.push(key);
        else if (right === undefined) localOnly.push(key);
        else {
          const comparison = this.#codec.compareSameKey(left, right);
          if (comparison.collision !== undefined) collisions.push(comparison.collision);
        }
      }
    }

    return {
      localOnly: [...new Set(localOnly)].toSorted((left, right) => left.localeCompare(right)),
      remoteOnly: [...new Set(remoteOnly)].toSorted((left, right) => left.localeCompare(right)),
      collisions: [...new Map(
        collisions.map((collision) => [this.#codec.collisionKey(collision), collision]),
      ).values()].toSorted((left, right) => (
        this.#codec.collisionKey(left).localeCompare(this.#codec.collisionKey(right))
      )),
      leafDescriptorsExamined,
      estimatedLeafDescriptorBytesExchanged,
    };
  }

  compare(remote: GenericPrefixMerkleIndex<D, K, C>): CoreMerkleDiff<K, C> {
    this.#assertComparable(remote);
    if (this.rootDigest === remote.rootDigest) {
      return {
        rootEqual: true,
        internalHashComparisons: 1,
        mismatchedLeafIds: [],
        localOnly: [],
        remoteOnly: [],
        collisions: [],
        leafDescriptorsExamined: 0,
        estimatedLeafDescriptorBytesExchanged: 0,
      };
    }

    const mismatch = this.#mismatchedLeaves(remote);
    const leaves = this.#compareLeaves(remote, mismatch.leafIds);
    return {
      rootEqual: false,
      internalHashComparisons: mismatch.internalHashComparisons,
      mismatchedLeafIds: mismatch.leafIds,
      ...leaves,
    };
  }
}

export async function restoreGenericPrefixMerkleIndex<D, K extends string, C>(
  codec: MerkleDescriptorCodec<D, K, C>,
  snapshot: CoreMerkleSnapshot<D>,
): Promise<GenericPrefixMerkleIndex<D, K, C>> {
  const descriptors: D[] = [];
  let previousLeafId = -1;
  for (const leaf of snapshot.nonEmptyLeaves) {
    if (!Number.isInteger(leaf.leafId) || leaf.leafId < 0 || leaf.leafId >= 2 ** snapshot.prefixBits) {
      throw codec.invalid(`Invalid prefix Merkle leaf id ${leaf.leafId}`);
    }
    if (leaf.leafId <= previousLeafId) {
      throw codec.invalid("Prefix Merkle snapshot leaves must be strictly ordered");
    }
    previousLeafId = leaf.leafId;
    if (leaf.recordCount !== leaf.descriptors.length) {
      throw codec.invalid(`Prefix Merkle leaf ${leaf.leafId} recordCount mismatch`);
    }
    descriptors.push(...leaf.descriptors);
  }
  if (descriptors.length !== snapshot.recordCount) {
    throw codec.invalid("Prefix Merkle snapshot total recordCount mismatch");
  }
  const rebuilt = await GenericPrefixMerkleIndex.build(codec, descriptors, {
    prefixBits: snapshot.prefixBits,
    scopeId: snapshot.scopeId,
  });
  const rebuiltSnapshot = rebuilt.snapshot();
  if (rebuiltSnapshot.rootDigest !== snapshot.rootDigest) {
    throw codec.invalid("Prefix Merkle snapshot root digest mismatch");
  }
  if (canonicalJson(rebuiltSnapshot) !== canonicalJson(snapshot)) {
    throw codec.invalid("Prefix Merkle snapshot leaf metadata mismatch");
  }
  return rebuilt;
}
