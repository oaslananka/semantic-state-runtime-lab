import { canonicalJson } from "@ssrl/core";

const DIGEST_PATTERN = /^[a-z0-9]+(?:[+._-][a-z0-9]+)*:[A-Za-z0-9=_-]+$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MEDIA_TYPE_RESTRICTED_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

export const ARTIFACT_STORE_SNAPSHOT_SCHEMA = "ssrl-artifact-store-snapshot-v1" as const;

declare const artifactDigestBrand: unique symbol;
export type ArtifactDigest = string & { readonly [artifactDigestBrand]: true };

export interface StoredArtifactBlob {
  readonly digest: ArtifactDigest;
  readonly size: number;
}

export interface ArtifactBlobDescriptor extends StoredArtifactBlob {
  readonly mediaType: string;
}

export interface ArtifactResourceIdentity {
  /** Stable non-secret source scope. Credentials/tokens must never be embedded here. */
  readonly sourceKey: string;
  readonly externalType: string;
  readonly externalId: string;
}

interface ArtifactMutationBase {
  readonly id: string;
  readonly resource: ArtifactResourceIdentity;
  readonly effectiveAt: string;
  readonly recordedAt: string;
  readonly revision?: string;
  readonly title?: string;
  readonly sourceUri?: string;
}

export interface ArtifactUpsert extends ArtifactMutationBase {
  readonly kind: "upsert";
  readonly blob: ArtifactBlobDescriptor;
}

export interface ArtifactDelete extends ArtifactMutationBase {
  readonly kind: "delete";
}

export type ArtifactMutation = ArtifactUpsert | ArtifactDelete;

export interface ArtifactStoreSnapshot {
  readonly schema: typeof ARTIFACT_STORE_SNAPSHOT_SCHEMA;
  readonly blobs: readonly StoredArtifactBlob[];
  readonly mutations: readonly ArtifactMutation[];
}

export type ResolvedArtifact =
  | { readonly status: "none" }
  | { readonly status: "deleted"; readonly mutation: ArtifactDelete }
  | { readonly status: "present"; readonly mutation: ArtifactUpsert };

export interface ArtifactBlobReadRequest {
  readonly offset?: number;
  readonly length?: number;
  readonly maxBytes: number;
}

export interface ArtifactBlobReadResult extends StoredArtifactBlob {
  readonly offset: number;
  readonly bytes: Uint8Array;
  readonly complete: boolean;
}

export interface ArtifactStore {
  putBlob(bytes: Uint8Array, mediaType: string): Promise<ArtifactBlobDescriptor>;
  headBlob(digest: ArtifactDigest): Promise<StoredArtifactBlob | undefined>;
  readBlobRange(
    digest: ArtifactDigest,
    request: ArtifactBlobReadRequest,
  ): Promise<ArtifactBlobReadResult>;
  append(mutations: readonly ArtifactMutation[]): Promise<number>;
  mutation(id: string): Promise<ArtifactMutation | undefined>;
  mutationsForResource(resource: ArtifactResourceIdentity): Promise<readonly ArtifactMutation[]>;
  snapshot(): Promise<ArtifactStoreSnapshot>;
}

export class ArtifactMutationCollisionError extends Error {
  constructor(readonly mutationId: string) {
    super(`Artifact mutation ${mutationId} already exists with different content`);
    this.name = "ArtifactMutationCollisionError";
  }
}

export class ArtifactBlobNotFoundError extends Error {
  constructor(readonly digest: ArtifactDigest) {
    super(`Artifact blob ${digest} does not exist`);
    this.name = "ArtifactBlobNotFoundError";
  }
}

export class ArtifactBlobCorruptError extends Error {
  constructor(readonly digest: ArtifactDigest, message: string) {
    super(`Artifact blob ${digest} is corrupt: ${message}`);
    this.name = "ArtifactBlobCorruptError";
  }
}

export class ArtifactBlobReadLimitError extends Error {
  constructor(readonly requestedBytes: number, readonly maxBytes: number) {
    super(`Artifact blob read requires ${requestedBytes} bytes but maxBytes is ${maxBytes}`);
    this.name = "ArtifactBlobReadLimitError";
  }
}

export class ArtifactMutationMissingBlobError extends Error {
  constructor(readonly mutationId: string, readonly digest: ArtifactDigest) {
    super(`Artifact mutation ${mutationId} references missing blob ${digest}`);
    this.name = "ArtifactMutationMissingBlobError";
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function normalizedTimestamp(value: unknown, label: string): string {
  const source = requiredString(value, label);
  const millis = Date.parse(source);
  if (!Number.isFinite(millis)) throw new TypeError(`${label} must be a valid timestamp`);
  return new Date(millis).toISOString();
}

function normalizedSize(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

export function artifactDigest(value: string): ArtifactDigest {
  if (!DIGEST_PATTERN.test(value)) throw new TypeError(`Invalid artifact digest: ${value}`);
  if (value.startsWith("sha256:") && !SHA256_PATTERN.test(value)) {
    throw new TypeError(`Invalid SHA-256 artifact digest: ${value}`);
  }
  return value as ArtifactDigest;
}

export function normalizeArtifactMediaType(value: string): string {
  const mediaType = requiredString(value, "artifact mediaType").toLowerCase();
  const parts = mediaType.split("/");
  if (
    parts.length !== 2
    || !MEDIA_TYPE_RESTRICTED_NAME_PATTERN.test(parts[0] ?? "")
    || !MEDIA_TYPE_RESTRICTED_NAME_PATTERN.test(parts[1] ?? "")
  ) {
    throw new TypeError(`Invalid artifact mediaType: ${value}`);
  }
  return mediaType;
}

export function normalizeStoredArtifactBlob(value: StoredArtifactBlob): StoredArtifactBlob {
  return {
    digest: artifactDigest(value.digest),
    size: normalizedSize(value.size, "artifact blob size"),
  };
}

export function normalizeArtifactBlobDescriptor(
  value: ArtifactBlobDescriptor,
): ArtifactBlobDescriptor {
  return {
    ...normalizeStoredArtifactBlob(value),
    mediaType: normalizeArtifactMediaType(value.mediaType),
  };
}

export function normalizeArtifactResourceIdentity(
  value: ArtifactResourceIdentity,
): ArtifactResourceIdentity {
  return {
    sourceKey: requiredString(value.sourceKey, "artifact resource sourceKey"),
    externalType: requiredString(value.externalType, "artifact resource externalType"),
    externalId: requiredString(value.externalId, "artifact resource externalId"),
  };
}

export function normalizeArtifactMutation(value: ArtifactMutation): ArtifactMutation {
  if (value.kind !== "upsert" && value.kind !== "delete") {
    throw new TypeError("artifact mutation kind must be upsert or delete");
  }
  const revision = value.revision === undefined
    ? undefined
    : requiredString(value.revision, "artifact revision");
  const title = value.title === undefined ? undefined : requiredString(value.title, "artifact title");
  const sourceUri = value.sourceUri === undefined
    ? undefined
    : requiredString(value.sourceUri, "artifact sourceUri");
  const base = {
    id: requiredString(value.id, "artifact mutation id"),
    resource: normalizeArtifactResourceIdentity(value.resource),
    effectiveAt: normalizedTimestamp(value.effectiveAt, "artifact effectiveAt"),
    recordedAt: normalizedTimestamp(value.recordedAt, "artifact recordedAt"),
    ...(revision === undefined ? {} : { revision }),
    ...(title === undefined ? {} : { title }),
    ...(sourceUri === undefined ? {} : { sourceUri }),
  };
  if (value.kind === "delete") return { ...base, kind: "delete" };
  return { ...base, kind: "upsert", blob: normalizeArtifactBlobDescriptor(value.blob) };
}

export function artifactMutationJson(value: ArtifactMutation): string {
  return canonicalJson(normalizeArtifactMutation(value));
}


function parsedObject(value: string, label: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new TypeError(`${label} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`${label} must be an object`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

export function parseArtifactMutationJson(value: string): ArtifactMutation {
  return normalizeArtifactMutation(parsedObject(value, "artifact mutation") as unknown as ArtifactMutation);
}

export function storedArtifactBlobJson(value: StoredArtifactBlob): string {
  return canonicalJson(normalizeStoredArtifactBlob(value));
}

export function parseStoredArtifactBlobJson(value: string): StoredArtifactBlob {
  return normalizeStoredArtifactBlob(parsedObject(value, "artifact blob") as unknown as StoredArtifactBlob);
}

export function sameArtifactResource(
  left: ArtifactResourceIdentity,
  right: ArtifactResourceIdentity,
): boolean {
  return left.sourceKey === right.sourceKey
    && left.externalType === right.externalType
    && left.externalId === right.externalId;
}

function compareMutationOrder(left: ArtifactMutation, right: ArtifactMutation): number {
  return Date.parse(right.effectiveAt) - Date.parse(left.effectiveAt)
    || Date.parse(right.recordedAt) - Date.parse(left.recordedAt)
    || right.id.localeCompare(left.id);
}

export function resolveArtifact(input: {
  readonly resource: ArtifactResourceIdentity;
  readonly mutations: readonly ArtifactMutation[];
  readonly validAt: string;
  readonly knownAt: string;
}): ResolvedArtifact {
  const resource = normalizeArtifactResourceIdentity(input.resource);
  const validAt = Date.parse(normalizedTimestamp(input.validAt, "artifact validAt"));
  const knownAt = Date.parse(normalizedTimestamp(input.knownAt, "artifact knownAt"));
  const ids = new Set<string>();
  const candidates: ArtifactMutation[] = [];
  for (const raw of input.mutations) {
    const mutation = normalizeArtifactMutation(raw);
    if (ids.has(mutation.id)) throw new Error(`Duplicate artifact mutation id: ${mutation.id}`);
    ids.add(mutation.id);
    if (!sameArtifactResource(resource, mutation.resource)) continue;
    if (Date.parse(mutation.recordedAt) > knownAt) continue;
    if (Date.parse(mutation.effectiveAt) > validAt) continue;
    candidates.push(mutation);
  }
  const selected = candidates.toSorted(compareMutationOrder)[0];
  if (selected === undefined) return { status: "none" };
  return selected.kind === "delete"
    ? { status: "deleted", mutation: selected }
    : { status: "present", mutation: selected };
}

export function artifactBlobUri(digest: ArtifactDigest): string {
  const normalized = artifactDigest(digest);
  const separator = normalized.indexOf(":");
  const algorithm = normalized.slice(0, separator);
  const encoded = normalized.slice(separator + 1);
  return `ssrl://artifact/blob/${encodeURIComponent(algorithm)}/${encodeURIComponent(encoded)}`;
}


async function sha256Fingerprint(value: string): Promise<string> {
  const input = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Stable, non-reversible projection URI for a source resource identity.
 * Raw source scope / external IDs never appear in the URI.
 */
export async function artifactResourceUri(resource: ArtifactResourceIdentity): Promise<string> {
  const fingerprint = await sha256Fingerprint(
    canonicalJson(normalizeArtifactResourceIdentity(resource)),
  );
  return `ssrl://artifact/resource/sha256/${fingerprint}`;
}

/**
 * Stable URI for one immutable artifact mutation/version.
 * The URI fingerprints canonical mutation metadata so source identifiers and sourceUri stay opaque.
 */
export async function artifactVersionUri(mutation: ArtifactMutation): Promise<string> {
  const fingerprint = await sha256Fingerprint(artifactMutationJson(mutation));
  return `ssrl://artifact/version/sha256/${fingerprint}`;
}
