import { normalizeVaultEpochId, type VaultEpochId } from "@ssrl/e2e";
import type {
  OpaqueReplicationCollision,
  OpaqueReplicationDescriptor,
  OpaqueReplicationTag,
} from "./encrypted.js";
import {
  OpaqueReplicationEpochMismatchError,
  opaqueMerkleCodec,
  type OpaquePrefixMerkleIndex,
} from "./opaque-merkle.js";
import type { PrefixMerkleBits } from "./merkle.js";
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

export const OPAQUE_RECONCILIATION_PROTOCOL_SCHEMA = "ssrl-opaque-reconciliation-v1" as const;

export * from "./sync-public.js";

export interface OpaqueReconciliationViewInfo extends ProtocolViewInfoBase {
  readonly schema: typeof OPAQUE_RECONCILIATION_PROTOCOL_SCHEMA;
  readonly epochId: VaultEpochId;
}

declare const opaqueReconciliationLeafCursorBrand: unique symbol;
export type OpaqueReconciliationLeafCursor = string & {
  readonly [opaqueReconciliationLeafCursorBrand]: true;
};

export type OpaqueMerkleNodeHashResponse = ProtocolMerkleNodeHashResponse;
export type OpaqueLeafPageOptions = ProtocolLeafPageOptions<OpaqueReconciliationLeafCursor>;
export type OpaqueReconciliationLeafPage = ProtocolLeafPage<OpaqueReplicationDescriptor, OpaqueReconciliationLeafCursor>;
export type OpaqueReconciliationViewReader = ProtocolReconciliationViewReader<OpaqueReplicationDescriptor, OpaqueReconciliationViewInfo, OpaqueReconciliationLeafCursor>;
export type OpaqueReconciliationEndpoint = ProtocolReconciliationEndpoint<OpaqueReplicationDescriptor, OpaqueReconciliationViewInfo, OpaqueReconciliationLeafCursor>;
export type OpaqueReconciliationResult = ProtocolReconciliationResult<OpaqueReplicationTag, OpaqueReplicationCollision>;

const runtime = createReconciliationProtocolRuntime<
  OpaqueReplicationDescriptor,
  OpaqueReplicationTag,
  OpaqueReplicationCollision,
  OpaqueReconciliationViewInfo,
  OpaqueReconciliationLeafCursor,
  OpaquePrefixMerkleIndex
>({
  codec: opaqueMerkleCodec,
  schema: OPAQUE_RECONCILIATION_PROTOCOL_SCHEMA,
  coreIndex: (index) => index.coreForSync(),
  publicInfo: (info) => ({
    schema: OPAQUE_RECONCILIATION_PROTOCOL_SCHEMA,
    epochId: normalizeVaultEpochId(info.scopeId),
    ...protocolViewInfoBase(info),
  }),
  genericInfo: (info) => ({
    schema: OPAQUE_RECONCILIATION_PROTOCOL_SCHEMA,
    scopeId: normalizeVaultEpochId(info.epochId),
    ...protocolViewInfoBase(info),
  }),
  publicCursor: (cursor) => cursor as OpaqueReconciliationLeafCursor,
});

export const FrozenOpaquePrefixMerkleView = runtime.FrozenView;
export type FrozenOpaquePrefixMerkleView = Awaited<ReturnType<typeof FrozenOpaquePrefixMerkleView.open>>;

export const InMemoryOpaqueReconciliationViewRegistry = runtime.Registry;
export type InMemoryOpaqueReconciliationViewRegistry = InstanceType<typeof InMemoryOpaqueReconciliationViewRegistry>;

export const InMemoryOpaqueReconciliationEndpoint = runtime.Endpoint;
export type InMemoryOpaqueReconciliationEndpoint = InstanceType<typeof InMemoryOpaqueReconciliationEndpoint>;

export const OpaqueBoundedReconciliationSession = runtime.Session;
export type OpaqueBoundedReconciliationSession = Awaited<ReturnType<typeof OpaqueBoundedReconciliationSession.start>>;

export type { PrefixMerkleBits };
