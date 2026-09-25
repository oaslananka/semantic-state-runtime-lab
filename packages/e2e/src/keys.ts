import { canonicalJson } from "@ssrl/core";
import {
  E2EValidationError,
  base64UrlDecode,
  base64UrlEncode,
  canonicalBytes,
  exactObjectKeys,
  plainObject,
  requiredString,
  sha256,
} from "./codec.js";

const JWK_THUMBPRINT_URI_PREFIX = "urn:ietf:params:oauth:jwk-thumbprint:sha-256:";
const EPOCH_ID_PREFIX = "urn:ssrl:vault-epoch:";
const EPOCH_ID_RANDOM_BYTES = 16;
const X25519_KEY_BYTES = 32;

export interface X25519PublicJwk {
  readonly kty: "OKP";
  readonly crv: "X25519";
  readonly x: string;
}

export interface X25519PrivateJwk extends X25519PublicJwk {
  readonly d: string;
}

export interface X25519KeyPair {
  readonly keyId: string;
  readonly publicKeyJwk: X25519PublicJwk;
  /** Local secret material. Never serialize into relay/public protocol objects. */
  readonly privateKeyJwk: X25519PrivateJwk;
}

declare const vaultEpochIdBrand: unique symbol;
export type VaultEpochId = string & { readonly [vaultEpochIdBrand]: true };

declare const vaultEpochSecretBrand: unique symbol;
export type VaultEpochSecret = Uint8Array<ArrayBuffer> & {
  readonly [vaultEpochSecretBrand]: true;
};

export interface VaultEpoch {
  readonly epochId: VaultEpochId;
  readonly secret: VaultEpochSecret;
}

function normalizedPublicObject(value: unknown): Readonly<Record<string, unknown>> {
  const object = plainObject(value, "X25519 public JWK");
  exactObjectKeys(object, ["crv", "kty", "x"], "X25519 public JWK");
  return object;
}

export function normalizeX25519PublicJwk(value: unknown): X25519PublicJwk {
  const object = normalizedPublicObject(value);
  if (object.kty !== "OKP" || object.crv !== "X25519") {
    throw new E2EValidationError("X25519 public JWK must use kty=OKP and crv=X25519");
  }
  const x = requiredString(object.x, "X25519 public JWK x", 64);
  base64UrlDecode(x, "X25519 public JWK x", { exactBytes: X25519_KEY_BYTES });
  return { kty: "OKP", crv: "X25519", x };
}

export function normalizeX25519PrivateJwk(value: unknown): X25519PrivateJwk {
  const object = plainObject(value, "X25519 private JWK");
  exactObjectKeys(object, ["crv", "d", "kty", "x"], "X25519 private JWK");
  if (object.kty !== "OKP" || object.crv !== "X25519") {
    throw new E2EValidationError("X25519 private JWK must use kty=OKP and crv=X25519");
  }
  const x = requiredString(object.x, "X25519 private JWK x", 64);
  const d = requiredString(object.d, "X25519 private JWK d", 64);
  base64UrlDecode(x, "X25519 private JWK x", { exactBytes: X25519_KEY_BYTES });
  base64UrlDecode(d, "X25519 private JWK d", { exactBytes: X25519_KEY_BYTES });
  return { kty: "OKP", crv: "X25519", x, d };
}

export function x25519PublicFromPrivate(value: X25519PrivateJwk): X25519PublicJwk {
  const normalized = normalizeX25519PrivateJwk(value);
  return { kty: "OKP", crv: "X25519", x: normalized.x };
}

export async function x25519JwkThumbprintUri(value: X25519PublicJwk): Promise<string> {
  const normalized = normalizeX25519PublicJwk(value);
  const digest = await sha256(canonicalBytes({
    crv: normalized.crv,
    kty: normalized.kty,
    x: normalized.x,
  }));
  return `${JWK_THUMBPRINT_URI_PREFIX}${base64UrlEncode(digest)}`;
}

export async function generateX25519KeyPair(): Promise<X25519KeyPair> {
  const pair = await globalThis.crypto.subtle.generateKey(
    { name: "X25519" },
    true,
    ["deriveBits"],
  ) as CryptoKeyPair;
  const exportedPublic = await globalThis.crypto.subtle.exportKey("jwk", pair.publicKey);
  const exportedPrivate = await globalThis.crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicKeyJwk = normalizeX25519PublicJwk({
    kty: exportedPublic.kty,
    crv: exportedPublic.crv,
    x: exportedPublic.x,
  });
  const privateKeyJwk = normalizeX25519PrivateJwk({
    kty: exportedPrivate.kty,
    crv: exportedPrivate.crv,
    x: exportedPrivate.x,
    d: exportedPrivate.d,
  });
  return {
    keyId: await x25519JwkThumbprintUri(publicKeyJwk),
    publicKeyJwk,
    privateKeyJwk,
  };
}

export function normalizeVaultEpochId(value: unknown): VaultEpochId {
  const id = requiredString(value, "vault epoch id", EPOCH_ID_PREFIX.length + 22);
  if (!id.startsWith(EPOCH_ID_PREFIX)) {
    throw new E2EValidationError("vault epoch id has an unsupported prefix");
  }
  const suffix = id.slice(EPOCH_ID_PREFIX.length);
  base64UrlDecode(suffix, "vault epoch id", { exactBytes: EPOCH_ID_RANDOM_BYTES });
  return id as VaultEpochId;
}

export function vaultEpochSecret(value: ArrayBufferLike | ArrayBufferView): VaultEpochSecret {
  const source = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  if (bytes.byteLength !== 32) {
    throw new E2EValidationError("vault epoch secret must be exactly 32 bytes");
  }
  return bytes as VaultEpochSecret;
}

export function generateVaultEpoch(): VaultEpoch {
  const idBytes = globalThis.crypto.getRandomValues(new Uint8Array(EPOCH_ID_RANDOM_BYTES));
  const secretBytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return {
    epochId: normalizeVaultEpochId(`${EPOCH_ID_PREFIX}${base64UrlEncode(idBytes)}`),
    secret: vaultEpochSecret(secretBytes),
  };
}

export function x25519PublicJwkJson(value: X25519PublicJwk): string {
  return canonicalJson(normalizeX25519PublicJwk(value));
}
