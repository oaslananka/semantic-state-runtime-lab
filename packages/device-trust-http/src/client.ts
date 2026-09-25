import { canonicalJson } from "@ssrl/core";
import {
  normalizeDeviceEnrollmentOffer,
  normalizeDeviceTrustEvent,
  normalizeEd25519PublicJwk,
  normalizeRecoveryProvisioningProof,
  normalizeTrustedDevice,
  normalizeTrustedDeviceKey,
  normalizeTrustedRecoveryCredential,
  validateDeviceRecoveryChallengeKeyIds,
  validateDeviceTrustChallengeKeyId,
  type DeviceEnrollmentOffer,
  type DeviceRecoveryChallenge,
  type DeviceTrustChallenge,
  type DeviceTrustMutationResult,
  type RecoveryCredentialMutationResult,
  type RecoveryProvisioningProof,
  type RecoveryTrustSetMutationResult,
} from "@ssrl/device-trust";
import {
  collectBoundedBytes,
  exactObjectKeys,
  normalizedMediaType,
  objectRecord,
  secureHttpBaseUrl,
} from "@ssrl/http-wire";
import {
  DEVICE_TRUST_HTTP_CHALLENGE_SCHEMA,
  DEVICE_TRUST_HTTP_ERROR_SCHEMA,
  DEVICE_TRUST_HTTP_MUTATION_SCHEMA,
  DEVICE_TRUST_HTTP_RECOVERY_CHALLENGE_SCHEMA,
  DEVICE_TRUST_HTTP_RECOVERY_CREDENTIAL_MUTATION_SCHEMA,
  DEVICE_TRUST_HTTP_RECOVERY_MUTATION_SCHEMA,
  DEVICE_TRUST_HTTP_RECOVERY_PROVISIONING_SCHEMA,
  DEVICE_TRUST_HTTP_ROUTES,
} from "./protocol.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;
export type DeviceTrustHttpFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface DeviceTrustHttpClientOptions {
  readonly baseUrl: URL;
  readonly trustedFetch: DeviceTrustHttpFetch;
  readonly candidateFetch?: DeviceTrustHttpFetch;
}

export class DeviceTrustHttpRemoteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DeviceTrustHttpRemoteError";
  }
}

export class InvalidDeviceTrustHttpResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDeviceTrustHttpResponseError";
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  if (normalizedMediaType(response.headers) !== "application/json") {
    throw new InvalidDeviceTrustHttpResponseError("Device trust response must be application/json");
  }
  const bytes = await collectBoundedBytes({
    body: response.body,
    contentLength: response.headers.get("content-length"),
    maxBytes: MAX_RESPONSE_BYTES,
    invalidLength: (message) => new InvalidDeviceTrustHttpResponseError(message),
    tooLarge: (message) => new InvalidDeviceTrustHttpResponseError(message),
  });
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new InvalidDeviceTrustHttpResponseError("Device trust response is not valid JSON");
  }
  return objectRecord(
    value,
    "response",
    (message) => new InvalidDeviceTrustHttpResponseError(message),
  );
}

async function checkedJson(response: Response): Promise<Record<string, unknown>> {
  const body = await responseJson(response);
  if (!response.ok) {
    if (body.schema === DEVICE_TRUST_HTTP_ERROR_SCHEMA && typeof body.code === "string" && typeof body.message === "string") {
      throw new DeviceTrustHttpRemoteError(response.status, body.code, body.message);
    }
    throw new InvalidDeviceTrustHttpResponseError(`Device trust request failed with HTTP ${response.status}`);
  }
  return body;
}

function invalidResponse(message: string): InvalidDeviceTrustHttpResponseError {
  return new InvalidDeviceTrustHttpResponseError(message);
}

async function normalizedResponse<T>(
  operation: () => T | Promise<T>,
  label: string,
): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof InvalidDeviceTrustHttpResponseError) throw cause;
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    throw new InvalidDeviceTrustHttpResponseError(`${label} is invalid${detail}`);
  }
}

async function challengeResult(response: Response): Promise<DeviceTrustChallenge> {
  const body = await checkedJson(response);
  exactObjectKeys(body, ["schema", "challenge"], "challenge response", invalidResponse);
  if (body.schema !== DEVICE_TRUST_HTTP_CHALLENGE_SCHEMA) {
    throw new InvalidDeviceTrustHttpResponseError("Device trust challenge response schema is invalid");
  }
  return normalizedResponse(
    () => validateDeviceTrustChallengeKeyId(body.challenge as DeviceTrustChallenge),
    "Device trust challenge response",
  );
}

async function mutationResult(response: Response): Promise<DeviceTrustMutationResult> {
  const body = await checkedJson(response);
  exactObjectKeys(body, ["schema", "result"], "mutation response", invalidResponse);
  if (body.schema !== DEVICE_TRUST_HTTP_MUTATION_SCHEMA) {
    throw new InvalidDeviceTrustHttpResponseError("Device trust mutation response schema is invalid");
  }
  const raw = objectRecord(
    body.result,
    "mutation result",
    (message) => new InvalidDeviceTrustHttpResponseError(message),
  );
  exactObjectKeys(raw, ["outcome", "event", "device", "key"], "mutation result", invalidResponse);
  if (raw.outcome !== "inserted" && raw.outcome !== "replayed") {
    throw new InvalidDeviceTrustHttpResponseError("Device trust mutation outcome is invalid");
  }
  const { event, device, key } = await normalizedResponse(async () => ({
    event: normalizeDeviceTrustEvent(raw.event as never),
    device: normalizeTrustedDevice(raw.device as never),
    key: raw.key === undefined ? undefined : await normalizeTrustedDeviceKey(raw.key as never),
  }), "Device trust mutation response");
  if (event.deviceId !== device.deviceId || (key !== undefined && key.deviceId !== device.deviceId)) {
    throw new InvalidDeviceTrustHttpResponseError("Device trust mutation records disagree on device identity");
  }
  return { outcome: raw.outcome, event, device, ...(key === undefined ? {} : { key }) };
}

async function recoveryProvisioningResult(response: Response): Promise<RecoveryProvisioningProof> {
  const body = await checkedJson(response);
  exactObjectKeys(body, ["schema", "proof"], "recovery provisioning response", invalidResponse);
  if (body.schema !== DEVICE_TRUST_HTTP_RECOVERY_PROVISIONING_SCHEMA) {
    throw new InvalidDeviceTrustHttpResponseError(
      "Device trust recovery provisioning response schema is invalid",
    );
  }
  return normalizedResponse(
    () => normalizeRecoveryProvisioningProof(body.proof as RecoveryProvisioningProof),
    "Device trust recovery provisioning response",
  );
}

async function recoveryCredentialMutationResult(
  response: Response,
): Promise<RecoveryCredentialMutationResult> {
  const body = await checkedJson(response);
  exactObjectKeys(
    body,
    ["schema", "result"],
    "recovery credential mutation response",
    invalidResponse,
  );
  if (body.schema !== DEVICE_TRUST_HTTP_RECOVERY_CREDENTIAL_MUTATION_SCHEMA) {
    throw new InvalidDeviceTrustHttpResponseError(
      "Device trust recovery credential mutation response schema is invalid",
    );
  }
  const raw = objectRecord(body.result, "recovery credential mutation result", invalidResponse);
  exactObjectKeys(raw, ["outcome", "event", "credential"], "recovery credential mutation result", invalidResponse);
  if (raw.outcome !== "inserted" && raw.outcome !== "replayed") {
    throw new InvalidDeviceTrustHttpResponseError("Recovery credential mutation outcome is invalid");
  }
  const { event, credential } = await normalizedResponse(async () => ({
    event: normalizeDeviceTrustEvent(raw.event as never),
    credential: await normalizeTrustedRecoveryCredential(raw.credential as never),
  }), "Recovery credential mutation response");
  if (
    event.type !== "set-recovery-credential"
    || event.recoveryKeyId !== credential.keyId
    || event.recoveryGeneration !== credential.generation
    || canonicalJson(event.principal) !== canonicalJson(credential.principal)
  ) {
    throw new InvalidDeviceTrustHttpResponseError(
      "Recovery credential mutation records disagree",
    );
  }
  return { outcome: raw.outcome, event, credential };
}

async function recoveryChallengeResult(response: Response): Promise<DeviceRecoveryChallenge> {
  const body = await checkedJson(response);
  exactObjectKeys(body, ["schema", "challenge"], "recovery challenge response", invalidResponse);
  if (body.schema !== DEVICE_TRUST_HTTP_RECOVERY_CHALLENGE_SCHEMA) {
    throw new InvalidDeviceTrustHttpResponseError(
      "Device trust recovery challenge response schema is invalid",
    );
  }
  return normalizedResponse(
    () => validateDeviceRecoveryChallengeKeyIds(body.challenge as DeviceRecoveryChallenge),
    "Device trust recovery challenge response",
  );
}

async function recoveryMutationResult(response: Response): Promise<RecoveryTrustSetMutationResult> {
  const body = await checkedJson(response);
  exactObjectKeys(body, ["schema", "result"], "recovery mutation response", invalidResponse);
  if (body.schema !== DEVICE_TRUST_HTTP_RECOVERY_MUTATION_SCHEMA) {
    throw new InvalidDeviceTrustHttpResponseError("Device trust recovery mutation response schema is invalid");
  }
  const raw = objectRecord(body.result, "recovery mutation result", invalidResponse);
  exactObjectKeys(
    raw,
    ["outcome", "event", "device", "key", "recoveryCredential"],
    "recovery mutation result",
    invalidResponse,
  );
  if (raw.outcome !== "inserted" && raw.outcome !== "replayed") {
    throw new InvalidDeviceTrustHttpResponseError("Recovery mutation outcome is invalid");
  }
  const { event, device, key, recoveryCredential } = await normalizedResponse(async () => ({
    event: normalizeDeviceTrustEvent(raw.event as never),
    device: normalizeTrustedDevice(raw.device as never),
    key: await normalizeTrustedDeviceKey(raw.key as never),
    recoveryCredential: await normalizeTrustedRecoveryCredential(raw.recoveryCredential as never),
  }), "Recovery mutation response");
  if (
    event.type !== "recover-trust-set"
    || event.deviceId !== device.deviceId
    || event.keyId !== key.keyId
    || key.deviceId !== device.deviceId
    || event.nextRecoveryKeyId !== recoveryCredential.keyId
    || event.nextRecoveryGeneration !== recoveryCredential.generation
    || canonicalJson(event.principal) !== canonicalJson(device.principal)
    || canonicalJson(event.principal) !== canonicalJson(recoveryCredential.principal)
  ) {
    throw new InvalidDeviceTrustHttpResponseError("Recovery mutation records disagree");
  }
  return { outcome: raw.outcome, event, device, key, recoveryCredential };
}


function endpoint(baseUrl: URL, route: string): URL {
  return new URL(route, baseUrl);
}

function jsonInit(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export class DeviceTrustHttpClient {
  readonly #baseUrl: URL;
  readonly #trustedFetch: DeviceTrustHttpFetch;
  readonly #candidateFetch: DeviceTrustHttpFetch;

  constructor(options: DeviceTrustHttpClientOptions) {
    this.#baseUrl = secureHttpBaseUrl(options.baseUrl, "Device trust HTTP client");
    this.#trustedFetch = options.trustedFetch;
    this.#candidateFetch = options.candidateFetch ?? globalThis.fetch.bind(globalThis);
  }

  async startEnrollment(offer: DeviceEnrollmentOffer): Promise<DeviceTrustChallenge> {
    const normalizedOffer = await normalizeDeviceEnrollmentOffer(offer);
    return challengeResult(await this.#trustedFetch(
      endpoint(this.#baseUrl, DEVICE_TRUST_HTTP_ROUTES.startEnrollment),
      jsonInit({ offer: normalizedOffer }),
    ));
  }

  async completeEnrollment(input: {
    readonly eventId: string;
    readonly challengeId: string;
    readonly signature: Uint8Array;
  }): Promise<DeviceTrustMutationResult> {
    return mutationResult(await this.#candidateFetch(
      endpoint(this.#baseUrl, DEVICE_TRUST_HTTP_ROUTES.completeEnrollment),
      jsonInit({ ...input, signature: bytesToBase64Url(input.signature) }),
    ));
  }

  async startRotation(publicKeyJwk: JsonWebKey): Promise<DeviceTrustChallenge> {
    return challengeResult(await this.#trustedFetch(
      endpoint(this.#baseUrl, DEVICE_TRUST_HTTP_ROUTES.startRotation),
      jsonInit({ publicKeyJwk: normalizeEd25519PublicJwk(publicKeyJwk) }),
    ));
  }

  async completeRotation(input: {
    readonly eventId: string;
    readonly challengeId: string;
    readonly signature: Uint8Array;
  }): Promise<DeviceTrustMutationResult> {
    return mutationResult(await this.#candidateFetch(
      endpoint(this.#baseUrl, DEVICE_TRUST_HTTP_ROUTES.completeRotation),
      jsonInit({ ...input, signature: bytesToBase64Url(input.signature) }),
    ));
  }

  async prepareRecoveryCredential(
    eventId: string,
    publicKeyJwk: JsonWebKey,
  ): Promise<RecoveryProvisioningProof> {
    const normalizedKey = normalizeEd25519PublicJwk(publicKeyJwk);
    const proof = await recoveryProvisioningResult(await this.#trustedFetch(
      endpoint(this.#baseUrl, DEVICE_TRUST_HTTP_ROUTES.prepareRecoveryCredential),
      jsonInit({ eventId, publicKeyJwk: normalizedKey }),
    ));
    if (proof.eventId !== eventId || canonicalJson(proof.recoveryPublicKeyJwk) !== canonicalJson(normalizedKey)) {
      throw new InvalidDeviceTrustHttpResponseError(
        "Recovery provisioning response does not match the requested event/key",
      );
    }
    return proof;
  }

  async commitRecoveryCredential(input: {
    readonly eventId: string;
    readonly publicKeyJwk: JsonWebKey;
    readonly signature: Uint8Array;
  }): Promise<RecoveryCredentialMutationResult> {
    const publicKeyJwk = normalizeEd25519PublicJwk(input.publicKeyJwk);
    const result = await recoveryCredentialMutationResult(await this.#trustedFetch(
      endpoint(this.#baseUrl, DEVICE_TRUST_HTTP_ROUTES.commitRecoveryCredential),
      jsonInit({
        eventId: input.eventId,
        publicKeyJwk,
        signature: bytesToBase64Url(input.signature),
      }),
    ));
    if (
      result.event.eventId !== input.eventId
      || canonicalJson(result.credential.publicKeyJwk) !== canonicalJson(publicKeyJwk)
    ) {
      throw new InvalidDeviceTrustHttpResponseError(
        "Recovery credential mutation does not match the requested event/key",
      );
    }
    return result;
  }

  async startRecovery(input: {
    readonly recoveryKeyId: string;
    readonly deviceId: string;
    readonly displayName: string;
    readonly publicKeyJwk: JsonWebKey;
    readonly nextRecoveryPublicKeyJwk: JsonWebKey;
  }): Promise<DeviceRecoveryChallenge> {
    const publicKeyJwk = normalizeEd25519PublicJwk(input.publicKeyJwk);
    const nextRecoveryPublicKeyJwk = normalizeEd25519PublicJwk(input.nextRecoveryPublicKeyJwk);
    const challenge = await recoveryChallengeResult(await this.#candidateFetch(
      endpoint(this.#baseUrl, DEVICE_TRUST_HTTP_ROUTES.startRecovery),
      jsonInit({ ...input, publicKeyJwk, nextRecoveryPublicKeyJwk }),
    ));
    if (
      challenge.recoveryKeyId !== input.recoveryKeyId
      || challenge.deviceId !== input.deviceId
      || challenge.displayName !== input.displayName
      || canonicalJson(challenge.publicKeyJwk) !== canonicalJson(publicKeyJwk)
      || canonicalJson(challenge.nextRecoveryPublicKeyJwk) !== canonicalJson(nextRecoveryPublicKeyJwk)
    ) {
      throw new InvalidDeviceTrustHttpResponseError(
        "Recovery challenge does not match the requested recovery/device keys",
      );
    }
    return challenge;
  }

  async completeRecovery(input: {
    readonly eventId: string;
    readonly challengeId: string;
    readonly recoverySignature: Uint8Array;
    readonly deviceSignature: Uint8Array;
    readonly nextRecoverySignature: Uint8Array;
  }): Promise<RecoveryTrustSetMutationResult> {
    const result = await recoveryMutationResult(await this.#candidateFetch(
      endpoint(this.#baseUrl, DEVICE_TRUST_HTTP_ROUTES.completeRecovery),
      jsonInit({
        eventId: input.eventId,
        challengeId: input.challengeId,
        recoverySignature: bytesToBase64Url(input.recoverySignature),
        deviceSignature: bytesToBase64Url(input.deviceSignature),
        nextRecoverySignature: bytesToBase64Url(input.nextRecoverySignature),
      }),
    ));
    if (result.event.eventId !== input.eventId || result.event.challengeId !== input.challengeId) {
      throw new InvalidDeviceTrustHttpResponseError(
        "Recovery mutation does not match the requested event/challenge",
      );
    }
    return result;
  }

  async revokeKey(eventId: string, targetKeyId: string): Promise<DeviceTrustMutationResult> {
    return mutationResult(await this.#trustedFetch(
      endpoint(this.#baseUrl, DEVICE_TRUST_HTTP_ROUTES.revokeKey),
      jsonInit({ eventId, targetKeyId }),
    ));
  }

  async revokeDevice(eventId: string, targetDeviceId: string): Promise<DeviceTrustMutationResult> {
    return mutationResult(await this.#trustedFetch(
      endpoint(this.#baseUrl, DEVICE_TRUST_HTTP_ROUTES.revokeDevice),
      jsonInit({ eventId, targetDeviceId }),
    ));
  }
}
