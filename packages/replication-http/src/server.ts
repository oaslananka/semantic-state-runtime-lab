import { canonicalJson } from "@ssrl/core";
import {
  normalizeAccessPrincipal,
  type AccessPrincipal,
} from "@ssrl/access";
import type { ArtifactStore } from "@ssrl/artifact-store";
import {
  InvalidReplicationRecordError,
  type ReplicationRecord,
} from "@ssrl/replication";
import {
  InvalidReconciliationCursorError,
  ReconciliationLimitError,
  StaleReconciliationViewError,
} from "@ssrl/replication/sync";
import {
  ReplicationAccessGateway,
  ReplicationAccessLimitError,
  ReplicationApplyDeniedError,
  ReplicationArtifactBlobApplyDeniedError,
  ReplicationArtifactBlobIntegrityError,
  ReplicationArtifactBlobUnavailableError,
  ReplicationAuthorizationViewError,
  ReplicationRecordUnavailableError,
} from "@ssrl/replication-access";
import type { SemanticStateStore } from "@ssrl/state-store";
import {
  REPLICATION_BLOB_DIGEST_HEADER,
  REPLICATION_BLOB_INSTALL_MEDIA_TYPE,
  REPLICATION_BLOB_SIZE_HEADER,
  REPLICATION_HTTP_ERROR_SCHEMA,
  REPLICATION_HTTP_ROUTES,
  type ApplyRecordsRequestBody,
  type InstallBlobFrameMetadata,
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
  positiveInteger,
} from "./wire.js";

const DEFAULT_MAX_JSON_REQUEST_BYTES = 1024 * 1024;
const HARD_MAX_JSON_REQUEST_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_BLOB_INSTALL_REQUEST_BYTES = 65 * 1024 * 1024;
const HARD_MAX_BLOB_INSTALL_REQUEST_BYTES = 1024 * 1024 * 1024;
const MAX_BLOB_INSTALL_METADATA_BYTES = 1024 * 1024;

export interface ReplicationHttpAuthenticator {
  authenticate(request: Request): AccessPrincipal | Response | Promise<AccessPrincipal | Response>;
}

export interface ReplicationHttpServerOptions {
  readonly gateway: ReplicationAccessGateway;
  readonly semanticStore: SemanticStateStore;
  readonly artifactStore: ArtifactStore;
  readonly authenticator: ReplicationHttpAuthenticator;
  readonly allowedHostnames: readonly string[];
  readonly allowedOriginHostnames?: readonly string[];
  readonly maxJsonRequestBytes?: number;
  readonly maxBlobInstallRequestBytes?: number;
}

export interface ReplicationHttpHandler {
  fetch(request: Request): Promise<Response>;
}

export class ReplicationHttpProtocolError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReplicationHttpProtocolError";
  }
}

function uniqueHostnames(values: readonly string[], label: string): ReadonlySet<string> {
  const normalized = values.map((value) => value.trim().toLowerCase());
  if (normalized.length === 0 || normalized.some((value) => value.length === 0)) {
    throw new TypeError(`${label} must contain non-empty hostnames`);
  }
  return new Set(normalized);
}

function configuredJsonLimit(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_JSON_REQUEST_BYTES;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > HARD_MAX_JSON_REQUEST_BYTES) {
    throw new RangeError(
      `maxJsonRequestBytes must be an integer between 1 and ${HARD_MAX_JSON_REQUEST_BYTES}`,
    );
  }
  return resolved;
}

function configuredBlobInstallLimit(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_BLOB_INSTALL_REQUEST_BYTES;
  if (
    !Number.isSafeInteger(resolved)
    || resolved < 5
    || resolved > HARD_MAX_BLOB_INSTALL_REQUEST_BYTES
  ) {
    throw new RangeError(
      `maxBlobInstallRequestBytes must be an integer between 5 and ${HARD_MAX_BLOB_INSTALL_REQUEST_BYTES}`,
    );
  }
  return resolved;
}

function hostnameFromHostHeader(value: string): string {
  try {
    const authority = value.trim();
    if (authority.length === 0 || authority !== value) throw new Error("invalid host whitespace");
    const parsed = new URL(`http://${authority}`);
    if (
      parsed.username.length > 0
      || parsed.password.length > 0
      || parsed.pathname !== "/"
      || parsed.search.length > 0
      || parsed.hash.length > 0
    ) {
      throw new Error("invalid host authority");
    }
    return parsed.hostname.toLowerCase();
  } catch {
    throw new ReplicationHttpProtocolError(400, "invalid-host", "Invalid request host");
  }
}

function validateHost(request: Request, allowed: ReadonlySet<string>): void {
  const urlHostname = new URL(request.url).hostname.toLowerCase();
  if (!allowed.has(urlHostname)) {
    throw new ReplicationHttpProtocolError(421, "host-not-allowed", "Request host is not allowed");
  }
  const host = request.headers.get("host");
  if (host !== null && !allowed.has(hostnameFromHostHeader(host))) {
    throw new ReplicationHttpProtocolError(421, "host-not-allowed", "Request host is not allowed");
  }
}

function validateOrigin(request: Request, allowed: ReadonlySet<string>): void {
  const origin = request.headers.get("origin");
  if (origin === null) return;
  let hostname: string;
  try {
    const parsed = new URL(origin);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username.length > 0
      || parsed.password.length > 0
      || parsed.pathname !== "/"
      || parsed.search.length > 0
      || parsed.hash.length > 0
    ) {
      throw new Error("invalid origin");
    }
    hostname = parsed.hostname.toLowerCase();
  } catch {
    throw new ReplicationHttpProtocolError(403, "origin-not-allowed", "Request origin is not allowed");
  }
  if (!allowed.has(hostname)) {
    throw new ReplicationHttpProtocolError(403, "origin-not-allowed", "Request origin is not allowed");
  }
}

function exactContentType(request: Request, expected: string): void {
  if (normalizedMediaType(request.headers) !== expected) {
    throw new ReplicationHttpProtocolError(415, "unsupported-media-type", `Expected ${expected}`);
  }
}

function jsonContentType(request: Request): void {
  exactContentType(request, "application/json");
}

async function boundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  return collectBoundedBytes({
    body: request.body,
    contentLength: request.headers.get("content-length"),
    maxBytes,
    invalidLength: () => new ReplicationHttpProtocolError(
      400,
      "invalid-content-length",
      "Invalid Content-Length",
    ),
    tooLarge: () => new ReplicationHttpProtocolError(
      413,
      "request-too-large",
      "Request body exceeds limit",
    ),
  });
}

async function jsonBody(request: Request, maxBytes: number): Promise<unknown> {
  jsonContentType(request);
  return parseUtf8Json(
    await boundedBody(request, maxBytes),
    () => new ReplicationHttpProtocolError(400, "invalid-json", "Request body is not valid UTF-8 JSON"),
    () => new ReplicationHttpProtocolError(400, "invalid-json", "Request body is not valid JSON"),
  );
}

function installBlobMetadata(value: unknown): InstallBlobFrameMetadata {
  const body = objectBody(value);
  exactRequestKeys(body, ["projectionId", "record", "maxBytes"]);
  return {
    projectionId: requiredString(body.projectionId, "projectionId"),
    record: replicationRecordBody(body.record),
    ...(body.maxBytes === undefined
      ? {}
      : { maxBytes: optionalPositiveInteger(body.maxBytes, "maxBytes")! }),
  };
}

async function blobInstallFrame(
  request: Request,
  maxRequestBytes: number,
): Promise<{ readonly metadata: InstallBlobFrameMetadata; readonly bytes: Uint8Array }> {
  exactContentType(request, REPLICATION_BLOB_INSTALL_MEDIA_TYPE);
  const frame = await boundedBody(request, maxRequestBytes);
  if (frame.byteLength < 4) {
    throw new ReplicationHttpProtocolError(400, "invalid-blob-frame", "Blob install frame is truncated");
  }
  const metadataLength = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, false);
  if (metadataLength < 2 || metadataLength > MAX_BLOB_INSTALL_METADATA_BYTES) {
    throw new ReplicationHttpProtocolError(400, "invalid-blob-frame", "Blob install metadata length is invalid");
  }
  const metadataEnd = 4 + metadataLength;
  if (metadataEnd > frame.byteLength) {
    throw new ReplicationHttpProtocolError(400, "invalid-blob-frame", "Blob install frame is truncated");
  }
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(4, metadataEnd));
    parsed = JSON.parse(text) as unknown;
    if (canonicalJson(parsed) !== text) {
      throw new ReplicationHttpProtocolError(
        400,
        "invalid-blob-frame",
        "Blob install metadata must use canonical JSON",
      );
    }
  } catch (error) {
    if (error instanceof ReplicationHttpProtocolError) throw error;
    throw new ReplicationHttpProtocolError(400, "invalid-blob-frame", "Blob install metadata is invalid");
  }
  return { metadata: installBlobMetadata(parsed), bytes: frame.slice(metadataEnd) };
}

function invalidRequest(message: string): Error {
  return new ReplicationHttpProtocolError(400, "invalid-request", message);
}

function objectBody(value: unknown): Record<string, unknown> {
  return objectRecord(value, "Request body", invalidRequest);
}

function exactRequestKeys(
  body: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): void {
  exactObjectKeys(body, allowed, "Request body", invalidRequest);
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

function replicationRecordBody(value: unknown): ReplicationRecord {
  const record = objectRecord(value, "Replication record", invalidRequest);
  exactObjectKeys(record, REPLICATION_RECORD_FIELDS, "Replication record", invalidRequest);
  return record as unknown as ReplicationRecord;
}

function requiredString(value: unknown, label: string): string {
  return nonEmptyString(value, label, invalidRequest);
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  return positiveInteger(value, label, invalidRequest);
}

function viewFields(body: Readonly<Record<string, unknown>>): ViewInfoRequestBody {
  return {
    projectionId: requiredString(body.projectionId, "projectionId"),
    viewId: requiredString(body.viewId, "viewId"),
  };
}

function viewBody(value: unknown): ViewInfoRequestBody {
  const body = objectBody(value);
  exactRequestKeys(body, ["projectionId", "viewId"]);
  return viewFields(body);
}

function openProjectionBody(value: unknown): OpenProjectionRequestBody {
  const body = objectBody(value);
  exactRequestKeys(body, ["projectionId", "prefixBits", "leaseMs"]);
  const prefixBits = body.prefixBits;
  if (prefixBits !== undefined && prefixBits !== 8 && prefixBits !== 12 && prefixBits !== 16) {
    throw new ReplicationHttpProtocolError(400, "invalid-request", "prefixBits must be 8, 12 or 16");
  }
  return {
    projectionId: requiredString(body.projectionId, "projectionId"),
    ...(prefixBits === undefined ? {} : { prefixBits }),
    ...(body.leaseMs === undefined ? {} : { leaseMs: optionalPositiveInteger(body.leaseMs, "leaseMs")! }),
  };
}

function nodeHashesBody(value: unknown): NodeHashesRequestBody {
  const body = objectBody(value);
  exactRequestKeys(body, ["projectionId", "viewId", "refs", "maxNodeRefs"]);
  const base = viewFields(body);
  if (!Array.isArray(body.refs)) {
    throw new ReplicationHttpProtocolError(400, "invalid-request", "refs must be an array");
  }
  const refs = body.refs.map((entry) => {
    const ref = objectBody(entry);
    exactObjectKeys(ref, ["level", "index"], "Merkle ref", invalidRequest);
    if (!Number.isSafeInteger(ref.level) || !Number.isSafeInteger(ref.index)) {
      throw new ReplicationHttpProtocolError(400, "invalid-request", "Merkle refs must contain integer level/index");
    }
    return { level: ref.level as number, index: ref.index as number };
  });
  const maxNodeRefs = optionalPositiveInteger(body.maxNodeRefs, "maxNodeRefs");
  return { ...base, refs, ...(maxNodeRefs === undefined ? {} : { maxNodeRefs }) };
}

function leafPageBody(value: unknown): LeafPageRequestBody {
  const body = objectBody(value);
  exactRequestKeys(body, [
    "projectionId",
    "viewId",
    "leafId",
    "cursor",
    "maxDescriptors",
    "maxBytes",
  ]);
  const base = viewFields(body);
  if (!Number.isSafeInteger(body.leafId) || (body.leafId as number) < 0) {
    throw new ReplicationHttpProtocolError(400, "invalid-request", "leafId must be a non-negative integer");
  }
  if (body.cursor !== undefined && typeof body.cursor !== "string") {
    throw new ReplicationHttpProtocolError(400, "invalid-request", "cursor must be a string");
  }
  const maxDescriptors = optionalPositiveInteger(body.maxDescriptors, "maxDescriptors");
  const maxBytes = optionalPositiveInteger(body.maxBytes, "maxBytes");
  return {
    ...base,
    leafId: body.leafId as number,
    ...(body.cursor === undefined
      ? {}
      : { cursor: body.cursor as NonNullable<LeafPageRequestBody["cursor"]> }),
    ...(maxDescriptors === undefined ? {} : { maxDescriptors }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  };
}

function transferLimits(body: Record<string, unknown>): {
  readonly maxRecords?: number;
  readonly maxBytes?: number;
} {
  const maxRecords = optionalPositiveInteger(body.maxRecords, "maxRecords");
  const maxBytes = optionalPositiveInteger(body.maxBytes, "maxBytes");
  return {
    ...(maxRecords === undefined ? {} : { maxRecords }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  };
}

function readRecordsBody(value: unknown): ReadRecordsRequestBody {
  const body = objectBody(value);
  exactRequestKeys(body, ["projectionId", "viewId", "keys", "maxRecords", "maxBytes"]);
  const base = viewFields(body);
  if (!Array.isArray(body.keys) || body.keys.some((key) => typeof key !== "string")) {
    throw new ReplicationHttpProtocolError(400, "invalid-request", "keys must be a string array");
  }
  return {
    ...base,
    keys: body.keys as ReadRecordsRequestBody["keys"],
    ...transferLimits(body),
  };
}

function applyRecordsBody(value: unknown): ApplyRecordsRequestBody {
  const body = objectBody(value);
  exactRequestKeys(body, ["projectionId", "records", "maxRecords", "maxBytes"]);
  if (!Array.isArray(body.records)) {
    throw new ReplicationHttpProtocolError(400, "invalid-request", "records must be an array");
  }
  return {
    projectionId: requiredString(body.projectionId, "projectionId"),
    records: body.records.map(replicationRecordBody),
    ...transferLimits(body),
  };
}

function readBlobBody(value: unknown): ReadBlobRequestBody {
  const body = objectBody(value);
  exactRequestKeys(body, ["projectionId", "viewId", "digest", "maxBytes"]);
  const base = viewFields(body);
  const maxBytes = optionalPositiveInteger(body.maxBytes, "maxBytes");
  return {
    ...base,
    digest: requiredString(body.digest, "digest") as ReadBlobRequestBody["digest"],
    ...(maxBytes === undefined ? {} : { maxBytes }),
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  const body: ReplicationHttpErrorBody = {
    schema: REPLICATION_HTTP_ERROR_SCHEMA,
    code,
    message,
  };
  return jsonResponse(body, status);
}

function mappedError(error: unknown): Response {
  if (error instanceof ReplicationHttpProtocolError) {
    return errorResponse(error.status, error.code, error.message);
  }
  if (error instanceof ReplicationAuthorizationViewError) {
    if (error.code === "expired") return errorResponse(409, "view-expired", "Replication view expired");
    if (error.code === "revoked") return errorResponse(409, "view-revoked", "Replication view was revoked");
    return errorResponse(404, "view-unavailable", "Replication view is unavailable");
  }
  if (error instanceof StaleReconciliationViewError) {
    return errorResponse(409, "view-stale", "Replication view is stale");
  }
  if (error instanceof ReplicationRecordUnavailableError) {
    return errorResponse(404, "record-unavailable", "Requested replication record is unavailable");
  }
  if (error instanceof ReplicationArtifactBlobUnavailableError) {
    return errorResponse(404, "blob-unavailable", "Requested replication artifact blob is unavailable");
  }
  if (error instanceof ReplicationApplyDeniedError || error instanceof ReplicationArtifactBlobApplyDeniedError) {
    return errorResponse(403, "apply-denied", "Replication apply is not authorized");
  }
  if (error instanceof ReplicationAccessLimitError || error instanceof ReconciliationLimitError) {
    return errorResponse(413, "limit-exceeded", "Replication request exceeds configured limits");
  }
  if (
    error instanceof InvalidReplicationRecordError
    || error instanceof InvalidReconciliationCursorError
    || error instanceof ReplicationArtifactBlobIntegrityError
  ) {
    return errorResponse(400, "invalid-replication-data", "Replication request contains invalid data");
  }
  return errorResponse(500, "internal-error", "Replication transport failed");
}

function requirePost(request: Request): void {
  if (request.method !== "POST") {
    throw new ReplicationHttpProtocolError(405, "method-not-allowed", "Replication endpoint requires POST");
  }
}

const knownRoutes = new Set<string>(Object.values(REPLICATION_HTTP_ROUTES));

export function createReplicationHttpHandler(options: ReplicationHttpServerOptions): ReplicationHttpHandler {
  const allowedHosts = uniqueHostnames(options.allowedHostnames, "allowedHostnames");
  const allowedOrigins = options.allowedOriginHostnames === undefined
    ? allowedHosts
    : uniqueHostnames(options.allowedOriginHostnames, "allowedOriginHostnames");
  const maxJsonRequestBytes = configuredJsonLimit(options.maxJsonRequestBytes);
  const maxBlobInstallRequestBytes = configuredBlobInstallLimit(options.maxBlobInstallRequestBytes);

  return {
    async fetch(request) {
      try {
        validateHost(request, allowedHosts);
        validateOrigin(request, allowedOrigins);
        const authenticated = await options.authenticator.authenticate(request);
        if (authenticated instanceof Response) return authenticated;
        const principal = normalizeAccessPrincipal(authenticated);
        requirePost(request);
        const path = new URL(request.url).pathname;
        if (!knownRoutes.has(path)) {
          return errorResponse(404, "route-not-found", "Replication route does not exist");
        }
        if (path === REPLICATION_HTTP_ROUTES.installBlob) {
          const frame = await blobInstallFrame(request, maxBlobInstallRequestBytes);
          const result = await options.gateway.installArtifactBlob(options.artifactStore, {
            principal,
            projectionId: frame.metadata.projectionId,
            record: frame.metadata.record,
            bytes: frame.bytes,
            ...(frame.metadata.maxBytes === undefined ? {} : { maxBytes: frame.metadata.maxBytes }),
          });
          return jsonResponse(result);
        }
        const value = await jsonBody(request, maxJsonRequestBytes);

        if (path === REPLICATION_HTTP_ROUTES.openProjection) {
          const body = openProjectionBody(value);
          return jsonResponse(await options.gateway.openProjection({ principal, ...body }));
        }
        if (path === REPLICATION_HTTP_ROUTES.viewInfo) {
          const body = viewBody(value);
          return jsonResponse(options.gateway.endpoint(principal, body.projectionId).viewInfo(body.viewId));
        }
        if (path === REPLICATION_HTTP_ROUTES.nodeHashes) {
          const body = nodeHashesBody(value);
          return jsonResponse(options.gateway.endpoint(principal, body.projectionId).nodeHashes(
            body.viewId,
            body.refs,
            body.maxNodeRefs === undefined ? {} : { maxNodeRefs: body.maxNodeRefs },
          ));
        }
        if (path === REPLICATION_HTTP_ROUTES.leafPage) {
          const body = leafPageBody(value);
          return jsonResponse(await options.gateway.endpoint(principal, body.projectionId).leafPage(
            body.viewId,
            {
              leafId: body.leafId,
              ...(body.cursor === undefined ? {} : { cursor: body.cursor }),
              ...(body.maxDescriptors === undefined ? {} : { maxDescriptors: body.maxDescriptors }),
              ...(body.maxBytes === undefined ? {} : { maxBytes: body.maxBytes }),
            },
          ));
        }
        if (path === REPLICATION_HTTP_ROUTES.readRecords) {
          const body = readRecordsBody(value);
          return jsonResponse(await options.gateway.readRecords({ principal, ...body }));
        }
        if (path === REPLICATION_HTTP_ROUTES.applySemantic) {
          const body = applyRecordsBody(value);
          await options.gateway.applySemantic(options.semanticStore, { principal, ...body });
          return jsonResponse({ applied: true });
        }
        if (path === REPLICATION_HTTP_ROUTES.applyArtifacts) {
          const body = applyRecordsBody(value);
          const insertedMutations = await options.gateway.applyArtifacts(
            options.artifactStore,
            { principal, ...body },
          );
          return jsonResponse({ insertedMutations });
        }
        if (path === REPLICATION_HTTP_ROUTES.readBlob) {
          const body = readBlobBody(value);
          const result = await options.gateway.readArtifactBlob(options.artifactStore, {
            principal,
            ...body,
          });
          return new Response(Uint8Array.from(result.bytes), {
            status: 200,
            headers: {
              "content-type": result.mediaType,
              "content-length": String(result.size),
              [REPLICATION_BLOB_DIGEST_HEADER]: result.digest,
              [REPLICATION_BLOB_SIZE_HEADER]: String(result.size),
              "cache-control": "no-store",
            },
          });
        }
        return errorResponse(404, "route-not-found", "Replication route does not exist");
      } catch (error) {
        return mappedError(error);
      }
    },
  };
}
