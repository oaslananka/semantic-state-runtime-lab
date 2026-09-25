import {
  Aes256Gcm,
  CipherSuite,
  DhkemX25519HkdfSha256,
  HkdfSha256,
} from "@hpke/core";
import { canonicalJson } from "@ssrl/core";
import {
  E2ECryptoError,
  E2EValidationError,
  base64UrlDecode,
  base64UrlEncode,
  canonicalBytes,
  exactObjectKeys,
  parseJsonObject,
  plainObject,
  requiredString,
  sha256,
} from "./codec.js";
import {
  normalizeVaultEpochId,
  normalizeX25519PrivateJwk,
  normalizeX25519PublicJwk,
  vaultEpochSecret,
  x25519JwkThumbprintUri,
  x25519PublicFromPrivate,
  type VaultEpochId,
  type VaultEpochSecret,
  type X25519PrivateJwk,
  type X25519PublicJwk,
} from "./keys.js";
import { E2E_SUITE_V1 } from "./payload.js";

export const E2E_EPOCH_KEY_GRANT_SCHEMA = "ssrl-e2e-epoch-key-grant-v1" as const;
const HPKE_ENCAPSULATED_KEY_BYTES = 32;
const HPKE_EPOCH_SECRET_CIPHERTEXT_BYTES = 48;
const MAX_GRANT_JSON_CHARS = 4_096;

export interface HpkeEpochKeyGrant {
  readonly schema: typeof E2E_EPOCH_KEY_GRANT_SCHEMA;
  readonly suite: typeof E2E_SUITE_V1;
  readonly epochId: VaultEpochId;
  readonly recipientKeyId: string;
  readonly encapsulatedKey: string;
  readonly ciphertext: string;
}

function hpkeSuite(): CipherSuite {
  return new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
  });
}

function grantMetadata(input: Pick<
  HpkeEpochKeyGrant,
  "schema" | "suite" | "epochId" | "recipientKeyId"
>): Readonly<Record<string, unknown>> {
  return {
    schema: input.schema,
    suite: input.suite,
    epochId: input.epochId,
    recipientKeyId: input.recipientKeyId,
  };
}

async function hpkeInfo(metadata: Readonly<Record<string, unknown>>): Promise<Uint8Array> {
  return sha256(canonicalBytes({ ...metadata, purpose: "vault-epoch-key-grant" }));
}

function normalizedRecipientKeyId(value: unknown): string {
  const id = requiredString(value, "recipient encryption key id", 160);
  if (!id.startsWith("urn:ietf:params:oauth:jwk-thumbprint:sha-256:")) {
    throw new E2EValidationError("recipient encryption key id must be a JWK thumbprint URI");
  }
  base64UrlDecode(id.slice(id.lastIndexOf(":") + 1), "recipient encryption key thumbprint", {
    exactBytes: 32,
  });
  return id;
}

export async function createEpochKeyGrant(input: {
  readonly epochId: VaultEpochId;
  readonly epochSecret: VaultEpochSecret;
  readonly recipientPublicKeyJwk: X25519PublicJwk;
}): Promise<HpkeEpochKeyGrant> {
  const epochId = normalizeVaultEpochId(input.epochId);
  const publicKeyJwk = normalizeX25519PublicJwk(input.recipientPublicKeyJwk);
  const recipientKeyId = await x25519JwkThumbprintUri(publicKeyJwk);
  const metadata = grantMetadata({
    schema: E2E_EPOCH_KEY_GRANT_SCHEMA,
    suite: E2E_SUITE_V1,
    epochId,
    recipientKeyId,
  });
  const suite = hpkeSuite();
  try {
    const recipientPublicKey = await suite.kem.importKey("jwk", publicKeyJwk as JsonWebKey);
    const sealed = await suite.seal(
      {
        recipientPublicKey,
        info: await hpkeInfo(metadata),
      },
      vaultEpochSecret(input.epochSecret),
      canonicalBytes(metadata),
    );
    return {
      schema: E2E_EPOCH_KEY_GRANT_SCHEMA,
      suite: E2E_SUITE_V1,
      epochId,
      recipientKeyId,
      encapsulatedKey: base64UrlEncode(sealed.enc),
      ciphertext: base64UrlEncode(sealed.ct),
    };
  } catch (cause) {
    throw new E2ECryptoError("epoch key grant encryption failed", { cause });
  }
}

export function normalizeEpochKeyGrant(value: unknown): HpkeEpochKeyGrant {
  const object = plainObject(value, "epoch key grant");
  exactObjectKeys(
    object,
    ["schema", "suite", "epochId", "recipientKeyId", "encapsulatedKey", "ciphertext"],
    "epoch key grant",
  );
  if (object.schema !== E2E_EPOCH_KEY_GRANT_SCHEMA) {
    throw new E2EValidationError("unsupported epoch key grant schema");
  }
  if (object.suite !== E2E_SUITE_V1) throw new E2EValidationError("unsupported E2E suite");
  const epochId = normalizeVaultEpochId(object.epochId);
  const recipientKeyId = normalizedRecipientKeyId(object.recipientKeyId);
  const encapsulatedKey = requiredString(object.encapsulatedKey, "HPKE encapsulated key", 64);
  base64UrlDecode(encapsulatedKey, "HPKE encapsulated key", { exactBytes: HPKE_ENCAPSULATED_KEY_BYTES });
  const ciphertext = requiredString(object.ciphertext, "HPKE grant ciphertext", 96);
  base64UrlDecode(ciphertext, "HPKE grant ciphertext", { exactBytes: HPKE_EPOCH_SECRET_CIPHERTEXT_BYTES });
  return {
    schema: E2E_EPOCH_KEY_GRANT_SCHEMA,
    suite: E2E_SUITE_V1,
    epochId,
    recipientKeyId,
    encapsulatedKey,
    ciphertext,
  };
}

export async function openEpochKeyGrant(
  grant: HpkeEpochKeyGrant,
  recipientPrivateKeyJwk: X25519PrivateJwk,
): Promise<VaultEpochSecret> {
  const normalized = normalizeEpochKeyGrant(grant);
  const privateKeyJwk = normalizeX25519PrivateJwk(recipientPrivateKeyJwk);
  const publicKeyJwk = x25519PublicFromPrivate(privateKeyJwk);
  const actualKeyId = await x25519JwkThumbprintUri(publicKeyJwk);
  if (actualKeyId !== normalized.recipientKeyId) {
    throw new E2ECryptoError("epoch key grant recipient does not match the private key");
  }
  const metadata = grantMetadata(normalized);
  const suite = hpkeSuite();
  try {
    const recipientKey = await suite.kem.importKey(
      "jwk",
      privateKeyJwk as JsonWebKey,
      false,
    );
    const plaintext = await suite.open(
      {
        recipientKey,
        enc: base64UrlDecode(normalized.encapsulatedKey, "HPKE encapsulated key", {
          exactBytes: HPKE_ENCAPSULATED_KEY_BYTES,
        }),
        info: await hpkeInfo(metadata),
      },
      base64UrlDecode(normalized.ciphertext, "HPKE grant ciphertext", {
        exactBytes: HPKE_EPOCH_SECRET_CIPHERTEXT_BYTES,
      }),
      canonicalBytes(metadata),
    );
    return vaultEpochSecret(plaintext);
  } catch (cause) {
    throw new E2ECryptoError("epoch key grant decryption failed", { cause });
  }
}

export function epochKeyGrantJson(value: HpkeEpochKeyGrant): string {
  return canonicalJson(normalizeEpochKeyGrant(value));
}

export function parseEpochKeyGrantJson(value: string): HpkeEpochKeyGrant {
  return normalizeEpochKeyGrant(parseJsonObject(value, "epoch key grant JSON", MAX_GRANT_JSON_CHARS));
}
