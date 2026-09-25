import {
  normalizeAccessPrincipal,
  type AccessPrincipal,
} from "@ssrl/access";
import { canonicalJson } from "@ssrl/core";
import {
  normalizeX25519PublicJwk,
  x25519JwkThumbprintUri,
  type X25519PublicJwk,
} from "@ssrl/e2e";

export type EncryptionBindingSubjectKind = "device-signing-key" | "recovery-credential";

interface TrustedEncryptionKeyBindingBase {
  readonly encryptionKeyId: string;
  readonly publicKeyJwk: X25519PublicJwk;
  readonly subjectKeyId: string;
  readonly principal: AccessPrincipal;
  readonly boundAt: string;
}

export interface TrustedDeviceEncryptionKeyBinding extends TrustedEncryptionKeyBindingBase {
  readonly subjectKind: "device-signing-key";
  readonly deviceId: string;
}

export interface TrustedRecoveryEncryptionKeyBinding extends TrustedEncryptionKeyBindingBase {
  readonly subjectKind: "recovery-credential";
  readonly recoveryGeneration: number;
}

export type TrustedEncryptionKeyBinding =
  | TrustedDeviceEncryptionKeyBinding
  | TrustedRecoveryEncryptionKeyBinding;

export type ActiveEncryptionRecipient = TrustedEncryptionKeyBinding;

function requiredString(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${label} must not be empty`);
  return normalized;
}

function positiveGeneration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function normalizeTimestamp(value: string, label: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${label} must be a valid timestamp`);
  return new Date(milliseconds).toISOString();
}

export async function encryptionKeyIdentity(
  publicKeyJwk: JsonWebKey | X25519PublicJwk,
): Promise<{ readonly encryptionKeyId: string; readonly publicKeyJwk: X25519PublicJwk }> {
  const normalized = normalizeX25519PublicJwk(publicKeyJwk);
  return {
    encryptionKeyId: await x25519JwkThumbprintUri(normalized),
    publicKeyJwk: normalized,
  };
}

export async function normalizeTrustedEncryptionKeyBinding(
  binding: TrustedEncryptionKeyBinding,
): Promise<TrustedEncryptionKeyBinding> {
  const identity = await encryptionKeyIdentity(binding.publicKeyJwk);
  if (binding.encryptionKeyId !== identity.encryptionKeyId) {
    throw new TypeError(
      `encryptionKeyId does not match RFC 9278 JWK Thumbprint URI: ${binding.encryptionKeyId}`,
    );
  }
  const common = {
    encryptionKeyId: identity.encryptionKeyId,
    publicKeyJwk: identity.publicKeyJwk,
    subjectKeyId: requiredString(binding.subjectKeyId, "encryption binding subjectKeyId"),
    principal: normalizeAccessPrincipal(binding.principal),
    boundAt: normalizeTimestamp(binding.boundAt, "encryption binding boundAt"),
  };
  if (binding.subjectKind === "device-signing-key") {
    return {
      ...common,
      subjectKind: binding.subjectKind,
      deviceId: requiredString(binding.deviceId, "encryption binding deviceId"),
    };
  }
  if (binding.subjectKind === "recovery-credential") {
    return {
      ...common,
      subjectKind: binding.subjectKind,
      recoveryGeneration: positiveGeneration(
        binding.recoveryGeneration,
        "encryption binding recoveryGeneration",
      ),
    };
  }
  throw new TypeError("encryption binding subjectKind is invalid");
}

export async function trustedEncryptionKeyBindingJson(
  binding: TrustedEncryptionKeyBinding,
): Promise<string> {
  return canonicalJson(await normalizeTrustedEncryptionKeyBinding(binding));
}
