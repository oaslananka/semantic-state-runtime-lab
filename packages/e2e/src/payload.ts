import { canonicalJson } from "@ssrl/core";
import {
  E2ECryptoError,
  E2EValidationError,
  base64UrlDecode,
  base64UrlEncode,
  bytesCopy,
  canonicalBytes,
  exactObjectKeys,
  parseJsonObject,
  plainObject,
  requiredSafeInteger,
  requiredString,
  utf8,
} from "./codec.js";
import {
  normalizeVaultEpochId,
  vaultEpochSecret,
  type VaultEpochId,
  type VaultEpochSecret,
} from "./keys.js";

export const E2E_SUITE_V1 = "ssrl-e2e-v1:x25519-hkdf-sha256-aes256gcm" as const;
export const E2E_PAYLOAD_ENVELOPE_SCHEMA = "ssrl-e2e-payload-envelope-v1" as const;
export const MAX_E2E_PAYLOAD_BYTES = 64 * 1024 * 1024;
const AES_GCM_TAG_BYTES = 16;
const AES_GCM_NONCE_BYTES = 12;
const HKDF_SALT = utf8("ssrl-e2e-object-key-v1");

export type EncryptedObjectKind = "replication-record" | "artifact-blob";

export interface EncryptedPayloadEnvelope {
  readonly schema: typeof E2E_PAYLOAD_ENVELOPE_SCHEMA;
  readonly suite: typeof E2E_SUITE_V1;
  readonly epochId: VaultEpochId;
  readonly objectKind: EncryptedObjectKind;
  readonly objectId: string;
  readonly plaintextBytes: number;
  readonly nonce: string;
  readonly ciphertext: string;
}

export interface EncryptPayloadInput {
  readonly epochId: VaultEpochId;
  readonly epochSecret: VaultEpochSecret;
  readonly objectKind: EncryptedObjectKind;
  readonly objectId: string;
  readonly plaintext: ArrayBufferLike | ArrayBufferView;
}

function objectKind(value: unknown): EncryptedObjectKind {
  if (value !== "replication-record" && value !== "artifact-blob") {
    throw new E2EValidationError("objectKind must be replication-record or artifact-blob");
  }
  return value;
}

function envelopeMetadata(value: Pick<
  EncryptedPayloadEnvelope,
  "schema" | "suite" | "epochId" | "objectKind" | "objectId" | "plaintextBytes"
>): Readonly<Record<string, unknown>> {
  return {
    schema: value.schema,
    suite: value.suite,
    epochId: value.epochId,
    objectKind: value.objectKind,
    objectId: value.objectId,
    plaintextBytes: value.plaintextBytes,
  };
}

async function payloadKey(
  secret: VaultEpochSecret,
  metadata: Readonly<Record<string, unknown>>,
  usages: readonly KeyUsage[],
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
      salt: HKDF_SALT,
      info: canonicalBytes({ ...metadata, purpose: "payload-aead-key" }),
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    [...usages],
  );
}

function normalizedObjectId(value: unknown): string {
  return requiredString(value, "encrypted object id", 1_024);
}

function assertSuite(value: unknown): asserts value is typeof E2E_SUITE_V1 {
  if (value !== E2E_SUITE_V1) throw new E2EValidationError("unsupported E2E suite");
}

export async function encryptPayload(input: EncryptPayloadInput): Promise<EncryptedPayloadEnvelope> {
  const epochId = normalizeVaultEpochId(input.epochId);
  const kind = objectKind(input.objectKind);
  const id = normalizedObjectId(input.objectId);
  const plaintext = bytesCopy(input.plaintext);
  if (plaintext.byteLength > MAX_E2E_PAYLOAD_BYTES) {
    throw new E2EValidationError(`plaintext exceeds ${MAX_E2E_PAYLOAD_BYTES} bytes`);
  }
  const metadata = envelopeMetadata({
    schema: E2E_PAYLOAD_ENVELOPE_SCHEMA,
    suite: E2E_SUITE_V1,
    epochId,
    objectKind: kind,
    objectId: id,
    plaintextBytes: plaintext.byteLength,
  });
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_BYTES));
  const key = await payloadKey(vaultEpochSecret(input.epochSecret), metadata, ["encrypt"]);
  let ciphertext: ArrayBuffer;
  try {
    ciphertext = await globalThis.crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: canonicalBytes(metadata),
        tagLength: 128,
      },
      key,
      plaintext,
    );
  } catch (cause) {
    throw new E2ECryptoError("payload encryption failed", { cause });
  }
  return {
    ...metadata,
    nonce: base64UrlEncode(nonce),
    ciphertext: base64UrlEncode(ciphertext),
  } as EncryptedPayloadEnvelope;
}

export function normalizeEncryptedPayloadEnvelope(value: unknown): EncryptedPayloadEnvelope {
  const object = plainObject(value, "encrypted payload envelope");
  exactObjectKeys(
    object,
    ["schema", "suite", "epochId", "objectKind", "objectId", "plaintextBytes", "nonce", "ciphertext"],
    "encrypted payload envelope",
  );
  if (object.schema !== E2E_PAYLOAD_ENVELOPE_SCHEMA) {
    throw new E2EValidationError("unsupported encrypted payload envelope schema");
  }
  assertSuite(object.suite);
  const epochId = normalizeVaultEpochId(object.epochId);
  const kind = objectKind(object.objectKind);
  const id = normalizedObjectId(object.objectId);
  const plaintextBytes = requiredSafeInteger(object.plaintextBytes, "plaintextBytes", MAX_E2E_PAYLOAD_BYTES);
  const nonce = requiredString(object.nonce, "encrypted payload nonce", 32);
  base64UrlDecode(nonce, "encrypted payload nonce", { exactBytes: AES_GCM_NONCE_BYTES });
  const ciphertext = requiredString(
    object.ciphertext,
    "encrypted payload ciphertext",
    Math.ceil((MAX_E2E_PAYLOAD_BYTES + AES_GCM_TAG_BYTES) * 4 / 3) + 4,
  );
  const ciphertextBytes = base64UrlDecode(ciphertext, "encrypted payload ciphertext", {
    maxBytes: MAX_E2E_PAYLOAD_BYTES + AES_GCM_TAG_BYTES,
  });
  if (ciphertextBytes.byteLength !== plaintextBytes + AES_GCM_TAG_BYTES) {
    throw new E2EValidationError("encrypted payload ciphertext length disagrees with plaintextBytes");
  }
  return {
    schema: E2E_PAYLOAD_ENVELOPE_SCHEMA,
    suite: E2E_SUITE_V1,
    epochId,
    objectKind: kind,
    objectId: id,
    plaintextBytes,
    nonce,
    ciphertext,
  };
}

export async function decryptPayload(
  envelope: EncryptedPayloadEnvelope,
  epochSecret: VaultEpochSecret,
): Promise<Uint8Array> {
  const normalized = normalizeEncryptedPayloadEnvelope(envelope);
  const metadata = envelopeMetadata(normalized);
  const key = await payloadKey(vaultEpochSecret(epochSecret), metadata, ["decrypt"]);
  try {
    const plaintext = await globalThis.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlDecode(normalized.nonce, "encrypted payload nonce", { exactBytes: AES_GCM_NONCE_BYTES }),
        additionalData: canonicalBytes(metadata),
        tagLength: 128,
      },
      key,
      base64UrlDecode(normalized.ciphertext, "encrypted payload ciphertext", {
        maxBytes: MAX_E2E_PAYLOAD_BYTES + AES_GCM_TAG_BYTES,
      }),
    );
    const bytes = new Uint8Array(plaintext);
    if (bytes.byteLength !== normalized.plaintextBytes) {
      throw new E2ECryptoError("decrypted payload length disagrees with envelope");
    }
    return bytes;
  } catch (cause) {
    if (cause instanceof E2ECryptoError) throw cause;
    throw new E2ECryptoError("payload decryption failed", { cause });
  }
}

export function encryptedPayloadEnvelopeJson(value: EncryptedPayloadEnvelope): string {
  return canonicalJson(normalizeEncryptedPayloadEnvelope(value));
}

export function parseEncryptedPayloadEnvelopeJson(value: string): EncryptedPayloadEnvelope {
  return normalizeEncryptedPayloadEnvelope(
    parseJsonObject(
      value,
      "encrypted payload envelope JSON",
      Math.ceil((MAX_E2E_PAYLOAD_BYTES + AES_GCM_TAG_BYTES) * 4 / 3) + 4_096,
    ),
  );
}
