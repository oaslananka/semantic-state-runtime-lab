import { canonicalJson } from "@ssrl/core";
import {
  InvalidReplicationRecordError,
  assertSameReplicationDescriptor,
  normalizeReplicationDescriptors,
  replicationDescriptor,
  type ReplicationRecordDescriptor,
  type ReplicationRecordKey,
} from "./index.js";
import {
  restorePrefixMerkleIndex,
  type PrefixMerkleBits,
  type PrefixMerkleIndex,
} from "./merkle.js";

export const RECONCILIATION_PROTOCOL_SCHEMA = "ssrl-reconciliation-v1" as const;
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

export interface MerkleNodeHashResponse {
  readonly viewId: string;
  readonly rootDigest: string;
  readonly nodes: readonly MerkleNodeHash[];
}

export interface ReconciliationViewInfo {
  readonly schema: typeof RECONCILIATION_PROTOCOL_SCHEMA;
  readonly viewId: string;
  readonly prefixBits: PrefixMerkleBits;
  readonly rootDigest: string;
  readonly recordCount: number;
}

export interface NodeQueryOptions {
  readonly maxNodeRefs?: number;
}

export interface LeafPageOptions {
  readonly leafId: number;
  readonly cursor?: ReconciliationLeafCursor;
  readonly maxDescriptors?: number;
  readonly maxBytes?: number;
}

export interface ReconciliationLeafPage {
  readonly viewId: string;
  readonly rootDigest: string;
  readonly leafId: number;
  readonly descriptors: readonly ReplicationRecordDescriptor[];
  readonly estimatedBytes: number;
  readonly nextCursor?: ReconciliationLeafCursor;
  readonly completed: boolean;
}

declare const reconciliationLeafCursorBrand: unique symbol;
export type ReconciliationLeafCursor = string & {
  readonly [reconciliationLeafCursorBrand]: true;
};

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

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesFromHex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/.test(value)) throw new InvalidReconciliationCursorError();
  return Uint8Array.from(
    Array.from({ length: value.length / 2 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)),
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

function descriptorBytes(descriptor: ReplicationRecordDescriptor): number {
  return utf8Bytes(canonicalJson(replicationDescriptor(descriptor))).byteLength;
}

function pageBytes(current: number, descriptor: ReplicationRecordDescriptor, count: number): number {
  const separator = count === 0 ? 0 : 1;
  return current + separator + descriptorBytes(descriptor);
}

interface LeafCursorPayload {
  readonly schema: typeof RECONCILIATION_PROTOCOL_SCHEMA;
  readonly viewId: string;
  readonly rootDigest: string;
  readonly leafId: number;
  readonly afterKey: ReplicationRecordKey;
}

function cursorPayloadJson(payload: LeafCursorPayload): string {
  return canonicalJson(payload);
}

async function encodeLeafCursor(
  secret: CryptoKey,
  payload: LeafCursorPayload,
): Promise<ReconciliationLeafCursor> {
  const material = cursorPayloadJson(payload);
  return `${hex(utf8Bytes(material))}.${await hmac(secret, material)}` as ReconciliationLeafCursor;
}

async function decodeLeafCursor(
  secret: CryptoKey,
  cursor: ReconciliationLeafCursor,
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
    parsed = JSON.parse(material);
  } catch {
    throw new InvalidReconciliationCursorError();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidReconciliationCursorError();
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.schema !== RECONCILIATION_PROTOCOL_SCHEMA
    || typeof value.viewId !== "string"
    || typeof value.rootDigest !== "string"
    || !Number.isSafeInteger(value.leafId)
    || typeof value.afterKey !== "string"
  ) {
    throw new InvalidReconciliationCursorError();
  }
  return value as unknown as LeafCursorPayload;
}

export class FrozenPrefixMerkleView {
  readonly #index: PrefixMerkleIndex;
  readonly #secret: CryptoKey;
  readonly #info: ReconciliationViewInfo;

  private constructor(index: PrefixMerkleIndex, secret: CryptoKey, viewId: string) {
    this.#index = index;
    this.#secret = secret;
    this.#info = {
      schema: RECONCILIATION_PROTOCOL_SCHEMA,
      viewId,
      prefixBits: index.prefixBits,
      rootDigest: index.rootDigest,
      recordCount: index.recordCount,
    };
  }

  static async open(index: PrefixMerkleIndex): Promise<FrozenPrefixMerkleView> {
    const frozen = await restorePrefixMerkleIndex(index.snapshot());
    return new FrozenPrefixMerkleView(frozen, await randomSecret(), randomViewId());
  }

  info(): ReconciliationViewInfo {
    return { ...this.#info };
  }

  nodeHashes(
    refs: readonly MerkleNodeRef[],
    options: NodeQueryOptions = {},
  ): MerkleNodeHashResponse {
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

  async leafPage(options: LeafPageOptions): Promise<ReconciliationLeafPage> {
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
    let afterKey: ReplicationRecordKey | undefined;
    if (options.cursor !== undefined) {
      const cursor = await decodeLeafCursor(this.#secret, options.cursor);
      if (
        cursor.viewId !== this.#info.viewId
        || cursor.rootDigest !== this.#info.rootDigest
        || cursor.leafId !== options.leafId
      ) {
        throw new InvalidReconciliationCursorError("Reconciliation cursor does not belong to this view/leaf");
      }
      if (!descriptors.some((descriptor) => descriptor.key === cursor.afterKey)) {
        throw new InvalidReconciliationCursorError("Reconciliation cursor points to a missing leaf key");
      }
      afterKey = cursor.afterKey;
    }

    const start = afterKey === undefined
      ? 0
      : descriptors.findIndex((descriptor) => descriptor.key === afterKey) + 1;
    const page: ReplicationRecordDescriptor[] = [];
    let estimatedBytes = 2;
    for (const descriptor of descriptors.slice(start)) {
      if (page.length >= maxDescriptors) break;
      const nextBytes = pageBytes(estimatedBytes, descriptor, page.length);
      if (nextBytes > maxBytes) {
        if (page.length === 0) {
          throw new ReconciliationLimitError(
            `Descriptor ${descriptor.key} cannot fit inside maxBytes=${maxBytes}`,
          );
        }
        break;
      }
      page.push(replicationDescriptor(descriptor));
      estimatedBytes = nextBytes;
    }
    const completed = start + page.length >= descriptors.length;
    const last = page.at(-1);
    const nextCursor = completed || last === undefined
      ? undefined
      : await encodeLeafCursor(this.#secret, {
        schema: RECONCILIATION_PROTOCOL_SCHEMA,
        viewId: this.#info.viewId,
        rootDigest: this.#info.rootDigest,
        leafId: options.leafId,
        afterKey: last.key,
      });
    return {
      viewId: this.#info.viewId,
      rootDigest: this.#info.rootDigest,
      leafId: options.leafId,
      descriptors: page,
      estimatedBytes,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      completed,
    };
  }
}

export class InMemoryReconciliationViewRegistry {
  readonly #views = new Map<string, FrozenPrefixMerkleView>();

  async open(index: PrefixMerkleIndex): Promise<FrozenPrefixMerkleView> {
    const view = await FrozenPrefixMerkleView.open(index);
    this.#views.set(view.info().viewId, view);
    return view;
  }

  get(viewId: string): FrozenPrefixMerkleView {
    const view = this.#views.get(viewId);
    if (view === undefined) throw new StaleReconciliationViewError(viewId);
    return view;
  }

  expire(viewId: string): boolean {
    return this.#views.delete(viewId);
  }
}

export interface ReconciliationViewReader {
  info(): ReconciliationViewInfo;
  nodeHashes(refs: readonly MerkleNodeRef[], options?: NodeQueryOptions): MerkleNodeHashResponse;
  leafPage(options: LeafPageOptions): Promise<ReconciliationLeafPage>;
}

export interface ReconciliationEndpoint {
  viewInfo(viewId: string): ReconciliationViewInfo;
  nodeHashes(
    viewId: string,
    refs: readonly MerkleNodeRef[],
    options?: NodeQueryOptions,
  ): MerkleNodeHashResponse;
  leafPage(viewId: string, options: LeafPageOptions): Promise<ReconciliationLeafPage>;
}

export class InMemoryReconciliationEndpoint implements ReconciliationEndpoint {
  constructor(readonly registry: InMemoryReconciliationViewRegistry) {}

  viewInfo(viewId: string): ReconciliationViewInfo {
    return this.registry.get(viewId).info();
  }

  nodeHashes(
    viewId: string,
    refs: readonly MerkleNodeRef[],
    options: NodeQueryOptions = {},
  ): MerkleNodeHashResponse {
    return this.registry.get(viewId).nodeHashes(refs, options);
  }

  leafPage(viewId: string, options: LeafPageOptions): Promise<ReconciliationLeafPage> {
    return this.registry.get(viewId).leafPage(options);
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

export interface ReconciliationResult {
  readonly localOnly: readonly ReplicationRecordKey[];
  readonly remoteOnly: readonly ReplicationRecordKey[];
  readonly collisions: readonly import("./index.js").ReplicationRecordCollision[];
  readonly counters: ReconciliationCounters;
}

type ReconciliationPhase = "nodes" | "leaves" | "complete";

interface LeafWorkState {
  readonly leafId: number;
  localCursor?: ReconciliationLeafCursor;
  remoteCursor?: ReconciliationLeafCursor;
  localBuffer: ReplicationRecordDescriptor[];
  remoteBuffer: ReplicationRecordDescriptor[];
  localCompleted: boolean;
  remoteCompleted: boolean;
}

interface ReconciliationSessionState {
  readonly schema: typeof RECONCILIATION_PROTOCOL_SCHEMA;
  readonly local: ReconciliationViewInfo;
  readonly remote: ReconciliationViewInfo;
  readonly options: ResolvedReconciliationSessionOptions;
  phase: ReconciliationPhase;
  pendingNodes: MerkleNodeRef[];
  pendingLeaves: number[];
  currentLeaf?: LeafWorkState;
  localOnly: ReplicationRecordKey[];
  remoteOnly: ReplicationRecordKey[];
  collisions: import("./index.js").ReplicationRecordCollision[];
  counters: {
    steps: number;
    remoteNodeQueries: number;
    remoteNodeHashes: number;
    remoteLeafPages: number;
    remoteLeafDescriptors: number;
    remoteLeafBytes: number;
  };
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

function resolveSessionOptions(
  options: ReconciliationSessionOptions,
): ResolvedReconciliationSessionOptions {
  return {
    maxNodeRefsPerStep: validateLimit(
      options.maxNodeRefsPerStep ?? 64,
      MAX_NODE_REFS,
      "maxNodeRefsPerStep",
    ),
    maxLeafDescriptors: validateLimit(
      options.maxLeafDescriptors ?? DEFAULT_MAX_LEAF_DESCRIPTORS,
      MAX_LEAF_DESCRIPTORS,
      "maxLeafDescriptors",
    ),
    maxLeafBytes: validateLimit(
      options.maxLeafBytes ?? DEFAULT_MAX_LEAF_BYTES,
      MAX_LEAF_BYTES,
      "maxLeafBytes",
    ),
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

function validateViewInfo(value: ReconciliationViewInfo, label: string): void {
  if (value.schema !== RECONCILIATION_PROTOCOL_SCHEMA) {
    throw new InvalidReconciliationResponseError(`${label} uses an unsupported protocol schema`);
  }
  if (typeof value.viewId !== "string" || value.viewId.length < 1 || value.viewId.length > 256) {
    throw new InvalidReconciliationResponseError(`${label} has an invalid viewId`);
  }
  if (value.prefixBits !== 8 && value.prefixBits !== 12 && value.prefixBits !== 16) {
    throw new InvalidReconciliationResponseError(`${label} has unsupported prefixBits`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(value.rootDigest)) {
    throw new InvalidReconciliationResponseError(`${label} has an invalid rootDigest`);
  }
  if (!Number.isSafeInteger(value.recordCount) || value.recordCount < 0) {
    throw new InvalidReconciliationResponseError(`${label} has an invalid recordCount`);
  }
}

function validateNodeRef(ref: MerkleNodeRef, prefixBits: PrefixMerkleBits): void {
  if (!Number.isSafeInteger(ref.level) || ref.level < 0 || ref.level > prefixBits) {
    throw new InvalidReplicationRecordError(
      `Merkle level must be between 0 and ${prefixBits}; received ${String(ref.level)}`,
    );
  }
  const nodeCount = 2 ** (prefixBits - ref.level);
  if (!Number.isSafeInteger(ref.index) || ref.index < 0 || ref.index >= nodeCount) {
    throw new InvalidReplicationRecordError(
      `Merkle node index ${String(ref.index)} is outside level ${ref.level}`,
    );
  }
}

function assertPendingWorkBounds(state: ReconciliationSessionState): void {
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

function sameView(left: ReconciliationViewInfo, right: ReconciliationViewInfo): boolean {
  return left.schema === right.schema
    && left.viewId === right.viewId
    && left.prefixBits === right.prefixBits
    && left.rootDigest === right.rootDigest
    && left.recordCount === right.recordCount;
}

function assertView(expected: ReconciliationViewInfo, actual: ReconciliationViewInfo): void {
  if (!sameView(expected, actual)) throw new StaleReconciliationViewError(expected.viewId);
}

function assertNodeResponse(
  expected: ReconciliationViewInfo,
  refs: readonly MerkleNodeRef[],
  response: MerkleNodeHashResponse,
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

function descriptorListBytes(descriptors: readonly ReplicationRecordDescriptor[]): number {
  if (descriptors.length === 0) return 2;
  return 2 + descriptors.reduce((total, descriptor, index) => (
    total + descriptorBytes(descriptor) + (index === 0 ? 0 : 1)
  ), 0);
}

async function assertLeafResponse(
  expected: ReconciliationViewInfo,
  leafId: number,
  response: ReconciliationLeafPage,
  options: ResolvedReconciliationSessionOptions,
): Promise<void> {
  if (
    response.viewId !== expected.viewId
    || response.rootDigest !== expected.rootDigest
    || response.leafId !== leafId
  ) {
    throw new StaleReconciliationViewError(expected.viewId);
  }
  if (response.descriptors.length > options.maxLeafDescriptors) {
    throw new InvalidReconciliationResponseError("Leaf response exceeds descriptor limit");
  }
  if (response.estimatedBytes > options.maxLeafBytes) {
    throw new InvalidReconciliationResponseError("Leaf response exceeds byte limit");
  }
  if (response.estimatedBytes !== descriptorListBytes(response.descriptors)) {
    throw new InvalidReconciliationResponseError("Leaf response byte accounting mismatch");
  }
  if (response.descriptors.some((descriptor) => Object.hasOwn(descriptor, "payload"))) {
    throw new InvalidReconciliationResponseError("Leaf response must not contain payload bodies");
  }
  const normalized = await normalizeReplicationDescriptors(response.descriptors);
  if (canonicalJson(normalized) !== canonicalJson(response.descriptors)) {
    throw new InvalidReconciliationResponseError("Leaf response descriptors are not canonical/sorted");
  }
  if (response.completed && response.nextCursor !== undefined) {
    throw new InvalidReconciliationResponseError("Completed leaf response must not contain a cursor");
  }
  if (!response.completed && response.nextCursor === undefined) {
    throw new InvalidReconciliationResponseError("Incomplete leaf response must contain a cursor");
  }
}

function emptyCounters(): ReconciliationSessionState["counters"] {
  return {
    steps: 0,
    remoteNodeQueries: 0,
    remoteNodeHashes: 0,
    remoteLeafPages: 0,
    remoteLeafDescriptors: 0,
    remoteLeafBytes: 0,
  };
}

function sortResultKeys(values: readonly ReplicationRecordKey[]): ReplicationRecordKey[] {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function sortedCollisions(
  values: readonly import("./index.js").ReplicationRecordCollision[],
): import("./index.js").ReplicationRecordCollision[] {
  return [...new Map(values.map((value) => [value.key, value])).values()]
    .toSorted((left, right) => left.key.localeCompare(right.key));
}

function startState(
  local: ReconciliationViewInfo,
  remote: ReconciliationViewInfo,
  options: ResolvedReconciliationSessionOptions,
): ReconciliationSessionState {
  validateViewInfo(local, "Local reconciliation view");
  validateViewInfo(remote, "Remote reconciliation view");
  if (local.prefixBits !== remote.prefixBits) {
    throw new InvalidReplicationRecordError(
      `Merkle prefixBits mismatch: ${local.prefixBits} != ${remote.prefixBits}`,
    );
  }
  const equal = local.rootDigest === remote.rootDigest;
  if (equal && local.recordCount !== remote.recordCount) {
    throw new InvalidReconciliationResponseError(
      "Equal Merkle roots cannot advertise different record counts",
    );
  }
  return {
    schema: RECONCILIATION_PROTOCOL_SCHEMA,
    local,
    remote,
    options,
    phase: equal ? "complete" : "nodes",
    pendingNodes: equal ? [] : [{ level: local.prefixBits, index: 0 }],
    pendingLeaves: [],
    localOnly: [],
    remoteOnly: [],
    collisions: [],
    counters: emptyCounters(),
  };
}

function structuralState(value: unknown): ReconciliationSessionState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidReplicationRecordError("Reconciliation state must be an object");
  }
  const state = value as Partial<ReconciliationSessionState>;
  if (
    state.schema !== RECONCILIATION_PROTOCOL_SCHEMA
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
    throw new InvalidReplicationRecordError("Malformed reconciliation state");
  }
  return state as ReconciliationSessionState;
}

async function validateRestoredState(state: ReconciliationSessionState): Promise<void> {
  const resolvedOptions = resolveSessionOptions(state.options);
  if (canonicalJson(resolvedOptions) !== canonicalJson(state.options)) {
    throw new InvalidReplicationRecordError("Restored reconciliation state options are not canonical");
  }
  validateViewInfo(state.local, "Restored local reconciliation view");
  validateViewInfo(state.remote, "Restored remote reconciliation view");
  if (state.local.prefixBits !== state.remote.prefixBits) {
    throw new InvalidReplicationRecordError("Restored reconciliation state has prefixBits mismatch");
  }
  for (const ref of state.pendingNodes) validateNodeRef(ref, state.local.prefixBits);
  for (const leafId of state.pendingLeaves) {
    if (!Number.isSafeInteger(leafId) || leafId < 0 || leafId >= 2 ** state.local.prefixBits) {
      throw new InvalidReplicationRecordError("Restored reconciliation state has invalid leaf id");
    }
  }
  assertPendingWorkBounds(state);
  const counters = Object.values(state.counters);
  if (counters.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new InvalidReplicationRecordError("Restored reconciliation state has invalid counters");
  }
  if (state.counters.steps > state.options.maxSteps) {
    throw new InvalidReplicationRecordError("Restored reconciliation state exceeds maxSteps");
  }
  const work = state.currentLeaf;
  if (work !== undefined) {
    if (!Number.isSafeInteger(work.leafId) || work.leafId < 0 || work.leafId >= 2 ** state.local.prefixBits) {
      throw new InvalidReplicationRecordError("Restored reconciliation state has invalid current leaf");
    }
    const localBuffer = await normalizeReplicationDescriptors(work.localBuffer);
    const remoteBuffer = await normalizeReplicationDescriptors(work.remoteBuffer);
    if (
      canonicalJson(localBuffer) !== canonicalJson(work.localBuffer)
      || canonicalJson(remoteBuffer) !== canonicalJson(work.remoteBuffer)
    ) {
      throw new InvalidReplicationRecordError("Restored reconciliation leaf buffers are not canonical");
    }
  }
}

export class BoundedReconciliationSession {
  readonly #state: ReconciliationSessionState;

  private constructor(state: ReconciliationSessionState) {
    this.#state = state;
  }

  static async start(
    local: ReconciliationViewReader,
    remote: ReconciliationEndpoint,
    remoteViewId: string,
    options: ReconciliationSessionOptions = {},
  ): Promise<BoundedReconciliationSession> {
    const localInfo = local.info();
    const remoteInfo = remote.viewInfo(remoteViewId);
    return new BoundedReconciliationSession(
      startState(localInfo, remoteInfo, resolveSessionOptions(options)),
    );
  }

  static async restore(encoded: string): Promise<BoundedReconciliationSession> {
    if (utf8Bytes(encoded).byteLength > MAX_RECONCILIATION_STATE_BYTES) {
      throw new ReconciliationLimitError(
        `Encoded reconciliation state exceeds ${MAX_RECONCILIATION_STATE_BYTES} bytes`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded);
    } catch {
      throw new InvalidReplicationRecordError("Reconciliation state is not valid JSON");
    }
    const state = structuralState(parsed);
    await validateRestoredState(state);
    return new BoundedReconciliationSession(state);
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

  result(): ReconciliationResult {
    if (!this.complete) throw new Error("Reconciliation is not complete");
    return {
      localOnly: sortResultKeys(this.#state.localOnly),
      remoteOnly: sortResultKeys(this.#state.remoteOnly),
      collisions: sortedCollisions(this.#state.collisions),
      counters: this.counters(),
    };
  }

  async step(
    local: ReconciliationViewReader,
    remote: ReconciliationEndpoint,
  ): Promise<void> {
    if (this.complete) return;
    if (this.#state.counters.steps >= this.#state.options.maxSteps) {
      throw new ReconciliationBudgetExceededError(this.#state.options.maxSteps);
    }
    assertView(this.#state.local, local.info());
    this.#state.counters.steps += 1;
    if (this.#state.phase === "nodes") {
      await this.#stepNodes(local, remote);
      return;
    }
    await this.#stepLeaf(local, remote);
  }

  async runToCompletion(
    local: ReconciliationViewReader,
    remote: ReconciliationEndpoint,
  ): Promise<ReconciliationResult> {
    while (!this.complete) await this.step(local, remote);
    return this.result();
  }

  async #stepNodes(
    local: ReconciliationViewReader,
    remote: ReconciliationEndpoint,
  ): Promise<void> {
    const refs = this.#state.pendingNodes.splice(0, this.#state.options.maxNodeRefsPerStep);
    const localResponse = local.nodeHashes(refs, {
      maxNodeRefs: this.#state.options.maxNodeRefsPerStep,
    });
    const remoteResponse = remote.nodeHashes(this.#state.remote.viewId, refs, {
      maxNodeRefs: this.#state.options.maxNodeRefsPerStep,
    });
    assertNodeResponse(this.#state.local, refs, localResponse);
    assertNodeResponse(this.#state.remote, refs, remoteResponse);
    this.#state.counters.remoteNodeQueries += 1;
    this.#state.counters.remoteNodeHashes += remoteResponse.nodes.length;

    refs.forEach((ref, index) => {
      if (localResponse.nodes[index]!.hash === remoteResponse.nodes[index]!.hash) return;
      if (ref.level === 0) {
        this.#state.pendingLeaves.push(ref.index);
        return;
      }
      this.#state.pendingNodes.push(
        { level: ref.level - 1, index: ref.index * 2 },
        { level: ref.level - 1, index: ref.index * 2 + 1 },
      );
    });

    assertPendingWorkBounds(this.#state);
    if (this.#state.pendingNodes.length === 0) {
      this.#state.pendingLeaves = [...new Set(this.#state.pendingLeaves)].toSorted((a, b) => a - b);
      assertPendingWorkBounds(this.#state);
      this.#state.phase = this.#state.pendingLeaves.length === 0 ? "complete" : "leaves";
    }
  }

  async #fetchLocalPage(
    local: ReconciliationViewReader,
    work: LeafWorkState,
  ): Promise<void> {
    if (work.localCompleted || work.localBuffer.length > 0) return;
    const page = await local.leafPage({
      leafId: work.leafId,
      ...(work.localCursor === undefined ? {} : { cursor: work.localCursor }),
      maxDescriptors: this.#state.options.maxLeafDescriptors,
      maxBytes: this.#state.options.maxLeafBytes,
    });
    await assertLeafResponse(this.#state.local, work.leafId, page, this.#state.options);
    work.localBuffer.push(...page.descriptors);
    if (page.nextCursor === undefined) delete work.localCursor;
    else work.localCursor = page.nextCursor;
    work.localCompleted = page.completed;
  }

  async #fetchRemotePage(
    remote: ReconciliationEndpoint,
    work: LeafWorkState,
  ): Promise<void> {
    if (work.remoteCompleted || work.remoteBuffer.length > 0) return;
    const page = await remote.leafPage(this.#state.remote.viewId, {
      leafId: work.leafId,
      ...(work.remoteCursor === undefined ? {} : { cursor: work.remoteCursor }),
      maxDescriptors: this.#state.options.maxLeafDescriptors,
      maxBytes: this.#state.options.maxLeafBytes,
    });
    await assertLeafResponse(this.#state.remote, work.leafId, page, this.#state.options);
    work.remoteBuffer.push(...page.descriptors);
    if (page.nextCursor === undefined) delete work.remoteCursor;
    else work.remoteCursor = page.nextCursor;
    work.remoteCompleted = page.completed;
    this.#state.counters.remoteLeafPages += 1;
    this.#state.counters.remoteLeafDescriptors += page.descriptors.length;
    this.#state.counters.remoteLeafBytes += page.estimatedBytes;
  }

  #mergeLeafBuffers(work: LeafWorkState): void {
    while (work.localBuffer.length > 0 && work.remoteBuffer.length > 0) {
      const left = work.localBuffer[0]!;
      const right = work.remoteBuffer[0]!;
      const order = left.key.localeCompare(right.key);
      if (order < 0) {
        this.#state.localOnly.push(left.key);
        work.localBuffer.shift();
        continue;
      }
      if (order > 0) {
        this.#state.remoteOnly.push(right.key);
        work.remoteBuffer.shift();
        continue;
      }
      if (left.payloadDigest !== right.payloadDigest) {
        this.#state.collisions.push({
          key: left.key,
          localDigest: left.payloadDigest,
          remoteDigest: right.payloadDigest,
        });
      } else {
        assertSameReplicationDescriptor(left, right);
      }
      work.localBuffer.shift();
      work.remoteBuffer.shift();
    }
    if (work.localCompleted && work.localBuffer.length === 0) {
      this.#state.remoteOnly.push(...work.remoteBuffer.map((value) => value.key));
      work.remoteBuffer.splice(0);
    }
    if (work.remoteCompleted && work.remoteBuffer.length === 0) {
      this.#state.localOnly.push(...work.localBuffer.map((value) => value.key));
      work.localBuffer.splice(0);
    }
  }

  async #stepLeaf(
    local: ReconciliationViewReader,
    remote: ReconciliationEndpoint,
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
