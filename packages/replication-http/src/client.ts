import type { ArtifactDigest } from "@ssrl/artifact-store";
import { canonicalJson } from "@ssrl/core";
import {
  normalizeReplicationDescriptors,
  requiredArtifactBlobs,
  verifyReplicationRecord,
  type ReplicationRecord,
  type ReplicationRecordKey,
} from "@ssrl/replication";
import {
  RECONCILIATION_PROTOCOL_SCHEMA,
  type LeafPageOptions,
  type MerkleNodeHashResponse,
  type MerkleNodeRef,
  type NodeQueryOptions,
  type ReconciliationEndpoint,
  type ReconciliationLeafPage,
  type ReconciliationViewInfo,
} from "@ssrl/replication/sync";
import type { AuthorizedProjectionOpenResult } from "@ssrl/replication-access";
import {
  REPLICATION_BLOB_DIGEST_HEADER,
  REPLICATION_BLOB_INSTALL_MEDIA_TYPE,
  REPLICATION_BLOB_SIZE_HEADER,
  REPLICATION_HTTP_ERROR_SCHEMA,
  REPLICATION_HTTP_ROUTES,
  type ApplyArtifactsResponseBody,
  type ApplyRecordsRequestBody,
  type InstallBlobFrameMetadata,
  type InstallBlobResponseBody,
  type LeafPageRequestBody,
  type NodeHashesRequestBody,
  type OpenProjectionRequestBody,
  type ReadBlobRequestBody,
  type ReadRecordsRequestBody,
  type ReplicationHttpErrorBody,
  type ViewInfoRequestBody,
} from "./protocol.js";
import {
  collectBoundedBytes,
  exactObjectKeys,
  nonEmptyString,
  normalizedMediaType,
  objectRecord,
  parseUtf8Json,
} from "./wire.js";

const DEFAULT_MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
const HARD_MAX_RESPONSE_BYTES = 128 * 1024 * 1024;

export type ReplicationHttpFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ReplicationHttpClientOptions {
  readonly baseUrl: URL;
  readonly fetch?: ReplicationHttpFetch;
  readonly headers?: () => HeadersInit | Promise<HeadersInit>;
  readonly maxJsonResponseBytes?: number;
  readonly maxBlobResponseBytes?: number;
  readonly maxBlobRequestBytes?: number;
}

export class ReplicationHttpRemoteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReplicationHttpRemoteError";
  }
}

export class InvalidReplicationHttpResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReplicationHttpResponseError";
  }
}

function secureBaseUrl(value: URL): URL {
  const url = new URL(value.toString());
  const loopback = url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]"
    || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new TypeError("Replication HTTP client requires HTTPS outside loopback");
  }
  return url;
}

function responseLimit(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > HARD_MAX_RESPONSE_BYTES) {
    throw new RangeError(`${label} must be between 1 and ${HARD_MAX_RESPONSE_BYTES}`);
  }
  return resolved;
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  return collectBoundedBytes({
    body: response.body,
    contentLength: response.headers.get("content-length"),
    maxBytes,
    invalidLength: () => new InvalidReplicationHttpResponseError(
      "Remote response has invalid Content-Length",
    ),
    tooLarge: () => new InvalidReplicationHttpResponseError(
      "Remote response exceeds configured byte limit",
    ),
  });
}

function jsonMediaType(response: Response): void {
  if (normalizedMediaType(response.headers) !== "application/json") {
    throw new InvalidReplicationHttpResponseError("Remote response is not application/json");
  }
}

async function parseJsonBytes(response: Response, maxBytes: number): Promise<unknown> {
  jsonMediaType(response);
  return parseUtf8Json(
    await readResponseBytes(response, maxBytes),
    () => new InvalidReplicationHttpResponseError("Remote JSON response is not valid UTF-8"),
    () => new InvalidReplicationHttpResponseError("Remote response is not valid JSON"),
  );
}

function invalidResponse(message: string): Error {
  return new InvalidReplicationHttpResponseError(message);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  return objectRecord(value, label, invalidResponse);
}

function exactResponseKeys(
  body: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): void {
  exactObjectKeys(body, allowed, label, invalidResponse);
}

const REPLICATION_RECORD_FIELDS = [
  "key",
  "kind",
  "recordId",
  "payloadDigest",
  "fingerprint",
  "payloadBytes",
  "payload",
] as const;

const REPLICATION_DESCRIPTOR_FIELDS = [
  "key",
  "kind",
  "recordId",
  "payloadDigest",
  "fingerprint",
  "payloadBytes",
] as const;

function replicationRecordValue(value: unknown): ReplicationRecord {
  const record = objectValue(value, "Replication record");
  exactResponseKeys(record, REPLICATION_RECORD_FIELDS, "Replication record");
  return record as unknown as ReplicationRecord;
}

function stringValue(value: unknown, label: string): string {
  return nonEmptyString(value, label, invalidResponse);
}

function integerValue(value: unknown, label: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) {
    throw new InvalidReplicationHttpResponseError(`${label} must be an integer >= ${min}`);
  }
  return value as number;
}

async function remoteError(response: Response, maxBytes: number): Promise<never> {
  let body: unknown;
  try {
    body = await parseJsonBytes(response, maxBytes);
  } catch {
    throw new ReplicationHttpRemoteError(response.status, "remote-error", "Replication remote request failed");
  }
  const value = objectValue(body, "Remote error");
  const code = value.schema === REPLICATION_HTTP_ERROR_SCHEMA && typeof value.code === "string"
    ? value.code
    : "remote-error";
  const message = value.schema === REPLICATION_HTTP_ERROR_SCHEMA && typeof value.message === "string"
    ? value.message
    : "Replication remote request failed";
  throw new ReplicationHttpRemoteError(response.status, code, message);
}

function validateViewInfo(value: unknown): ReconciliationViewInfo {
  const body = objectValue(value, "Reconciliation view");
  exactResponseKeys(
    body,
    ["schema", "viewId", "prefixBits", "rootDigest", "recordCount"],
    "Reconciliation view",
  );
  const prefixBits = body.prefixBits;
  if (prefixBits !== 8 && prefixBits !== 12 && prefixBits !== 16) {
    throw new InvalidReplicationHttpResponseError("Remote view has invalid prefixBits");
  }
  const recordCount = integerValue(body.recordCount, "recordCount");
  const schema = stringValue(body.schema, "schema");
  const rootDigest = stringValue(body.rootDigest, "rootDigest");
  if (schema !== RECONCILIATION_PROTOCOL_SCHEMA) {
    throw new InvalidReplicationHttpResponseError("Remote view uses unsupported schema");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(rootDigest)) {
    throw new InvalidReplicationHttpResponseError("Remote view has invalid rootDigest");
  }
  return {
    schema: RECONCILIATION_PROTOCOL_SCHEMA,
    viewId: stringValue(body.viewId, "viewId"),
    prefixBits,
    rootDigest,
    recordCount,
  };
}

function validateNodeResponse(value: unknown): MerkleNodeHashResponse {
  const body = objectValue(value, "Merkle node response");
  exactResponseKeys(body, ["viewId", "rootDigest", "nodes"], "Merkle node response");
  if (!Array.isArray(body.nodes)) {
    throw new InvalidReplicationHttpResponseError("Merkle node response nodes must be an array");
  }
  return {
    viewId: stringValue(body.viewId, "viewId"),
    rootDigest: stringValue(body.rootDigest, "rootDigest"),
    nodes: body.nodes.map((item) => {
      const node = objectValue(item, "Merkle node");
      exactResponseKeys(node, ["level", "index", "hash"], "Merkle node");
      const hash = stringValue(node.hash, "hash");
      if (!/^sha256:[0-9a-f]{64}$/.test(hash)) {
        throw new InvalidReplicationHttpResponseError("Merkle node response contains invalid hash");
      }
      return {
        level: integerValue(node.level, "level"),
        index: integerValue(node.index, "index"),
        hash,
      };
    }),
  };
}

async function validateLeafPage(value: unknown): Promise<ReconciliationLeafPage> {
  const body = objectValue(value, "Merkle leaf response");
  exactResponseKeys(
    body,
    ["viewId", "rootDigest", "leafId", "descriptors", "estimatedBytes", "nextCursor", "completed"],
    "Merkle leaf response",
  );
  if (!Array.isArray(body.descriptors)) {
    throw new InvalidReplicationHttpResponseError("Merkle leaf descriptors must be an array");
  }
  if (typeof body.completed !== "boolean") {
    throw new InvalidReplicationHttpResponseError("Merkle leaf completed must be boolean");
  }
  if (body.nextCursor !== undefined && typeof body.nextCursor !== "string") {
    throw new InvalidReplicationHttpResponseError("Merkle leaf cursor must be a string");
  }
  let descriptors: ReconciliationLeafPage["descriptors"];
  try {
    const descriptorValues = body.descriptors.map((item) => {
      const descriptor = objectValue(item, "Replication descriptor");
      exactResponseKeys(
        descriptor,
        REPLICATION_DESCRIPTOR_FIELDS,
        "Replication descriptor",
      );
      return descriptor;
    });
    descriptors = await normalizeReplicationDescriptors(
      descriptorValues as unknown as ReconciliationLeafPage["descriptors"],
    );
  } catch {
    throw new InvalidReplicationHttpResponseError("Merkle leaf descriptors are invalid");
  }
  if (canonicalJson(descriptors) !== canonicalJson(body.descriptors)) {
    throw new InvalidReplicationHttpResponseError("Merkle leaf descriptors are not canonical/sorted");
  }
  const rootDigest = stringValue(body.rootDigest, "rootDigest");
  if (!/^sha256:[0-9a-f]{64}$/.test(rootDigest)) {
    throw new InvalidReplicationHttpResponseError("Merkle leaf response has invalid rootDigest");
  }
  return {
    viewId: stringValue(body.viewId, "viewId"),
    rootDigest,
    leafId: integerValue(body.leafId, "leafId"),
    descriptors,
    estimatedBytes: integerValue(body.estimatedBytes, "estimatedBytes"),
    ...(body.nextCursor === undefined
      ? {}
      : { nextCursor: body.nextCursor as NonNullable<ReconciliationLeafPage["nextCursor"]> }),
    completed: body.completed,
  };
}

async function sha256Digest(bytes: Uint8Array): Promise<string> {
  const copy = Uint8Array.from(bytes);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy.buffer));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export class ReplicationHttpClient {
  readonly #baseUrl: URL;
  readonly #fetch: ReplicationHttpFetch;
  readonly #headers: (() => HeadersInit | Promise<HeadersInit>) | undefined;
  readonly #maxJsonResponseBytes: number;
  readonly #maxBlobResponseBytes: number;
  readonly #maxBlobRequestBytes: number;

  constructor(options: ReplicationHttpClientOptions) {
    this.#baseUrl = secureBaseUrl(options.baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#headers = options.headers;
    this.#maxJsonResponseBytes = responseLimit(
      options.maxJsonResponseBytes,
      DEFAULT_MAX_JSON_RESPONSE_BYTES,
      "maxJsonResponseBytes",
    );
    this.#maxBlobResponseBytes = responseLimit(
      options.maxBlobResponseBytes,
      64 * 1024 * 1024,
      "maxBlobResponseBytes",
    );
    this.#maxBlobRequestBytes = responseLimit(
      options.maxBlobRequestBytes,
      65 * 1024 * 1024,
      "maxBlobRequestBytes",
    );
  }

  async #request(
    path: string,
    body: BodyInit,
    contentType: string,
    accept: string,
  ): Promise<Response> {
    const headers = new Headers(await this.#headers?.());
    headers.set("content-type", contentType);
    headers.set("accept", accept);
    const response = await this.#fetch(new URL(path, this.#baseUrl), {
      method: "POST",
      headers,
      body,
    });
    if (!response.ok) await remoteError(response, this.#maxJsonResponseBytes);
    return response;
  }

  async #post(path: string, body: unknown): Promise<Response> {
    return this.#request(path, JSON.stringify(body), "application/json", "application/json");
  }

  async #json(path: string, body: unknown): Promise<unknown> {
    return parseJsonBytes(await this.#post(path, body), this.#maxJsonResponseBytes);
  }

  async openProjection(input: OpenProjectionRequestBody): Promise<AuthorizedProjectionOpenResult> {
    const value = objectValue(
      await this.#json(REPLICATION_HTTP_ROUTES.openProjection, input),
      "Projection open response",
    );
    exactResponseKeys(
      value,
      ["view", "projectionId", "policyVersion", "expiresAt", "accounting"],
      "Projection open response",
    );
    const accounting = objectValue(value.accounting, "Projection accounting");
    exactResponseKeys(
      accounting,
      ["sourceRecordsScanned", "policyEvaluations", "allowedDescriptors"],
      "Projection accounting",
    );
    const view = validateViewInfo(value.view);
    const projectionId = stringValue(value.projectionId, "projectionId");
    if (projectionId !== input.projectionId) {
      throw new InvalidReplicationHttpResponseError("Projection response does not match request");
    }
    return {
      view,
      projectionId,
      policyVersion: stringValue(value.policyVersion, "policyVersion"),
      expiresAt: stringValue(value.expiresAt, "expiresAt"),
      accounting: {
        sourceRecordsScanned: integerValue(accounting.sourceRecordsScanned, "sourceRecordsScanned"),
        policyEvaluations: integerValue(accounting.policyEvaluations, "policyEvaluations"),
        allowedDescriptors: integerValue(accounting.allowedDescriptors, "allowedDescriptors"),
      },
    };
  }

  endpoint(projectionId: string): ReconciliationEndpoint {
    return {
      viewInfo: (viewId) => this.viewInfo({ projectionId, viewId }),
      nodeHashes: (viewId, refs, options) => this.nodeHashes({
        projectionId,
        viewId,
        refs,
        ...(options?.maxNodeRefs === undefined ? {} : { maxNodeRefs: options.maxNodeRefs }),
      }),
      leafPage: (viewId, options) => this.leafPage({
        projectionId,
        viewId,
        leafId: options.leafId,
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        ...(options.maxDescriptors === undefined ? {} : { maxDescriptors: options.maxDescriptors }),
        ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      }),
    };
  }

  async viewInfo(input: ViewInfoRequestBody): Promise<ReconciliationViewInfo> {
    const result = validateViewInfo(await this.#json(REPLICATION_HTTP_ROUTES.viewInfo, input));
    if (result.viewId !== input.viewId) {
      throw new InvalidReplicationHttpResponseError("View response does not match request");
    }
    return result;
  }

  async nodeHashes(input: NodeHashesRequestBody): Promise<MerkleNodeHashResponse> {
    const result = validateNodeResponse(await this.#json(REPLICATION_HTTP_ROUTES.nodeHashes, input));
    if (result.viewId !== input.viewId || result.nodes.length !== input.refs.length) {
      throw new InvalidReplicationHttpResponseError("Node response does not match request");
    }
    result.nodes.forEach((node, index) => {
      const expected = input.refs[index]!;
      if (node.level !== expected.level || node.index !== expected.index) {
        throw new InvalidReplicationHttpResponseError("Node response reference order mismatch");
      }
    });
    return result;
  }

  async leafPage(input: LeafPageRequestBody): Promise<ReconciliationLeafPage> {
    const result = await validateLeafPage(await this.#json(REPLICATION_HTTP_ROUTES.leafPage, input));
    if (result.viewId !== input.viewId || result.leafId !== input.leafId) {
      throw new InvalidReplicationHttpResponseError("Leaf response does not match request");
    }
    return result;
  }

  async readRecords(input: ReadRecordsRequestBody): Promise<ReplicationRecord[]> {
    const value = await this.#json(REPLICATION_HTTP_ROUTES.readRecords, input);
    if (!Array.isArray(value)) {
      throw new InvalidReplicationHttpResponseError("Record read response must be an array");
    }
    const records: ReplicationRecord[] = [];
    try {
      for (const candidate of value) {
        records.push(await verifyReplicationRecord(replicationRecordValue(candidate)));
      }
    } catch {
      throw new InvalidReplicationHttpResponseError("Record read response contains invalid envelopes");
    }
    const expected = [...new Set(input.keys)].toSorted((left, right) => left.localeCompare(right));
    const actual = records.map((record) => record.key).toSorted((left, right) => left.localeCompare(right));
    if (canonicalJson(expected) !== canonicalJson(actual)) {
      throw new InvalidReplicationHttpResponseError("Record read response key set does not match request");
    }
    return records;
  }

  async applySemantic(input: ApplyRecordsRequestBody): Promise<void> {
    const value = objectValue(
      await this.#json(REPLICATION_HTTP_ROUTES.applySemantic, input),
      "Semantic apply response",
    );
    exactResponseKeys(value, ["applied"], "Semantic apply response");
    if (value.applied !== true) {
      throw new InvalidReplicationHttpResponseError("Semantic apply response is invalid");
    }
  }

  async applyArtifacts(input: ApplyRecordsRequestBody): Promise<number> {
    const value = objectValue(
      await this.#json(REPLICATION_HTTP_ROUTES.applyArtifacts, input),
      "Artifact apply response",
    );
    exactResponseKeys(value, ["insertedMutations"], "Artifact apply response");
    return integerValue(value.insertedMutations, "insertedMutations");
  }

  async installArtifactBlob(input: {
    readonly projectionId: string;
    readonly record: ReplicationRecord;
    readonly bytes: Uint8Array;
    readonly maxBytes?: number;
  }): Promise<InstallBlobResponseBody> {
    const record = await verifyReplicationRecord(input.record);
    const required = await requiredArtifactBlobs([record]);
    const expectedBlob = required[0];
    if (expectedBlob === undefined || required.length !== 1) {
      throw new TypeError("Blob install requires one artifact upsert record");
    }
    const metadata: InstallBlobFrameMetadata = {
      projectionId: input.projectionId,
      record,
      ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
    };
    const metadataBytes = new TextEncoder().encode(canonicalJson(metadata));
    if (metadataBytes.byteLength > 0xffff_ffff) {
      throw new RangeError("Blob install metadata exceeds uint32 framing limit");
    }
    const total = 4 + metadataBytes.byteLength + input.bytes.byteLength;
    if (total > this.#maxBlobRequestBytes) {
      throw new RangeError("Blob install request exceeds configured client byte limit");
    }
    const frame = new Uint8Array(total);
    new DataView(frame.buffer).setUint32(0, metadataBytes.byteLength, false);
    frame.set(metadataBytes, 4);
    frame.set(input.bytes, 4 + metadataBytes.byteLength);
    const response = await this.#request(
      REPLICATION_HTTP_ROUTES.installBlob,
      frame,
      REPLICATION_BLOB_INSTALL_MEDIA_TYPE,
      "application/json",
    );
    const value = objectValue(
      await parseJsonBytes(response, this.#maxJsonResponseBytes),
      "Blob install response",
    );
    exactResponseKeys(value, ["descriptor", "accounting"], "Blob install response");
    const descriptor = objectValue(value.descriptor, "Blob install descriptor");
    exactResponseKeys(descriptor, ["digest", "size", "mediaType"], "Blob install descriptor");
    const accounting = objectValue(value.accounting, "Blob install accounting");
    exactResponseKeys(
      accounting,
      [
        "referencingRecords",
        "recordPolicyEvaluations",
        "blobPolicyEvaluations",
        "transferredBytes",
      ],
      "Blob install accounting",
    );
    const parsedDescriptor = {
      digest: stringValue(descriptor.digest, "digest") as ArtifactDigest,
      size: integerValue(descriptor.size, "size"),
      mediaType: stringValue(descriptor.mediaType, "mediaType"),
    };
    if (
      parsedDescriptor.digest !== expectedBlob.digest
      || parsedDescriptor.size !== expectedBlob.size
      || !expectedBlob.mediaTypes.includes(parsedDescriptor.mediaType)
      || parsedDescriptor.size !== input.bytes.byteLength
      || await sha256Digest(input.bytes) !== parsedDescriptor.digest
    ) {
      throw new InvalidReplicationHttpResponseError("Blob install response does not match request bytes/record");
    }
    return {
      descriptor: parsedDescriptor,
      accounting: {
        referencingRecords: integerValue(accounting.referencingRecords, "referencingRecords"),
        recordPolicyEvaluations: integerValue(
          accounting.recordPolicyEvaluations,
          "recordPolicyEvaluations",
        ),
        blobPolicyEvaluations: integerValue(accounting.blobPolicyEvaluations, "blobPolicyEvaluations"),
        transferredBytes: integerValue(accounting.transferredBytes, "transferredBytes"),
      },
    };
  }

  async readArtifactBlob(input: ReadBlobRequestBody): Promise<{
    readonly digest: ArtifactDigest;
    readonly size: number;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
  }> {
    const response = await this.#request(
      REPLICATION_HTTP_ROUTES.readBlob,
      JSON.stringify(input),
      "application/json",
      "application/octet-stream, */*",
    );
    const digest = response.headers.get(REPLICATION_BLOB_DIGEST_HEADER);
    const sizeText = response.headers.get(REPLICATION_BLOB_SIZE_HEADER);
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (digest === null || sizeText === null || mediaType === undefined || mediaType.length === 0) {
      throw new InvalidReplicationHttpResponseError("Blob response is missing required metadata headers");
    }
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0 || size > this.#maxBlobResponseBytes) {
      throw new InvalidReplicationHttpResponseError("Blob response has invalid size metadata");
    }
    const bytes = await readResponseBytes(response, this.#maxBlobResponseBytes);
    if (bytes.byteLength !== size) {
      throw new InvalidReplicationHttpResponseError("Blob response size does not match body bytes");
    }
    if (digest !== input.digest || await sha256Digest(bytes) !== digest) {
      throw new InvalidReplicationHttpResponseError("Blob response digest verification failed");
    }
    return { digest: digest as ArtifactDigest, size, mediaType, bytes };
  }
}
