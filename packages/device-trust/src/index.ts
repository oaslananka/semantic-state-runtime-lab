import {
  normalizeAccessPrincipal,
  type AccessPrincipal,
} from "@ssrl/access";
import { canonicalJson } from "@ssrl/core";

const JWK_THUMBPRINT_URI_PREFIX = "urn:ietf:params:oauth:jwk-thumbprint:sha-256:";
const DEVICE_TRUST_PROOF_SCHEMA = "ssrl-device-trust-proof-v1" as const;
const DEFAULT_CHALLENGE_LIFETIME_SECONDS = 300;
const MAX_CHALLENGE_LIFETIME_SECONDS = 900;
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

export type TrustedDeviceStatus = "active" | "revoked";
export type TrustedDeviceKeyStatus = "active" | "revoked";
export type DeviceTrustOperation = "enroll-device" | "rotate-key";
export type DeviceTrustEventType =
  | "bootstrap-device"
  | "enroll-device"
  | "rotate-key"
  | "revoke-key"
  | "revoke-device";

export interface Ed25519PublicJwk {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
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

export type DeviceTrustActor =
  | { readonly mode: "local-bootstrap" }
  | {
    readonly mode: "trusted-device";
    readonly deviceId: string;
    readonly keyId: string;
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
}

export interface EnrollDeviceEvent extends DeviceTrustEventBase {
  readonly type: "enroll-device";
  readonly keyId: string;
  readonly challengeId: string;
}

export interface RotateKeyEvent extends DeviceTrustEventBase {
  readonly type: "rotate-key";
  readonly keyId: string;
  readonly predecessorKeyId: string;
  readonly challengeId: string;
}

export interface RevokeKeyEvent extends DeviceTrustEventBase {
  readonly type: "revoke-key";
  readonly keyId: string;
}

export interface RevokeDeviceEvent extends DeviceTrustEventBase {
  readonly type: "revoke-device";
}

export type DeviceTrustEvent =
  | BootstrapDeviceEvent
  | EnrollDeviceEvent
  | RotateKeyEvent
  | RevokeKeyEvent
  | RevokeDeviceEvent;

export interface DeviceTrustChallenge {
  readonly challengeId: string;
  readonly challenge: string;
  readonly operation: DeviceTrustOperation;
  readonly principal: AccessPrincipal;
  readonly deviceId: string;
  readonly displayName: string;
  readonly publicKeyJwk: Ed25519PublicJwk;
  readonly keyId: string;
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
}

export interface EnrollDeviceTransition {
  readonly event: EnrollDeviceEvent;
  readonly challenge: DeviceTrustChallenge;
  readonly device: TrustedDevice;
  readonly key: TrustedDeviceKey;
  readonly now: string;
}

export interface RotateKeyTransition {
  readonly event: RotateKeyEvent;
  readonly challenge: DeviceTrustChallenge;
  readonly deviceId: string;
  readonly predecessorKeyId: string;
  readonly key: TrustedDeviceKey;
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

export interface DeviceTrustRepository
  extends ReplicationDeviceKeyResolver, ReplicationSignatureReplayStore {
  isEmpty(): boolean | Promise<boolean>;
  device(deviceId: string): TrustedDevice | undefined | Promise<TrustedDevice | undefined>;
  key(keyId: string): TrustedDeviceKey | undefined | Promise<TrustedDeviceKey | undefined>;
  event(eventId: string): DeviceTrustEvent | undefined | Promise<DeviceTrustEvent | undefined>;
  challenge(
    challengeId: string,
  ): StoredDeviceTrustChallenge | undefined | Promise<StoredDeviceTrustChallenge | undefined>;
  issueChallenge(challenge: DeviceTrustChallenge): void | Promise<void>;
  bootstrapDevice(transition: BootstrapDeviceTransition): DeviceTrustMutationResult | Promise<DeviceTrustMutationResult>;
  enrollDevice(transition: EnrollDeviceTransition): DeviceTrustMutationResult | Promise<DeviceTrustMutationResult>;
  rotateKey(transition: RotateKeyTransition): DeviceTrustMutationResult | Promise<DeviceTrustMutationResult>;
  revokeKey(transition: RevokeKeyTransition): DeviceTrustMutationResult | Promise<DeviceTrustMutationResult>;
  revokeDevice(transition: RevokeDeviceTransition): DeviceTrustMutationResult | Promise<DeviceTrustMutationResult>;
  pruneExpired(now: string): number | Promise<number>;
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
}

export interface StartEnrollmentInput {
  /** Must come from an already-authenticated trust-management context, not request payload identity. */
  readonly authorizingKeyId: string;
  readonly deviceId: string;
  readonly displayName: string;
  readonly publicKeyJwk: JsonWebKey;
  readonly audience: string;
}

export interface StartRotationInput {
  /** Must come from an already-authenticated trust-management context. */
  readonly authorizingKeyId: string;
  readonly publicKeyJwk: JsonWebKey;
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

function normalizeDeviceTrustActor(actor: DeviceTrustActor): DeviceTrustActor {
  if (actor.mode === "local-bootstrap") return { mode: "local-bootstrap" };
  if (actor.mode === "trusted-device") {
    return {
      mode: "trusted-device",
      deviceId: requiredString(actor.deviceId, "actor deviceId"),
      keyId: requiredString(actor.keyId, "actor keyId"),
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
      return { ...base, type: event.type, keyId: requiredString(event.keyId, "event keyId") };
    case "enroll-device":
      if (event.actor.mode !== "trusted-device") {
        throw new TypeError("enroll-device event requires trusted-device actor");
      }
      return {
        ...base,
        type: event.type,
        keyId: requiredString(event.keyId, "event keyId"),
        challengeId: requiredString(event.challengeId, "event challengeId"),
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
  return {
    challengeId: requiredString(challenge.challengeId, "challengeId"),
    challenge: requiredString(challenge.challenge, "challenge"),
    operation: challenge.operation,
    principal: normalizeAccessPrincipal(challenge.principal),
    deviceId: requiredString(challenge.deviceId, "challenge deviceId"),
    displayName: requiredString(challenge.displayName, "challenge displayName"),
    publicKeyJwk: normalizeEd25519PublicJwk(challenge.publicKeyJwk),
    keyId: requiredString(challenge.keyId, "challenge keyId"),
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

function trustedActor(device: TrustedDevice, key: TrustedDeviceKey): DeviceTrustActor {
  return { mode: "trusted-device", deviceId: device.deviceId, keyId: key.keyId };
}

function principalMatches(left: AccessPrincipal, right: AccessPrincipal): boolean {
  return canonicalJson(normalizeAccessPrincipal(left)) === canonicalJson(normalizeAccessPrincipal(right));
}

function eventReplayMatchesChallenge(event: DeviceTrustEvent, challenge: DeviceTrustChallenge): boolean {
  if (event.type !== challenge.operation) return false;
  if (event.deviceId !== challenge.deviceId || !principalMatches(event.principal, challenge.principal)) return false;
  if (event.type === "enroll-device") {
    return event.keyId === challenge.keyId && event.challengeId === challenge.challengeId;
  }
  return event.keyId === challenge.keyId && event.challengeId === challenge.challengeId;
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

  async #activeAuthorization(keyId: string): Promise<{
    readonly device: TrustedDevice;
    readonly key: TrustedDeviceKey;
  }> {
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

  async bootstrapLocal(input: LocalBootstrapInput): Promise<DeviceTrustMutationResult> {
    const eventId = requiredString(input.eventId, "eventId");
    const principal = normalizeAccessPrincipal(input.principal);
    const publicKeyJwk = normalizeEd25519PublicJwk(input.publicKeyJwk);
    const keyId = await ed25519JwkThumbprintUri(publicKeyJwk);
    const deviceId = requiredString(input.deviceId, "deviceId");
    const displayName = requiredString(input.displayName, "displayName");
    const existing = await this.#repository.event(eventId);
    if (existing !== undefined) {
      if (
        existing.type !== "bootstrap-device"
        || existing.actor.mode !== "local-bootstrap"
        || existing.deviceId !== deviceId
        || existing.keyId !== keyId
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
      actor: { mode: "local-bootstrap" },
    };
    return this.#repository.bootstrapDevice({ event, device, key });
  }

  async #issueChallenge(input: {
    readonly operation: DeviceTrustOperation;
    readonly authorization: { readonly device: TrustedDevice; readonly key: TrustedDeviceKey };
    readonly deviceId: string;
    readonly displayName: string;
    readonly publicKeyJwk: JsonWebKey;
    readonly audience: string;
  }): Promise<DeviceTrustChallenge> {
    const createdAt = nowIso(this.#now);
    const expiresAt = new Date(
      Date.parse(createdAt) + this.#challengeLifetimeSeconds * 1_000,
    ).toISOString();
    const publicKeyJwk = normalizeEd25519PublicJwk(input.publicKeyJwk);
    const keyId = await ed25519JwkThumbprintUri(publicKeyJwk);
    const challenge: DeviceTrustChallenge = normalizeDeviceTrustChallenge({
      challengeId: randomToken(this.#randomBytes, 18, "challenge id"),
      challenge: randomToken(this.#randomBytes, 32, "challenge value"),
      operation: input.operation,
      principal: input.authorization.device.principal,
      deviceId: input.deviceId,
      displayName: input.displayName,
      publicKeyJwk,
      keyId,
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
      actor: trustedActor(authorizer.device, authorizer.key),
    };
    return this.#repository.enrollDevice({ event, challenge, device, key, now: occurredAt });
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
      actor: trustedActor(authorizer.device, authorizer.key),
    };
    return this.#repository.rotateKey({
      event,
      challenge,
      deviceId: challenge.deviceId,
      predecessorKeyId: authorizer.key.keyId,
      key,
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
}
