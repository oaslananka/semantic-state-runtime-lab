import type {
  ReplicationRecordCollision,
  ReplicationRecordDescriptor,
  ReplicationRecordKey,
} from "./index.js";
import {
  PLAINTEXT_RECONCILIATION_SCOPE,
  plaintextMerkleCodec,
  type PrefixMerkleIndex,
} from "./merkle.js";
import {
  createReconciliationProtocolRuntime,
  protocolViewInfoBase,
  type ProtocolLeafPage,
  type ProtocolLeafPageOptions,
  type ProtocolMerkleNodeHashResponse,
  type ProtocolReconciliationEndpoint,
  type ProtocolReconciliationResult,
  type ProtocolReconciliationViewReader,
  type ProtocolViewInfoBase,
} from "./sync-adapter.js";

export const RECONCILIATION_PROTOCOL_SCHEMA = "ssrl-reconciliation-v1" as const;

export * from "./sync-public.js";

export interface ReconciliationViewInfo extends ProtocolViewInfoBase {
  readonly schema: typeof RECONCILIATION_PROTOCOL_SCHEMA;
}

declare const reconciliationLeafCursorBrand: unique symbol;
export type ReconciliationLeafCursor = string & {
  readonly [reconciliationLeafCursorBrand]: true;
};

export type MerkleNodeHashResponse = ProtocolMerkleNodeHashResponse;
export type LeafPageOptions = ProtocolLeafPageOptions<ReconciliationLeafCursor>;
export type ReconciliationLeafPage = ProtocolLeafPage<ReplicationRecordDescriptor, ReconciliationLeafCursor>;
export type ReconciliationViewReader = ProtocolReconciliationViewReader<ReplicationRecordDescriptor, ReconciliationViewInfo, ReconciliationLeafCursor>;
export type ReconciliationEndpoint = ProtocolReconciliationEndpoint<ReplicationRecordDescriptor, ReconciliationViewInfo, ReconciliationLeafCursor>;
export type ReconciliationResult = ProtocolReconciliationResult<ReplicationRecordKey, ReplicationRecordCollision>;

const runtime = createReconciliationProtocolRuntime<
  ReplicationRecordDescriptor,
  ReplicationRecordKey,
  ReplicationRecordCollision,
  ReconciliationViewInfo,
  ReconciliationLeafCursor,
  PrefixMerkleIndex
>({
  codec: plaintextMerkleCodec,
  schema: RECONCILIATION_PROTOCOL_SCHEMA,
  coreIndex: (index) => index.coreForSync(),
  publicInfo: (info) => ({
    schema: RECONCILIATION_PROTOCOL_SCHEMA,
    ...protocolViewInfoBase(info),
  }),
  genericInfo: (info) => ({
    schema: RECONCILIATION_PROTOCOL_SCHEMA,
    scopeId: PLAINTEXT_RECONCILIATION_SCOPE,
    ...protocolViewInfoBase(info),
  }),
  publicCursor: (cursor) => cursor as ReconciliationLeafCursor,
});

export const FrozenPrefixMerkleView = runtime.FrozenView;
export type FrozenPrefixMerkleView = Awaited<ReturnType<typeof FrozenPrefixMerkleView.open>>;

export const InMemoryReconciliationViewRegistry = runtime.Registry;
export type InMemoryReconciliationViewRegistry = InstanceType<typeof InMemoryReconciliationViewRegistry>;

export const InMemoryReconciliationEndpoint = runtime.Endpoint;
export type InMemoryReconciliationEndpoint = InstanceType<typeof InMemoryReconciliationEndpoint>;

export const BoundedReconciliationSession = runtime.Session;
export type BoundedReconciliationSession = Awaited<ReturnType<typeof BoundedReconciliationSession.start>>;

// Keep PrefixMerkleBits reachable to downstream declaration consumers through ReconciliationViewInfo.
export type { PrefixMerkleBits } from "./merkle.js";
