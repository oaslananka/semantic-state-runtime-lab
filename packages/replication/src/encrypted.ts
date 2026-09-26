import { canonicalJson } from "@ssrl/core";
import {
  MAX_E2E_PAYLOAD_BYTES,
  base64UrlDecode,
  base64UrlEncode,
  decryptPayload,
  encryptPayload,
  normalizeEncryptedPayloadEnvelope,
  normalizeVaultEpochId,
  plainObject,
  requiredSafeInteger,
  requiredString,
  sha256,
  utf8,
  vaultEpochSecret,
  type EncryptedObjectKind,
  type EncryptedPayloadEnvelope,
  type VaultEpochId,
  type VaultEpochSecret,
} from "@ssrl/e2e";
import {
  verifyReplicationRecord,
  type ReplicationRecord,
  type ReplicationRecordKey,
} from "./index.js";

export const OPAQUE_REPLICATION_DESCRIPTOR_SCHEMA =
  "ssrl-opaque-replication-descriptor-v1" as const;
export const ENCRYPTED_REPLICATION_OBJECT_SCHEMA =
  "ssrl-encrypted-replication-object-v1" as const;

const INDEX_KDF_SALT = utf8("ssrl-opaque-replication-index-salt-v1");
const INDEX_KDF_INFO_DOMAIN = "ssrl-opaque-replication-index-key-v1";
const HMAC_TAG_PREFIX = "hmac-sha256:";
const AES_GCM_TAG_BYTES = 16;
const MAX_PUBLIC_OBJECT_JSON_CHARS =
  Math.ceil((MAX_E2E_PAYLOAD_BYTES + AES_GCM_TAG_BYTES) * 4 / 3) + 32_768;

declare const opaqueReplicationTagBrand: unique symbol;
export type OpaqueReplicationTag = string & {
  readonly [opaqueReplicationTagBrand]: true;
};

export interface OpaqueReplicationDescriptor {
  readonly schema: typeof OPAQUE_REPLICATION_DESCRIPTOR_SCHEMA;
  readonly epochId: VaultEpochId;
  readonly objectKind: EncryptedObjectKind;
  readonly opaqueKey: OpaqueReplicationTag;
  readonly opaqueContentTag: OpaqueReplicationTag;
  readonly ciphertextBytes: number;
  readonly fingerprint: string;
}

export interface EncryptedReplicationObject {
  readonly schema: typeof ENCRYPTED_REPLICATION_OBJECT_SCHEMA;
  readonly descriptor: OpaqueReplicationDescriptor;
  readonly envelope: EncryptedPayloadEnvelope;
}

export interface OpaqueReplicationCollision {
  readonly epochId: VaultEpochId;
  readonly opaqueKey: OpaqueReplicationTag;
  readonly localContentTag: OpaqueReplicationTag;
  readonly remoteContentTag: OpaqueReplicationTag;
}

export class OpaqueReplicationCollisionError extends Error {
  constructor(readonly collision: OpaqueReplicationCollision) {
    super(`Opaque replication object ${collision.opaqueKey} has different content tags`);
    this.name = "OpaqueReplicationCollisionError";
  }
}

export class EncryptedReplicationValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EncryptedReplicationValidationError";
  }
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).toSorted((left, right) => left.localeCompare(right));
  const expected = [...keys].toSorted((left, right) => left.localeCompare(right));
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new EncryptedReplicationValidationError(
      `${label} has unexpected or missing fields`,
    );
  }
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sha256Digest(bytes: Uint8Array): Promise<string> {
  return sha256(bytes).then((digest) => `sha256:${hex(digest)}`);
}

function encryptedObjectKind(value: unknown): EncryptedObjectKind {
  if (value !== "replication-record" && value !== "artifact-blob") {
    throw new EncryptedReplicationValidationError(
      "opaque replication objectKind must be replication-record or artifact-blob",
    );
  }
  return value;
}

function opaqueTag(value: unknown, label: string): OpaqueReplicationTag {
  const normalized = requiredString(value, label, HMAC_TAG_PREFIX.length + 43);
  if (!normalized.startsWith(HMAC_TAG_PREFIX)) {
    throw new EncryptedReplicationValidationError(
      `${label} must use the hmac-sha256 prefix`,
    );
  }
  base64UrlDecode(normalized.slice(HMAC_TAG_PREFIX.length), label, { exactBytes: 32 });
  return normalized as OpaqueReplicationTag;
}

function fingerprint(value: unknown): string {
  const normalized = requiredString(value, "opaque descriptor fingerprint", 71);
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) {
    throw new EncryptedReplicationValidationError(
      "opaque descriptor fingerprint must be lowercase SHA-256",
    );
  }
  return normalized;
}

async function indexHmacKey(
  secret: VaultEpochSecret,
  epochId: VaultEpochId,
): Promise<CryptoKey> {
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    "raw",
    vaultEpochSecret(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return globalThis.crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: INDEX_KDF_SALT,
      info: utf8(canonicalJson([INDEX_KDF_INFO_DOMAIN, normalizeVaultEpochId(epochId)])),
    },
    keyMaterial,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

async function keyedTag(
  key: CryptoKey,
  purpose: "record-key" | "record-content" | "blob-key" | "blob-content",
  value: string,
): Promise<OpaqueReplicationTag> {
  const material = utf8(canonicalJson([
    "ssrl-opaque-replication-tag-v1",
    purpose,
    value,
  ]));
  const signature = await globalThis.crypto.subtle.sign("HMAC", key, material);
  return `${HMAC_TAG_PREFIX}${base64UrlEncode(signature)}` as OpaqueReplicationTag;
}

type DescriptorMaterial = Omit<OpaqueReplicationDescriptor, "fingerprint">;

async function descriptorFingerprint(material: DescriptorMaterial): Promise<string> {
  return sha256Digest(utf8(canonicalJson(material)));
}

async function createOpaqueDescriptor(input: {
  readonly epochId: VaultEpochId;
  readonly epochSecret: VaultEpochSecret;
  readonly objectKind: EncryptedObjectKind;
  readonly logicalKey: string;
  readonly contentIdentity: string;
  readonly plaintextBytes: number;
}): Promise<OpaqueReplicationDescriptor> {
  const epochId = normalizeVaultEpochId(input.epochId);
  const plaintextBytes = requiredSafeInteger(
    input.plaintextBytes,
    "opaque descriptor plaintext bytes",
    MAX_E2E_PAYLOAD_BYTES,
  );
  const hmacKey = await indexHmacKey(input.epochSecret, epochId);
  const record = input.objectKind === "replication-record";
  const [opaqueKey, opaqueContentTag] = await Promise.all([
    keyedTag(hmacKey, record ? "record-key" : "blob-key", input.logicalKey),
    keyedTag(
      hmacKey,
      record ? "record-content" : "blob-content",
      canonicalJson([input.logicalKey, input.contentIdentity]),
    ),
  ]);
  const material: DescriptorMaterial = {
    schema: OPAQUE_REPLICATION_DESCRIPTOR_SCHEMA,
    epochId,
    objectKind: input.objectKind,
    opaqueKey,
    opaqueContentTag,
    ciphertextBytes: plaintextBytes + AES_GCM_TAG_BYTES,
  };
  return {
    ...material,
    fingerprint: await descriptorFingerprint(material),
  };
}

export async function normalizeOpaqueReplicationDescriptor(
  value: unknown,
): Promise<OpaqueReplicationDescriptor> {
  const object = plainObject(value, "opaque replication descriptor");
  exactKeys(
    object,
    [
      "schema",
      "epochId",
      "objectKind",
      "opaqueKey",
      "opaqueContentTag",
      "ciphertextBytes",
      "fingerprint",
    ],
    "opaque replication descriptor",
  );
  if (object.schema !== OPAQUE_REPLICATION_DESCRIPTOR_SCHEMA) {
    throw new EncryptedReplicationValidationError(
      "unsupported opaque replication descriptor schema",
    );
  }
  const material: DescriptorMaterial = {
    schema: OPAQUE_REPLICATION_DESCRIPTOR_SCHEMA,
    epochId: normalizeVaultEpochId(object.epochId),
    objectKind: encryptedObjectKind(object.objectKind),
    opaqueKey: opaqueTag(object.opaqueKey, "opaque replication key"),
    opaqueContentTag: opaqueTag(
      object.opaqueContentTag,
      "opaque replication content tag",
    ),
    ciphertextBytes: requiredSafeInteger(
      object.ciphertextBytes,
      "opaque descriptor ciphertextBytes",
      MAX_E2E_PAYLOAD_BYTES + AES_GCM_TAG_BYTES,
    ),
  };
  const expectedFingerprint = await descriptorFingerprint(material);
  const actualFingerprint = fingerprint(object.fingerprint);
  if (actualFingerprint !== expectedFingerprint) {
    throw new EncryptedReplicationValidationError(
      "opaque replication descriptor fingerprint mismatch",
    );
  }
  return { ...material, fingerprint: actualFingerprint };
}

export async function opaqueReplicationDescriptorJson(
  value: OpaqueReplicationDescriptor,
): Promise<string> {
  return canonicalJson(await normalizeOpaqueReplicationDescriptor(value));
}

function replicationRecordObject(record: ReplicationRecord): Readonly<Record<string, unknown>> {
  return {
    key: record.key,
    kind: record.kind,
    recordId: record.recordId,
    payloadDigest: record.payloadDigest,
    fingerprint: record.fingerprint,
    payloadBytes: record.payloadBytes,
    payload: record.payload,
  };
}

async function canonicalReplicationRecordJson(record: ReplicationRecord): Promise<string> {
  const verified = await verifyReplicationRecord(record);
  return canonicalJson(replicationRecordObject(verified));
}

function parsedJsonObject(value: string, label: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (cause) {
    throw new EncryptedReplicationValidationError(`${label} is not valid JSON`, {
      cause,
    });
  }
  return plainObject(parsed, label);
}

async function parseCanonicalReplicationRecord(
  bytes: Uint8Array,
): Promise<ReplicationRecord> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new EncryptedReplicationValidationError(
      "decrypted replication record is not valid UTF-8",
      { cause },
    );
  }
  const object = parsedJsonObject(text, "decrypted replication record");
  exactKeys(
    object,
    [
      "key",
      "kind",
      "recordId",
      "payloadDigest",
      "fingerprint",
      "payloadBytes",
      "payload",
    ],
    "decrypted replication record",
  );
  const candidate = {
    key: requiredString(object.key, "replication record key", 4_096) as ReplicationRecordKey,
    kind: requiredString(object.kind, "replication record kind", 128) as ReplicationRecord["kind"],
    recordId: requiredString(object.recordId, "replication recordId", 4_096),
    payloadDigest: requiredString(object.payloadDigest, "replication payloadDigest", 128),
    fingerprint: requiredString(object.fingerprint, "replication fingerprint", 128),
    payloadBytes: requiredSafeInteger(
      object.payloadBytes,
      "replication payloadBytes",
      MAX_E2E_PAYLOAD_BYTES,
    ),
    payload: requiredString(object.payload, "replication payload", MAX_E2E_PAYLOAD_BYTES),
  } satisfies ReplicationRecord;
  const verified = await verifyReplicationRecord(candidate);
  if (canonicalJson(replicationRecordObject(verified)) !== text) {
    throw new EncryptedReplicationValidationError(
      "decrypted replication record must use canonical JSON",
    );
  }
  return verified;
}

function descriptorEqual(
  left: OpaqueReplicationDescriptor,
  right: OpaqueReplicationDescriptor,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function assertSameOpaqueReplicationDescriptor(
  existing: OpaqueReplicationDescriptor,
  incoming: OpaqueReplicationDescriptor,
): void {
  if (
    existing.epochId !== incoming.epochId
    || existing.opaqueKey !== incoming.opaqueKey
    || existing.objectKind !== incoming.objectKind
  ) {
    throw new EncryptedReplicationValidationError(
      "opaque replication descriptors do not identify the same object",
    );
  }
  if (existing.opaqueContentTag !== incoming.opaqueContentTag) {
    throw new OpaqueReplicationCollisionError({
      epochId: existing.epochId,
      opaqueKey: existing.opaqueKey,
      localContentTag: existing.opaqueContentTag,
      remoteContentTag: incoming.opaqueContentTag,
    });
  }
  if (!descriptorEqual(existing, incoming)) {
    throw new EncryptedReplicationValidationError(
      "duplicate opaque replication descriptor has inconsistent metadata",
    );
  }
}

async function normalizeEncryptedObject(
  value: EncryptedReplicationObject,
): Promise<EncryptedReplicationObject> {
  if (value.schema !== ENCRYPTED_REPLICATION_OBJECT_SCHEMA) {
    throw new EncryptedReplicationValidationError(
      "unsupported encrypted replication object schema",
    );
  }
  const descriptor = await normalizeOpaqueReplicationDescriptor(value.descriptor);
  const envelope = normalizeEncryptedPayloadEnvelope(value.envelope);
  if (
    envelope.epochId !== descriptor.epochId
    || envelope.objectKind !== descriptor.objectKind
    || envelope.objectId !== descriptor.opaqueKey
  ) {
    throw new EncryptedReplicationValidationError(
      "encrypted envelope identity disagrees with opaque descriptor",
    );
  }
  const ciphertextBytes = base64UrlDecode(
    envelope.ciphertext,
    "encrypted replication ciphertext",
    { maxBytes: MAX_E2E_PAYLOAD_BYTES + AES_GCM_TAG_BYTES },
  ).byteLength;
  if (
    ciphertextBytes !== descriptor.ciphertextBytes
    || ciphertextBytes !== envelope.plaintextBytes + AES_GCM_TAG_BYTES
  ) {
    throw new EncryptedReplicationValidationError(
      "encrypted envelope byte accounting disagrees with opaque descriptor",
    );
  }
  return {
    schema: ENCRYPTED_REPLICATION_OBJECT_SCHEMA,
    descriptor,
    envelope,
  };
}

export async function encryptedReplicationObjectJson(
  value: EncryptedReplicationObject,
): Promise<string> {
  return canonicalJson(await normalizeEncryptedObject(value));
}

export async function parseEncryptedReplicationObjectJson(
  value: string,
): Promise<EncryptedReplicationObject> {
  if (typeof value !== "string" || value.length > MAX_PUBLIC_OBJECT_JSON_CHARS) {
    throw new EncryptedReplicationValidationError(
      "encrypted replication object JSON exceeds its size limit",
    );
  }
  const object = parsedJsonObject(value, "encrypted replication object");
  exactKeys(object, ["schema", "descriptor", "envelope"], "encrypted replication object");
  return normalizeEncryptedObject({
    schema: object.schema as typeof ENCRYPTED_REPLICATION_OBJECT_SCHEMA,
    descriptor: object.descriptor as OpaqueReplicationDescriptor,
    envelope: object.envelope as EncryptedPayloadEnvelope,
  });
}

export async function opaqueReplicationRecordDescriptor(input: {
  readonly epochId: VaultEpochId;
  readonly epochSecret: VaultEpochSecret;
  readonly record: ReplicationRecord;
}): Promise<OpaqueReplicationDescriptor> {
  const record = await verifyReplicationRecord(input.record);
  const plaintext = utf8(await canonicalReplicationRecordJson(record));
  return createOpaqueDescriptor({
    epochId: input.epochId,
    epochSecret: input.epochSecret,
    objectKind: "replication-record",
    logicalKey: record.key,
    contentIdentity: record.payloadDigest,
    plaintextBytes: plaintext.byteLength,
  });
}

export async function encryptReplicationRecord(input: {
  readonly epochId: VaultEpochId;
  readonly epochSecret: VaultEpochSecret;
  readonly record: ReplicationRecord;
}): Promise<EncryptedReplicationObject> {
  const record = await verifyReplicationRecord(input.record);
  const plaintext = utf8(await canonicalReplicationRecordJson(record));
  const descriptor = await createOpaqueDescriptor({
    epochId: input.epochId,
    epochSecret: input.epochSecret,
    objectKind: "replication-record",
    logicalKey: record.key,
    contentIdentity: record.payloadDigest,
    plaintextBytes: plaintext.byteLength,
  });
  const envelope = await encryptPayload({
    epochId: descriptor.epochId,
    epochSecret: input.epochSecret,
    objectKind: "replication-record",
    objectId: descriptor.opaqueKey,
    plaintext,
  });
  return normalizeEncryptedObject({
    schema: ENCRYPTED_REPLICATION_OBJECT_SCHEMA,
    descriptor,
    envelope,
  });
}

export async function decryptReplicationRecord(
  object: EncryptedReplicationObject,
  epochSecret: VaultEpochSecret,
): Promise<ReplicationRecord> {
  const normalized = await normalizeEncryptedObject(object);
  if (normalized.descriptor.objectKind !== "replication-record") {
    throw new EncryptedReplicationValidationError(
      "encrypted object does not contain a replication record",
    );
  }
  const plaintext = await decryptPayload(normalized.envelope, epochSecret);
  const record = await parseCanonicalReplicationRecord(plaintext);
  const expected = await opaqueReplicationRecordDescriptor({
    epochId: normalized.descriptor.epochId,
    epochSecret,
    record,
  });
  if (!descriptorEqual(expected, normalized.descriptor)) {
    throw new EncryptedReplicationValidationError(
      "decrypted replication record does not match opaque descriptor",
    );
  }
  return record;
}

function assertArtifactDigest(value: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new EncryptedReplicationValidationError(
      "artifact plaintext digest must be lowercase SHA-256",
    );
  }
}

async function verifyArtifactDigest(bytes: Uint8Array, digest: string): Promise<void> {
  assertArtifactDigest(digest);
  if (await sha256Digest(bytes) !== digest) {
    throw new EncryptedReplicationValidationError(
      "artifact plaintext bytes do not match the expected SHA-256 digest",
    );
  }
}

export async function opaqueArtifactBlobDescriptor(input: {
  readonly epochId: VaultEpochId;
  readonly epochSecret: VaultEpochSecret;
  readonly plaintextDigest: string;
  readonly plaintextBytes: number;
}): Promise<OpaqueReplicationDescriptor> {
  assertArtifactDigest(input.plaintextDigest);
  return createOpaqueDescriptor({
    epochId: input.epochId,
    epochSecret: input.epochSecret,
    objectKind: "artifact-blob",
    logicalKey: input.plaintextDigest,
    contentIdentity: input.plaintextDigest,
    plaintextBytes: input.plaintextBytes,
  });
}

export async function encryptArtifactBlob(input: {
  readonly epochId: VaultEpochId;
  readonly epochSecret: VaultEpochSecret;
  readonly plaintextDigest: string;
  readonly bytes: Uint8Array;
}): Promise<EncryptedReplicationObject> {
  await verifyArtifactDigest(input.bytes, input.plaintextDigest);
  const descriptor = await opaqueArtifactBlobDescriptor({
    epochId: input.epochId,
    epochSecret: input.epochSecret,
    plaintextDigest: input.plaintextDigest,
    plaintextBytes: input.bytes.byteLength,
  });
  const envelope = await encryptPayload({
    epochId: descriptor.epochId,
    epochSecret: input.epochSecret,
    objectKind: "artifact-blob",
    objectId: descriptor.opaqueKey,
    plaintext: input.bytes,
  });
  return normalizeEncryptedObject({
    schema: ENCRYPTED_REPLICATION_OBJECT_SCHEMA,
    descriptor,
    envelope,
  });
}

export async function decryptArtifactBlob(
  object: EncryptedReplicationObject,
  epochSecret: VaultEpochSecret,
  expectedPlaintextDigest: string,
): Promise<Uint8Array> {
  assertArtifactDigest(expectedPlaintextDigest);
  const normalized = await normalizeEncryptedObject(object);
  if (normalized.descriptor.objectKind !== "artifact-blob") {
    throw new EncryptedReplicationValidationError(
      "encrypted object does not contain an artifact blob",
    );
  }
  const plaintext = await decryptPayload(normalized.envelope, epochSecret);
  await verifyArtifactDigest(plaintext, expectedPlaintextDigest);
  const expected = await opaqueArtifactBlobDescriptor({
    epochId: normalized.descriptor.epochId,
    epochSecret,
    plaintextDigest: expectedPlaintextDigest,
    plaintextBytes: plaintext.byteLength,
  });
  if (!descriptorEqual(expected, normalized.descriptor)) {
    throw new EncryptedReplicationValidationError(
      "decrypted artifact blob does not match opaque descriptor",
    );
  }
  return plaintext;
}

// Preserve the underlying E2E parser error class in the public dependency graph so
// callers may distinguish malformed E2E envelopes from SSRL descriptor mismatches.
export { E2EValidationError } from "@ssrl/e2e";
