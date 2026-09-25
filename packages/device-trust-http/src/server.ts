import { normalizeAccessPrincipal, type AccessPrincipal } from "@ssrl/access";
import { canonicalJson } from "@ssrl/core";
import { normalizeX25519PublicJwk, type X25519PublicJwk } from "@ssrl/e2e";
import {
  DeviceTrustAuthorizationError,
  DeviceTrustChallengeError,
  DeviceTrustConflictError,
  DeviceTrustManager,
  DeviceTrustProofError,
  normalizeDeviceEnrollmentOffer,
  normalizeEd25519PublicJwk,
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
  nonEmptyString,
  normalizedMediaType,
  objectRecord,
  parseUtf8Json,
  uniqueHostnames,
  validateRequestHost,
  validateRequestOrigin,
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
  type DeviceTrustHttpErrorBody,
} from "./protocol.js";

const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;
const HARD_MAX_REQUEST_BYTES = 1024 * 1024;
const BASE64URL_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

export interface DeviceTrustHttpAuthentication {
  readonly principal: AccessPrincipal;
  readonly device?: {
    readonly keyId: string;
    readonly deviceId?: string;
  };
  readonly verifyBody?: (bytes: Uint8Array) => boolean | Promise<boolean>;
}

export interface DeviceTrustHttpAuthenticator {
  authenticate(
    request: Request,
  ): DeviceTrustHttpAuthentication | Response | Promise<DeviceTrustHttpAuthentication | Response>;
}

export interface DeviceTrustHttpServerOptions {
  readonly manager: DeviceTrustManager;
  readonly authenticator: DeviceTrustHttpAuthenticator;
  readonly audience: string;
  readonly allowedHostnames: readonly string[];
  readonly allowedOriginHostnames?: readonly string[];
  readonly maxRequestBytes?: number;
}

export interface DeviceTrustHttpHandler {
  fetch(request: Request): Promise<Response>;
}

export class DeviceTrustHttpProtocolError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DeviceTrustHttpProtocolError";
  }
}

function configuredLimit(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_REQUEST_BYTES;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > HARD_MAX_REQUEST_BYTES) {
    throw new RangeError(`maxRequestBytes must be an integer between 1 and ${HARD_MAX_REQUEST_BYTES}`);
  }
  return resolved;
}

function configuredAudience(value: string): string {
  const audience = value.trim();
  if (audience.length === 0) throw new TypeError("device trust HTTP audience must not be empty");
  return audience;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  const body: DeviceTrustHttpErrorBody = {
    schema: DEVICE_TRUST_HTTP_ERROR_SCHEMA,
    code,
    message,
  };
  return jsonResponse(body, status);
}

function authFailure(): Response {
  return errorResponse(401, "authentication-failed", "Device trust authentication failed");
}

function invalidRequest(message: string): DeviceTrustHttpProtocolError {
  return new DeviceTrustHttpProtocolError(400, "invalid-request", message);
}

function base64UrlToSignature(value: string): Uint8Array {
  if (!BASE64URL_SIGNATURE.test(value)) throw invalidRequest("signature must be unpadded base64url Ed25519 bytes");
  const base64 = `${value.replaceAll("-", "+").replaceAll("_", "/")}==`;
  try {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
    if (bytes.byteLength !== 64) throw new Error("wrong length");
    return bytes;
  } catch {
    throw invalidRequest("signature must be unpadded base64url Ed25519 bytes");
  }
}

async function boundedBody(
  request: Request,
  maxBytes: number,
  authentication?: DeviceTrustHttpAuthentication,
): Promise<Uint8Array> {
  const bytes = await collectBoundedBytes({
    body: request.body,
    contentLength: request.headers.get("content-length"),
    maxBytes,
    invalidLength: (message) => new DeviceTrustHttpProtocolError(400, "invalid-content-length", message),
    tooLarge: (message) => new DeviceTrustHttpProtocolError(413, "request-too-large", message),
  });
  if (authentication !== undefined) {
    if (authentication.verifyBody === undefined) throw new DeviceTrustHttpProtocolError(401, "authentication-failed", "Device trust authentication failed");
    let valid = false;
    try {
      valid = await authentication.verifyBody(bytes);
    } catch {
      valid = false;
    }
    if (!valid) throw new DeviceTrustHttpProtocolError(401, "authentication-failed", "Device trust authentication failed");
  }
  return bytes;
}

function jsonBody(bytes: Uint8Array): Record<string, unknown> {
  return objectRecord(
    parseUtf8Json(bytes, invalidRequest, invalidRequest),
    "request body",
    invalidRequest,
  );
}

async function parsedOffer(value: unknown, audience: string): Promise<DeviceEnrollmentOffer> {
  const offer = objectRecord(value, "offer", invalidRequest);
  exactObjectKeys(
    offer,
    [
      "schema", "deviceId", "displayName", "publicKeyJwk", "keyId",
      "encryptionPublicKeyJwk", "encryptionKeyId", "audience",
    ],
    "offer",
    invalidRequest,
  );
  const jwk = objectRecord(offer.publicKeyJwk, "offer.publicKeyJwk", invalidRequest);
  exactObjectKeys(jwk, ["kty", "crv", "x"], "offer.publicKeyJwk", invalidRequest);
  const encryptionPublicKeyJwk = parsedEncryptionPublicJwk(
    offer.encryptionPublicKeyJwk,
    "offer.encryptionPublicKeyJwk",
  );
  const normalized = await normalizeDeviceEnrollmentOffer({
    schema: nonEmptyString(offer.schema, "offer.schema", invalidRequest) as DeviceEnrollmentOffer["schema"],
    deviceId: nonEmptyString(offer.deviceId, "offer.deviceId", invalidRequest),
    displayName: nonEmptyString(offer.displayName, "offer.displayName", invalidRequest),
    publicKeyJwk: normalizeEd25519PublicJwk({
      kty: nonEmptyString(jwk.kty, "offer.publicKeyJwk.kty", invalidRequest),
      crv: nonEmptyString(jwk.crv, "offer.publicKeyJwk.crv", invalidRequest),
      x: nonEmptyString(jwk.x, "offer.publicKeyJwk.x", invalidRequest),
    } as JsonWebKey),
    keyId: nonEmptyString(offer.keyId, "offer.keyId", invalidRequest),
    encryptionPublicKeyJwk,
    encryptionKeyId: nonEmptyString(offer.encryptionKeyId, "offer.encryptionKeyId", invalidRequest),
    audience: nonEmptyString(offer.audience, "offer.audience", invalidRequest),
  });
  if (normalized.audience !== audience) throw invalidRequest("offer audience does not match this trust registry");
  return normalized;
}

function parsedPublicJwk(value: unknown, label = "publicKeyJwk"): JsonWebKey {
  const jwk = objectRecord(value, label, invalidRequest);
  exactObjectKeys(jwk, ["kty", "crv", "x"], label, invalidRequest);
  try {
    return normalizeEd25519PublicJwk({
      kty: nonEmptyString(jwk.kty, `${label}.kty`, invalidRequest),
      crv: nonEmptyString(jwk.crv, `${label}.crv`, invalidRequest),
      x: nonEmptyString(jwk.x, `${label}.x`, invalidRequest),
    } as JsonWebKey);
  } catch (cause) {
    if (cause instanceof DeviceTrustHttpProtocolError) throw cause;
    const detail = cause instanceof Error ? cause.message : `${label} is invalid`;
    throw invalidRequest(detail);
  }
}

function parsedEncryptionPublicJwk(
  value: unknown,
  label = "encryptionPublicKeyJwk",
): X25519PublicJwk {
  const jwk = objectRecord(value, label, invalidRequest);
  exactObjectKeys(jwk, ["kty", "crv", "x"], label, invalidRequest);
  try {
    return normalizeX25519PublicJwk({
      kty: nonEmptyString(jwk.kty, `${label}.kty`, invalidRequest),
      crv: nonEmptyString(jwk.crv, `${label}.crv`, invalidRequest),
      x: nonEmptyString(jwk.x, `${label}.x`, invalidRequest),
    } as JsonWebKey);
  } catch (cause) {
    if (cause instanceof DeviceTrustHttpProtocolError) throw cause;
    const detail = cause instanceof Error ? cause.message : `${label} is invalid`;
    throw invalidRequest(detail);
  }
}

function principalEqual(left: AccessPrincipal, right: AccessPrincipal): boolean {
  return canonicalJson(normalizeAccessPrincipal(left)) === canonicalJson(normalizeAccessPrincipal(right));
}

async function requestAuthentication(
  request: Request,
  authenticator: DeviceTrustHttpAuthenticator,
): Promise<DeviceTrustHttpAuthentication | Response> {
  const authentication = await authenticator.authenticate(request);
  if (authentication instanceof Response) return authFailure();
  if (authentication.device?.keyId === undefined) return authFailure();
  return authentication;
}

async function validateDurableAuthorizer(
  authentication: DeviceTrustHttpAuthentication,
  manager: DeviceTrustManager,
): Promise<boolean> {
  const keyId = authentication.device?.keyId;
  if (keyId === undefined) return false;
  try {
    const active = await manager.activeAuthorization(keyId);
    return principalEqual(authentication.principal, active.device.principal)
      && (authentication.device?.deviceId === undefined
        || authentication.device.deviceId === active.device.deviceId);
  } catch {
    return false;
  }
}

function challengeResponse(challenge: DeviceTrustChallenge): Response {
  return jsonResponse({ schema: DEVICE_TRUST_HTTP_CHALLENGE_SCHEMA, challenge });
}

function mutationResponse(result: DeviceTrustMutationResult): Response {
  return jsonResponse({ schema: DEVICE_TRUST_HTTP_MUTATION_SCHEMA, result });
}


function recoveryProvisioningResponse(proof: RecoveryProvisioningProof): Response {
  return jsonResponse({ schema: DEVICE_TRUST_HTTP_RECOVERY_PROVISIONING_SCHEMA, proof });
}

function recoveryCredentialMutationResponse(result: RecoveryCredentialMutationResult): Response {
  return jsonResponse({ schema: DEVICE_TRUST_HTTP_RECOVERY_CREDENTIAL_MUTATION_SCHEMA, result });
}

function recoveryChallengeResponse(challenge: DeviceRecoveryChallenge): Response {
  return jsonResponse({ schema: DEVICE_TRUST_HTTP_RECOVERY_CHALLENGE_SCHEMA, challenge });
}

function recoveryMutationResponse(result: RecoveryTrustSetMutationResult): Response {
  return jsonResponse({ schema: DEVICE_TRUST_HTTP_RECOVERY_MUTATION_SCHEMA, result });
}

async function signedBody(
  request: Request,
  options: {
    readonly authenticator: DeviceTrustHttpAuthenticator;
    readonly manager: DeviceTrustManager;
    readonly maxRequestBytes: number;
  },
): Promise<{ readonly authentication: DeviceTrustHttpAuthentication; readonly body: Record<string, unknown> } | Response> {
  const authentication = await requestAuthentication(request, options.authenticator);
  if (authentication instanceof Response) return authentication;
  const bytes = await boundedBody(request, options.maxRequestBytes, authentication);
  if (!(await validateDurableAuthorizer(authentication, options.manager))) return authFailure();
  return { authentication, body: jsonBody(bytes) };
}

function completionInput(body: Readonly<Record<string, unknown>>): {
  readonly eventId: string;
  readonly challengeId: string;
  readonly signature: Uint8Array;
} {
  exactObjectKeys(body, ["eventId", "challengeId", "signature"], "request body", invalidRequest);
  return {
    eventId: nonEmptyString(body.eventId, "eventId", invalidRequest),
    challengeId: nonEmptyString(body.challengeId, "challengeId", invalidRequest),
    signature: base64UrlToSignature(nonEmptyString(body.signature, "signature", invalidRequest)),
  };
}

function recoveryProvisioningInput(body: Readonly<Record<string, unknown>>): {
  readonly eventId: string;
  readonly publicKeyJwk: JsonWebKey;
  readonly encryptionPublicKeyJwk: JsonWebKey;
} {
  exactObjectKeys(
    body,
    ["eventId", "publicKeyJwk", "encryptionPublicKeyJwk"],
    "request body",
    invalidRequest,
  );
  return {
    eventId: nonEmptyString(body.eventId, "eventId", invalidRequest),
    publicKeyJwk: parsedPublicJwk(body.publicKeyJwk),
    encryptionPublicKeyJwk: parsedEncryptionPublicJwk(body.encryptionPublicKeyJwk),
  };
}

function recoveryCommitInput(body: Readonly<Record<string, unknown>>): {
  readonly eventId: string;
  readonly publicKeyJwk: JsonWebKey;
  readonly encryptionPublicKeyJwk: JsonWebKey;
  readonly signature: Uint8Array;
} {
  exactObjectKeys(
    body,
    ["eventId", "publicKeyJwk", "encryptionPublicKeyJwk", "signature"],
    "request body",
    invalidRequest,
  );
  return {
    ...recoveryProvisioningInput({
      eventId: body.eventId,
      publicKeyJwk: body.publicKeyJwk,
      encryptionPublicKeyJwk: body.encryptionPublicKeyJwk,
    }),
    signature: base64UrlToSignature(nonEmptyString(body.signature, "signature", invalidRequest)),
  };
}

function recoveryStartInput(body: Readonly<Record<string, unknown>>): {
  readonly recoveryKeyId: string;
  readonly deviceId: string;
  readonly displayName: string;
  readonly publicKeyJwk: JsonWebKey;
  readonly deviceEncryptionPublicKeyJwk: JsonWebKey;
  readonly nextRecoveryPublicKeyJwk: JsonWebKey;
  readonly nextRecoveryEncryptionPublicKeyJwk: JsonWebKey;
} {
  exactObjectKeys(
    body,
    [
      "recoveryKeyId", "deviceId", "displayName", "publicKeyJwk",
      "deviceEncryptionPublicKeyJwk", "nextRecoveryPublicKeyJwk",
      "nextRecoveryEncryptionPublicKeyJwk",
    ],
    "request body",
    invalidRequest,
  );
  return {
    recoveryKeyId: nonEmptyString(body.recoveryKeyId, "recoveryKeyId", invalidRequest),
    deviceId: nonEmptyString(body.deviceId, "deviceId", invalidRequest),
    displayName: nonEmptyString(body.displayName, "displayName", invalidRequest),
    publicKeyJwk: parsedPublicJwk(body.publicKeyJwk),
    deviceEncryptionPublicKeyJwk: parsedEncryptionPublicJwk(
      body.deviceEncryptionPublicKeyJwk,
      "deviceEncryptionPublicKeyJwk",
    ),
    nextRecoveryPublicKeyJwk: parsedPublicJwk(
      body.nextRecoveryPublicKeyJwk,
      "nextRecoveryPublicKeyJwk",
    ),
    nextRecoveryEncryptionPublicKeyJwk: parsedEncryptionPublicJwk(
      body.nextRecoveryEncryptionPublicKeyJwk,
      "nextRecoveryEncryptionPublicKeyJwk",
    ),
  };
}

function recoveryCompletionInput(body: Readonly<Record<string, unknown>>): {
  readonly eventId: string;
  readonly challengeId: string;
  readonly recoverySignature: Uint8Array;
  readonly deviceSignature: Uint8Array;
  readonly nextRecoverySignature: Uint8Array;
} {
  exactObjectKeys(
    body,
    ["eventId", "challengeId", "recoverySignature", "deviceSignature", "nextRecoverySignature"],
    "request body",
    invalidRequest,
  );
  return {
    eventId: nonEmptyString(body.eventId, "eventId", invalidRequest),
    challengeId: nonEmptyString(body.challengeId, "challengeId", invalidRequest),
    recoverySignature: base64UrlToSignature(
      nonEmptyString(body.recoverySignature, "recoverySignature", invalidRequest),
    ),
    deviceSignature: base64UrlToSignature(
      nonEmptyString(body.deviceSignature, "deviceSignature", invalidRequest),
    ),
    nextRecoverySignature: base64UrlToSignature(
      nonEmptyString(body.nextRecoverySignature, "nextRecoverySignature", invalidRequest),
    ),
  };
}

type DeviceTrustErrorProfile = "management" | "candidate-proof" | "public-recovery";

function recoveryFailure(): Response {
  return errorResponse(401, "recovery-failed", "Device trust recovery failed");
}

function mapError(error: unknown, profile: DeviceTrustErrorProfile): Response {
  if (error instanceof DeviceTrustHttpProtocolError) {
    return errorResponse(error.status, error.code, error.message);
  }
  if (
    profile === "public-recovery"
    && (
      error instanceof DeviceTrustAuthorizationError
      || error instanceof DeviceTrustConflictError
      || error instanceof DeviceTrustChallengeError
      || error instanceof DeviceTrustProofError
      || error instanceof TypeError
    )
  ) {
    return recoveryFailure();
  }
  if (
    profile === "candidate-proof"
    && (error instanceof DeviceTrustChallengeError || error instanceof DeviceTrustProofError)
  ) {
    return errorResponse(401, "proof-failed", "Device trust proof failed");
  }
  if (error instanceof DeviceTrustProofError) {
    return errorResponse(401, "proof-failed", "Device trust proof failed");
  }
  if (error instanceof DeviceTrustAuthorizationError) {
    return errorResponse(403, "device-trust-denied", "Device trust operation denied");
  }
  if (error instanceof DeviceTrustConflictError) {
    return errorResponse(409, "device-trust-conflict", "Device trust operation conflicts with current state");
  }
  if (error instanceof TypeError) return errorResponse(400, "invalid-request", error.message);
  return errorResponse(500, "internal-error", "Device trust request failed");
}

function knownRoute(pathname: string): boolean {
  const routes: readonly string[] = Object.values(DEVICE_TRUST_HTTP_ROUTES);
  return routes.includes(pathname);
}

export function createDeviceTrustHttpHandler(
  options: DeviceTrustHttpServerOptions,
): DeviceTrustHttpHandler {
  const audience = configuredAudience(options.audience);
  const allowedHosts = uniqueHostnames(options.allowedHostnames, "allowedHostnames");
  const allowedOrigins = options.allowedOriginHostnames === undefined
    ? allowedHosts
    : uniqueHostnames(options.allowedOriginHostnames, "allowedOriginHostnames");
  const maxRequestBytes = configuredLimit(options.maxRequestBytes);

  return {
    async fetch(request: Request): Promise<Response> {
      let errorProfile: DeviceTrustErrorProfile = "management";
      try {
        validateRequestHost({
          request,
          allowed: allowedHosts,
          invalidHost: (message) => new DeviceTrustHttpProtocolError(400, "invalid-host", message),
          notAllowed: (message) => new DeviceTrustHttpProtocolError(421, "host-not-allowed", message),
        });
        validateRequestOrigin({
          request,
          allowed: allowedOrigins,
          notAllowed: (message) => new DeviceTrustHttpProtocolError(403, "origin-not-allowed", message),
        });
        const pathname = new URL(request.url).pathname;
        if (!knownRoute(pathname)) return errorResponse(404, "route-not-found", "Device trust route does not exist");
        if (request.method !== "POST") return errorResponse(405, "method-not-allowed", "Device trust routes require POST");
        if (normalizedMediaType(request.headers) !== "application/json") {
          return errorResponse(415, "unsupported-media-type", "Expected application/json");
        }

        if (pathname === DEVICE_TRUST_HTTP_ROUTES.completeEnrollment) {
          errorProfile = "candidate-proof";
          const body = jsonBody(await boundedBody(request, maxRequestBytes));
          return mutationResponse(await options.manager.completeEnrollment(completionInput(body)));
        }
        if (pathname === DEVICE_TRUST_HTTP_ROUTES.completeRotation) {
          errorProfile = "candidate-proof";
          const body = jsonBody(await boundedBody(request, maxRequestBytes));
          return mutationResponse(await options.manager.completeRotation(completionInput(body)));
        }

        if (pathname === DEVICE_TRUST_HTTP_ROUTES.startRecovery) {
          errorProfile = "public-recovery";
          const body = jsonBody(await boundedBody(request, maxRequestBytes));
          const input = recoveryStartInput(body);
          return recoveryChallengeResponse(await options.manager.startRecovery({
            ...input,
            audience,
          }));
        }
        if (pathname === DEVICE_TRUST_HTTP_ROUTES.completeRecovery) {
          errorProfile = "public-recovery";
          const body = jsonBody(await boundedBody(request, maxRequestBytes));
          return recoveryMutationResponse(
            await options.manager.completeRecovery(recoveryCompletionInput(body)),
          );
        }

        const signed = await signedBody(request, {
          authenticator: options.authenticator,
          manager: options.manager,
          maxRequestBytes,
        });
        if (signed instanceof Response) return signed;
        const authorizingKeyId = signed.authentication.device!.keyId;

        if (pathname === DEVICE_TRUST_HTTP_ROUTES.prepareRecoveryCredential) {
          const input = recoveryProvisioningInput(signed.body);
          return recoveryProvisioningResponse(await options.manager.prepareRecoveryCredential({
            ...input,
            authorizingKeyId,
            audience,
          }));
        }
        if (pathname === DEVICE_TRUST_HTTP_ROUTES.commitRecoveryCredential) {
          const input = recoveryCommitInput(signed.body);
          return recoveryCredentialMutationResponse(await options.manager.setRecoveryCredential({
            ...input,
            authorizingKeyId,
            audience,
          }));
        }

        if (pathname === DEVICE_TRUST_HTTP_ROUTES.startEnrollment) {
          exactObjectKeys(signed.body, ["offer"], "request body", invalidRequest);
          const offer = await parsedOffer(signed.body.offer, audience);
          return challengeResponse(await options.manager.startEnrollment({
            authorizingKeyId,
            deviceId: offer.deviceId,
            displayName: offer.displayName,
            publicKeyJwk: offer.publicKeyJwk,
            encryptionPublicKeyJwk: offer.encryptionPublicKeyJwk,
            audience,
          }));
        }
        if (pathname === DEVICE_TRUST_HTTP_ROUTES.startRotation) {
          exactObjectKeys(
            signed.body,
            ["publicKeyJwk", "encryptionPublicKeyJwk"],
            "request body",
            invalidRequest,
          );
          return challengeResponse(await options.manager.startRotation({
            authorizingKeyId,
            publicKeyJwk: parsedPublicJwk(signed.body.publicKeyJwk),
            encryptionPublicKeyJwk: parsedEncryptionPublicJwk(signed.body.encryptionPublicKeyJwk),
            audience,
          }));
        }
        if (pathname === DEVICE_TRUST_HTTP_ROUTES.revokeKey) {
          exactObjectKeys(signed.body, ["eventId", "targetKeyId"], "request body", invalidRequest);
          return mutationResponse(await options.manager.revokeKey({
            eventId: nonEmptyString(signed.body.eventId, "eventId", invalidRequest),
            authorizingKeyId,
            targetKeyId: nonEmptyString(signed.body.targetKeyId, "targetKeyId", invalidRequest),
          }));
        }
        if (pathname === DEVICE_TRUST_HTTP_ROUTES.revokeDevice) {
          exactObjectKeys(signed.body, ["eventId", "targetDeviceId"], "request body", invalidRequest);
          return mutationResponse(await options.manager.revokeDevice({
            eventId: nonEmptyString(signed.body.eventId, "eventId", invalidRequest),
            authorizingKeyId,
            targetDeviceId: nonEmptyString(signed.body.targetDeviceId, "targetDeviceId", invalidRequest),
          }));
        }
        return errorResponse(404, "route-not-found", "Device trust route does not exist");
      } catch (error) {
        return mapError(error, errorProfile);
      }
    },
  };
}
