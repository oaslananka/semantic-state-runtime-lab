import { normalizeAccessPrincipal } from "@ssrl/access";
import type {
  ReplicationDeviceCredential,
  ReplicationDeviceKeyResolver,
  ReplicationSignatureReplayInput,
  ReplicationSignatureReplayStore,
} from "@ssrl/device-trust";
export type {
  ReplicationDeviceCredential,
  ReplicationDeviceKeyResolver,
  ReplicationSignatureReplayInput,
  ReplicationSignatureReplayStore,
} from "@ssrl/device-trust";
import type {
  ReplicationHttpAuthentication,
  ReplicationHttpAuthenticator,
} from "./authentication.js";
import type { ReplicationHttpFetch } from "./client.js";
import { REPLICATION_HTTP_ERROR_SCHEMA } from "./protocol.js";

const SIGNATURE_LABEL = "ssrl";
const SIGNATURE_TAG = "ssrl-replication-v1";
const SIGNATURE_ALGORITHM = "ed25519";
const CONTENT_DIGEST_ALGORITHM = "sha-256";
const DEFAULT_SIGNATURE_LIFETIME_SECONDS = 60;
const MAX_SIGNATURE_LIFETIME_SECONDS = 300;
const DEFAULT_CLOCK_SKEW_SECONDS = 5;
const DEFAULT_REPLAY_ENTRIES = 10_000;
const PROFILE_COMPONENTS = [
  "@method",
  "@target-uri",
  "content-digest",
  "content-type",
] as const;
const PROFILE_COMPONENT_LIST = PROFILE_COMPONENTS.map((value) => `"${value}"`).join(" ");
const SAFE_KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const SIGNATURE_INPUT = new RegExp(String.raw`^${SIGNATURE_LABEL}=\("@method" "@target-uri" "content-digest" "content-type"\);created=(\d+);expires=(\d+);nonce="([A-Za-z0-9_-]{16,128})";keyid="([A-Za-z0-9._:-]{1,128})";alg="${SIGNATURE_ALGORITHM}";tag="${SIGNATURE_TAG}"$`);
const SIGNATURE_VALUE = new RegExp(`^${SIGNATURE_LABEL}=:([A-Za-z0-9+/]+={0,2}):$`);
const CONTENT_DIGEST_VALUE = new RegExp(`^${CONTENT_DIGEST_ALGORITHM}=:([A-Za-z0-9+/]+={0,2}):$`);

export interface HttpMessageSignatureAuthenticatorOptions {
  readonly keys: ReplicationDeviceKeyResolver;
  readonly replayStore: ReplicationSignatureReplayStore;
  /** Epoch milliseconds. */
  readonly now?: () => number;
  readonly maxSignatureLifetimeSeconds?: number;
  readonly clockSkewSeconds?: number;
}

export interface HttpMessageSigningFetchOptions {
  readonly keyId: string;
  readonly privateKey: CryptoKey;
  readonly fetch?: ReplicationHttpFetch;
  /** Epoch milliseconds. */
  readonly now?: () => number;
  readonly nonce?: () => string;
  readonly lifetimeSeconds?: number;
}

interface SignatureParametersInput {
  readonly created: number;
  readonly expires: number;
  readonly nonce: string;
  readonly keyId: string;
}

interface ParsedSignatureInput extends SignatureParametersInput {
  readonly serialized: string;
}

function safeIntegerSeconds(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be non-negative integer seconds`);
  return value;
}

function configuredLifetime(value: number | undefined): number {
  const result = value ?? DEFAULT_SIGNATURE_LIFETIME_SECONDS;
  if (!Number.isSafeInteger(result) || result < 1 || result > MAX_SIGNATURE_LIFETIME_SECONDS) {
    throw new RangeError(
      `signature lifetime must be an integer between 1 and ${MAX_SIGNATURE_LIFETIME_SECONDS} seconds`,
    );
  }
  return result;
}

function configuredSkew(value: number | undefined): number {
  const result = value ?? DEFAULT_CLOCK_SKEW_SECONDS;
  if (!Number.isSafeInteger(result) || result < 0 || result > MAX_SIGNATURE_LIFETIME_SECONDS) {
    throw new RangeError(
      `clockSkewSeconds must be an integer between 0 and ${MAX_SIGNATURE_LIFETIME_SECONDS}`,
    );
  }
  return result;
}

function assertSafeKeyId(value: string): string {
  if (!SAFE_KEY_ID.test(value)) throw new TypeError("replication signature keyId is invalid");
  return value;
}

function assertSafeNonce(value: string): string {
  if (!SAFE_NONCE.test(value)) throw new TypeError("replication signature nonce is invalid");
  return value;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary);
}

function base64ToBytes(value: string, expectedLength: number): Uint8Array | undefined {
  try {
    const binary = atob(value);
    if (binary.length !== expectedLength) return undefined;
    const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
    return bytesToBase64(bytes) === value ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function base64Url(bytes: Uint8Array): string {
  const value = bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_");
  if (value.endsWith("==")) return value.slice(0, -2);
  return value.endsWith("=") ? value.slice(0, -1) : value;
}

function randomNonce(): string {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy));
}

function contentDigestValue(bytes: Uint8Array): string {
  return `${CONTENT_DIGEST_ALGORITHM}=:${bytesToBase64(bytes)}:`;
}

function parseContentDigest(value: string | null): Uint8Array | undefined {
  if (value === null || value.length > 128) return undefined;
  const match = CONTENT_DIGEST_VALUE.exec(value);
  return match === null ? undefined : base64ToBytes(match[1]!, 32);
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function signatureParameters(input: SignatureParametersInput): string {
  return `(${PROFILE_COMPONENT_LIST});created=${input.created};expires=${input.expires}`
    + `;nonce="${input.nonce}";keyid="${input.keyId}";alg="${SIGNATURE_ALGORITHM}"`
    + `;tag="${SIGNATURE_TAG}"`;
}

function signatureInputValue(input: SignatureParametersInput): string {
  return `${SIGNATURE_LABEL}=${signatureParameters(input)}`;
}

function signatureBase(request: Request, serializedParameters: string): string | undefined {
  const digest = request.headers.get("content-digest");
  const contentType = request.headers.get("content-type");
  if (digest === null || contentType === null || contentType.length > 256) return undefined;
  return [
    `"@method": ${request.method}`,
    `"@target-uri": ${request.url}`,
    `"content-digest": ${digest}`,
    `"content-type": ${contentType}`,
    `"@signature-params": ${serializedParameters}`,
  ].join("\n");
}

function parseSignatureInput(value: string | null): ParsedSignatureInput | undefined {
  if (value === null || value.length > 512) return undefined;
  const match = SIGNATURE_INPUT.exec(value);
  if (match === null) return undefined;
  const created = Number(match[1]);
  const expires = Number(match[2]);
  if (!Number.isSafeInteger(created) || !Number.isSafeInteger(expires)) return undefined;
  return {
    serialized: value.slice(`${SIGNATURE_LABEL}=`.length),
    created,
    expires,
    nonce: match[3]!,
    keyId: match[4]!,
  };
}

function parseSignature(value: string | null): Uint8Array | undefined {
  if (value === null || value.length > 128) return undefined;
  const match = SIGNATURE_VALUE.exec(value);
  return match === null ? undefined : base64ToBytes(match[1]!, 64);
}

function validPublicJwk(value: JsonWebKey): boolean {
  return value.kty === "OKP"
    && value.crv === "Ed25519"
    && typeof value.x === "string"
    && value.x.length > 0
    && value.d === undefined;
}

async function importVerificationKey(value: JsonWebKey): Promise<CryptoKey> {
  if (!validPublicJwk(value)) throw new TypeError("replication device public key must be Ed25519 JWK");
  return globalThis.crypto.subtle.importKey("jwk", value, { name: "Ed25519" }, false, ["verify"]);
}

function signingKey(value: CryptoKey): CryptoKey {
  if (value.type !== "private" || value.algorithm.name !== "Ed25519" || !value.usages.includes("sign")) {
    throw new TypeError("replication signing key must be an Ed25519 private CryptoKey");
  }
  return value;
}

function authFailure(): Response {
  return new Response(JSON.stringify({
    schema: REPLICATION_HTTP_ERROR_SCHEMA,
    code: "authentication-failed",
    message: "Replication authentication failed",
  }), {
    status: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function timeIsValid(
  parsed: ParsedSignatureInput,
  now: number,
  maxLifetime: number,
  skew: number,
): boolean {
  if (parsed.expires <= parsed.created) return false;
  if (parsed.expires - parsed.created > maxLifetime) return false;
  if (parsed.created > now + skew) return false;
  if (parsed.expires < now - skew) return false;
  return true;
}

export class StaticReplicationDeviceKeyResolver implements ReplicationDeviceKeyResolver {
  readonly #credentials: ReadonlyMap<string, ReplicationDeviceCredential>;

  constructor(credentials: readonly ReplicationDeviceCredential[]) {
    const map = new Map<string, ReplicationDeviceCredential>();
    for (const credential of credentials) {
      const keyId = assertSafeKeyId(credential.keyId);
      if (map.has(keyId)) throw new TypeError(`duplicate replication device keyId: ${keyId}`);
      if (!validPublicJwk(credential.publicKeyJwk)) {
        throw new TypeError(`replication device ${keyId} public key must be Ed25519 JWK`);
      }
      if (credential.status !== undefined && credential.status !== "active" && credential.status !== "revoked") {
        throw new TypeError(`replication device ${keyId} status is invalid`);
      }
      map.set(keyId, {
        keyId,
        publicKeyJwk: { ...credential.publicKeyJwk },
        principal: normalizeAccessPrincipal(credential.principal),
        status: credential.status ?? "active",
      });
    }
    this.#credentials = map;
  }

  resolve(keyId: string): ReplicationDeviceCredential | undefined {
    return this.#credentials.get(keyId);
  }
}

export class InMemoryReplicationSignatureReplayStore implements ReplicationSignatureReplayStore {
  readonly #entries = new Map<string, number>();
  readonly #maxEntries: number;

  constructor(maxEntries = DEFAULT_REPLAY_ENTRIES) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive integer");
    }
    this.#maxEntries = maxEntries;
  }

  consume(input: ReplicationSignatureReplayInput): boolean {
    for (const [key, expiresAt] of this.#entries) {
      if (expiresAt < input.now) this.#entries.delete(key);
    }
    const key = `${input.keyId}\u0000${input.nonce}`;
    if (this.#entries.has(key)) return false;
    if (this.#entries.size >= this.#maxEntries) return false;
    this.#entries.set(key, input.expiresAt);
    return true;
  }
}

export class HttpMessageSignatureAuthenticator implements ReplicationHttpAuthenticator {
  readonly #keys: ReplicationDeviceKeyResolver;
  readonly #replayStore: ReplicationSignatureReplayStore;
  readonly #now: () => number;
  readonly #maxLifetime: number;
  readonly #clockSkew: number;

  constructor(options: HttpMessageSignatureAuthenticatorOptions) {
    this.#keys = options.keys;
    this.#replayStore = options.replayStore;
    this.#now = options.now ?? Date.now;
    this.#maxLifetime = configuredLifetime(options.maxSignatureLifetimeSeconds);
    this.#clockSkew = configuredSkew(options.clockSkewSeconds);
  }

  async authenticate(request: Request): Promise<ReplicationHttpAuthentication | Response> {
    try {
      const parsed = parseSignatureInput(request.headers.get("signature-input"));
      const signature = parseSignature(request.headers.get("signature"));
      const expectedDigest = parseContentDigest(request.headers.get("content-digest"));
      const contentType = request.headers.get("content-type");
      if (parsed === undefined || signature === undefined || expectedDigest === undefined || contentType === null) {
        return authFailure();
      }
      const now = Math.floor(this.#now() / 1000);
      if (!timeIsValid(parsed, now, this.#maxLifetime, this.#clockSkew)) return authFailure();
      const credential = await this.#keys.resolve(parsed.keyId);
      if (credential === undefined || credential.status === "revoked" || credential.keyId !== parsed.keyId) {
        return authFailure();
      }
      const base = signatureBase(request, parsed.serialized);
      if (base === undefined) return authFailure();
      const publicKey = await importVerificationKey(credential.publicKeyJwk);
      const signatureBytes = new Uint8Array(signature.byteLength);
      signatureBytes.set(signature);
      const verified = await globalThis.crypto.subtle.verify(
        "Ed25519",
        publicKey,
        signatureBytes,
        new TextEncoder().encode(base),
      );
      if (!verified) return authFailure();
      return {
        principal: normalizeAccessPrincipal(credential.principal),
        verifyBody: async (bytes) => {
          if (!timingSafeEqual(await sha256(bytes), expectedDigest)) return false;
          return this.#replayStore.consume({
            keyId: parsed.keyId,
            nonce: parsed.nonce,
            expiresAt: parsed.expires + this.#clockSkew,
            now,
          });
        },
      };
    } catch {
      return authFailure();
    }
  }
}

export function createHttpMessageSigningFetch(
  options: HttpMessageSigningFetchOptions,
): ReplicationHttpFetch {
  const keyId = assertSafeKeyId(options.keyId);
  const privateKey = signingKey(options.privateKey);
  const fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const nonce = options.nonce ?? randomNonce;
  const lifetime = configuredLifetime(options.lifetimeSeconds);

  return async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== "POST") {
      throw new TypeError("SSRL replication HTTP message signature profile signs POST requests only");
    }
    const contentType = request.headers.get("content-type");
    if (contentType === null) throw new TypeError("signed replication request requires Content-Type");
    const bytes = new Uint8Array(await request.clone().arrayBuffer());
    const digestBytes = await sha256(bytes);
    const headers = new Headers(request.headers);
    headers.set("content-digest", contentDigestValue(digestBytes));
    const created = safeIntegerSeconds(Math.floor(now() / 1000), "signature created");
    const expires = created + lifetime;
    const nonceValue = assertSafeNonce(nonce());
    const inputValue = signatureInputValue({ created, expires, nonce: nonceValue, keyId });
    headers.set("signature-input", inputValue);
    const unsigned = new Request(request.url, { method: request.method, headers });
    const base = signatureBase(unsigned, inputValue.slice(`${SIGNATURE_LABEL}=`.length));
    if (base === undefined) throw new TypeError("signed replication request is missing covered fields");
    const signature = new Uint8Array(await globalThis.crypto.subtle.sign(
      "Ed25519",
      privateKey,
      new TextEncoder().encode(base),
    ));
    headers.set("signature", `${SIGNATURE_LABEL}=:${bytesToBase64(signature)}:`);
    const signed = new Request(request.url, {
      method: request.method,
      headers,
      body: bytes,
      redirect: request.redirect,
      signal: request.signal,
    });
    return fetch(signed);
  };
}
