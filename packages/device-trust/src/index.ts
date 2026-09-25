import {
  normalizeAccessPrincipal,
  type AccessPrincipal,
} from "@ssrl/access";
import { canonicalJson } from "@ssrl/core";
import {
  normalizeX25519PublicJwk,
  type X25519PublicJwk,
} from "@ssrl/e2e";
import {
  encryptionKeyIdentity,
  normalizeTrustedEncryptionKeyBinding,
  type ActiveEncryptionRecipient,
  type EncryptionBindingSubjectKind,
  type TrustedDeviceEncryptionKeyBinding,
  type TrustedEncryptionKeyBinding,
  type TrustedRecoveryEncryptionKeyBinding,
} from "./encryption-binding.js";

const JWK_THUMBPRINT_URI_PREFIX = "urn:ietf:params:oauth:jwk-thumbprint:sha-256:";
const DEVICE_TRUST_PROOF_SCHEMA = "ssrl-device-trust-proof-v1" as const;
const RECOVERY_PROVISIONING_PROOF_SCHEMA = "ssrl-recovery-provisioning-proof-v1" as const;
export const ENCRYPTION_BINDING_PROOF_SCHEMA = "ssrl-encryption-binding-proof-v1" as const;
export const DEVICE_RECOVERY_CHALLENGE_SCHEMA = "ssrl-device-recovery-challenge-v1" as const;
const DEVICE_RECOVERY_PROOF_SCHEMA = "ssrl-device-recovery-proof-v1" as const;
export const DEVICE_ENROLLMENT_OFFER_SCHEMA = "ssrl-device-enrollment-offer-v1" as const;
const DEFAULT_CHALLENGE_LIFETIME_SECONDS = 300;
const MAX_CHALLENGE_LIFETIME_SECONDS = 900;
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

export type TrustedDeviceStatus = "active" | "revoked";
export type TrustedDeviceKeyStatus = "active" | "revoked";
export type TrustedRecoveryCredentialStatus = "active" | "retired";
export type DeviceTrustOperation = "enroll-device" | "rotate-key";
export type DeviceTrustEventType =
  | "bootstrap-device"
  | "enroll-device"
  | "rotate-key"
  | "revoke-key"
  | "revoke-device"
  | "set-recovery-credential"
  | "recover-trust-set"
  | "bind-encryption-key";

export interface Ed25519PublicJwk {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
}

export interface DeviceEnrollmentOffer {
  readonly schema: typeof DEVICE_ENROLLMENT_OFFER_SCHEMA;
  readonly deviceId: string;
  readonly displayName: string;
  readonly publicKeyJwk: Ed25519PublicJwk;
  readonly keyId: string;
  readonly encryptionPublicKeyJwk: X25519PublicJwk;
  readonly encryptionKeyId: string;
  readonly audience: string;
}

export interface DeviceEnrollmentOfferInput {
  readonly deviceId: string;
  readonly displayName: string;
  readonly publicKeyJwk: JsonWebKey;
  readonly encryptionPublicKeyJwk: JsonWebKey;
  readonly audience: string;
}

export interface TrustedDevice {
  readonly deviceId: string;
  readonly principal: AccessPrincipal;
  readonly displayName: string;
  readonly enrolledAt: string;
  readonly status: TrustedDeviceStatus;
  readonly revokedAt?: string;
}

export interface TrustedDeviceKey {
  readonly keyId: string;
  readonly deviceId: string;
  readonly publicKeyJwk: Ed25519PublicJwk;
  readonly activatedAt: string;
  readonly status: TrustedDeviceKeyStatus;
  readonly revokedAt?: string;
  readonly predecessorKeyId?: string;
}


export interface TrustedRecoveryCredential {
  readonly keyId: string;
  readonly principal: AccessPrincipal;
  readonly publicKeyJwk: Ed25519PublicJwk;
  readonly generation: number;
  readonly activatedAt: string;
  readonly status: TrustedRecoveryCredentialStatus;
  readonly retiredAt?: string;
  readonly predecessorKeyId?: string;
}

export type DeviceTrustActor =
  | { readonly mode: "local-bootstrap" }
  | {
    readonly mode: "trusted-device";
    readonly deviceId: string;
    readonly keyId: string;
  }
  | {
    readonly mode: "recovery-credential";
    readonly keyId: string;
    readonly generation: number;
  };

interface DeviceTrustEventBase {
  readonly eventId: string;
  readonly type: DeviceTrustEventType;
  readonly occurredAt: string;
  readonly principal: AccessPrincipal;
  readonly deviceId: string;
  readonly actor: DeviceTrustActor;
}

export interface BootstrapDeviceEvent extends DeviceTrustEventBase {
  readonly type: "bootstrap-device";
  readonly keyId: string;
  readonly encryptionKeyId?: string;
}

export interface EnrollDeviceEvent extends DeviceTrustEventBase {
  readonly type: "enroll-device";
  readonly keyId: string;
  readonly challengeId: string;
  readonly encryptionKeyId?: string;
}

export interface RotateKeyEvent extends DeviceTrustEventBase {
  readonly type: "rotate-key";
  readonly keyId: string;
  readonly predecessorKeyId: string;
  readonly challengeId: string;
  readonly encryptionKeyId?: string;
}

export interface RevokeKeyEvent extends DeviceTrustEventBase {
  readonly type: "revoke-key";
  readonly keyId: string;
}

export interface RevokeDeviceEvent extends DeviceTrustEventBase {
  readonly type: "revoke-device";
}

export interface SetRecoveryCredentialEvent extends DeviceTrustEventBase {
  readonly type: "set-recovery-credential";
  readonly recoveryKeyId: string;
  readonly recoveryGeneration: number;
  readonly encryptionKeyId?: string;
  readonly audience: string;
}

export interface RecoverTrustSetEvent extends DeviceTrustEventBase {
  readonly type: "recover-trust-set";
  readonly keyId: string;
  readonly challengeId: string;
  readonly recoveryKeyId: string;
  readonly recoveryGeneration: number;
  readonly nextRecoveryKeyId: string;
  readonly nextRecoveryGeneration: number;
  readonly deviceEncryptionKeyId?: string;
  readonly nextRecoveryEncryptionKeyId?: string;
  readonly audience: string;
}

export interface BindEncryptionKeyEvent extends DeviceTrustEventBase {
  readonly type: "bind-encryption-key";
  readonly subjectKind: EncryptionBindingSubjectKind;
  readonly subjectKeyId: string;
  readonly encryptionKeyId: string;
  readonly audience: string;
}

export type DeviceTrustEvent =
  | BootstrapDeviceEvent
  | EnrollDeviceEvent
  | RotateKeyEvent
  | RevokeKeyEvent
  | RevokeDeviceEvent
  | SetRecoveryCredentialEvent
  | RecoverTrustSetEvent
  | BindEncryptionKeyEvent;

export interface DeviceTrustChallenge {
  readonly challengeId: string;
  readonly challenge: string;
  readonly operation: DeviceTrustOperation;
  readonly principal: AccessPrincipal;
  readonly deviceId: string;
  readonly displayName: string;
  readonly publicKeyJwk: Ed25519PublicJwk;
  readonly keyId: string;
  readonly encryptionPublicKeyJwk?: X25519PublicJwk;
  readonly encryptionKeyId?: string;
  readonly audience: string;
  readonly authorizedByDeviceId: string;
  readonly authorizedByKeyId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface StoredDeviceTrustChallenge {
  readonly challenge: DeviceTrustChallenge;
  readonly consumedAt?: string;
}


export interface DeviceRecoveryChallenge {
  readonly schema: typeof DEVICE_RECOVERY_CHALLENGE_SCHEMA;
  readonly challengeId: string;
  readonly challenge: string;
  readonly principal: AccessPrincipal;
  readonly recoveryKeyId: string;
  readonly recoveryGeneration: number;
  readonly recoveryPublicKeyJwk: Ed25519PublicJwk;
  readonly deviceId: string;
  readonly displayName: string;
  readonly publicKeyJwk: Ed25519PublicJwk;
  readonly keyId: string;
  readonly deviceEncryptionPublicKeyJwk?: X25519PublicJwk;
  readonly deviceEncryptionKeyId?: string;
  readonly nextRecoveryPublicKeyJwk: Ed25519PublicJwk;
  readonly nextRecoveryKeyId: string;
  readonly nextRecoveryEncryptionPublicKeyJwk?: X25519PublicJwk;
  readonly nextRecoveryEncryptionKeyId?: string;
  readonly nextRecoveryGeneration: number;
  readonly audience: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface StoredDeviceRecoveryChallenge {
  readonly challenge: DeviceRecoveryChallenge;
  readonly consumedAt?: string;
}

export interface ReplicationDeviceCredential {
  readonly keyId: string;
  readonly publicKeyJwk: JsonWebKey;
  readonly principal: AccessPrincipal;
  readonly status?: TrustedDeviceKeyStatus;
  readonly deviceId?: string;
}

export interface ReplicationDeviceKeyResolver {
  resolve(
    keyId: string,
  ): ReplicationDeviceCredential | undefined | Promise<ReplicationDeviceCredential | undefined>;
}

export interface ReplicationSignatureReplayInput {
  readonly keyId: string;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly now: number;
}

export interface ReplicationSignatureReplayStore {
  /** Returns true only when this key/nonce pair was accepted for the first time. */
  consume(input: ReplicationSignatureReplayInput): boolean | Promise<boolean>;
}

export interface DeviceTrustMutationResult {
  readonly outcome: "inserted" | "replayed";
  readonly event: DeviceTrustEvent;
  readonly device: TrustedDevice;
  readonly key?: TrustedDeviceKey;
}

export interface BootstrapDeviceTransition {
  readonly event: BootstrapDeviceEvent;
  readonly device: TrustedDevice;
  readonly key: TrustedDeviceKey;
  readonly encryptionBinding?: TrustedDeviceEncryptionKeyBinding;
}

export interface EnrollDeviceTransition {
  readonly event: EnrollDeviceEvent;
  readonly challenge: DeviceTrustChallenge;
  readonly device: TrustedDevice;
  readonly key: TrustedDeviceKey;
  readonly encryptionBinding?: TrustedDeviceEncryptionKeyBinding;
  readonly now: string;
}

export interface RotateKeyTransition {
  readonly event: RotateKeyEvent;
  readonly challenge: DeviceTrustChallenge;
  readonly deviceId: string;
  readonly predecessorKeyId: string;
  readonly key: TrustedDeviceKey;
  readonly encryptionBinding?: TrustedDeviceEncryptionKeyBinding;
  readonly now: string;
}

export interface RevokeKeyTransition {
  readonly event: RevokeKeyEvent;
  readonly keyId: string;
  readonly now: string;
}

export interface RevokeDeviceTransition {
  readonly event: RevokeDeviceEvent;
  readonly deviceId: string;
  readonly now: string;
}


export interface RecoveryCredentialMutationResult {
  readonly outcome: "inserted" | "replayed";
  readonly event: SetRecoveryCredentialEvent;
  readonly credential: TrustedRecoveryCredential;
}

export interface RecoveryTrustSetMutationResult {
  readonly outcome: "inserted" | "replayed";
  readonly event: RecoverTrustSetEvent;
  readonly device: TrustedDevice;
  readonly key: TrustedDeviceKey;
  readonly recoveryCredential: TrustedRecoveryCredential;
}

export interface EncryptionBindingMutationResult {
  readonly outcome: "inserted" | "replayed";
  readonly event: BindEncryptionKeyEvent;
  readonly binding: TrustedEncryptionKeyBinding;
}

export interface BindEncryptionKeyTransition {
  readonly event: BindEncryptionKeyEvent;
  readonly binding: TrustedEncryptionKeyBinding;
}

export interface SetRecoveryCredentialTransition {
  readonly event: SetRecoveryCredentialEvent;
  readonly credential: TrustedRecoveryCredential;
  readonly encryptionBinding?: TrustedRecoveryEncryptionKeyBinding;
  readonly previousRecoveryKeyId?: string;
  readonly now: string;
}

export interface RecoverTrustSetTransition {
  readonly event: RecoverTrustSetEvent;
  readonly challenge: DeviceRecoveryChallenge;
  readonly device: TrustedDevice;
  readonly key: TrustedDeviceKey;
  readonly recoveryCredential: TrustedRecoveryCredential;
  readonly deviceEncryptionBinding?: TrustedDeviceEncryptionKeyBinding;
  readonly recoveryEncryptionBinding?: TrustedRecoveryEncryptionKeyBinding;
  readonly previousRecoveryKeyId: string;
  readonly now: string;
}

export interface DeviceTrustRepository
  extends ReplicationDeviceKeyResolver, ReplicationSignatureReplayStore {
  isEmpty(): boolean | Promise<boolean>;
  device(deviceId: string): TrustedDevice | undefined | Promise<TrustedDevice | undefined>;
  key(keyId: string): TrustedDeviceKey | undefined | Promise<TrustedDeviceKey | undefined>;
  event(eventId: string): DeviceTrustEvent | undefined | Promise<DeviceTrustEvent | undefined>;
  challenge(
    challengeId: string,
  ): StoredDeviceTrustChallenge | undefined | Promise<StoredDeviceTrustChallenge | undefined>;
  recoveryCredential(
    keyId: string,
  ): TrustedRecoveryCredential | undefined | Promise<TrustedRecoveryCredential | undefined>;
  activeRecoveryCredential(
    principal: AccessPrincipal,
  ): TrustedRecoveryCredential | undefined | Promise<TrustedRecoveryCredential | undefined>;
  encryptionBinding(
    encryptionKeyId: string,
  ): TrustedEncryptionKeyBinding | undefined | Promise<TrustedEncryptionKeyBinding | undefined>;
  encryptionBindingForSubject(
    subjectKind: EncryptionBindingSubjectKind,
    subjectKeyId: string,
  ): TrustedEncryptionKeyBinding | undefined | Promise<TrustedEncryptionKeyBinding | undefined>;
  activeEncryptionRecipients(
    principal: AccessPrincipal,
  ): readonly ActiveEncryptionRecipient[] | Promise<readonly ActiveEncryptionRecipient[]>;
  recoveryChallenge(
    challengeId: string,
  ): StoredDeviceRecoveryChallenge | undefined | Promise<StoredDeviceRecoveryChallenge | undefined>;
  issueChallenge(challenge: DeviceTrustChallenge): void | Promise<void>;
  issueRecoveryChallenge(challenge: DeviceRecoveryChallenge): void | Promise<void>;
  bootstrapDevice(transition: BootstrapDeviceTransition): DeviceTrustMutationResult | Promise<DeviceTrustMutationResult>;
  enrollDevice(transition: EnrollDeviceTransition): DeviceTrustMutationResult | Promise<DeviceTrustMutationResult>;
  rotateKey(transition: RotateKeyTransition): DeviceTrustMutationResult | Promise<DeviceTrustMutationResult>;
  revokeKey(transition: RevokeKeyTransition): DeviceTrustMutationResult | Promise<DeviceTrustMutationResult>;
  revokeDevice(transition: RevokeDeviceTransition): DeviceTrustMutationResult | Promise<DeviceTrustMutationResult>;
  setRecoveryCredential(
    transition: SetRecoveryCredentialTransition,
  ): RecoveryCredentialMutationResult | Promise<RecoveryCredentialMutationResult>;
  recoverTrustSet(
    transition: RecoverTrustSetTransition,
  ): RecoveryTrustSetMutationResult | Promise<RecoveryTrustSetMutationResult>;
  bindEncryptionKey(
    transition: BindEncryptionKeyTransition,
  ): EncryptionBindingMutationResult | Promise<EncryptionBindingMutationResult>;
  pruneExpired(now: string): number | Promise<number>;
}

export interface ActiveDeviceAuthorization {
  readonly device: TrustedDevice;
  readonly key: TrustedDeviceKey;
}

export interface DeviceTrustManagerOptions {
  readonly repository: DeviceTrustRepository;
  readonly now?: () => number;
  readonly randomBytes?: (length: number) => Uint8Array;
  readonly challengeLifetimeSeconds?: number;
}

export interface LocalBootstrapInput {
  readonly eventId: string;
  readonly deviceId: string;
  readonly displayName: string;
  readonly principal: AccessPrincipal;
  readonly publicKeyJwk: JsonWebKey;
  readonly encryptionPublicKeyJwk: JsonWebKey;
}

export interface StartEnrollmentInput {
  /** Must come from an already-authenticated trust-management context, not request payload identity. */
  readonly authorizingKeyId: string;
  readonly deviceId: string;
  readonly displayName: string;
  readonly publicKeyJwk: JsonWebKey;
  readonly encryptionPublicKeyJwk: JsonWebKey;
  readonly audience: string;
}

export interface StartRotationInput {
  /** Must come from an already-authenticated trust-management context. */
  readonly authorizingKeyId: string;
  readonly publicKeyJwk: JsonWebKey;
  readonly encryptionPublicKeyJwk: JsonWebKey;
  readonly audience: string;
}

export interface CompleteChallengeInput {
  readonly eventId: string;
  readonly challengeId: string;
  readonly signature: Uint8Array;
}

export interface RevokeKeyInput {
  readonly eventId: string;
  readonly authorizingKeyId: string;
  readonly targetKeyId: string;
}

export interface RevokeDeviceInput {
  readonly eventId: string;
  readonly authorizingKeyId: string;
  readonly targetDeviceId: string;
}


export interface PrepareRecoveryCredentialInput {
  readonly eventId: string;
  readonly authorizingKeyId: string;
  readonly publicKeyJwk: JsonWebKey;
  readonly encryptionPublicKeyJwk: JsonWebKey;
  readonly audience: string;
}

export interface SetRecoveryCredentialInput extends PrepareRecoveryCredentialInput {
  readonly signature: Uint8Array;
}

export interface StartRecoveryInput {
  readonly recoveryKeyId: string;
  readonly deviceId: string;
  readonly displayName: string;
  readonly publicKeyJwk: JsonWebKey;
  readonly deviceEncryptionPublicKeyJwk: JsonWebKey;
  readonly nextRecoveryPublicKeyJwk: JsonWebKey;
  readonly nextRecoveryEncryptionPublicKeyJwk: JsonWebKey;
  readonly audience: string;
}

export interface CompleteRecoveryInput {
  readonly eventId: string;
  readonly challengeId: string;
  readonly recoverySignature: Uint8Array;
  readonly deviceSignature: Uint8Array;
  readonly nextRecoverySignature: Uint8Array;
}

export interface RecoveryProvisioningProof {
  readonly schema: typeof RECOVERY_PROVISIONING_PROOF_SCHEMA;
  readonly eventId: string;
  readonly principal: AccessPrincipal;
  readonly authorizingDeviceId: string;
  readonly authorizingKeyId: string;
  readonly recoveryPublicKeyJwk: Ed25519PublicJwk;
  readonly recoveryKeyId: string;
  readonly recoveryEncryptionPublicKeyJwk: X25519PublicJwk;
  readonly recoveryEncryptionKeyId: string;
  readonly recoveryGeneration: number;
  readonly audience: string;
}

export interface EncryptionBindingProof {
  readonly schema: typeof ENCRYPTION_BINDING_PROOF_SCHEMA;
  readonly eventId: string;
  readonly subjectKind: EncryptionBindingSubjectKind;
  readonly subjectKeyId: string;
  readonly principal: AccessPrincipal;
  readonly authorizingDeviceId: string;
  readonly authorizingKeyId: string;
  readonly encryptionPublicKeyJwk: X25519PublicJwk;
  readonly encryptionKeyId: string;
  readonly audience: string;
  readonly deviceId?: string;
  readonly recoveryGeneration?: number;
}

export interface PrepareEncryptionBindingInput {
  readonly eventId: string;
  readonly authorizingKeyId: string;
  readonly subjectKind: EncryptionBindingSubjectKind;
  readonly subjectKeyId: string;
  readonly encryptionPublicKeyJwk: JsonWebKey;
  readonly audience: string;
}

export interface BindEncryptionKeyInput extends PrepareEncryptionBindingInput {
  readonly subjectSignature: Uint8Array;
}

export class DeviceTrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class DeviceTrustConflictError extends DeviceTrustError {}
export class DeviceTrustAuthorizationError extends DeviceTrustError {}
export class DeviceTrustChallengeError extends DeviceTrustError {}
export class DeviceTrustProofError extends DeviceTrustError {}

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

function nowIso(now: () => number): string {
  const value = now();
  if (!Number.isFinite(value)) throw new TypeError("device trust clock must return epoch milliseconds");
  return new Date(value).toISOString();
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary);
}

function base64Url(bytes: Uint8Array): string {
  let encoded = bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_");
  while (encoded.endsWith("=")) encoded = encoded.slice(0, -1);
  return encoded;
}

function base64UrlBytes(value: string): Uint8Array | undefined {
  if (!BASE64URL_32_BYTES.test(value)) return undefined;
  const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}=`;
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
    return bytes.byteLength === 32 && base64Url(bytes) === value ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function cloneBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(value.byteLength);
  const copy = new Uint8Array(buffer);
  copy.set(value);
  return copy;
}

function defaultRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function randomToken(
  randomBytes: (length: number) => Uint8Array,
  length: number,
  label: string,
): string {
  const bytes = randomBytes(length);
  if (bytes.byteLength !== length) throw new TypeError(`${label} random source returned wrong byte length`);
  return base64Url(bytes);
}

function configuredChallengeLifetime(value: number | undefined): number {
  const result = value ?? DEFAULT_CHALLENGE_LIFETIME_SECONDS;
  if (!Number.isSafeInteger(result) || result < 1 || result > MAX_CHALLENGE_LIFETIME_SECONDS) {
    throw new RangeError(
      `challenge lifetime must be an integer between 1 and ${MAX_CHALLENGE_LIFETIME_SECONDS} seconds`,
    );
  }
  return result;
}

function encryptionKeyIdentityShape(value: X25519PublicJwk | JsonWebKey): X25519PublicJwk {
  return normalizeX25519PublicJwk(value);
}

export function normalizeEd25519PublicJwk(value: JsonWebKey): Ed25519PublicJwk {
  if (
    value.kty !== "OKP"
    || value.crv !== "Ed25519"
    || typeof value.x !== "string"
    || base64UrlBytes(value.x) === undefined
    || value.d !== undefined
  ) {
    throw new TypeError("device public key must be a public Ed25519 OKP JWK");
  }
  return { crv: "Ed25519", kty: "OKP", x: value.x };
}

export async function ed25519JwkThumbprintUri(value: JsonWebKey): Promise<string> {
  const publicJwk = normalizeEd25519PublicJwk(value);
  const bytes = new TextEncoder().encode(canonicalJson(publicJwk));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return `${JWK_THUMBPRINT_URI_PREFIX}${base64Url(digest)}`;
}


export async function createDeviceEnrollmentOffer(
  input: DeviceEnrollmentOfferInput,
): Promise<DeviceEnrollmentOffer> {
  const publicKeyJwk = normalizeEd25519PublicJwk(input.publicKeyJwk);
  const encryption = await encryptionKeyIdentity(input.encryptionPublicKeyJwk);
  return {
    schema: DEVICE_ENROLLMENT_OFFER_SCHEMA,
    deviceId: requiredString(input.deviceId, "offer deviceId"),
    displayName: requiredString(input.displayName, "offer displayName"),
    publicKeyJwk,
    keyId: await ed25519JwkThumbprintUri(publicKeyJwk),
    encryptionPublicKeyJwk: encryption.publicKeyJwk,
    encryptionKeyId: encryption.encryptionKeyId,
    audience: requiredString(input.audience, "offer audience"),
  };
}

export async function normalizeDeviceEnrollmentOffer(
  value: DeviceEnrollmentOffer,
): Promise<DeviceEnrollmentOffer> {
  if (value.schema !== DEVICE_ENROLLMENT_OFFER_SCHEMA) {
    throw new TypeError("device enrollment offer schema is invalid");
  }
  const normalized = await createDeviceEnrollmentOffer(value);
  if (value.keyId !== normalized.keyId) {
    throw new TypeError("device enrollment offer keyId does not match public JWK thumbprint");
  }
  if (value.encryptionKeyId !== normalized.encryptionKeyId) {
    throw new TypeError("device enrollment offer encryptionKeyId does not match public JWK thumbprint");
  }
  return normalized;
}

export async function deviceEnrollmentOfferJson(
  offer: DeviceEnrollmentOffer,
): Promise<string> {
  return canonicalJson(await normalizeDeviceEnrollmentOffer(offer));
}

function displayFingerprint(bytes: Uint8Array): string {
  return Array.from(bytes.slice(0, 8), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()
    .match(/.{4}/g)!
    .join("-");
}

export async function deviceEnrollmentOfferFingerprint(
  offer: DeviceEnrollmentOffer,
): Promise<string> {
  const bytes = new TextEncoder().encode(await deviceEnrollmentOfferJson(offer));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return displayFingerprint(digest);
}

export async function assertEnrollmentChallengeMatchesOffer(
  challenge: DeviceTrustChallenge,
  offer: DeviceEnrollmentOffer,
): Promise<DeviceTrustChallenge> {
  const normalizedOffer = await normalizeDeviceEnrollmentOffer(offer);
  const normalizedChallenge = await validateDeviceTrustChallengeKeyId(challenge);
  if (
    normalizedChallenge.operation !== "enroll-device"
    || normalizedChallenge.deviceId !== normalizedOffer.deviceId
    || normalizedChallenge.displayName !== normalizedOffer.displayName
    || normalizedChallenge.keyId !== normalizedOffer.keyId
    || canonicalJson(normalizedChallenge.publicKeyJwk) !== canonicalJson(normalizedOffer.publicKeyJwk)
    || normalizedChallenge.encryptionKeyId !== normalizedOffer.encryptionKeyId
    || canonicalJson(normalizedChallenge.encryptionPublicKeyJwk)
      !== canonicalJson(normalizedOffer.encryptionPublicKeyJwk)
    || normalizedChallenge.audience !== normalizedOffer.audience
  ) {
    throw new DeviceTrustChallengeError("enrollment challenge does not match the local device offer");
  }
  return normalizedChallenge;
}

export async function signEnrollmentChallengeForOffer(
  challenge: DeviceTrustChallenge,
  offer: DeviceEnrollmentOffer,
  privateKey: CryptoKey,
): Promise<Uint8Array> {
  const normalized = await assertEnrollmentChallengeMatchesOffer(challenge, offer);
  return signDeviceTrustChallenge(normalized, privateKey);
}

export function normalizeTrustedDevice(device: TrustedDevice): TrustedDevice {
  const status = device.status;
  if (status !== "active" && status !== "revoked") throw new TypeError("trusted device status is invalid");
  const enrolledAt = normalizeTimestamp(device.enrolledAt, "device enrolledAt");
  const revokedAt = device.revokedAt === undefined
    ? undefined
    : normalizeTimestamp(device.revokedAt, "device revokedAt");
  if (status === "active" && revokedAt !== undefined) {
    throw new TypeError("active trusted device cannot have revokedAt");
  }
  if (status === "revoked" && revokedAt === undefined) {
    throw new TypeError("revoked trusted device requires revokedAt");
  }
  if (revokedAt !== undefined && Date.parse(revokedAt) < Date.parse(enrolledAt)) {
    throw new TypeError("device revokedAt cannot precede enrolledAt");
  }
  return {
    deviceId: requiredString(device.deviceId, "deviceId"),
    principal: normalizeAccessPrincipal(device.principal),
    displayName: requiredString(device.displayName, "displayName"),
    enrolledAt,
    status,
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
}

export async function normalizeTrustedDeviceKey(key: TrustedDeviceKey): Promise<TrustedDeviceKey> {
  const status = key.status;
  if (status !== "active" && status !== "revoked") throw new TypeError("trusted device key status is invalid");
  const publicKeyJwk = normalizeEd25519PublicJwk(key.publicKeyJwk);
  const expectedKeyId = await ed25519JwkThumbprintUri(publicKeyJwk);
  if (key.keyId !== expectedKeyId) {
    throw new TypeError(`device keyId does not match RFC 9278 JWK Thumbprint URI: ${key.keyId}`);
  }
  const activatedAt = normalizeTimestamp(key.activatedAt, "key activatedAt");
  const revokedAt = key.revokedAt === undefined
    ? undefined
    : normalizeTimestamp(key.revokedAt, "key revokedAt");
  if (status === "active" && revokedAt !== undefined) throw new TypeError("active key cannot have revokedAt");
  if (status === "revoked" && revokedAt === undefined) throw new TypeError("revoked key requires revokedAt");
  if (revokedAt !== undefined && Date.parse(revokedAt) < Date.parse(activatedAt)) {
    throw new TypeError("key revokedAt cannot precede activatedAt");
  }
  return {
    keyId: expectedKeyId,
    deviceId: requiredString(key.deviceId, "key deviceId"),
    publicKeyJwk,
    activatedAt,
    status,
    ...(revokedAt === undefined ? {} : { revokedAt }),
    ...(key.predecessorKeyId === undefined
      ? {}
      : { predecessorKeyId: requiredString(key.predecessorKeyId, "predecessorKeyId") }),
  };
}

export async function normalizeTrustedRecoveryCredential(
  credential: TrustedRecoveryCredential,
): Promise<TrustedRecoveryCredential> {
  const status = credential.status;
  if (status !== "active" && status !== "retired") {
    throw new TypeError("trusted recovery credential status is invalid");
  }
  const publicKeyJwk = normalizeEd25519PublicJwk(credential.publicKeyJwk);
  const expectedKeyId = await ed25519JwkThumbprintUri(publicKeyJwk);
  if (credential.keyId !== expectedKeyId) {
    throw new TypeError(`recovery keyId does not match RFC 9278 JWK Thumbprint URI: ${credential.keyId}`);
  }
  const activatedAt = normalizeTimestamp(credential.activatedAt, "recovery credential activatedAt");
  const retiredAt = credential.retiredAt === undefined
    ? undefined
    : normalizeTimestamp(credential.retiredAt, "recovery credential retiredAt");
  if (status === "active" && retiredAt !== undefined) {
    throw new TypeError("active recovery credential cannot have retiredAt");
  }
  if (status === "retired" && retiredAt === undefined) {
    throw new TypeError("retired recovery credential requires retiredAt");
  }
  if (retiredAt !== undefined && Date.parse(retiredAt) < Date.parse(activatedAt)) {
    throw new TypeError("recovery credential retiredAt cannot precede activatedAt");
  }
  return {
    keyId: expectedKeyId,
    principal: normalizeAccessPrincipal(credential.principal),
    publicKeyJwk,
    generation: positiveGeneration(credential.generation, "recovery credential generation"),
    activatedAt,
    status,
    ...(retiredAt === undefined ? {} : { retiredAt }),
    ...(credential.predecessorKeyId === undefined
      ? {}
      : { predecessorKeyId: requiredString(credential.predecessorKeyId, "recovery predecessorKeyId") }),
  };
}

export async function trustedRecoveryCredentialJson(
  credential: TrustedRecoveryCredential,
): Promise<string> {
  return canonicalJson(await normalizeTrustedRecoveryCredential(credential));
}

function normalizeDeviceTrustActor(actor: DeviceTrustActor): DeviceTrustActor {
  if (actor.mode === "local-bootstrap") return { mode: "local-bootstrap" };
  if (actor.mode === "trusted-device") {
    return {
      mode: "trusted-device",
      deviceId: requiredString(actor.deviceId, "actor deviceId"),
      keyId: requiredString(actor.keyId, "actor keyId"),
    };
  }
  if (actor.mode === "recovery-credential") {
    return {
      mode: "recovery-credential",
      keyId: requiredString(actor.keyId, "recovery actor keyId"),
      generation: positiveGeneration(actor.generation, "recovery actor generation"),
    };
  }
  throw new TypeError("device trust actor mode is invalid");
}

export function normalizeDeviceTrustEvent(event: DeviceTrustEvent): DeviceTrustEvent {
  const base = {
    eventId: requiredString(event.eventId, "eventId"),
    occurredAt: normalizeTimestamp(event.occurredAt, "event occurredAt"),
    principal: normalizeAccessPrincipal(event.principal),
    deviceId: requiredString(event.deviceId, "event deviceId"),
    actor: normalizeDeviceTrustActor(event.actor),
  };
  switch (event.type) {
    case "bootstrap-device":
      if (event.actor.mode !== "local-bootstrap") {
        throw new TypeError("bootstrap-device event requires local-bootstrap actor");
      }
      return {
        ...base,
        type: event.type,
        keyId: requiredString(event.keyId, "event keyId"),
        ...(event.encryptionKeyId === undefined
          ? {}
          : { encryptionKeyId: requiredString(event.encryptionKeyId, "event encryptionKeyId") }),
      };
    case "enroll-device":
      if (event.actor.mode !== "trusted-device") {
        throw new TypeError("enroll-device event requires trusted-device actor");
      }
      return {
        ...base,
        type: event.type,
        keyId: requiredString(event.keyId, "event keyId"),
        challengeId: requiredString(event.challengeId, "event challengeId"),
        ...(event.encryptionKeyId === undefined
          ? {}
          : { encryptionKeyId: requiredString(event.encryptionKeyId, "event encryptionKeyId") }),
      };
    case "rotate-key":
      if (event.actor.mode !== "trusted-device") {
        throw new TypeError("rotate-key event requires trusted-device actor");
      }
      return {
        ...base,
        type: event.type,
        keyId: requiredString(event.keyId, "event keyId"),
        predecessorKeyId: requiredString(event.predecessorKeyId, "event predecessorKeyId"),
        challengeId: requiredString(event.challengeId, "event challengeId"),
        ...(event.encryptionKeyId === undefined
          ? {}
          : { encryptionKeyId: requiredString(event.encryptionKeyId, "event encryptionKeyId") }),
      };
    case "revoke-key":
      if (event.actor.mode !== "trusted-device") {
        throw new TypeError("revoke-key event requires trusted-device actor");
      }
      return { ...base, type: event.type, keyId: requiredString(event.keyId, "event keyId") };
    case "revoke-device":
      if (event.actor.mode !== "trusted-device") {
        throw new TypeError("revoke-device event requires trusted-device actor");
      }
      return { ...base, type: event.type };
    case "set-recovery-credential":
      if (event.actor.mode !== "trusted-device") {
        throw new TypeError("set-recovery-credential event requires trusted-device actor");
      }
      return {
        ...base,
        type: event.type,
        recoveryKeyId: requiredString(event.recoveryKeyId, "event recoveryKeyId"),
        recoveryGeneration: positiveGeneration(event.recoveryGeneration, "event recoveryGeneration"),
        ...(event.encryptionKeyId === undefined
          ? {}
          : { encryptionKeyId: requiredString(event.encryptionKeyId, "event encryptionKeyId") }),
        audience: requiredString(event.audience, "event audience"),
      };
    case "recover-trust-set":
      if (event.actor.mode !== "recovery-credential") {
        throw new TypeError("recover-trust-set event requires recovery-credential actor");
      }
      return {
        ...base,
        type: event.type,
        keyId: requiredString(event.keyId, "event keyId"),
        challengeId: requiredString(event.challengeId, "event challengeId"),
        recoveryKeyId: requiredString(event.recoveryKeyId, "event recoveryKeyId"),
        recoveryGeneration: positiveGeneration(event.recoveryGeneration, "event recoveryGeneration"),
        nextRecoveryKeyId: requiredString(event.nextRecoveryKeyId, "event nextRecoveryKeyId"),
        nextRecoveryGeneration: positiveGeneration(
          event.nextRecoveryGeneration,
          "event nextRecoveryGeneration",
        ),
        ...(event.deviceEncryptionKeyId === undefined
          ? {}
          : { deviceEncryptionKeyId: requiredString(event.deviceEncryptionKeyId, "event deviceEncryptionKeyId") }),
        ...(event.nextRecoveryEncryptionKeyId === undefined
          ? {}
          : {
            nextRecoveryEncryptionKeyId: requiredString(
              event.nextRecoveryEncryptionKeyId,
              "event nextRecoveryEncryptionKeyId",
            ),
          }),
        audience: requiredString(event.audience, "event audience"),
      };
    case "bind-encryption-key":
      if (event.actor.mode !== "trusted-device") {
        throw new TypeError("bind-encryption-key event requires trusted-device management actor");
      }
      if (event.subjectKind !== "device-signing-key" && event.subjectKind !== "recovery-credential") {
        throw new TypeError("bind-encryption-key subjectKind is invalid");
      }
      return {
        ...base,
        type: event.type,
        subjectKind: event.subjectKind,
        subjectKeyId: requiredString(event.subjectKeyId, "event subjectKeyId"),
        encryptionKeyId: requiredString(event.encryptionKeyId, "event encryptionKeyId"),
        audience: requiredString(event.audience, "event audience"),
      };
    default:
      throw new TypeError("device trust event type is invalid");
  }
}

export function trustedDeviceJson(device: TrustedDevice): string {
  return canonicalJson(normalizeTrustedDevice(device));
}

export async function trustedDeviceKeyJson(key: TrustedDeviceKey): Promise<string> {
  return canonicalJson(await normalizeTrustedDeviceKey(key));
}

export function deviceTrustEventJson(event: DeviceTrustEvent): string {
  return canonicalJson(normalizeDeviceTrustEvent(event));
}

export function normalizeDeviceTrustChallenge(challenge: DeviceTrustChallenge): DeviceTrustChallenge {
  const createdAt = normalizeTimestamp(challenge.createdAt, "challenge createdAt");
  const expiresAt = normalizeTimestamp(challenge.expiresAt, "challenge expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new TypeError("challenge expiresAt must be after createdAt");
  }
  if (challenge.operation !== "enroll-device" && challenge.operation !== "rotate-key") {
    throw new TypeError("device trust challenge operation is invalid");
  }
  const hasEncryptionJwk = challenge.encryptionPublicKeyJwk !== undefined;
  const hasEncryptionKeyId = challenge.encryptionKeyId !== undefined;
  if (hasEncryptionJwk !== hasEncryptionKeyId) {
    throw new TypeError("device trust challenge encryption binding is incomplete");
  }
  const encryptionPublicKeyJwk = challenge.encryptionPublicKeyJwk === undefined
    ? undefined
    : encryptionKeyIdentityShape(challenge.encryptionPublicKeyJwk);
  return {
    challengeId: requiredString(challenge.challengeId, "challengeId"),
    challenge: requiredString(challenge.challenge, "challenge"),
    operation: challenge.operation,
    principal: normalizeAccessPrincipal(challenge.principal),
    deviceId: requiredString(challenge.deviceId, "challenge deviceId"),
    displayName: requiredString(challenge.displayName, "challenge displayName"),
    publicKeyJwk: normalizeEd25519PublicJwk(challenge.publicKeyJwk),
    keyId: requiredString(challenge.keyId, "challenge keyId"),
    ...(encryptionPublicKeyJwk === undefined ? {} : {
      encryptionPublicKeyJwk,
      encryptionKeyId: requiredString(challenge.encryptionKeyId!, "challenge encryptionKeyId"),
    }),
    audience: requiredString(challenge.audience, "challenge audience"),
    authorizedByDeviceId: requiredString(challenge.authorizedByDeviceId, "authorizedByDeviceId"),
    authorizedByKeyId: requiredString(challenge.authorizedByKeyId, "authorizedByKeyId"),
    createdAt,
    expiresAt,
  };
}

export function deviceTrustChallengeJson(challenge: DeviceTrustChallenge): string {
  return canonicalJson(normalizeDeviceTrustChallenge(challenge));
}

export async function validateDeviceTrustChallengeKeyId(
  challenge: DeviceTrustChallenge,
): Promise<DeviceTrustChallenge> {
  const normalized = normalizeDeviceTrustChallenge(challenge);
  const expected = await ed25519JwkThumbprintUri(normalized.publicKeyJwk);
  if (normalized.keyId !== expected) {
    throw new TypeError("challenge keyId does not match public JWK thumbprint");
  }
  if (normalized.encryptionPublicKeyJwk !== undefined) {
    const encryption = await encryptionKeyIdentity(normalized.encryptionPublicKeyJwk);
    if (normalized.encryptionKeyId !== encryption.encryptionKeyId) {
      throw new TypeError("challenge encryptionKeyId does not match public JWK thumbprint");
    }
  }
  return normalized;
}

export function deviceTrustProofJson(challenge: DeviceTrustChallenge): string {
  const normalized = normalizeDeviceTrustChallenge(challenge);
  return canonicalJson({
    schema: DEVICE_TRUST_PROOF_SCHEMA,
    challengeId: normalized.challengeId,
    challenge: normalized.challenge,
    operation: normalized.operation,
    principal: normalized.principal,
    deviceId: normalized.deviceId,
    displayName: normalized.displayName,
    publicKeyJwk: normalized.publicKeyJwk,
    keyId: normalized.keyId,
    ...(normalized.encryptionPublicKeyJwk === undefined ? {} : {
      encryptionPublicKeyJwk: normalized.encryptionPublicKeyJwk,
      encryptionKeyId: normalized.encryptionKeyId,
    }),
    audience: normalized.audience,
  });
}

export function deviceTrustProofBytes(challenge: DeviceTrustChallenge): Uint8Array {
  return new TextEncoder().encode(deviceTrustProofJson(challenge));
}

export async function signDeviceTrustChallenge(
  challenge: DeviceTrustChallenge,
  privateKey: CryptoKey,
): Promise<Uint8Array> {
  if (
    privateKey.type !== "private"
    || privateKey.algorithm.name !== "Ed25519"
    || !privateKey.usages.includes("sign")
  ) {
    throw new TypeError("device trust proof key must be an Ed25519 private CryptoKey");
  }
  return new Uint8Array(await globalThis.crypto.subtle.sign(
    "Ed25519",
    privateKey,
    cloneBytes(deviceTrustProofBytes(challenge)),
  ));
}

export async function verifyDeviceTrustChallenge(
  challenge: DeviceTrustChallenge,
  signature: Uint8Array,
): Promise<boolean> {
  if (signature.byteLength !== 64) return false;
  let normalized: DeviceTrustChallenge;
  try {
    normalized = await validateDeviceTrustChallengeKeyId(challenge);
  } catch {
    return false;
  }
  const publicKey = await globalThis.crypto.subtle.importKey(
    "jwk",
    normalized.publicKeyJwk,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return globalThis.crypto.subtle.verify(
    "Ed25519",
    publicKey,
    cloneBytes(signature),
    cloneBytes(deviceTrustProofBytes(normalized)),
  );
}

async function verifyEd25519Proof(
  publicKeyJwk: Ed25519PublicJwk,
  signature: Uint8Array,
  bytes: Uint8Array,
): Promise<boolean> {
  if (signature.byteLength !== 64) return false;
  const publicKey = await globalThis.crypto.subtle.importKey(
    "jwk",
    publicKeyJwk,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return globalThis.crypto.subtle.verify(
    "Ed25519",
    publicKey,
    cloneBytes(signature),
    cloneBytes(bytes),
  );
}

async function signEd25519Proof(privateKey: CryptoKey, bytes: Uint8Array): Promise<Uint8Array> {
  if (
    privateKey.type !== "private"
    || privateKey.algorithm.name !== "Ed25519"
    || !privateKey.usages.includes("sign")
  ) {
    throw new TypeError("recovery proof key must be an Ed25519 private CryptoKey");
  }
  return new Uint8Array(await globalThis.crypto.subtle.sign(
    "Ed25519",
    privateKey,
    cloneBytes(bytes),
  ));
}

export async function normalizeRecoveryProvisioningProof(
  proof: RecoveryProvisioningProof,
): Promise<RecoveryProvisioningProof> {
  if (proof.schema !== RECOVERY_PROVISIONING_PROOF_SCHEMA) {
    throw new TypeError("recovery provisioning proof schema is invalid");
  }
  const recoveryPublicKeyJwk = normalizeEd25519PublicJwk(proof.recoveryPublicKeyJwk);
  const recoveryKeyId = await ed25519JwkThumbprintUri(recoveryPublicKeyJwk);
  if (proof.recoveryKeyId !== recoveryKeyId) {
    throw new TypeError("recovery provisioning keyId does not match public JWK thumbprint");
  }
  const recoveryEncryption = await encryptionKeyIdentity(proof.recoveryEncryptionPublicKeyJwk);
  if (proof.recoveryEncryptionKeyId !== recoveryEncryption.encryptionKeyId) {
    throw new TypeError("recovery provisioning encryptionKeyId does not match public JWK thumbprint");
  }
  return {
    schema: RECOVERY_PROVISIONING_PROOF_SCHEMA,
    eventId: requiredString(proof.eventId, "recovery provisioning eventId"),
    principal: normalizeAccessPrincipal(proof.principal),
    authorizingDeviceId: requiredString(
      proof.authorizingDeviceId,
      "recovery provisioning authorizingDeviceId",
    ),
    authorizingKeyId: requiredString(proof.authorizingKeyId, "recovery provisioning authorizingKeyId"),
    recoveryPublicKeyJwk,
    recoveryKeyId,
    recoveryEncryptionPublicKeyJwk: recoveryEncryption.publicKeyJwk,
    recoveryEncryptionKeyId: recoveryEncryption.encryptionKeyId,
    recoveryGeneration: positiveGeneration(
      proof.recoveryGeneration,
      "recovery provisioning generation",
    ),
    audience: requiredString(proof.audience, "recovery provisioning audience"),
  };
}

export async function recoveryProvisioningProofJson(
  proof: RecoveryProvisioningProof,
): Promise<string> {
  return canonicalJson(await normalizeRecoveryProvisioningProof(proof));
}

export async function recoveryProvisioningProofBytes(
  proof: RecoveryProvisioningProof,
): Promise<Uint8Array> {
  return new TextEncoder().encode(await recoveryProvisioningProofJson(proof));
}

export async function signRecoveryProvisioningProof(
  proof: RecoveryProvisioningProof,
  privateKey: CryptoKey,
): Promise<Uint8Array> {
  return signEd25519Proof(privateKey, await recoveryProvisioningProofBytes(proof));
}

export async function verifyRecoveryProvisioningProof(
  proof: RecoveryProvisioningProof,
  signature: Uint8Array,
): Promise<boolean> {
  let normalized: RecoveryProvisioningProof;
  try {
    normalized = await normalizeRecoveryProvisioningProof(proof);
  } catch {
    return false;
  }
  return verifyEd25519Proof(
    normalized.recoveryPublicKeyJwk,
    signature,
    await recoveryProvisioningProofBytes(normalized),
  );
}


export async function normalizeEncryptionBindingProof(
  proof: EncryptionBindingProof,
): Promise<EncryptionBindingProof> {
  if (proof.schema !== ENCRYPTION_BINDING_PROOF_SCHEMA) {
    throw new TypeError("encryption binding proof schema is invalid");
  }
  if (proof.subjectKind !== "device-signing-key" && proof.subjectKind !== "recovery-credential") {
    throw new TypeError("encryption binding proof subjectKind is invalid");
  }
  const encryption = await encryptionKeyIdentity(proof.encryptionPublicKeyJwk);
  if (proof.encryptionKeyId !== encryption.encryptionKeyId) {
    throw new TypeError("encryption binding proof encryptionKeyId does not match public JWK thumbprint");
  }
  const common = {
    schema: ENCRYPTION_BINDING_PROOF_SCHEMA,
    eventId: requiredString(proof.eventId, "encryption binding eventId"),
    subjectKind: proof.subjectKind,
    subjectKeyId: requiredString(proof.subjectKeyId, "encryption binding subjectKeyId"),
    principal: normalizeAccessPrincipal(proof.principal),
    authorizingDeviceId: requiredString(
      proof.authorizingDeviceId,
      "encryption binding authorizingDeviceId",
    ),
    authorizingKeyId: requiredString(
      proof.authorizingKeyId,
      "encryption binding authorizingKeyId",
    ),
    encryptionPublicKeyJwk: encryption.publicKeyJwk,
    encryptionKeyId: encryption.encryptionKeyId,
    audience: requiredString(proof.audience, "encryption binding audience"),
  };
  if (proof.subjectKind === "device-signing-key") {
    if (proof.recoveryGeneration !== undefined) {
      throw new TypeError("device encryption binding proof must not include recoveryGeneration");
    }
    return {
      ...common,
      subjectKind: "device-signing-key",
      deviceId: requiredString(proof.deviceId ?? "", "encryption binding deviceId"),
    };
  }
  if (proof.deviceId !== undefined) {
    throw new TypeError("recovery encryption binding proof must not include deviceId");
  }
  return {
    ...common,
    subjectKind: "recovery-credential",
    recoveryGeneration: positiveGeneration(
      proof.recoveryGeneration ?? 0,
      "encryption binding recoveryGeneration",
    ),
  };
}

export async function encryptionBindingProofJson(
  proof: EncryptionBindingProof,
): Promise<string> {
  return canonicalJson(await normalizeEncryptionBindingProof(proof));
}

export async function encryptionBindingProofBytes(
  proof: EncryptionBindingProof,
): Promise<Uint8Array> {
  return new TextEncoder().encode(await encryptionBindingProofJson(proof));
}

export async function signEncryptionBindingProof(
  proof: EncryptionBindingProof,
  privateKey: CryptoKey,
): Promise<Uint8Array> {
  return signEd25519Proof(privateKey, await encryptionBindingProofBytes(proof));
}

export async function verifyEncryptionBindingProof(
  proof: EncryptionBindingProof,
  subjectPublicKeyJwk: Ed25519PublicJwk,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    const normalized = await normalizeEncryptionBindingProof(proof);
    return verifyEd25519Proof(
      normalizeEd25519PublicJwk(subjectPublicKeyJwk),
      signature,
      await encryptionBindingProofBytes(normalized),
    );
  } catch {
    return false;
  }
}

export function normalizeDeviceRecoveryChallenge(
  challenge: DeviceRecoveryChallenge,
): DeviceRecoveryChallenge {
  if (challenge.schema !== DEVICE_RECOVERY_CHALLENGE_SCHEMA) {
    throw new TypeError("device recovery challenge schema is invalid");
  }
  const createdAt = normalizeTimestamp(challenge.createdAt, "recovery challenge createdAt");
  const expiresAt = normalizeTimestamp(challenge.expiresAt, "recovery challenge expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new TypeError("recovery challenge expiresAt must be after createdAt");
  }
  const recoveryGeneration = positiveGeneration(
    challenge.recoveryGeneration,
    "recovery challenge generation",
  );
  const nextRecoveryGeneration = positiveGeneration(
    challenge.nextRecoveryGeneration,
    "next recovery generation",
  );
  if (nextRecoveryGeneration !== recoveryGeneration + 1) {
    throw new TypeError("next recovery generation must increment current generation by one");
  }
  const deviceEncryptionPresent = challenge.deviceEncryptionPublicKeyJwk !== undefined
    || challenge.deviceEncryptionKeyId !== undefined;
  const nextRecoveryEncryptionPresent = challenge.nextRecoveryEncryptionPublicKeyJwk !== undefined
    || challenge.nextRecoveryEncryptionKeyId !== undefined;
  if (
    deviceEncryptionPresent
    && (challenge.deviceEncryptionPublicKeyJwk === undefined || challenge.deviceEncryptionKeyId === undefined)
  ) {
    throw new TypeError("recovery device encryption binding is incomplete");
  }
  if (
    nextRecoveryEncryptionPresent
    && (
      challenge.nextRecoveryEncryptionPublicKeyJwk === undefined
      || challenge.nextRecoveryEncryptionKeyId === undefined
    )
  ) {
    throw new TypeError("next recovery encryption binding is incomplete");
  }
  return {
    schema: DEVICE_RECOVERY_CHALLENGE_SCHEMA,
    challengeId: requiredString(challenge.challengeId, "recovery challengeId"),
    challenge: requiredString(challenge.challenge, "recovery challenge"),
    principal: normalizeAccessPrincipal(challenge.principal),
    recoveryKeyId: requiredString(challenge.recoveryKeyId, "recovery keyId"),
    recoveryGeneration,
    recoveryPublicKeyJwk: normalizeEd25519PublicJwk(challenge.recoveryPublicKeyJwk),
    deviceId: requiredString(challenge.deviceId, "recovery deviceId"),
    displayName: requiredString(challenge.displayName, "recovery displayName"),
    publicKeyJwk: normalizeEd25519PublicJwk(challenge.publicKeyJwk),
    keyId: requiredString(challenge.keyId, "recovery device keyId"),
    ...(challenge.deviceEncryptionPublicKeyJwk === undefined ? {} : {
      deviceEncryptionPublicKeyJwk: normalizeX25519PublicJwk(challenge.deviceEncryptionPublicKeyJwk),
      deviceEncryptionKeyId: requiredString(
        challenge.deviceEncryptionKeyId!,
        "recovery device encryptionKeyId",
      ),
    }),
    nextRecoveryPublicKeyJwk: normalizeEd25519PublicJwk(challenge.nextRecoveryPublicKeyJwk),
    nextRecoveryKeyId: requiredString(challenge.nextRecoveryKeyId, "next recovery keyId"),
    ...(challenge.nextRecoveryEncryptionPublicKeyJwk === undefined ? {} : {
      nextRecoveryEncryptionPublicKeyJwk: normalizeX25519PublicJwk(
        challenge.nextRecoveryEncryptionPublicKeyJwk,
      ),
      nextRecoveryEncryptionKeyId: requiredString(
        challenge.nextRecoveryEncryptionKeyId!,
        "next recovery encryptionKeyId",
      ),
    }),
    nextRecoveryGeneration,
    audience: requiredString(challenge.audience, "recovery audience"),
    createdAt,
    expiresAt,
  };
}

export async function validateDeviceRecoveryChallengeKeyIds(
  challenge: DeviceRecoveryChallenge,
): Promise<DeviceRecoveryChallenge> {
  const normalized = normalizeDeviceRecoveryChallenge(challenge);
  const [recoveryKeyId, keyId, nextRecoveryKeyId] = await Promise.all([
    ed25519JwkThumbprintUri(normalized.recoveryPublicKeyJwk),
    ed25519JwkThumbprintUri(normalized.publicKeyJwk),
    ed25519JwkThumbprintUri(normalized.nextRecoveryPublicKeyJwk),
  ]);
  if (
    normalized.recoveryKeyId !== recoveryKeyId
    || normalized.keyId !== keyId
    || normalized.nextRecoveryKeyId !== nextRecoveryKeyId
  ) {
    throw new TypeError("device recovery challenge keyId does not match public JWK thumbprint");
  }
  if (new Set([recoveryKeyId, keyId, nextRecoveryKeyId]).size !== 3) {
    throw new TypeError("device recovery challenge requires distinct current/device/next recovery keys");
  }
  const deviceEncryption = normalized.deviceEncryptionPublicKeyJwk === undefined
    ? undefined
    : await encryptionKeyIdentity(normalized.deviceEncryptionPublicKeyJwk);
  const nextRecoveryEncryption = normalized.nextRecoveryEncryptionPublicKeyJwk === undefined
    ? undefined
    : await encryptionKeyIdentity(normalized.nextRecoveryEncryptionPublicKeyJwk);
  if (
    deviceEncryption !== undefined
    && normalized.deviceEncryptionKeyId !== deviceEncryption.encryptionKeyId
  ) {
    throw new TypeError("recovery device encryptionKeyId does not match public JWK thumbprint");
  }
  if (
    nextRecoveryEncryption !== undefined
    && normalized.nextRecoveryEncryptionKeyId !== nextRecoveryEncryption.encryptionKeyId
  ) {
    throw new TypeError("next recovery encryptionKeyId does not match public JWK thumbprint");
  }
  if (
    deviceEncryption !== undefined
    && nextRecoveryEncryption !== undefined
    && deviceEncryption.encryptionKeyId === nextRecoveryEncryption.encryptionKeyId
  ) {
    throw new TypeError("recovery device and next recovery encryption keys must be distinct");
  }
  return normalized;
}

export async function deviceRecoveryChallengeJson(
  challenge: DeviceRecoveryChallenge,
): Promise<string> {
  return canonicalJson(await validateDeviceRecoveryChallengeKeyIds(challenge));
}

export async function deviceRecoveryProofBytes(
  challenge: DeviceRecoveryChallenge,
): Promise<Uint8Array> {
  const normalized = await validateDeviceRecoveryChallengeKeyIds(challenge);
  return new TextEncoder().encode(canonicalJson({
    schema: DEVICE_RECOVERY_PROOF_SCHEMA,
    challengeId: normalized.challengeId,
    challenge: normalized.challenge,
    principal: normalized.principal,
    recoveryKeyId: normalized.recoveryKeyId,
    recoveryGeneration: normalized.recoveryGeneration,
    deviceId: normalized.deviceId,
    displayName: normalized.displayName,
    publicKeyJwk: normalized.publicKeyJwk,
    keyId: normalized.keyId,
    ...(normalized.deviceEncryptionPublicKeyJwk === undefined ? {} : {
      deviceEncryptionPublicKeyJwk: normalized.deviceEncryptionPublicKeyJwk,
      deviceEncryptionKeyId: normalized.deviceEncryptionKeyId,
    }),
    nextRecoveryPublicKeyJwk: normalized.nextRecoveryPublicKeyJwk,
    nextRecoveryKeyId: normalized.nextRecoveryKeyId,
    ...(normalized.nextRecoveryEncryptionPublicKeyJwk === undefined ? {} : {
      nextRecoveryEncryptionPublicKeyJwk: normalized.nextRecoveryEncryptionPublicKeyJwk,
      nextRecoveryEncryptionKeyId: normalized.nextRecoveryEncryptionKeyId,
    }),
    nextRecoveryGeneration: normalized.nextRecoveryGeneration,
    audience: normalized.audience,
  }));
}

export async function signDeviceRecoveryChallenge(
  challenge: DeviceRecoveryChallenge,
  privateKey: CryptoKey,
): Promise<Uint8Array> {
  return signEd25519Proof(privateKey, await deviceRecoveryProofBytes(challenge));
}

export async function verifyDeviceRecoveryChallengeSignature(
  challenge: DeviceRecoveryChallenge,
  publicKeyJwk: Ed25519PublicJwk,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    return await verifyEd25519Proof(
      publicKeyJwk,
      signature,
      await deviceRecoveryProofBytes(challenge),
    );
  } catch {
    return false;
  }
}

function trustedActor(device: TrustedDevice, key: TrustedDeviceKey): DeviceTrustActor {
  return { mode: "trusted-device", deviceId: device.deviceId, keyId: key.keyId };
}

function recoveryActor(credential: TrustedRecoveryCredential): DeviceTrustActor {
  return {
    mode: "recovery-credential",
    keyId: credential.keyId,
    generation: credential.generation,
  };
}

function principalMatches(left: AccessPrincipal, right: AccessPrincipal): boolean {
  return canonicalJson(normalizeAccessPrincipal(left)) === canonicalJson(normalizeAccessPrincipal(right));
}

function eventReplayMatchesChallenge(event: DeviceTrustEvent, challenge: DeviceTrustChallenge): boolean {
  if (event.type !== challenge.operation) return false;
  if (event.deviceId !== challenge.deviceId || !principalMatches(event.principal, challenge.principal)) return false;
  if (event.type === "enroll-device") {
    return event.keyId === challenge.keyId
      && event.challengeId === challenge.challengeId
      && event.encryptionKeyId === challenge.encryptionKeyId;
  }
  return event.keyId === challenge.keyId
    && event.challengeId === challenge.challengeId
    && event.encryptionKeyId === challenge.encryptionKeyId;
}

async function deviceEncryptionBinding(input: {
  readonly subjectKeyId: string;
  readonly deviceId: string;
  readonly principal: AccessPrincipal;
  readonly publicKeyJwk: X25519PublicJwk | JsonWebKey;
  readonly boundAt: string;
}): Promise<TrustedDeviceEncryptionKeyBinding> {
  const encryption = await encryptionKeyIdentity(input.publicKeyJwk);
  const binding = await normalizeTrustedEncryptionKeyBinding({
    subjectKind: "device-signing-key",
    subjectKeyId: input.subjectKeyId,
    deviceId: input.deviceId,
    principal: input.principal,
    encryptionKeyId: encryption.encryptionKeyId,
    publicKeyJwk: encryption.publicKeyJwk,
    boundAt: input.boundAt,
  });
  if (binding.subjectKind !== "device-signing-key") throw new TypeError("expected device encryption binding");
  return binding;
}

async function recoveryEncryptionBinding(input: {
  readonly subjectKeyId: string;
  readonly generation: number;
  readonly principal: AccessPrincipal;
  readonly publicKeyJwk: X25519PublicJwk | JsonWebKey;
  readonly boundAt: string;
}): Promise<TrustedRecoveryEncryptionKeyBinding> {
  const encryption = await encryptionKeyIdentity(input.publicKeyJwk);
  const binding = await normalizeTrustedEncryptionKeyBinding({
    subjectKind: "recovery-credential",
    subjectKeyId: input.subjectKeyId,
    recoveryGeneration: input.generation,
    principal: input.principal,
    encryptionKeyId: encryption.encryptionKeyId,
    publicKeyJwk: encryption.publicKeyJwk,
    boundAt: input.boundAt,
  });
  if (binding.subjectKind !== "recovery-credential") throw new TypeError("expected recovery encryption binding");
  return binding;
}

interface ActiveEncryptionBindingSubject {
  readonly subjectKind: EncryptionBindingSubjectKind;
  readonly subjectKeyId: string;
  readonly principal: AccessPrincipal;
  readonly publicKeyJwk: Ed25519PublicJwk;
  readonly deviceId?: string;
  readonly recoveryGeneration?: number;
}

export class DeviceTrustManager {
  readonly #repository: DeviceTrustRepository;
  readonly #now: () => number;
  readonly #randomBytes: (length: number) => Uint8Array;
  readonly #challengeLifetimeSeconds: number;

  constructor(options: DeviceTrustManagerOptions) {
    this.#repository = options.repository;
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.#challengeLifetimeSeconds = configuredChallengeLifetime(options.challengeLifetimeSeconds);
  }

  async #activeAuthorization(keyId: string): Promise<ActiveDeviceAuthorization> {
    const key = await this.#repository.key(requiredString(keyId, "authorizingKeyId"));
    if (key?.status !== "active") {
      throw new DeviceTrustAuthorizationError("authorizing device key is not active");
    }
    const device = await this.#repository.device(key.deviceId);
    if (device?.status !== "active") {
      throw new DeviceTrustAuthorizationError("authorizing device is not active");
    }
    return { device, key };
  }

  async activeAuthorization(keyId: string): Promise<ActiveDeviceAuthorization> {
    return this.#activeAuthorization(keyId);
  }

  async #activeEncryptionBindingSubject(
    subjectKind: EncryptionBindingSubjectKind,
    subjectKeyIdInput: string,
  ): Promise<ActiveEncryptionBindingSubject> {
    const subjectKeyId = requiredString(subjectKeyIdInput, "encryption binding subjectKeyId");
    if (subjectKind === "device-signing-key") {
      const key = await this.#repository.key(subjectKeyId);
      if (key?.status !== "active") {
        throw new DeviceTrustAuthorizationError("device encryption binding subject key is not active");
      }
      const device = await this.#repository.device(key.deviceId);
      if (device?.status !== "active") {
        throw new DeviceTrustAuthorizationError("device encryption binding subject device is not active");
      }
      return {
        subjectKind,
        subjectKeyId,
        principal: device.principal,
        publicKeyJwk: key.publicKeyJwk,
        deviceId: device.deviceId,
      };
    }
    const credential = await this.#repository.recoveryCredential(subjectKeyId);
    if (credential?.status !== "active") {
      throw new DeviceTrustAuthorizationError("recovery encryption binding subject is not active");
    }
    return {
      subjectKind,
      subjectKeyId,
      principal: credential.principal,
      publicKeyJwk: credential.publicKeyJwk,
      recoveryGeneration: credential.generation,
    };
  }

  async #replayedKeyEvent(
    event: DeviceTrustEvent,
    label: string,
  ): Promise<DeviceTrustMutationResult> {
    if (!("keyId" in event)) {
      throw new DeviceTrustConflictError(`replayed ${label} event has no key identity`);
    }
    const [device, key] = await Promise.all([
      this.#repository.device(event.deviceId),
      this.#repository.key(event.keyId),
    ]);
    if (device === undefined || key === undefined) {
      throw new DeviceTrustConflictError(`replayed ${label} event has missing materialized state`);
    }
    return { outcome: "replayed", event, device, key };
  }

  async #replayedDeviceEvent(
    event: DeviceTrustEvent,
    label: string,
  ): Promise<DeviceTrustMutationResult> {
    const device = await this.#repository.device(event.deviceId);
    if (device === undefined) {
      throw new DeviceTrustConflictError(`replayed ${label} event has missing materialized state`);
    }
    return { outcome: "replayed", event, device };
  }

  async #replayedRecoveryCredentialEvent(
    event: SetRecoveryCredentialEvent,
  ): Promise<RecoveryCredentialMutationResult> {
    const credential = await this.#repository.recoveryCredential(event.recoveryKeyId);
    if (credential?.generation !== event.recoveryGeneration) {
      throw new DeviceTrustConflictError("replayed recovery credential event has missing materialized state");
    }
    return { outcome: "replayed", event, credential };
  }

  async #replayedRecoveryEvent(event: RecoverTrustSetEvent): Promise<RecoveryTrustSetMutationResult> {
    const [device, key, recoveryCredential] = await Promise.all([
      this.#repository.device(event.deviceId),
      this.#repository.key(event.keyId),
      this.#repository.recoveryCredential(event.nextRecoveryKeyId),
    ]);
    if (
      device === undefined
      || key === undefined
      || recoveryCredential?.generation !== event.nextRecoveryGeneration
    ) {
      throw new DeviceTrustConflictError("replayed trust recovery event has missing materialized state");
    }
    return { outcome: "replayed", event, device, key, recoveryCredential };
  }

  async bootstrapLocal(input: LocalBootstrapInput): Promise<DeviceTrustMutationResult> {
    const eventId = requiredString(input.eventId, "eventId");
    const principal = normalizeAccessPrincipal(input.principal);
    const publicKeyJwk = normalizeEd25519PublicJwk(input.publicKeyJwk);
    const keyId = await ed25519JwkThumbprintUri(publicKeyJwk);
    const encryption = await encryptionKeyIdentity(input.encryptionPublicKeyJwk);
    const deviceId = requiredString(input.deviceId, "deviceId");
    const displayName = requiredString(input.displayName, "displayName");
    const existing = await this.#repository.event(eventId);
    if (existing !== undefined) {
      if (
        existing.type !== "bootstrap-device"
        || existing.actor.mode !== "local-bootstrap"
        || existing.deviceId !== deviceId
        || existing.keyId !== keyId
        || existing.encryptionKeyId !== encryption.encryptionKeyId
        || !principalMatches(existing.principal, principal)
      ) {
        throw new DeviceTrustConflictError(`device trust event ${eventId} collides with different content`);
      }
      const replay = await this.#replayedKeyEvent(existing, "bootstrap");
      if (replay.device.displayName !== displayName) {
        throw new DeviceTrustConflictError(`device trust event ${eventId} collides with different displayName`);
      }
      return replay;
    }
    if (!(await this.#repository.isEmpty())) {
      throw new DeviceTrustConflictError("local bootstrap is allowed only when the trust registry is empty");
    }
    const occurredAt = nowIso(this.#now);
    const device: TrustedDevice = normalizeTrustedDevice({
      deviceId,
      principal,
      displayName,
      enrolledAt: occurredAt,
      status: "active",
    });
    const key = await normalizeTrustedDeviceKey({
      keyId,
      deviceId: device.deviceId,
      publicKeyJwk,
      activatedAt: occurredAt,
      status: "active",
    });
    const event: BootstrapDeviceEvent = {
      eventId,
      type: "bootstrap-device",
      occurredAt,
      principal,
      deviceId: device.deviceId,
      keyId,
      encryptionKeyId: encryption.encryptionKeyId,
      actor: { mode: "local-bootstrap" },
    };
    const encryptionBinding = await deviceEncryptionBinding({
      subjectKeyId: keyId,
      deviceId: device.deviceId,
      principal,
      publicKeyJwk: encryption.publicKeyJwk,
      boundAt: occurredAt,
    });
    return this.#repository.bootstrapDevice({ event, device, key, encryptionBinding });
  }

  async #issueChallenge(input: {
    readonly operation: DeviceTrustOperation;
    readonly authorization: { readonly device: TrustedDevice; readonly key: TrustedDeviceKey };
    readonly deviceId: string;
    readonly displayName: string;
    readonly publicKeyJwk: JsonWebKey;
    readonly encryptionPublicKeyJwk: JsonWebKey;
    readonly audience: string;
  }): Promise<DeviceTrustChallenge> {
    const createdAt = nowIso(this.#now);
    const expiresAt = new Date(
      Date.parse(createdAt) + this.#challengeLifetimeSeconds * 1_000,
    ).toISOString();
    const publicKeyJwk = normalizeEd25519PublicJwk(input.publicKeyJwk);
    const keyId = await ed25519JwkThumbprintUri(publicKeyJwk);
    const encryption = await encryptionKeyIdentity(input.encryptionPublicKeyJwk);
    const challenge: DeviceTrustChallenge = normalizeDeviceTrustChallenge({
      challengeId: randomToken(this.#randomBytes, 18, "challenge id"),
      challenge: randomToken(this.#randomBytes, 32, "challenge value"),
      operation: input.operation,
      principal: input.authorization.device.principal,
      deviceId: input.deviceId,
      displayName: input.displayName,
      publicKeyJwk,
      keyId,
      encryptionPublicKeyJwk: encryption.publicKeyJwk,
      encryptionKeyId: encryption.encryptionKeyId,
      audience: input.audience,
      authorizedByDeviceId: input.authorization.device.deviceId,
      authorizedByKeyId: input.authorization.key.keyId,
      createdAt,
      expiresAt,
    });
    await validateDeviceTrustChallengeKeyId(challenge);
    await this.#repository.issueChallenge(challenge);
    return challenge;
  }

  async startEnrollment(input: StartEnrollmentInput): Promise<DeviceTrustChallenge> {
    const authorization = await this.#activeAuthorization(input.authorizingKeyId);
    if (await this.#repository.device(input.deviceId) !== undefined) {
      throw new DeviceTrustConflictError(`device ${input.deviceId} already exists`);
    }
    return this.#issueChallenge({
      operation: "enroll-device",
      authorization,
      deviceId: requiredString(input.deviceId, "deviceId"),
      displayName: requiredString(input.displayName, "displayName"),
      publicKeyJwk: input.publicKeyJwk,
      encryptionPublicKeyJwk: input.encryptionPublicKeyJwk,
      audience: input.audience,
    });
  }

  async startRotation(input: StartRotationInput): Promise<DeviceTrustChallenge> {
    const authorization = await this.#activeAuthorization(input.authorizingKeyId);
    return this.#issueChallenge({
      operation: "rotate-key",
      authorization,
      deviceId: authorization.device.deviceId,
      displayName: authorization.device.displayName,
      publicKeyJwk: input.publicKeyJwk,
      encryptionPublicKeyJwk: input.encryptionPublicKeyJwk,
      audience: input.audience,
    });
  }

  async #verifiedChallenge(
    challengeId: string,
    operation: DeviceTrustOperation,
    signature: Uint8Array,
  ): Promise<StoredDeviceTrustChallenge> {
    const stored = await this.#repository.challenge(requiredString(challengeId, "challengeId"));
    if (stored?.challenge.operation !== operation) {
      throw new DeviceTrustChallengeError("device trust challenge is unknown or has the wrong operation");
    }
    if (!(await verifyDeviceTrustChallenge(stored.challenge, signature))) {
      throw new DeviceTrustProofError("device trust proof of possession is invalid");
    }
    return stored;
  }

  #requireFreshChallenge(stored: StoredDeviceTrustChallenge): void {
    if (stored.consumedAt !== undefined) {
      throw new DeviceTrustChallengeError("device trust challenge has already been consumed");
    }
    if (Date.parse(stored.challenge.expiresAt) < this.#now()) {
      throw new DeviceTrustChallengeError("device trust challenge has expired");
    }
  }

  async completeEnrollment(input: CompleteChallengeInput): Promise<DeviceTrustMutationResult> {
    const stored = await this.#verifiedChallenge(input.challengeId, "enroll-device", input.signature);
    const challenge = stored.challenge;
    const existing = await this.#repository.event(input.eventId);
    if (existing !== undefined) {
      if (!eventReplayMatchesChallenge(existing, challenge)) {
        throw new DeviceTrustConflictError(`device trust event ${input.eventId} collides with different content`);
      }
      return this.#replayedKeyEvent(existing, "enrollment");
    }
    this.#requireFreshChallenge(stored);
    const authorizer = await this.#activeAuthorization(challenge.authorizedByKeyId);
    if (
      authorizer.device.deviceId !== challenge.authorizedByDeviceId
      || !principalMatches(authorizer.device.principal, challenge.principal)
    ) {
      throw new DeviceTrustAuthorizationError("enrollment authorizer no longer matches challenge principal");
    }
    const occurredAt = nowIso(this.#now);
    const device = normalizeTrustedDevice({
      deviceId: challenge.deviceId,
      principal: challenge.principal,
      displayName: challenge.displayName,
      enrolledAt: occurredAt,
      status: "active",
    });
    const key = await normalizeTrustedDeviceKey({
      keyId: challenge.keyId,
      deviceId: device.deviceId,
      publicKeyJwk: challenge.publicKeyJwk,
      activatedAt: occurredAt,
      status: "active",
    });
    const event: EnrollDeviceEvent = {
      eventId: requiredString(input.eventId, "eventId"),
      type: "enroll-device",
      occurredAt,
      principal: challenge.principal,
      deviceId: device.deviceId,
      keyId: key.keyId,
      challengeId: challenge.challengeId,
      ...(challenge.encryptionKeyId === undefined ? {} : { encryptionKeyId: challenge.encryptionKeyId }),
      actor: trustedActor(authorizer.device, authorizer.key),
    };
    const encryptionBinding = challenge.encryptionPublicKeyJwk === undefined
      ? undefined
      : await deviceEncryptionBinding({
        subjectKeyId: key.keyId,
        deviceId: device.deviceId,
        principal: challenge.principal,
        publicKeyJwk: challenge.encryptionPublicKeyJwk,
        boundAt: occurredAt,
      });
    return this.#repository.enrollDevice({
      event,
      challenge,
      device,
      key,
      ...(encryptionBinding === undefined ? {} : { encryptionBinding }),
      now: occurredAt,
    });
  }

  async completeRotation(input: CompleteChallengeInput): Promise<DeviceTrustMutationResult> {
    const stored = await this.#verifiedChallenge(input.challengeId, "rotate-key", input.signature);
    const challenge = stored.challenge;
    const existing = await this.#repository.event(input.eventId);
    if (existing !== undefined) {
      if (!eventReplayMatchesChallenge(existing, challenge) || existing.type !== "rotate-key") {
        throw new DeviceTrustConflictError(`device trust event ${input.eventId} collides with different content`);
      }
      return this.#replayedKeyEvent(existing, "rotation");
    }
    this.#requireFreshChallenge(stored);
    const authorizer = await this.#activeAuthorization(challenge.authorizedByKeyId);
    if (
      authorizer.device.deviceId !== challenge.deviceId
      || authorizer.device.deviceId !== challenge.authorizedByDeviceId
      || !principalMatches(authorizer.device.principal, challenge.principal)
    ) {
      throw new DeviceTrustAuthorizationError("rotation authorizer no longer matches challenge device");
    }
    if (challenge.keyId === authorizer.key.keyId) {
      throw new DeviceTrustConflictError("rotation key must differ from predecessor key");
    }
    const occurredAt = nowIso(this.#now);
    const key = await normalizeTrustedDeviceKey({
      keyId: challenge.keyId,
      deviceId: challenge.deviceId,
      publicKeyJwk: challenge.publicKeyJwk,
      activatedAt: occurredAt,
      status: "active",
      predecessorKeyId: authorizer.key.keyId,
    });
    const event: RotateKeyEvent = {
      eventId: requiredString(input.eventId, "eventId"),
      type: "rotate-key",
      occurredAt,
      principal: challenge.principal,
      deviceId: challenge.deviceId,
      keyId: key.keyId,
      predecessorKeyId: authorizer.key.keyId,
      challengeId: challenge.challengeId,
      ...(challenge.encryptionKeyId === undefined ? {} : { encryptionKeyId: challenge.encryptionKeyId }),
      actor: trustedActor(authorizer.device, authorizer.key),
    };
    return this.#repository.rotateKey({
      event,
      challenge,
      deviceId: challenge.deviceId,
      predecessorKeyId: authorizer.key.keyId,
      key,
      ...(challenge.encryptionPublicKeyJwk === undefined ? {} : {
        encryptionBinding: await deviceEncryptionBinding({
          subjectKeyId: key.keyId,
          deviceId: challenge.deviceId,
          principal: challenge.principal,
          publicKeyJwk: challenge.encryptionPublicKeyJwk,
          boundAt: occurredAt,
        }),
      }),
      now: occurredAt,
    });
  }

  async revokeKey(input: RevokeKeyInput): Promise<DeviceTrustMutationResult> {
    const eventId = requiredString(input.eventId, "eventId");
    const targetKeyId = requiredString(input.targetKeyId, "targetKeyId");
    const authorizingKeyId = requiredString(input.authorizingKeyId, "authorizingKeyId");
    const existing = await this.#repository.event(eventId);
    if (existing !== undefined) {
      if (
        existing.type !== "revoke-key"
        || existing.keyId !== targetKeyId
        || existing.actor.mode !== "trusted-device"
        || existing.actor.keyId !== authorizingKeyId
      ) {
        throw new DeviceTrustConflictError(`device trust event ${eventId} collides with different content`);
      }
      return this.#replayedKeyEvent(existing, "key-revocation");
    }
    const authorization = await this.#activeAuthorization(authorizingKeyId);
    const target = await this.#repository.key(targetKeyId);
    if (target?.status !== "active") {
      throw new DeviceTrustConflictError("target key is not active");
    }
    const targetDevice = await this.#repository.device(target.deviceId);
    if (targetDevice === undefined || !principalMatches(targetDevice.principal, authorization.device.principal)) {
      throw new DeviceTrustAuthorizationError("target key belongs to a different principal");
    }
    const occurredAt = nowIso(this.#now);
    const event: RevokeKeyEvent = {
      eventId,
      type: "revoke-key",
      occurredAt,
      principal: authorization.device.principal,
      deviceId: target.deviceId,
      keyId: target.keyId,
      actor: trustedActor(authorization.device, authorization.key),
    };
    return this.#repository.revokeKey({ event, keyId: target.keyId, now: occurredAt });
  }

  async revokeDevice(input: RevokeDeviceInput): Promise<DeviceTrustMutationResult> {
    const eventId = requiredString(input.eventId, "eventId");
    const targetDeviceId = requiredString(input.targetDeviceId, "targetDeviceId");
    const authorizingKeyId = requiredString(input.authorizingKeyId, "authorizingKeyId");
    const existing = await this.#repository.event(eventId);
    if (existing !== undefined) {
      if (
        existing.type !== "revoke-device"
        || existing.deviceId !== targetDeviceId
        || existing.actor.mode !== "trusted-device"
        || existing.actor.keyId !== authorizingKeyId
      ) {
        throw new DeviceTrustConflictError(`device trust event ${eventId} collides with different content`);
      }
      return this.#replayedDeviceEvent(existing, "device-revocation");
    }
    const authorization = await this.#activeAuthorization(authorizingKeyId);
    const target = await this.#repository.device(targetDeviceId);
    if (target?.status !== "active") {
      throw new DeviceTrustConflictError("target device is not active");
    }
    if (!principalMatches(target.principal, authorization.device.principal)) {
      throw new DeviceTrustAuthorizationError("target device belongs to a different principal");
    }
    const occurredAt = nowIso(this.#now);
    const event: RevokeDeviceEvent = {
      eventId,
      type: "revoke-device",
      occurredAt,
      principal: authorization.device.principal,
      deviceId: target.deviceId,
      actor: trustedActor(authorization.device, authorization.key),
    };
    return this.#repository.revokeDevice({ event, deviceId: target.deviceId, now: occurredAt });
  }

  async prepareEncryptionBinding(
    input: PrepareEncryptionBindingInput,
  ): Promise<EncryptionBindingProof> {
    const eventId = requiredString(input.eventId, "eventId");
    const audience = requiredString(input.audience, "encryption binding audience");
    const authorization = await this.#activeAuthorization(input.authorizingKeyId);
    const subject = await this.#activeEncryptionBindingSubject(
      input.subjectKind,
      input.subjectKeyId,
    );
    if (!principalMatches(subject.principal, authorization.device.principal)) {
      throw new DeviceTrustAuthorizationError(
        "encryption binding subject belongs to a different principal",
      );
    }
    const encryption = await encryptionKeyIdentity(input.encryptionPublicKeyJwk);
    const existingForSubject = await this.#repository.encryptionBindingForSubject(
      subject.subjectKind,
      subject.subjectKeyId,
    );
    if (
      existingForSubject !== undefined
      && existingForSubject.encryptionKeyId !== encryption.encryptionKeyId
    ) {
      throw new DeviceTrustConflictError("encryption binding subject already has a different key");
    }
    const existingForKey = await this.#repository.encryptionBinding(encryption.encryptionKeyId);
    if (
      existingForKey !== undefined
      && (
        existingForKey.subjectKind !== subject.subjectKind
        || existingForKey.subjectKeyId !== subject.subjectKeyId
      )
    ) {
      throw new DeviceTrustConflictError("encryption key is already bound to another trusted subject");
    }
    return normalizeEncryptionBindingProof({
      schema: ENCRYPTION_BINDING_PROOF_SCHEMA,
      eventId,
      subjectKind: subject.subjectKind,
      subjectKeyId: subject.subjectKeyId,
      principal: subject.principal,
      authorizingDeviceId: authorization.device.deviceId,
      authorizingKeyId: authorization.key.keyId,
      encryptionPublicKeyJwk: encryption.publicKeyJwk,
      encryptionKeyId: encryption.encryptionKeyId,
      audience,
      ...(subject.deviceId === undefined ? {} : { deviceId: subject.deviceId }),
      ...(subject.recoveryGeneration === undefined
        ? {}
        : { recoveryGeneration: subject.recoveryGeneration }),
    });
  }

  async bindEncryptionKey(
    input: BindEncryptionKeyInput,
  ): Promise<EncryptionBindingMutationResult> {
    const eventId = requiredString(input.eventId, "eventId");
    const subjectKeyId = requiredString(input.subjectKeyId, "encryption binding subjectKeyId");
    const authorizingKeyId = requiredString(input.authorizingKeyId, "authorizingKeyId");
    const audience = requiredString(input.audience, "encryption binding audience");
    const encryption = await encryptionKeyIdentity(input.encryptionPublicKeyJwk);
    const existing = await this.#repository.event(eventId);
    if (existing !== undefined) {
      if (
        existing.type !== "bind-encryption-key"
        || existing.actor.mode !== "trusted-device"
        || existing.actor.keyId !== authorizingKeyId
        || existing.subjectKind !== input.subjectKind
        || existing.subjectKeyId !== subjectKeyId
        || existing.encryptionKeyId !== encryption.encryptionKeyId
        || existing.audience !== audience
      ) {
        throw new DeviceTrustConflictError(
          `device trust event ${eventId} collides with different encryption binding content`,
        );
      }
      const binding = await this.#repository.encryptionBinding(encryption.encryptionKeyId);
      if (
        binding === undefined
        || binding.subjectKind !== input.subjectKind
        || binding.subjectKeyId !== subjectKeyId
        || canonicalJson(binding.publicKeyJwk) !== canonicalJson(encryption.publicKeyJwk)
      ) {
        throw new DeviceTrustConflictError(
          "replayed encryption binding event has missing or mismatched materialized binding",
        );
      }
      return { outcome: "replayed", event: existing, binding };
    }

    const proof = await this.prepareEncryptionBinding(input);
    const subject = await this.#activeEncryptionBindingSubject(input.subjectKind, subjectKeyId);
    if (!(await verifyEncryptionBindingProof(proof, subject.publicKeyJwk, input.subjectSignature))) {
      throw new DeviceTrustProofError("encryption binding subject proof is invalid");
    }
    const occurredAt = nowIso(this.#now);
    const binding = subject.subjectKind === "device-signing-key"
      ? await deviceEncryptionBinding({
        subjectKeyId: subject.subjectKeyId,
        deviceId: subject.deviceId!,
        principal: subject.principal,
        publicKeyJwk: proof.encryptionPublicKeyJwk,
        boundAt: occurredAt,
      })
      : await recoveryEncryptionBinding({
        subjectKeyId: subject.subjectKeyId,
        generation: subject.recoveryGeneration!,
        principal: subject.principal,
        publicKeyJwk: proof.encryptionPublicKeyJwk,
        boundAt: occurredAt,
      });
    const authorization = await this.#activeAuthorization(proof.authorizingKeyId);
    if (!principalMatches(authorization.device.principal, subject.principal)) {
      throw new DeviceTrustAuthorizationError("encryption binding authorizer principal changed");
    }
    const event: BindEncryptionKeyEvent = {
      eventId,
      type: "bind-encryption-key",
      occurredAt,
      principal: subject.principal,
      deviceId: authorization.device.deviceId,
      actor: trustedActor(authorization.device, authorization.key),
      subjectKind: subject.subjectKind,
      subjectKeyId: subject.subjectKeyId,
      encryptionKeyId: binding.encryptionKeyId,
      audience,
    };
    return this.#repository.bindEncryptionKey({ event, binding });
  }

  async prepareRecoveryCredential(
    input: PrepareRecoveryCredentialInput,
  ): Promise<RecoveryProvisioningProof> {
    const eventId = requiredString(input.eventId, "eventId");
    const authorizingKeyId = requiredString(input.authorizingKeyId, "authorizingKeyId");
    const audience = requiredString(input.audience, "recovery audience");
    const recoveryPublicKeyJwk = normalizeEd25519PublicJwk(input.publicKeyJwk);
    const recoveryKeyId = await ed25519JwkThumbprintUri(recoveryPublicKeyJwk);
    const recoveryEncryption = await encryptionKeyIdentity(input.encryptionPublicKeyJwk);
    const existing = await this.#repository.event(eventId);
    if (existing !== undefined) {
      if (
        existing.type !== "set-recovery-credential"
        || existing.actor.mode !== "trusted-device"
        || existing.actor.keyId !== authorizingKeyId
        || existing.recoveryKeyId !== recoveryKeyId
        || existing.encryptionKeyId !== recoveryEncryption.encryptionKeyId
        || existing.audience !== audience
      ) {
        throw new DeviceTrustConflictError(
          `device trust event ${eventId} collides with different content`,
        );
      }
      return normalizeRecoveryProvisioningProof({
        schema: RECOVERY_PROVISIONING_PROOF_SCHEMA,
        eventId,
        principal: existing.principal,
        authorizingDeviceId: existing.actor.deviceId,
        authorizingKeyId: existing.actor.keyId,
        recoveryPublicKeyJwk,
        recoveryKeyId,
        recoveryEncryptionPublicKeyJwk: recoveryEncryption.publicKeyJwk,
        recoveryEncryptionKeyId: recoveryEncryption.encryptionKeyId,
        recoveryGeneration: existing.recoveryGeneration,
        audience,
      });
    }

    const authorization = await this.#activeAuthorization(authorizingKeyId);
    const current = await this.#repository.activeRecoveryCredential(authorization.device.principal);
    return normalizeRecoveryProvisioningProof({
      schema: RECOVERY_PROVISIONING_PROOF_SCHEMA,
      eventId,
      principal: authorization.device.principal,
      authorizingDeviceId: authorization.device.deviceId,
      authorizingKeyId: authorization.key.keyId,
      recoveryPublicKeyJwk,
      recoveryKeyId,
      recoveryEncryptionPublicKeyJwk: recoveryEncryption.publicKeyJwk,
      recoveryEncryptionKeyId: recoveryEncryption.encryptionKeyId,
      recoveryGeneration: (current?.generation ?? 0) + 1,
      audience,
    });
  }

  async setRecoveryCredential(
    input: SetRecoveryCredentialInput,
  ): Promise<RecoveryCredentialMutationResult> {
    const proof = await this.prepareRecoveryCredential(input);
    if (!(await verifyRecoveryProvisioningProof(proof, input.signature))) {
      throw new DeviceTrustProofError("recovery credential proof of possession is invalid");
    }
    const existing = await this.#repository.event(proof.eventId);
    if (existing !== undefined) {
      if (existing.type !== "set-recovery-credential") {
        throw new DeviceTrustConflictError(
          `device trust event ${proof.eventId} collides with different content`,
        );
      }
      return this.#replayedRecoveryCredentialEvent(existing);
    }
    if (await this.#repository.key(proof.recoveryKeyId) !== undefined) {
      throw new DeviceTrustConflictError("recovery key material must not reuse a device key");
    }
    if (await this.#repository.recoveryCredential(proof.recoveryKeyId) !== undefined) {
      throw new DeviceTrustConflictError("recovery key material has already been used");
    }
    const authorization = await this.#activeAuthorization(proof.authorizingKeyId);
    const current = await this.#repository.activeRecoveryCredential(proof.principal);
    if (proof.recoveryGeneration !== (current?.generation ?? 0) + 1) {
      throw new DeviceTrustConflictError("recovery credential generation changed during provisioning");
    }
    const occurredAt = nowIso(this.#now);
    const credential = await normalizeTrustedRecoveryCredential({
      keyId: proof.recoveryKeyId,
      principal: proof.principal,
      publicKeyJwk: proof.recoveryPublicKeyJwk,
      generation: proof.recoveryGeneration,
      activatedAt: occurredAt,
      status: "active",
      ...(current === undefined ? {} : { predecessorKeyId: current.keyId }),
    });
    const event: SetRecoveryCredentialEvent = {
      eventId: proof.eventId,
      type: "set-recovery-credential",
      occurredAt,
      principal: proof.principal,
      deviceId: authorization.device.deviceId,
      actor: trustedActor(authorization.device, authorization.key),
      recoveryKeyId: proof.recoveryKeyId,
      recoveryGeneration: proof.recoveryGeneration,
      encryptionKeyId: proof.recoveryEncryptionKeyId,
      audience: proof.audience,
    };
    return this.#repository.setRecoveryCredential({
      event,
      credential,
      encryptionBinding: await recoveryEncryptionBinding({
        subjectKeyId: credential.keyId,
        generation: credential.generation,
        principal: credential.principal,
        publicKeyJwk: proof.recoveryEncryptionPublicKeyJwk,
        boundAt: occurredAt,
      }),
      ...(current === undefined ? {} : { previousRecoveryKeyId: current.keyId }),
      now: occurredAt,
    });
  }

  async startRecovery(input: StartRecoveryInput): Promise<DeviceRecoveryChallenge> {
    const recoveryKeyId = requiredString(input.recoveryKeyId, "recoveryKeyId");
    const recoveryCredential = await this.#repository.recoveryCredential(recoveryKeyId);
    if (recoveryCredential?.status !== "active") {
      throw new DeviceTrustAuthorizationError("recovery credential is not active");
    }
    const deviceId = requiredString(input.deviceId, "recovery deviceId");
    if (await this.#repository.device(deviceId) !== undefined) {
      throw new DeviceTrustConflictError("recovery replacement deviceId must be fresh");
    }
    const publicKeyJwk = normalizeEd25519PublicJwk(input.publicKeyJwk);
    const keyId = await ed25519JwkThumbprintUri(publicKeyJwk);
    const nextRecoveryPublicKeyJwk = normalizeEd25519PublicJwk(input.nextRecoveryPublicKeyJwk);
    const nextRecoveryKeyId = await ed25519JwkThumbprintUri(nextRecoveryPublicKeyJwk);
    const deviceEncryption = await encryptionKeyIdentity(input.deviceEncryptionPublicKeyJwk);
    const nextRecoveryEncryption = await encryptionKeyIdentity(input.nextRecoveryEncryptionPublicKeyJwk);
    if (deviceEncryption.encryptionKeyId === nextRecoveryEncryption.encryptionKeyId) {
      throw new DeviceTrustConflictError(
        "recovery replacement device and next recovery encryption keys must be distinct",
      );
    }
    if (new Set([recoveryKeyId, keyId, nextRecoveryKeyId]).size !== 3) {
      throw new DeviceTrustConflictError("recovery requires distinct current, device and next recovery keys");
    }
    if (
      await this.#repository.key(keyId) !== undefined
      || await this.#repository.recoveryCredential(keyId) !== undefined
    ) {
      throw new DeviceTrustConflictError("recovery replacement device key must be fresh");
    }
    if (
      await this.#repository.key(nextRecoveryKeyId) !== undefined
      || await this.#repository.recoveryCredential(nextRecoveryKeyId) !== undefined
    ) {
      throw new DeviceTrustConflictError("next recovery key must be fresh");
    }
    const createdAt = nowIso(this.#now);
    const expiresAt = new Date(
      Date.parse(createdAt) + this.#challengeLifetimeSeconds * 1_000,
    ).toISOString();
    const challenge = await validateDeviceRecoveryChallengeKeyIds({
      schema: DEVICE_RECOVERY_CHALLENGE_SCHEMA,
      challengeId: randomToken(this.#randomBytes, 18, "recovery challenge id"),
      challenge: randomToken(this.#randomBytes, 32, "recovery challenge value"),
      principal: recoveryCredential.principal,
      recoveryKeyId: recoveryCredential.keyId,
      recoveryGeneration: recoveryCredential.generation,
      recoveryPublicKeyJwk: recoveryCredential.publicKeyJwk,
      deviceId,
      displayName: requiredString(input.displayName, "recovery displayName"),
      publicKeyJwk,
      keyId,
      deviceEncryptionPublicKeyJwk: deviceEncryption.publicKeyJwk,
      deviceEncryptionKeyId: deviceEncryption.encryptionKeyId,
      nextRecoveryPublicKeyJwk,
      nextRecoveryKeyId,
      nextRecoveryEncryptionPublicKeyJwk: nextRecoveryEncryption.publicKeyJwk,
      nextRecoveryEncryptionKeyId: nextRecoveryEncryption.encryptionKeyId,
      nextRecoveryGeneration: recoveryCredential.generation + 1,
      audience: requiredString(input.audience, "recovery audience"),
      createdAt,
      expiresAt,
    });
    await this.#repository.issueRecoveryChallenge(challenge);
    return challenge;
  }

  async completeRecovery(input: CompleteRecoveryInput): Promise<RecoveryTrustSetMutationResult> {
    const challengeId = requiredString(input.challengeId, "recovery challengeId");
    const stored = await this.#repository.recoveryChallenge(challengeId);
    if (stored === undefined) {
      throw new DeviceTrustChallengeError("device recovery challenge is unknown");
    }
    const challenge = await validateDeviceRecoveryChallengeKeyIds(stored.challenge);
    const [recoveryValid, deviceValid, nextRecoveryValid] = await Promise.all([
      verifyDeviceRecoveryChallengeSignature(
        challenge,
        challenge.recoveryPublicKeyJwk,
        input.recoverySignature,
      ),
      verifyDeviceRecoveryChallengeSignature(challenge, challenge.publicKeyJwk, input.deviceSignature),
      verifyDeviceRecoveryChallengeSignature(
        challenge,
        challenge.nextRecoveryPublicKeyJwk,
        input.nextRecoverySignature,
      ),
    ]);
    if (!recoveryValid || !deviceValid || !nextRecoveryValid) {
      throw new DeviceTrustProofError("device recovery proof is invalid");
    }
    const eventId = requiredString(input.eventId, "eventId");
    const existing = await this.#repository.event(eventId);
    if (existing !== undefined) {
      if (
        existing.type !== "recover-trust-set"
        || existing.challengeId !== challenge.challengeId
        || existing.deviceId !== challenge.deviceId
        || existing.keyId !== challenge.keyId
        || existing.recoveryKeyId !== challenge.recoveryKeyId
        || existing.recoveryGeneration !== challenge.recoveryGeneration
        || existing.nextRecoveryKeyId !== challenge.nextRecoveryKeyId
        || existing.nextRecoveryGeneration !== challenge.nextRecoveryGeneration
        || existing.deviceEncryptionKeyId !== challenge.deviceEncryptionKeyId
        || existing.nextRecoveryEncryptionKeyId !== challenge.nextRecoveryEncryptionKeyId
        || existing.audience !== challenge.audience
        || !principalMatches(existing.principal, challenge.principal)
      ) {
        throw new DeviceTrustConflictError(`device trust event ${eventId} collides with different content`);
      }
      return this.#replayedRecoveryEvent(existing);
    }
    if (stored.consumedAt !== undefined) {
      throw new DeviceTrustChallengeError("device recovery challenge has already been consumed");
    }
    if (Date.parse(challenge.expiresAt) < this.#now()) {
      throw new DeviceTrustChallengeError("device recovery challenge has expired");
    }
    const current = await this.#repository.recoveryCredential(challenge.recoveryKeyId);
    if (
      current?.status !== "active"
      || current.generation !== challenge.recoveryGeneration
      || !principalMatches(current.principal, challenge.principal)
      || await trustedRecoveryCredentialJson(current)
        !== await trustedRecoveryCredentialJson({
          ...current,
          publicKeyJwk: challenge.recoveryPublicKeyJwk,
        })
    ) {
      throw new DeviceTrustAuthorizationError("recovery credential no longer matches challenge state");
    }
    if (
      await this.#repository.device(challenge.deviceId) !== undefined
      || await this.#repository.key(challenge.keyId) !== undefined
      || await this.#repository.recoveryCredential(challenge.nextRecoveryKeyId) !== undefined
      || await this.#repository.key(challenge.nextRecoveryKeyId) !== undefined
    ) {
      throw new DeviceTrustConflictError("recovery target identities are no longer fresh");
    }
    const occurredAt = nowIso(this.#now);
    const device = normalizeTrustedDevice({
      deviceId: challenge.deviceId,
      principal: challenge.principal,
      displayName: challenge.displayName,
      enrolledAt: occurredAt,
      status: "active",
    });
    const key = await normalizeTrustedDeviceKey({
      keyId: challenge.keyId,
      deviceId: challenge.deviceId,
      publicKeyJwk: challenge.publicKeyJwk,
      activatedAt: occurredAt,
      status: "active",
    });
    const recoveryCredential = await normalizeTrustedRecoveryCredential({
      keyId: challenge.nextRecoveryKeyId,
      principal: challenge.principal,
      publicKeyJwk: challenge.nextRecoveryPublicKeyJwk,
      generation: challenge.nextRecoveryGeneration,
      activatedAt: occurredAt,
      status: "active",
      predecessorKeyId: challenge.recoveryKeyId,
    });
    const event: RecoverTrustSetEvent = {
      eventId,
      type: "recover-trust-set",
      occurredAt,
      principal: challenge.principal,
      deviceId: challenge.deviceId,
      keyId: challenge.keyId,
      challengeId: challenge.challengeId,
      recoveryKeyId: challenge.recoveryKeyId,
      recoveryGeneration: challenge.recoveryGeneration,
      nextRecoveryKeyId: challenge.nextRecoveryKeyId,
      nextRecoveryGeneration: challenge.nextRecoveryGeneration,
      ...(challenge.deviceEncryptionKeyId === undefined
        ? {}
        : { deviceEncryptionKeyId: challenge.deviceEncryptionKeyId }),
      ...(challenge.nextRecoveryEncryptionKeyId === undefined
        ? {}
        : { nextRecoveryEncryptionKeyId: challenge.nextRecoveryEncryptionKeyId }),
      audience: challenge.audience,
      actor: recoveryActor(current),
    };
    return this.#repository.recoverTrustSet({
      event,
      challenge,
      device,
      key,
      recoveryCredential,
      ...(challenge.deviceEncryptionPublicKeyJwk === undefined ? {} : {
        deviceEncryptionBinding: await deviceEncryptionBinding({
          subjectKeyId: key.keyId,
          deviceId: device.deviceId,
          principal: device.principal,
          publicKeyJwk: challenge.deviceEncryptionPublicKeyJwk,
          boundAt: occurredAt,
        }),
      }),
      ...(challenge.nextRecoveryEncryptionPublicKeyJwk === undefined ? {} : {
        recoveryEncryptionBinding: await recoveryEncryptionBinding({
          subjectKeyId: recoveryCredential.keyId,
          generation: recoveryCredential.generation,
          principal: recoveryCredential.principal,
          publicKeyJwk: challenge.nextRecoveryEncryptionPublicKeyJwk,
          boundAt: occurredAt,
        }),
      }),
      previousRecoveryKeyId: current.keyId,
      now: occurredAt,
    });
  }

}
export * from "./encryption-binding.js";
