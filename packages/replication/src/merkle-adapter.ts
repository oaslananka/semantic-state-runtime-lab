import { canonicalJson } from "@ssrl/core";
import {
  GenericPrefixMerkleIndex,
  restoreGenericPrefixMerkleIndex,
  type CoreMerkleBuildOptions,
  type CoreMerkleDiff,
  type CoreMerkleSnapshot,
  type MerkleDescriptorCodec,
} from "./merkle-core.js";
import type { PrefixMerkleBits } from "./merkle-common.js";

export interface MerkleLeafSnapshotBase<D> {
  readonly leafId: number;
  readonly hash: string;
  readonly recordCount: number;
  readonly descriptors: readonly D[];
}

export interface MerkleSnapshotBase<D> {
  readonly prefixBits: PrefixMerkleBits;
  readonly recordCount: number;
  readonly rootDigest: string;
  readonly nonEmptyLeaves: readonly MerkleLeafSnapshotBase<D>[];
}


export function merkleSnapshotBase<D>(
  snapshot: MerkleSnapshotBase<D>,
): MerkleSnapshotBase<D> {
  return {
    prefixBits: snapshot.prefixBits,
    recordCount: snapshot.recordCount,
    rootDigest: snapshot.rootDigest,
    nonEmptyLeaves: snapshot.nonEmptyLeaves,
  };
}

export function merkleCoreSnapshot<D>(
  scopeId: string,
  snapshot: MerkleSnapshotBase<D>,
): CoreMerkleSnapshot<D> {
  return { scopeId, ...merkleSnapshotBase(snapshot) };
}

export interface MerkleProtocolAdapter<
  D,
  K extends string,
  C,
  Snapshot extends MerkleSnapshotBase<D>,
  BuildOptions,
> {
  readonly codec: MerkleDescriptorCodec<D, K, C>;
  buildOptions(options: BuildOptions): CoreMerkleBuildOptions;
  publicSnapshot(snapshot: CoreMerkleSnapshot<D>): Snapshot;
  coreSnapshot(snapshot: Snapshot): CoreMerkleSnapshot<D>;
  validateSnapshot(snapshot: Snapshot): void;
}

export interface MerkleIndexRuntime<D, K extends string, C, Snapshot> {
  readonly prefixBits: PrefixMerkleBits;
  readonly recordCount: number;
  readonly leafCount: number;
  readonly rootDigest: string;
  nodeHash(level: number, index: number): string;
  leafDescriptors(leafId: number): readonly D[];
  snapshot(): Snapshot;
  add(descriptor: D): Promise<"inserted" | "unchanged">;
  coreForSync(): GenericPrefixMerkleIndex<D, K, C>;
  compare(remote: MerkleIndexRuntime<D, K, C, Snapshot>): CoreMerkleDiff<K, C>;
}

export interface MerkleProtocolRuntime<
  D,
  K extends string,
  C,
  Snapshot,
  BuildOptions,
> {
  readonly Index: {
    build(descriptors: readonly D[], options: BuildOptions): Promise<MerkleIndexRuntime<D, K, C, Snapshot>>;
    fromCore(core: GenericPrefixMerkleIndex<D, K, C>): MerkleIndexRuntime<D, K, C, Snapshot>;
  };
  build(
    descriptors: readonly D[],
    options: BuildOptions,
  ): Promise<MerkleIndexRuntime<D, K, C, Snapshot>>;
  restore(snapshot: Snapshot): Promise<MerkleIndexRuntime<D, K, C, Snapshot>>;
  compare(
    local: MerkleIndexRuntime<D, K, C, Snapshot>,
    remote: MerkleIndexRuntime<D, K, C, Snapshot>,
  ): CoreMerkleDiff<K, C>;
  snapshotJson(index: MerkleIndexRuntime<D, K, C, Snapshot>): string;
}

export function validateMerkleSnapshotBase<D>(
  snapshot: MerkleSnapshotBase<D>,
  invalid: (message: string) => Error,
): void {
  if (!Number.isSafeInteger(snapshot.recordCount) || snapshot.recordCount < 0) {
    throw invalid("Prefix Merkle snapshot recordCount is invalid");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(snapshot.rootDigest)) {
    throw invalid("Prefix Merkle snapshot rootDigest is invalid");
  }
}

export function createMerkleProtocolRuntime<
  D,
  K extends string,
  C,
  Snapshot extends MerkleSnapshotBase<D>,
  BuildOptions,
>(
  adapter: MerkleProtocolAdapter<D, K, C, Snapshot, BuildOptions>,
): MerkleProtocolRuntime<D, K, C, Snapshot, BuildOptions> {
  type Core = GenericPrefixMerkleIndex<D, K, C>;

  class Index implements MerkleIndexRuntime<D, K, C, Snapshot> {
    readonly #core: Core;
    private constructor(core: Core) {
      this.#core = core;
    }
    static async build(descriptors: readonly D[], options: BuildOptions): Promise<Index> {
      return new Index(await GenericPrefixMerkleIndex.build(
        adapter.codec,
        descriptors,
        adapter.buildOptions(options),
      ));
    }
    static fromCore(core: Core): Index {
      return new Index(core);
    }
    get prefixBits(): PrefixMerkleBits {
      return this.#core.prefixBits;
    }
    get recordCount(): number {
      return this.#core.recordCount;
    }
    get leafCount(): number {
      return this.#core.leafCount;
    }
    get rootDigest(): string {
      return this.#core.rootDigest;
    }
    nodeHash(level: number, index: number): string {
      return this.#core.nodeHash(level, index);
    }
    leafDescriptors(leafId: number): readonly D[] {
      return this.#core.leafDescriptors(leafId);
    }
    snapshot(): Snapshot {
      return adapter.publicSnapshot(this.#core.snapshot());
    }
    add(descriptor: D): Promise<"inserted" | "unchanged"> {
      return this.#core.add(descriptor);
    }
    coreForSync(): Core {
      return this.#core;
    }
    compare(remote: MerkleIndexRuntime<D, K, C, Snapshot>): CoreMerkleDiff<K, C> {
      return this.#core.compare(remote.coreForSync());
    }
  }

  async function restore(snapshot: Snapshot): Promise<Index> {
    adapter.validateSnapshot(snapshot);
    const restored = await restoreGenericPrefixMerkleIndex(
      adapter.codec,
      adapter.coreSnapshot(snapshot),
    );
    const index = Index.fromCore(restored);
    if (canonicalJson(index.snapshot()) !== canonicalJson(snapshot)) {
      throw adapter.codec.invalid("Prefix Merkle snapshot leaf metadata mismatch");
    }
    return index;
  }

  return {
    Index,
    build: (descriptors: readonly D[], options: BuildOptions) => Index.build(descriptors, options),
    restore,
    compare: (
      local: MerkleIndexRuntime<D, K, C, Snapshot>,
      remote: MerkleIndexRuntime<D, K, C, Snapshot>,
    ) => local.compare(remote),
    snapshotJson: (index: MerkleIndexRuntime<D, K, C, Snapshot>) => (
      canonicalJson(index.snapshot())
    ),
  } as unknown as MerkleProtocolRuntime<D, K, C, Snapshot, BuildOptions>;
}
