import type { ArtifactDigest } from "@ssrl/artifact-store";
import type {
  ReplicationRecord,
  ReplicationRecordKey,
} from "@ssrl/replication";
import type {
  LeafPageOptions,
  MerkleNodeRef,
  NodeQueryOptions,
  ReconciliationLeafCursor,
} from "@ssrl/replication/sync";

export const REPLICATION_HTTP_BASE_PATH = "/v1/replication" as const;
export const REPLICATION_HTTP_ERROR_SCHEMA = "ssrl-replication-http-error-v1" as const;

export const REPLICATION_HTTP_ROUTES = {
  openProjection: `${REPLICATION_HTTP_BASE_PATH}/projection/open`,
  viewInfo: `${REPLICATION_HTTP_BASE_PATH}/view/info`,
  nodeHashes: `${REPLICATION_HTTP_BASE_PATH}/view/nodes`,
  leafPage: `${REPLICATION_HTTP_BASE_PATH}/view/leaf`,
  readRecords: `${REPLICATION_HTTP_BASE_PATH}/records/read`,
  applySemantic: `${REPLICATION_HTTP_BASE_PATH}/records/apply/semantic`,
  applyArtifacts: `${REPLICATION_HTTP_BASE_PATH}/records/apply/artifacts`,
  readBlob: `${REPLICATION_HTTP_BASE_PATH}/blob/read`,
  installBlob: `${REPLICATION_HTTP_BASE_PATH}/blob/install`,
} as const;

export type ReplicationHttpRoute = typeof REPLICATION_HTTP_ROUTES[keyof typeof REPLICATION_HTTP_ROUTES];

export interface ReplicationHttpErrorBody {
  readonly schema: typeof REPLICATION_HTTP_ERROR_SCHEMA;
  readonly code: string;
  readonly message: string;
}

export interface OpenProjectionRequestBody {
  readonly projectionId: string;
  readonly prefixBits?: 8 | 12 | 16;
  readonly leaseMs?: number;
}

export interface ViewInfoRequestBody {
  readonly projectionId: string;
  readonly viewId: string;
}

export interface NodeHashesRequestBody extends ViewInfoRequestBody {
  readonly refs: readonly MerkleNodeRef[];
  readonly maxNodeRefs?: NodeQueryOptions["maxNodeRefs"];
}

export interface LeafPageRequestBody extends ViewInfoRequestBody {
  readonly leafId: number;
  readonly cursor?: ReconciliationLeafCursor;
  readonly maxDescriptors?: LeafPageOptions["maxDescriptors"];
  readonly maxBytes?: LeafPageOptions["maxBytes"];
}

export interface ReadRecordsRequestBody extends ViewInfoRequestBody {
  readonly keys: readonly ReplicationRecordKey[];
  readonly maxRecords?: number;
  readonly maxBytes?: number;
}

export interface ApplyRecordsRequestBody {
  readonly projectionId: string;
  readonly records: readonly ReplicationRecord[];
  readonly maxRecords?: number;
  readonly maxBytes?: number;
}

export interface ReadBlobRequestBody extends ViewInfoRequestBody {
  readonly digest: ArtifactDigest;
  readonly maxBytes?: number;
}

export interface ApplyArtifactsResponseBody {
  readonly insertedMutations: number;
}

export const REPLICATION_BLOB_DIGEST_HEADER = "x-ssrl-blob-digest";
export const REPLICATION_BLOB_SIZE_HEADER = "x-ssrl-blob-size";

export const REPLICATION_BLOB_INSTALL_MEDIA_TYPE = "application/vnd.ssrl.replication-blob-install-v1" as const;

export interface InstallBlobFrameMetadata {
  readonly projectionId: string;
  readonly record: ReplicationRecord;
  readonly maxBytes?: number;
}

export interface InstallBlobResponseBody {
  readonly descriptor: {
    readonly digest: ArtifactDigest;
    readonly size: number;
    readonly mediaType: string;
  };
  readonly accounting: {
    readonly referencingRecords: number;
    readonly recordPolicyEvaluations: number;
    readonly blobPolicyEvaluations: number;
    readonly transferredBytes: number;
  };
}
