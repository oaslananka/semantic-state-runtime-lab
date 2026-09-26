import { canonicalJson } from "@ssrl/core";
import type { PrefixMerkleBits } from "./merkle-common.js";
import {
  GenericPrefixMerkleIndex,
  normalizeMerkleDescriptors,
  restoreGenericPrefixMerkleIndex,
  type MerkleDescriptorCodec,
} from "./merkle-core.js";

export const DEFAULT_MAX_NODE_REFS = 128;
export const MAX_NODE_REFS = 512;
export const DEFAULT_MAX_LEAF_DESCRIPTORS = 128;
export const MAX_LEAF_DESCRIPTORS = 1_024;
export const DEFAULT_MAX_LEAF_BYTES = 64 * 1024;
export const MAX_LEAF_BYTES = 256 * 1024;
export const DEFAULT_MAX_PENDING_NODES = 4_096;
export const MAX_PENDING_NODES = 131_072;
export const DEFAULT_MAX_PENDING_LEAVES = 1_024;
export const MAX_PENDING_LEAVES = 65_536;
export const MAX_RECONCILIATION_STATE_BYTES = 8 * 1024 * 1024;

export interface MerkleNodeRef {
  readonly level: number;
  readonly index: number;
}

export interface MerkleNodeHash extends MerkleNodeRef {
  readonly hash: string;
}

export interface GenericMerkleNodeHashResponse {
  readonly viewId: string;
  readonly rootDigest: string;
  readonly nodes: readonly MerkleNodeHash[];
}

export interface GenericReconciliationViewInfo {
  readonly schema: string;
  readonly scopeId: string;
  readonly viewId: string;
  readonly prefixBits: PrefixMerkleBits;
  readonly rootDigest: string;
  readonly recordCount: number;
}

export interface NodeQueryOptions {
  readonly maxNodeRefs?: number;
}

export interface GenericLeafPageOptions {
  readonly leafId: number;
  readonly cursor?: string;
  readonly maxDescriptors?: number;
  readonly maxBytes?: number;
}

export interface GenericReconciliationLeafPage<D> {
  readonly viewId: string;
  readonly rootDigest: string;
  readonly leafId: number;
  readonly descriptors: readonly D[];
  readonly estimatedBytes: number;
  readonly nextCursor?: string;
  readonly completed: boolean;
}

export class StaleReconciliationViewError extends Error {
  constructor(readonly viewId: string) {
    super(`Reconciliation view ${viewId} is unavailable or expired`);
    this.name = "StaleReconciliationViewError";
  }
}

export class InvalidReconciliationCursorError extends Error {
  constructor(message = "Invalid reconciliation leaf cursor") {
    super(message);
    this.name = "InvalidReconciliationCursorError";
  }
}

export class ReconciliationLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconciliationLimitError";
  }
}

export class ReconciliationBudgetExceededError extends Error {
  constructor(readonly maxSteps: number) {
    super(`Reconciliation exceeded maxSteps=${maxSteps}`);
    this.name = "ReconciliationBudgetExceededError";
  }
}

export class InvalidReconciliationResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReconciliationResponseError";
  }
}

export interface ReconciliationSessionOptions {
  readonly maxNodeRefsPerStep?: number;
  readonly maxLeafDescriptors?: number;
  readonly maxLeafBytes?: number;
  readonly maxPendingNodes?: number;
  readonly maxPendingLeaves?: number;
  readonly maxSteps?: number;
}

interface ResolvedReconciliationSessionOptions {
  readonly maxNodeRefsPerStep: number;
  readonly maxLeafDescriptors: number;
  readonly maxLeafBytes: number;
  readonly maxPendingNodes: number;
  readonly maxPendingLeaves: number;
  readonly maxSteps: number;
}

export interface ReconciliationCounters {
  readonly steps: number;
  readonly remoteNodeQueries: number;
  readonly remoteNodeHashes: number;
  readonly remoteLeafPages: number;
  readonly remoteLeafDescriptors: number;
  readonly remoteLeafBytes: number;
}

interface MutableReconciliationCounters {
  steps: number;
  remoteNodeQueries: number;
  remoteNodeHashes: number;
  remoteLeafPages: number;
  remoteLeafDescriptors: number;
  remoteLeafBytes: number;
}

export interface GenericReconciliationResult<K extends string, C> {
  readonly localOnly: readonly K[];
  readonly remoteOnly: readonly K[];
  readonly collisions: readonly C[];
  readonly counters: ReconciliationCounters;
}

export interface GenericReconciliationViewReader<D> {
  info(): GenericReconciliationViewInfo;
  nodeHashes(
    refs: readonly MerkleNodeRef[],
    options?: NodeQueryOptions,
  ): GenericMerkleNodeHashResponse;
  leafPage(options: GenericLeafPageOptions): Promise<GenericReconciliationLeafPage<D>>;
}

export interface GenericReconciliationEndpoint<D> {
  viewInfo(viewId: string): GenericReconciliationViewInfo | Promise<GenericReconciliationViewInfo>;
  nodeHashes(
    viewId: string,
    refs: readonly MerkleNodeRef[],
    options?: NodeQueryOptions,
  ): GenericMerkleNodeHashResponse | Promise<GenericMerkleNodeHashResponse>;
  leafPage(
    viewId: string,
    options: GenericLeafPageOptions,
  ): Promise<GenericReconciliationLeafPage<D>>;
}

const encoder = new TextEncoder();

function utf8Bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function bytesFromHex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/.test(value)) throw new InvalidReconciliationCursorError();
  return Uint8Array.from(
    Array.from({ length: value.length / 2 }, (_, index) => (
      Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
    )),
  );
}

function textFromHex(value: string): string {
  try {
    return new TextDecoder().decode(bytesFromHex(value));
  } catch (cause) {
    if (cause instanceof InvalidReconciliationCursorError) throw cause;
    throw new InvalidReconciliationCursorError();
  }
}

async function hmac(secret: CryptoKey, value: string): Promise<string> {
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    secret,
    ownedArrayBuffer(utf8Bytes(value)),
  );
  return hex(new Uint8Array(signature));
}

async function randomSecret(): Promise<CryptoKey> {
  return globalThis.crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

function randomViewId(): string {
  return `view-${hex(globalThis.crypto.getRandomValues(new Uint8Array(16)))}`;
}

function validateLimit(value: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new ReconciliationLimitError(`${label} must be an integer between 1 and ${max}`);
  }
  return value;
}

function validateNodeRef(ref: MerkleNodeRef, prefixBits: PrefixMerkleBits): void {
  if (!Number.isSafeInteger(ref.level) || ref.level < 0 || ref.level > prefixBits) {
    throw new InvalidReconciliationResponseError(
      `Merkle level must be between 0 and ${prefixBits}; received ${String(ref.level)}`,
    );
  }
  const nodeCount = 2 ** (prefixBits - ref.level);
  if (!Number.isSafeInteger(ref.index) || ref.index < 0 || ref.index >= nodeCount) {
    throw new InvalidReconciliationResponseError(
      `Merkle node index ${String(ref.index)} is outside level ${ref.level}`,
    );
  }
}

interface LeafCursorPayload {
  readonly schema: string;
  readonly scopeId: string;
  readonly viewId: string;
  readonly rootDigest: string;
  readonly leafId: number;
  readonly afterKey: string;
}

async function encodeLeafCursor(
  secret: CryptoKey,
  payload: LeafCursorPayload,
): Promise<string> {
  const material = canonicalJson(payload);
  return `${hex(utf8Bytes(material))}.${await hmac(secret, material)}`;
}

async function decodeLeafCursor(
  secret: CryptoKey,
  cursor: string,
): Promise<LeafCursorPayload> {
  const [encoded, signature, extra] = cursor.split(".");
  if (encoded === undefined || signature === undefined || extra !== undefined) {
    throw new InvalidReconciliationCursorError();
  }
  const material = textFromHex(encoded);
  if (!/^[0-9a-f]{64}$/.test(signature)) throw new InvalidReconciliationCursorError();
  const valid = await globalThis.crypto.subtle.verify(
    "HMAC",
    secret,
    ownedArrayBuffer(bytesFromHex(signature)),
    ownedArrayBuffer(utf8Bytes(material)),
  );
  if (!valid) throw new InvalidReconciliationCursorError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(material) as unknown;
  } catch {
    throw new InvalidReconciliationCursorError();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidReconciliationCursorError();
  }
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.schema !== "string"
    || typeof value.scopeId !== "string"
    || typeof value.viewId !== "string"
    || typeof value.rootDigest !== "string"
    || !Number.isSafeInteger(value.leafId)
    || typeof value.afterKey !== "string"
  ) {
    throw new InvalidReconciliationCursorError();
  }
  return value as unknown as LeafCursorPayload;
}

function descriptorBytes<D, K extends string, C>(
  codec: MerkleDescriptorCodec<D, K, C>,
  descriptor: D,
): number {
  return utf8Bytes(canonicalJson(codec.canonicalValue(descriptor))).byteLength;
}

function descriptorListBytes<D, K extends string, C>(
  codec: MerkleDescriptorCodec<D, K, C>,
  descriptors: readonly D[],
): number {
  if (descriptors.length === 0) return 2;
  return 2 + descriptors.reduce((total, descriptor, index) => (
    total + descriptorBytes(codec, descriptor) + (index === 0 ? 0 : 1)
  ), 0);
}

function boundedLeafDescriptors<D, K extends string, C>(input: {
  readonly codec: MerkleDescriptorCodec<D, K, C>;
  readonly descriptors: readonly D[];
  readonly start: number;
  readonly maxDescriptors: number;
  readonly maxBytes: number;
}): { readonly descriptors: D[]; readonly estimatedBytes: number } {
  const page: D[] = [];
  let estimatedBytes = 2;
  for (const descriptor of input.descriptors.slice(input.start)) {
    if (page.length >= input.maxDescriptors) break;
    const nextBytes = estimatedBytes
      + (page.length === 0 ? 0 : 1)
      + descriptorBytes(input.codec, descriptor);
    if (nextBytes > input.maxBytes) {
      if (page.length === 0) {
        throw new ReconciliationLimitError(
          `Descriptor ${input.codec.key(descriptor)} cannot fit inside maxBytes=${input.maxBytes}`,
        );
      }
      break;
    }
    page.push(descriptor);
    estimatedBytes = nextBytes;
  }
  return { descriptors: page, estimatedBytes };
}

export class GenericFrozenPrefixMerkleView<D, K extends string, C>
implements GenericReconciliationViewReader<D> {
  readonly #index: GenericPrefixMerkleIndex<D, K, C>;
  readonly #codec: MerkleDescriptorCodec<D, K, C>;
  readonly #secret: CryptoKey;
  readonly #info: GenericReconciliationViewInfo;

  private constructor(input: {
    readonly index: GenericPrefixMerkleIndex<D, K, C>;
    readonly codec: MerkleDescriptorCodec<D, K, C>;
    readonly schema: string;
    readonly secret: CryptoKey;
    readonly viewId: string;
  }) {
    this.#index = input.index;
    this.#codec = input.codec;
    this.#secret = input.secret;
    this.#info = {
      schema: input.schema,
      scopeId: input.index.scopeId,
      viewId: input.viewId,
      prefixBits: input.index.prefixBits,
      rootDigest: input.index.rootDigest,
      recordCount: input.index.recordCount,
    };
  }

  static async open<D, K extends string, C>(input: {
    readonly index: GenericPrefixMerkleIndex<D, K, C>;
    readonly codec: MerkleDescriptorCodec<D, K, C>;
    readonly schema: string;
  }): Promise<GenericFrozenPrefixMerkleView<D, K, C>> {
    const frozen = await restoreGenericPrefixMerkleIndex(input.codec, input.index.snapshot());
    return new GenericFrozenPrefixMerkleView({
      ...input,
      index: frozen,
      secret: await randomSecret(),
      viewId: randomViewId(),
    });
  }

  info(): GenericReconciliationViewInfo {
    return { ...this.#info };
  }

  nodeHashes(
    refs: readonly MerkleNodeRef[],
    options: NodeQueryOptions = {},
  ): GenericMerkleNodeHashResponse {
    const maxNodeRefs = validateLimit(
      options.maxNodeRefs ?? DEFAULT_MAX_NODE_REFS,
      MAX_NODE_REFS,
      "maxNodeRefs",
    );
    if (refs.length > maxNodeRefs) {
      throw new ReconciliationLimitError(
        `Node query contains ${refs.length} refs; maxNodeRefs is ${maxNodeRefs}`,
      );
    }
    for (const ref of refs) validateNodeRef(ref, this.#info.prefixBits);
    return {
      viewId: this.#info.viewId,
      rootDigest: this.#info.rootDigest,
      nodes: refs.map((ref) => ({
        level: ref.level,
        index: ref.index,
        hash: this.#index.nodeHash(ref.level, ref.index),
      })),
    };
  }

  async leafPage(options: GenericLeafPageOptions): Promise<GenericReconciliationLeafPage<D>> {
    const maxDescriptors = validateLimit(
      options.maxDescriptors ?? DEFAULT_MAX_LEAF_DESCRIPTORS,
      MAX_LEAF_DESCRIPTORS,
      "maxDescriptors",
    );
    const maxBytes = validateLimit(
      options.maxBytes ?? DEFAULT_MAX_LEAF_BYTES,
      MAX_LEAF_BYTES,
      "maxBytes",
    );
    const descriptors = this.#index.leafDescriptors(options.leafId);
    let afterKey: string | undefined;
    if (options.cursor !== undefined) {
      const payload = await decodeLeafCursor(this.#secret, options.cursor);
      if (
        payload.schema !== this.#info.schema
        || payload.scopeId !== this.#info.scopeId
        || payload.viewId !== this.#info.viewId
        || payload.rootDigest !== this.#info.rootDigest
        || payload.leafId !== options.leafId
      ) {
        throw new InvalidReconciliationCursorError(
          "Reconciliation cursor does not belong to this view/leaf",
        );
      }
      if (!descriptors.some((descriptor) => this.#codec.key(descriptor) === payload.afterKey)) {
        throw new InvalidReconciliationCursorError(
          "Reconciliation cursor points to a missing leaf key",
        );
      }
      afterKey = payload.afterKey;
    }
    const start = afterKey === undefined
      ? 0
      : descriptors.findIndex((descriptor) => this.#codec.key(descriptor) === afterKey) + 1;
    const page = boundedLeafDescriptors({
      codec: this.#codec,
      descriptors,
      start,
      maxDescriptors,
      maxBytes,
    });
    const completed = start + page.descriptors.length >= descriptors.length;
    const last = page.descriptors.at(-1);
    const nextCursor = completed || last === undefined
      ? undefined
      : await encodeLeafCursor(this.#secret, {
        schema: this.#info.schema,
        scopeId: this.#info.scopeId,
        viewId: this.#info.viewId,
        rootDigest: this.#info.rootDigest,
        leafId: options.leafId,
        afterKey: this.#codec.key(last),
      });
    return {
      viewId: this.#info.viewId,
      rootDigest: this.#info.rootDigest,
      leafId: options.leafId,
      descriptors: page.descriptors,
      estimatedBytes: page.estimatedBytes,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      completed,
    };
  }
}

export class GenericReconciliationViewRegistry<D, K extends string, C> {
  readonly #views = new Map<string, GenericFrozenPrefixMerkleView<D, K, C>>();
  constructor(
    readonly codec: MerkleDescriptorCodec<D, K, C>,
    readonly schema: string,
  ) {}

  async open(index: GenericPrefixMerkleIndex<D, K, C>): Promise<GenericFrozenPrefixMerkleView<D, K, C>> {
    const view = await GenericFrozenPrefixMerkleView.open({ index, codec: this.codec, schema: this.schema });
    this.#views.set(view.info().viewId, view);
    return view;
  }

  get(viewId: string): GenericFrozenPrefixMerkleView<D, K, C> {
    const view = this.#views.get(viewId);
    if (view === undefined) throw new StaleReconciliationViewError(viewId);
    return view;
  }

  expire(viewId: string): boolean {
    return this.#views.delete(viewId);
  }
}

export class GenericReconciliationEndpointImpl<D, K extends string, C>
implements GenericReconciliationEndpoint<D> {
  constructor(readonly registry: GenericReconciliationViewRegistry<D, K, C>) {}
  viewInfo(viewId: string): GenericReconciliationViewInfo {
    return this.registry.get(viewId).info();
  }
  nodeHashes(
    viewId: string,
    refs: readonly MerkleNodeRef[],
    options: NodeQueryOptions = {},
  ): GenericMerkleNodeHashResponse {
    return this.registry.get(viewId).nodeHashes(refs, options);
  }
  leafPage(
    viewId: string,
    options: GenericLeafPageOptions,
  ): Promise<GenericReconciliationLeafPage<D>> {
    return this.registry.get(viewId).leafPage(options);
  }
}

interface LeafWorkState<D> {
  readonly leafId: number;
  localCursor?: string;
  remoteCursor?: string;
  localBuffer: D[];
  remoteBuffer: D[];
  localCompleted: boolean;
  remoteCompleted: boolean;
}

type ReconciliationPhase = "nodes" | "leaves" | "complete";

interface GenericReconciliationSessionState<D, K extends string, C> {
  readonly schema: string;
  readonly scopeId: string;
  readonly local: GenericReconciliationViewInfo;
  readonly remote: GenericReconciliationViewInfo;
  readonly options: ResolvedReconciliationSessionOptions;
  phase: ReconciliationPhase;
  pendingNodes: MerkleNodeRef[];
  pendingLeaves: number[];
  currentLeaf?: LeafWorkState<D>;
  localOnly: K[];
  remoteOnly: K[];
  collisions: C[];
  counters: MutableReconciliationCounters;
}

function resolveSessionOptions(options: ReconciliationSessionOptions): ResolvedReconciliationSessionOptions {
  return {
    maxNodeRefsPerStep: validateLimit(options.maxNodeRefsPerStep ?? 64, MAX_NODE_REFS, "maxNodeRefsPerStep"),
    maxLeafDescriptors: validateLimit(
      options.maxLeafDescriptors ?? DEFAULT_MAX_LEAF_DESCRIPTORS,
      MAX_LEAF_DESCRIPTORS,
      "maxLeafDescriptors",
    ),
    maxLeafBytes: validateLimit(options.maxLeafBytes ?? DEFAULT_MAX_LEAF_BYTES, MAX_LEAF_BYTES, "maxLeafBytes"),
    maxPendingNodes: validateLimit(
      options.maxPendingNodes ?? DEFAULT_MAX_PENDING_NODES,
      MAX_PENDING_NODES,
      "maxPendingNodes",
    ),
    maxPendingLeaves: validateLimit(
      options.maxPendingLeaves ?? DEFAULT_MAX_PENDING_LEAVES,
      MAX_PENDING_LEAVES,
      "maxPendingLeaves",
    ),
    maxSteps: validateLimit(options.maxSteps ?? 100_000, 1_000_000, "maxSteps"),
  };
}

function validateViewInfo(info: GenericReconciliationViewInfo, schema: string, label: string): void {
  if (info.schema !== schema) {
    throw new InvalidReconciliationResponseError(`${label} uses an unsupported protocol schema`);
  }
  if (typeof info.scopeId !== "string" || info.scopeId.length === 0 || info.scopeId.length > 256) {
    throw new InvalidReconciliationResponseError(`${label} has an invalid scopeId`);
  }
  if (typeof info.viewId !== "string" || info.viewId.length === 0 || info.viewId.length > 256) {
    throw new InvalidReconciliationResponseError(`${label} has an invalid viewId`);
  }
  if (info.prefixBits !== 8 && info.prefixBits !== 12 && info.prefixBits !== 16) {
    throw new InvalidReconciliationResponseError(`${label} has unsupported prefixBits`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(info.rootDigest)) {
    throw new InvalidReconciliationResponseError(`${label} has an invalid rootDigest`);
  }
  if (!Number.isSafeInteger(info.recordCount) || info.recordCount < 0) {
    throw new InvalidReconciliationResponseError(`${label} has an invalid recordCount`);
  }
}

function sameView(left: GenericReconciliationViewInfo, right: GenericReconciliationViewInfo): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertNodeResponse(
  expected: GenericReconciliationViewInfo,
  refs: readonly MerkleNodeRef[],
  response: GenericMerkleNodeHashResponse,
): void {
  if (response.viewId !== expected.viewId || response.rootDigest !== expected.rootDigest) {
    throw new StaleReconciliationViewError(expected.viewId);
  }
  if (response.nodes.length !== refs.length) {
    throw new InvalidReconciliationResponseError("Node response length does not match request");
  }
  response.nodes.forEach((node, index) => {
    const ref = refs[index]!;
    if (node.level !== ref.level || node.index !== ref.index) {
      throw new InvalidReconciliationResponseError("Node response order/reference mismatch");
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(node.hash)) {
      throw new InvalidReconciliationResponseError("Node response contains an invalid hash");
    }
  });
}

function assertPendingBounds<D, K extends string, C>(
  state: GenericReconciliationSessionState<D, K, C>,
): void {
  if (state.pendingNodes.length > state.options.maxPendingNodes) {
    throw new ReconciliationLimitError(
      `Pending node work ${state.pendingNodes.length} exceeds maxPendingNodes=${state.options.maxPendingNodes}`,
    );
  }
  if (state.pendingLeaves.length > state.options.maxPendingLeaves) {
    throw new ReconciliationLimitError(
      `Pending leaf work ${state.pendingLeaves.length} exceeds maxPendingLeaves=${state.options.maxPendingLeaves}`,
    );
  }
}

async function assertLeafResponse<D, K extends string, C>(input: {
  readonly codec: MerkleDescriptorCodec<D, K, C>;
  readonly expected: GenericReconciliationViewInfo;
  readonly leafId: number;
  readonly response: GenericReconciliationLeafPage<D>;
  readonly options: ResolvedReconciliationSessionOptions;
}): Promise<void> {
  const { response } = input;
  if (
    response.viewId !== input.expected.viewId
    || response.rootDigest !== input.expected.rootDigest
    || response.leafId !== input.leafId
  ) {
    throw new StaleReconciliationViewError(input.expected.viewId);
  }
  if (response.descriptors.length > input.options.maxLeafDescriptors) {
    throw new InvalidReconciliationResponseError("Leaf response exceeds descriptor limit");
  }
  if (response.estimatedBytes > input.options.maxLeafBytes) {
    throw new InvalidReconciliationResponseError("Leaf response exceeds byte limit");
  }
  if (response.estimatedBytes !== descriptorListBytes(input.codec, response.descriptors)) {
    throw new InvalidReconciliationResponseError("Leaf response byte accounting mismatch");
  }
  const normalized = await normalizeMerkleDescriptors(
    input.codec,
    response.descriptors,
    input.expected.scopeId,
  );
  if (canonicalJson(normalized.descriptors) !== canonicalJson(response.descriptors)) {
    throw new InvalidReconciliationResponseError("Leaf response descriptors are not canonical/sorted");
  }
  if (response.completed && response.nextCursor !== undefined) {
    throw new InvalidReconciliationResponseError("Completed leaf response must not contain a cursor");
  }
  if (!response.completed && response.nextCursor === undefined) {
    throw new InvalidReconciliationResponseError("Incomplete leaf response must contain a cursor");
  }
}

function emptyCounters(): MutableReconciliationCounters {
  return {
    steps: 0,
    remoteNodeQueries: 0,
    remoteNodeHashes: 0,
    remoteLeafPages: 0,
    remoteLeafDescriptors: 0,
    remoteLeafBytes: 0,
  };
}

function startState<D, K extends string, C>(input: {
  readonly codec: MerkleDescriptorCodec<D, K, C>;
  readonly schema: string;
  readonly local: GenericReconciliationViewInfo;
  readonly remote: GenericReconciliationViewInfo;
  readonly options: ResolvedReconciliationSessionOptions;
}): GenericReconciliationSessionState<D, K, C> {
  validateViewInfo(input.local, input.schema, "Local reconciliation view");
  validateViewInfo(input.remote, input.schema, "Remote reconciliation view");
  if (input.local.scopeId !== input.remote.scopeId) {
    throw input.codec.scopeMismatch(input.local.scopeId, input.remote.scopeId);
  }
  if (input.local.prefixBits !== input.remote.prefixBits) {
    throw input.codec.invalid(
      `Merkle prefixBits mismatch: ${input.local.prefixBits} != ${input.remote.prefixBits}`,
    );
  }
  const equal = input.local.rootDigest === input.remote.rootDigest;
  if (equal && input.local.recordCount !== input.remote.recordCount) {
    throw new InvalidReconciliationResponseError(
      "Equal Merkle roots cannot advertise different record counts",
    );
  }
  return {
    schema: input.schema,
    scopeId: input.local.scopeId,
    local: input.local,
    remote: input.remote,
    options: input.options,
    phase: equal ? "complete" : "nodes",
    pendingNodes: equal ? [] : [{ level: input.local.prefixBits, index: 0 }],
    pendingLeaves: [],
    localOnly: [],
    remoteOnly: [],
    collisions: [],
    counters: emptyCounters(),
  };
}

function structuralState<D, K extends string, C>(value: unknown): GenericReconciliationSessionState<D, K, C> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidReconciliationResponseError("Reconciliation state must be an object");
  }
  const state = value as Partial<GenericReconciliationSessionState<D, K, C>>;
  if (
    typeof state.schema !== "string"
    || typeof state.scopeId !== "string"
    || state.local === undefined
    || state.remote === undefined
    || state.options === undefined
    || (state.phase !== "nodes" && state.phase !== "leaves" && state.phase !== "complete")
    || !Array.isArray(state.pendingNodes)
    || !Array.isArray(state.pendingLeaves)
    || !Array.isArray(state.localOnly)
    || !Array.isArray(state.remoteOnly)
    || !Array.isArray(state.collisions)
    || state.counters === undefined
  ) {
    throw new InvalidReconciliationResponseError("Malformed reconciliation state");
  }
  return state as GenericReconciliationSessionState<D, K, C>;
}

async function validateRestoredState<D, K extends string, C>(input: {
  readonly codec: MerkleDescriptorCodec<D, K, C>;
  readonly schema: string;
  readonly state: GenericReconciliationSessionState<D, K, C>;
}): Promise<void> {
  const state = input.state;
  if (state.schema !== input.schema) {
    throw new InvalidReconciliationResponseError("Restored reconciliation state schema mismatch");
  }
  const resolvedOptions = resolveSessionOptions(state.options);
  if (canonicalJson(resolvedOptions) !== canonicalJson(state.options)) {
    throw new InvalidReconciliationResponseError("Restored reconciliation state options are not canonical");
  }
  validateViewInfo(state.local, input.schema, "Restored local reconciliation view");
  validateViewInfo(state.remote, input.schema, "Restored remote reconciliation view");
  if (state.scopeId !== state.local.scopeId || state.scopeId !== state.remote.scopeId) {
    throw input.codec.scopeMismatch(state.local.scopeId, state.remote.scopeId);
  }
  if (state.local.prefixBits !== state.remote.prefixBits) {
    throw input.codec.invalid("Restored reconciliation state has prefixBits mismatch");
  }
  for (const ref of state.pendingNodes) validateNodeRef(ref, state.local.prefixBits);
  for (const leafId of state.pendingLeaves) {
    if (!Number.isSafeInteger(leafId) || leafId < 0 || leafId >= 2 ** state.local.prefixBits) {
      throw new InvalidReconciliationResponseError("Restored reconciliation state has invalid leaf id");
    }
  }
  assertPendingBounds(state);
  if (Object.values(state.counters).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new InvalidReconciliationResponseError("Restored reconciliation state has invalid counters");
  }
  if (state.counters.steps > state.options.maxSteps) {
    throw new InvalidReconciliationResponseError("Restored reconciliation state exceeds maxSteps");
  }
  const work = state.currentLeaf;
  if (work !== undefined) {
    if (!Number.isSafeInteger(work.leafId) || work.leafId < 0 || work.leafId >= 2 ** state.local.prefixBits) {
      throw new InvalidReconciliationResponseError("Restored reconciliation state has invalid current leaf");
    }
    const [local, remote] = await Promise.all([
      normalizeMerkleDescriptors(input.codec, work.localBuffer, state.scopeId),
      normalizeMerkleDescriptors(input.codec, work.remoteBuffer, state.scopeId),
    ]);
    if (
      canonicalJson(local.descriptors) !== canonicalJson(work.localBuffer)
      || canonicalJson(remote.descriptors) !== canonicalJson(work.remoteBuffer)
    ) {
      throw new InvalidReconciliationResponseError("Restored reconciliation leaf buffers are not canonical");
    }
  }
}

export class GenericBoundedReconciliationSession<D, K extends string, C> {
  readonly #codec: MerkleDescriptorCodec<D, K, C>;
  readonly #state: GenericReconciliationSessionState<D, K, C>;

  private constructor(input: {
    readonly codec: MerkleDescriptorCodec<D, K, C>;
    readonly state: GenericReconciliationSessionState<D, K, C>;
  }) {
    this.#codec = input.codec;
    this.#state = input.state;
  }

  static async start<D, K extends string, C>(input: {
    readonly codec: MerkleDescriptorCodec<D, K, C>;
    readonly schema: string;
    readonly local: GenericReconciliationViewReader<D>;
    readonly remote: GenericReconciliationEndpoint<D>;
    readonly remoteViewId: string;
    readonly options?: ReconciliationSessionOptions;
  }): Promise<GenericBoundedReconciliationSession<D, K, C>> {
    const local = input.local.info();
    const remote = await input.remote.viewInfo(input.remoteViewId);
    return new GenericBoundedReconciliationSession({
      codec: input.codec,
      state: startState({
        codec: input.codec,
        schema: input.schema,
        local,
        remote,
        options: resolveSessionOptions(input.options ?? {}),
      }),
    });
  }

  static async restore<D, K extends string, C>(input: {
    readonly codec: MerkleDescriptorCodec<D, K, C>;
    readonly schema: string;
    readonly encoded: string;
  }): Promise<GenericBoundedReconciliationSession<D, K, C>> {
    if (utf8Bytes(input.encoded).byteLength > MAX_RECONCILIATION_STATE_BYTES) {
      throw new ReconciliationLimitError(
        `Encoded reconciliation state exceeds ${MAX_RECONCILIATION_STATE_BYTES} bytes`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.encoded) as unknown;
    } catch {
      throw new InvalidReconciliationResponseError("Reconciliation state is not valid JSON");
    }
    const state = structuralState<D, K, C>(parsed);
    await validateRestoredState({ codec: input.codec, schema: input.schema, state });
    return new GenericBoundedReconciliationSession({
      codec: input.codec,
      state,
    });
  }

  encode(): string {
    return canonicalJson(this.#state);
  }

  get complete(): boolean {
    return this.#state.phase === "complete";
  }

  counters(): ReconciliationCounters {
    return { ...this.#state.counters };
  }

  result(): GenericReconciliationResult<K, C> {
    if (!this.complete) throw new Error("Reconciliation is not complete");
    return {
      localOnly: [...new Set(this.#state.localOnly)].toSorted((left, right) => left.localeCompare(right)),
      remoteOnly: [...new Set(this.#state.remoteOnly)].toSorted((left, right) => left.localeCompare(right)),
      collisions: [...new Map(
        this.#state.collisions.map((collision) => [this.#codec.collisionKey(collision), collision]),
      ).values()].toSorted((left, right) => (
        this.#codec.collisionKey(left).localeCompare(this.#codec.collisionKey(right))
      )),
      counters: this.counters(),
    };
  }

  async step(
    local: GenericReconciliationViewReader<D>,
    remote: GenericReconciliationEndpoint<D>,
  ): Promise<void> {
    if (this.complete) return;
    if (this.#state.counters.steps >= this.#state.options.maxSteps) {
      throw new ReconciliationBudgetExceededError(this.#state.options.maxSteps);
    }
    if (!sameView(this.#state.local, local.info())) {
      throw new StaleReconciliationViewError(this.#state.local.viewId);
    }
    this.#state.counters.steps += 1;
    if (this.#state.phase === "nodes") await this.#stepNodes(local, remote);
    else await this.#stepLeaf(local, remote);
  }

  async runToCompletion(
    local: GenericReconciliationViewReader<D>,
    remote: GenericReconciliationEndpoint<D>,
  ): Promise<GenericReconciliationResult<K, C>> {
    while (!this.complete) await this.step(local, remote);
    return this.result();
  }

  async #stepNodes(
    local: GenericReconciliationViewReader<D>,
    remote: GenericReconciliationEndpoint<D>,
  ): Promise<void> {
    const refs = this.#state.pendingNodes.splice(0, this.#state.options.maxNodeRefsPerStep);
    const localResponse = local.nodeHashes(
      refs,
      { maxNodeRefs: this.#state.options.maxNodeRefsPerStep },
    );
    const remoteResponse = await remote.nodeHashes(this.#state.remote.viewId, refs, {
      maxNodeRefs: this.#state.options.maxNodeRefsPerStep,
    });
    assertNodeResponse(this.#state.local, refs, localResponse);
    assertNodeResponse(this.#state.remote, refs, remoteResponse);
    this.#state.counters.remoteNodeQueries += 1;
    this.#state.counters.remoteNodeHashes += remoteResponse.nodes.length;

    refs.forEach((ref, index) => {
      if (localResponse.nodes[index]!.hash === remoteResponse.nodes[index]!.hash) return;
      if (ref.level === 0) this.#state.pendingLeaves.push(ref.index);
      else this.#state.pendingNodes.push(
        { level: ref.level - 1, index: ref.index * 2 },
        { level: ref.level - 1, index: ref.index * 2 + 1 },
      );
    });
    assertPendingBounds(this.#state);
    if (this.#state.pendingNodes.length === 0) {
      this.#state.pendingLeaves = [...new Set(this.#state.pendingLeaves)].toSorted((a, b) => a - b);
      assertPendingBounds(this.#state);
      this.#state.phase = this.#state.pendingLeaves.length === 0 ? "complete" : "leaves";
    }
  }

  async #fetchLocalPage(
    local: GenericReconciliationViewReader<D>,
    work: LeafWorkState<D>,
  ): Promise<void> {
    if (work.localCompleted || work.localBuffer.length > 0) return;
    const page = await local.leafPage({
      leafId: work.leafId,
      ...(work.localCursor === undefined ? {} : { cursor: work.localCursor }),
      maxDescriptors: this.#state.options.maxLeafDescriptors,
      maxBytes: this.#state.options.maxLeafBytes,
    });
    await assertLeafResponse({
      codec: this.#codec,
      expected: this.#state.local,
      leafId: work.leafId,
      response: page,
      options: this.#state.options,
    });
    work.localBuffer.push(...page.descriptors);
    if (page.nextCursor === undefined) delete work.localCursor;
    else work.localCursor = page.nextCursor;
    work.localCompleted = page.completed;
  }

  async #fetchRemotePage(
    remote: GenericReconciliationEndpoint<D>,
    work: LeafWorkState<D>,
  ): Promise<void> {
    if (work.remoteCompleted || work.remoteBuffer.length > 0) return;
    const page = await remote.leafPage(this.#state.remote.viewId, {
      leafId: work.leafId,
      ...(work.remoteCursor === undefined ? {} : { cursor: work.remoteCursor }),
      maxDescriptors: this.#state.options.maxLeafDescriptors,
      maxBytes: this.#state.options.maxLeafBytes,
    });
    await assertLeafResponse({
      codec: this.#codec,
      expected: this.#state.remote,
      leafId: work.leafId,
      response: page,
      options: this.#state.options,
    });
    work.remoteBuffer.push(...page.descriptors);
    if (page.nextCursor === undefined) delete work.remoteCursor;
    else work.remoteCursor = page.nextCursor;
    work.remoteCompleted = page.completed;
    this.#state.counters.remoteLeafPages += 1;
    this.#state.counters.remoteLeafDescriptors += page.descriptors.length;
    this.#state.counters.remoteLeafBytes += page.estimatedBytes;
  }

  #mergeLeafBuffers(work: LeafWorkState<D>): void {
    while (work.localBuffer.length > 0 && work.remoteBuffer.length > 0) {
      const left = work.localBuffer[0]!;
      const right = work.remoteBuffer[0]!;
      const leftKey = this.#codec.key(left);
      const rightKey = this.#codec.key(right);
      const order = leftKey.localeCompare(rightKey);
      if (order < 0) {
        this.#state.localOnly.push(leftKey);
        work.localBuffer.shift();
        continue;
      }
      if (order > 0) {
        this.#state.remoteOnly.push(rightKey);
        work.remoteBuffer.shift();
        continue;
      }
      const comparison = this.#codec.compareSameKey(left, right);
      if (comparison.collision !== undefined) this.#state.collisions.push(comparison.collision);
      work.localBuffer.shift();
      work.remoteBuffer.shift();
    }
    if (work.localCompleted && work.localBuffer.length === 0) {
      this.#state.remoteOnly.push(...work.remoteBuffer.map((value) => this.#codec.key(value)));
      work.remoteBuffer.splice(0);
    }
    if (work.remoteCompleted && work.remoteBuffer.length === 0) {
      this.#state.localOnly.push(...work.localBuffer.map((value) => this.#codec.key(value)));
      work.localBuffer.splice(0);
    }
  }

  async #stepLeaf(
    local: GenericReconciliationViewReader<D>,
    remote: GenericReconciliationEndpoint<D>,
  ): Promise<void> {
    let work = this.#state.currentLeaf;
    if (work === undefined) {
      const leafId = this.#state.pendingLeaves.shift();
      if (leafId === undefined) {
        this.#state.phase = "complete";
        return;
      }
      work = {
        leafId,
        localBuffer: [],
        remoteBuffer: [],
        localCompleted: false,
        remoteCompleted: false,
      };
      this.#state.currentLeaf = work;
    }
    await Promise.all([
      this.#fetchLocalPage(local, work),
      this.#fetchRemotePage(remote, work),
    ]);
    this.#mergeLeafBuffers(work);
    if (
      work.localCompleted
      && work.remoteCompleted
      && work.localBuffer.length === 0
      && work.remoteBuffer.length === 0
    ) {
      delete this.#state.currentLeaf;
      if (this.#state.pendingLeaves.length === 0) this.#state.phase = "complete";
    }
  }
}
