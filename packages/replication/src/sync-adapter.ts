import type { PrefixMerkleBits } from "./merkle-common.js";
import type { GenericPrefixMerkleIndex, MerkleDescriptorCodec } from "./merkle-core.js";
import {
  GenericBoundedReconciliationSession,
  GenericFrozenPrefixMerkleView,
  StaleReconciliationViewError,
  type GenericLeafPageOptions,
  type GenericReconciliationEndpoint,
  type GenericReconciliationLeafPage,
  type GenericReconciliationResult,
  type GenericReconciliationViewInfo,
  type GenericReconciliationViewReader,
  type MerkleNodeHash,
  type MerkleNodeRef,
  type NodeQueryOptions,
  type ReconciliationCounters,
  type ReconciliationSessionOptions,
} from "./sync-generic.js";

export interface ProtocolViewInfoBase {
  readonly viewId: string;
  readonly prefixBits: PrefixMerkleBits;
  readonly rootDigest: string;
  readonly recordCount: number;
}


export function protocolViewInfoBase(info: ProtocolViewInfoBase): ProtocolViewInfoBase {
  return {
    viewId: info.viewId,
    prefixBits: info.prefixBits,
    rootDigest: info.rootDigest,
    recordCount: info.recordCount,
  };
}

export interface ProtocolLeafPageOptions<Cursor extends string> {
  readonly leafId: number;
  readonly cursor?: Cursor;
  readonly maxDescriptors?: number;
  readonly maxBytes?: number;
}

export interface ProtocolLeafPage<D, Cursor extends string> {
  readonly viewId: string;
  readonly rootDigest: string;
  readonly leafId: number;
  readonly descriptors: readonly D[];
  readonly estimatedBytes: number;
  readonly nextCursor?: Cursor;
  readonly completed: boolean;
}

export interface ProtocolMerkleNodeHashResponse {
  readonly viewId: string;
  readonly rootDigest: string;
  readonly nodes: readonly MerkleNodeHash[];
}

export interface ProtocolReconciliationViewReader<
  D,
  Info extends ProtocolViewInfoBase,
  Cursor extends string,
> {
  info(): Info;
  nodeHashes(
    refs: readonly MerkleNodeRef[],
    options?: NodeQueryOptions,
  ): ProtocolMerkleNodeHashResponse;
  leafPage(options: ProtocolLeafPageOptions<Cursor>): Promise<ProtocolLeafPage<D, Cursor>>;
}

export interface ProtocolReconciliationEndpoint<
  D,
  Info extends ProtocolViewInfoBase,
  Cursor extends string,
> {
  viewInfo(viewId: string): Info | Promise<Info>;
  nodeHashes(
    viewId: string,
    refs: readonly MerkleNodeRef[],
    options?: NodeQueryOptions,
  ): ProtocolMerkleNodeHashResponse | Promise<ProtocolMerkleNodeHashResponse>;
  leafPage(
    viewId: string,
    options: ProtocolLeafPageOptions<Cursor>,
  ): Promise<ProtocolLeafPage<D, Cursor>>;
}

export interface ProtocolReconciliationResult<K extends string, C> {
  readonly localOnly: readonly K[];
  readonly remoteOnly: readonly K[];
  readonly collisions: readonly C[];
  readonly counters: ReconciliationCounters;
}

export interface ProtocolFrozenViewRuntime<
  D,
  Info extends ProtocolViewInfoBase,
  Cursor extends string,
> extends ProtocolReconciliationViewReader<D, Info, Cursor> {
  genericReader(): GenericReconciliationViewReader<D>;
}

export interface ProtocolRegistryRuntime<Index, View> {
  open(index: Index): Promise<View>;
  get(viewId: string): View;
  expire(viewId: string): boolean;
}

export interface ProtocolSessionRuntime<
  D,
  K extends string,
  C,
  Info extends ProtocolViewInfoBase,
  Cursor extends string,
> {
  encode(): string;
  readonly complete: boolean;
  counters(): ReconciliationCounters;
  result(): ProtocolReconciliationResult<K, C>;
  step(
    local: ProtocolReconciliationViewReader<D, Info, Cursor>,
    remote: ProtocolReconciliationEndpoint<D, Info, Cursor>,
  ): Promise<void>;
  runToCompletion(
    local: ProtocolReconciliationViewReader<D, Info, Cursor>,
    remote: ProtocolReconciliationEndpoint<D, Info, Cursor>,
  ): Promise<ProtocolReconciliationResult<K, C>>;
}

export interface ReconciliationProtocolRuntime<
  D,
  K extends string,
  C,
  Info extends ProtocolViewInfoBase,
  Cursor extends string,
  Index,
> {
  readonly FrozenView: {
    open(index: Index): Promise<ProtocolFrozenViewRuntime<D, Info, Cursor>>;
  };
  readonly Registry: new () => ProtocolRegistryRuntime<
    Index,
    ProtocolFrozenViewRuntime<D, Info, Cursor>
  >;
  readonly Endpoint: new (
    registry: ProtocolRegistryRuntime<Index, ProtocolFrozenViewRuntime<D, Info, Cursor>>,
  ) => ProtocolReconciliationEndpoint<D, Info, Cursor>;
  readonly Session: {
    start(
      local: ProtocolReconciliationViewReader<D, Info, Cursor>,
      remote: ProtocolReconciliationEndpoint<D, Info, Cursor>,
      remoteViewId: string,
      options?: ReconciliationSessionOptions,
    ): Promise<ProtocolSessionRuntime<D, K, C, Info, Cursor>>;
    restore(encoded: string): Promise<ProtocolSessionRuntime<D, K, C, Info, Cursor>>;
  };
}

export interface ReconciliationProtocolAdapter<
  D,
  K extends string,
  C,
  Info extends ProtocolViewInfoBase,
  Cursor extends string,
  Index,
> {
  readonly codec: MerkleDescriptorCodec<D, K, C>;
  readonly schema: string;
  coreIndex(index: Index): GenericPrefixMerkleIndex<D, K, C>;
  publicInfo(info: GenericReconciliationViewInfo): Info;
  genericInfo(info: Info): GenericReconciliationViewInfo;
  publicCursor(cursor: string): Cursor;
}

function publicPage<D, Cursor extends string>(
  page: GenericReconciliationLeafPage<D>,
  cursor: (value: string) => Cursor,
): ProtocolLeafPage<D, Cursor> {
  return {
    viewId: page.viewId,
    rootDigest: page.rootDigest,
    leafId: page.leafId,
    descriptors: page.descriptors,
    estimatedBytes: page.estimatedBytes,
    ...(page.nextCursor === undefined ? {} : { nextCursor: cursor(page.nextCursor) }),
    completed: page.completed,
  };
}

interface PageOptionShape<Cursor extends string> {
  readonly leafId: number;
  readonly cursor?: Cursor;
  readonly maxDescriptors?: number;
  readonly maxBytes?: number;
}

function mapPageOptions<InputCursor extends string, OutputCursor extends string>(
  options: PageOptionShape<InputCursor>,
  cursor: (value: InputCursor) => OutputCursor,
): PageOptionShape<OutputCursor> {
  return {
    leafId: options.leafId,
    ...(options.cursor === undefined ? {} : { cursor: cursor(options.cursor) }),
    ...(options.maxDescriptors === undefined ? {} : { maxDescriptors: options.maxDescriptors }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  };
}

function genericPageOptions<Cursor extends string>(
  options: ProtocolLeafPageOptions<Cursor>,
): GenericLeafPageOptions {
  return mapPageOptions(options, (cursor) => cursor);
}

function publicPageOptions<Cursor extends string>(
  options: GenericLeafPageOptions,
  cursor: (value: string) => Cursor,
): ProtocolLeafPageOptions<Cursor> {
  return mapPageOptions(options, cursor);
}

export function createReconciliationProtocolRuntime<
  D,
  K extends string,
  C,
  Info extends ProtocolViewInfoBase,
  Cursor extends string,
  Index,
>(
  adapter: ReconciliationProtocolAdapter<D, K, C, Info, Cursor, Index>,
): ReconciliationProtocolRuntime<D, K, C, Info, Cursor, Index> {
  type Reader = ProtocolReconciliationViewReader<D, Info, Cursor>;
  type Endpoint = ProtocolReconciliationEndpoint<D, Info, Cursor>;
  type Result = ProtocolReconciliationResult<K, C>;
  type CoreView = GenericFrozenPrefixMerkleView<D, K, C>;
  type CoreSession = GenericBoundedReconciliationSession<D, K, C>;

  class FrozenView implements Reader {
    readonly #core: CoreView;
    private constructor(core: CoreView) {
      this.#core = core;
    }
    static async open(index: Index): Promise<FrozenView> {
      return new FrozenView(await GenericFrozenPrefixMerkleView.open({
        index: adapter.coreIndex(index),
        codec: adapter.codec,
        schema: adapter.schema,
      }));
    }
    info(): Info {
      return adapter.publicInfo(this.#core.info());
    }
    nodeHashes(
      refs: readonly MerkleNodeRef[],
      options: NodeQueryOptions = {},
    ): ProtocolMerkleNodeHashResponse {
      return this.#core.nodeHashes(refs, options);
    }
    async leafPage(options: ProtocolLeafPageOptions<Cursor>): Promise<ProtocolLeafPage<D, Cursor>> {
      return publicPage(
        await this.#core.leafPage(genericPageOptions(options)),
        adapter.publicCursor,
      );
    }
    genericReader(): GenericReconciliationViewReader<D> {
      return this.#core;
    }
  }

  class Registry {
    readonly #views = new Map<string, FrozenView>();
    async open(index: Index): Promise<FrozenView> {
      const view = await FrozenView.open(index);
      this.#views.set(view.info().viewId, view);
      return view;
    }
    get(viewId: string): FrozenView {
      const view = this.#views.get(viewId);
      if (view === undefined) throw new StaleReconciliationViewError(viewId);
      return view;
    }
    expire(viewId: string): boolean {
      return this.#views.delete(viewId);
    }
  }

  class EndpointImpl implements Endpoint {
    constructor(readonly registry: Registry) {}
    viewInfo(viewId: string): Info {
      return this.registry.get(viewId).info();
    }
    nodeHashes(
      viewId: string,
      refs: readonly MerkleNodeRef[],
      options: NodeQueryOptions = {},
    ): ProtocolMerkleNodeHashResponse {
      return this.registry.get(viewId).nodeHashes(refs, options);
    }
    leafPage(
      viewId: string,
      options: ProtocolLeafPageOptions<Cursor>,
    ): Promise<ProtocolLeafPage<D, Cursor>> {
      return this.registry.get(viewId).leafPage(options);
    }
  }

  function genericReader(reader: Reader): GenericReconciliationViewReader<D> {
    if (reader instanceof FrozenView) return reader.genericReader();
    return {
      info: () => adapter.genericInfo(reader.info()),
      nodeHashes: (refs, options) => reader.nodeHashes(refs, options),
      async leafPage(options) {
        return reader.leafPage(publicPageOptions(options, adapter.publicCursor));
      },
    };
  }

  function genericEndpoint(endpoint: Endpoint): GenericReconciliationEndpoint<D> {
    return {
      async viewInfo(viewId) {
        return adapter.genericInfo(await endpoint.viewInfo(viewId));
      },
      nodeHashes(viewId, refs, options) {
        return endpoint.nodeHashes(viewId, refs, options);
      },
      async leafPage(viewId, options) {
        return endpoint.leafPage(viewId, publicPageOptions(options, adapter.publicCursor));
      },
    };
  }

  class Session {
    readonly #core: CoreSession;
    private constructor(core: CoreSession) {
      this.#core = core;
    }
    static async start(
      local: Reader,
      remote: Endpoint,
      remoteViewId: string,
      options: ReconciliationSessionOptions = {},
    ): Promise<Session> {
      return new Session(await GenericBoundedReconciliationSession.start({
        codec: adapter.codec,
        schema: adapter.schema,
        local: genericReader(local),
        remote: genericEndpoint(remote),
        remoteViewId,
        options,
      }));
    }
    static async restore(encoded: string): Promise<Session> {
      return new Session(await GenericBoundedReconciliationSession.restore({
        codec: adapter.codec,
        schema: adapter.schema,
        encoded,
      }));
    }
    encode(): string {
      return this.#core.encode();
    }
    get complete(): boolean {
      return this.#core.complete;
    }
    counters(): ReconciliationCounters {
      return this.#core.counters();
    }
    result(): Result {
      return this.#core.result();
    }
    step(local: Reader, remote: Endpoint): Promise<void> {
      return this.#core.step(genericReader(local), genericEndpoint(remote));
    }
    runToCompletion(local: Reader, remote: Endpoint): Promise<Result> {
      return this.#core.runToCompletion(genericReader(local), genericEndpoint(remote));
    }
  }

  return {
    FrozenView,
    Registry,
    Endpoint: EndpointImpl,
    Session,
  } as unknown as ReconciliationProtocolRuntime<D, K, C, Info, Cursor, Index>;
}
