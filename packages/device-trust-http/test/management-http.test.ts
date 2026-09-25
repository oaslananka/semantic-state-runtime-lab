import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeviceTrustManager,
  createDeviceEnrollmentOffer,
  deviceTrustChallengeJson,
  ed25519JwkThumbprintUri,
  normalizeEd25519PublicJwk,
  signDeviceTrustChallenge,
  signEnrollmentChallengeForOffer,
} from "@ssrl/device-trust";
import { startNodeFetchHttpServer } from "@ssrl/http-wire/node";
import {
  HttpMessageSignatureAuthenticator,
  createHttpMessageSigningFetch,
} from "@ssrl/replication-http";
import { SQLiteDeviceTrustStore } from "@ssrl/storage-sqlite-device-trust";
import {
  DEVICE_TRUST_HTTP_ERROR_SCHEMA,
  DEVICE_TRUST_HTTP_ROUTES,
  DEVICE_TRUST_HTTP_SIGNATURE_TAG,
  DeviceTrustHttpClient,
  DeviceTrustHttpRemoteError,
  InvalidDeviceTrustHttpResponseError,
  createDeviceTrustHttpHandler,
  type DeviceTrustHttpAuthentication,
} from "../src/index.js";

const roots: string[] = [];
const now = Date.parse("2026-09-25T03:00:00Z");
const audience = "ssrl://device-trust/test-registry";
const principal = { subject: "user:alice", scopes: ["replication", "device-trust"] } as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ssrl-trust-http-"));
  roots.push(root);
  return join(root, "device-trust.sqlite");
}

async function keyPair() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKeyJwk = normalizeEd25519PublicJwk(await crypto.subtle.exportKey("jwk", pair.publicKey));
  const keyId = await ed25519JwkThumbprintUri(publicKeyJwk);
  return { ...pair, publicKeyJwk, keyId };
}

async function bootstrapped() {
  const path = await databasePath();
  const store = new SQLiteDeviceTrustStore({ path });
  const manager = new DeviceTrustManager({ repository: store, now: () => now });
  const laptop = await keyPair();
  await manager.bootstrapLocal({
    eventId: "bootstrap-laptop",
    deviceId: "device:laptop",
    displayName: "Alice Laptop",
    principal,
    publicKeyJwk: laptop.publicKeyJwk,
  });
  return { path, store, manager, laptop };
}

class CountingDeviceTrustManager extends DeviceTrustManager {
  activeAuthorizationCalls = 0;

  override async activeAuthorization(keyId: string) {
    this.activeAuthorizationCalls += 1;
    return super.activeAuthorization(keyId);
  }
}

function authenticator(store: SQLiteDeviceTrustStore, tag = DEVICE_TRUST_HTTP_SIGNATURE_TAG) {
  return new HttpMessageSignatureAuthenticator({
    keys: store,
    replayStore: store,
    now: () => now,
    tag,
  });
}

function signedFetch(
  keyId: string,
  privateKey: CryptoKey,
  tag: string = DEVICE_TRUST_HTTP_SIGNATURE_TAG,
) {
  let nonce = 0;
  return createHttpMessageSigningFetch({
    keyId,
    privateKey,
    tag,
    now: () => now,
    nonce: () => `nonce-trust-http-${String(++nonce).padStart(20, "0")}`,
  });
}

async function runningFixture() {
  const fixture = await bootstrapped();
  const handler = createDeviceTrustHttpHandler({
    manager: fixture.manager,
    authenticator: authenticator(fixture.store),
    audience,
    allowedHostnames: ["127.0.0.1"],
  });
  const server = await startNodeFetchHttpServer({ handler });
  const client = new DeviceTrustHttpClient({
    baseUrl: server.baseUrl,
    trustedFetch: signedFetch(fixture.laptop.keyId, fixture.laptop.privateKey),
  });
  return { ...fixture, handler, server, client };
}

async function phoneOffer() {
  const phone = await keyPair();
  const offer = await createDeviceEnrollmentOffer({
    deviceId: "device:phone",
    displayName: "Alice Phone",
    publicKeyJwk: phone.publicKeyJwk,
    audience,
  });
  return { phone, offer };
}

async function enrollPhone(fixture: Awaited<ReturnType<typeof runningFixture>>) {
  const { phone, offer } = await phoneOffer();
  const challenge = await fixture.client.startEnrollment(offer);
  const signature = await signEnrollmentChallengeForOffer(challenge, offer, phone.privateKey);
  const result = await fixture.client.completeEnrollment({
    eventId: "enroll-phone",
    challengeId: challenge.challengeId,
    signature,
  });
  return { phone, offer, challenge, result };
}

async function capturedSignedRequest(input: {
  readonly url: URL;
  readonly keyId: string;
  readonly privateKey: CryptoKey;
  readonly tag?: string;
  readonly body: unknown;
}): Promise<Request> {
  let captured: Request | undefined;
  const sign = createHttpMessageSigningFetch({
    keyId: input.keyId,
    privateKey: input.privateKey,
    tag: input.tag ?? DEVICE_TRUST_HTTP_SIGNATURE_TAG,
    now: () => now,
    nonce: () => "nonce-capture-00000000000001",
    fetch: async (requestInput, init) => {
      captured = new Request(requestInput, init);
      return new Response(null, { status: 204 });
    },
  });
  await sign(input.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input.body),
  });
  if (captured === undefined) throw new Error("expected captured signed request");
  return captured;
}

describe("device trust management HTTP", () => {
  it("enrolls a second device over real loopback HTTP and the new key can authenticate replication", async () => {
    const fixture = await runningFixture();
    const enrolled = await enrollPhone(fixture);

    expect(enrolled.result.outcome).toBe("inserted");
    expect(enrolled.result.device).toEqual(expect.objectContaining({
      deviceId: "device:phone",
      principal: { subject: "user:alice", scopes: ["device-trust", "replication"] },
      status: "active",
    }));
    expect(enrolled.result.key?.keyId).toBe(enrolled.phone.keyId);
    expect(enrolled.challenge.authorizedByDeviceId).toBe("device:laptop");
    expect(enrolled.challenge.authorizedByKeyId).toBe(fixture.laptop.keyId);
    expect(enrolled.challenge.audience).toBe(audience);
    expect(deviceTrustChallengeJson(enrolled.challenge)).not.toContain('"d"');

    const resolved = await fixture.store.resolve(enrolled.phone.keyId);
    expect(resolved).toEqual(expect.objectContaining({
      keyId: enrolled.phone.keyId,
      deviceId: "device:phone",
      principal: { subject: "user:alice", scopes: ["device-trust", "replication"] },
      status: "active",
    }));

    const replicationRequest = await capturedSignedRequest({
      url: new URL("http://replication.test/v1/replication/projection/open"),
      keyId: enrolled.phone.keyId,
      privateKey: enrolled.phone.privateKey,
      tag: "ssrl-replication-v1",
      body: { projectionId: "personal" },
    });
    const replicationAuth = new HttpMessageSignatureAuthenticator({
      keys: fixture.store,
      replayStore: fixture.store,
      now: () => now,
    });
    const accepted = await replicationAuth.authenticate(replicationRequest.clone());
    if (accepted instanceof Response) throw new Error(`expected replication auth, got ${accepted.status}`);
    await expect(accepted.verifyBody!(new TextEncoder().encode(JSON.stringify({ projectionId: "personal" }))))
      .resolves.toBe(true);
    expect(accepted.device).toEqual({ keyId: enrolled.phone.keyId, deviceId: "device:phone" });

    const privateJwk = await crypto.subtle.exportKey("jwk", enrolled.phone.privateKey);
    const rawDb = await readFile(fixture.path);
    expect(rawDb.toString("utf8")).not.toContain(privateJwk.d!);
    await fixture.server.close();
    fixture.store.close();
  });

  it("rejects replication-tag proofs and body-supplied authorizer identity", async () => {
    const fixture = await runningFixture();
    const { offer } = await phoneOffer();
    const url = new URL(DEVICE_TRUST_HTTP_ROUTES.startEnrollment, fixture.server.baseUrl);

    const wrongProfile = signedFetch(
      fixture.laptop.keyId,
      fixture.laptop.privateKey,
      "ssrl-replication-v1",
    );
    const wrongProfileResponse = await wrongProfile(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offer }),
    });
    expect(wrongProfileResponse.status).toBe(401);
    expect(await wrongProfileResponse.json()).toEqual(expect.objectContaining({
      schema: DEVICE_TRUST_HTTP_ERROR_SCHEMA,
      code: "authentication-failed",
    }));

    const correctProfile = signedFetch(fixture.laptop.keyId, fixture.laptop.privateKey);
    const override = await correctProfile(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        offer,
        authorizingKeyId: "attacker-key",
        principal: { subject: "user:mallory", scopes: ["device-trust"] },
      }),
    });
    expect(override.status).toBe(400);
    expect(await override.json()).toEqual(expect.objectContaining({ code: "invalid-request" }));
    await fixture.server.close();
    fixture.store.close();
  });

  it("verifies the signed body before domain work and does not burn the nonce on body tamper", async () => {
    const fixture = await bootstrapped();
    const countingManager = new CountingDeviceTrustManager({
      repository: fixture.store,
      now: () => now,
    });
    const handler = createDeviceTrustHttpHandler({
      manager: countingManager,
      authenticator: authenticator(fixture.store),
      audience,
      allowedHostnames: ["localhost"],
    });
    const { offer } = await phoneOffer();
    const url = new URL(`http://localhost${DEVICE_TRUST_HTTP_ROUTES.startEnrollment}`);
    const signed = await capturedSignedRequest({
      url,
      keyId: fixture.laptop.keyId,
      privateKey: fixture.laptop.privateKey,
      body: { offer },
    });
    const tamperedOffer = { ...offer, displayName: "Tampered Phone" };
    const tampered = new Request(signed.url, {
      method: signed.method,
      headers: signed.headers,
      body: JSON.stringify({ offer: tamperedOffer }),
    });

    const rejected = await handler.fetch(tampered);
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toEqual(expect.objectContaining({ code: "authentication-failed" }));
    expect(countingManager.activeAuthorizationCalls).toBe(0);

    const accepted = await handler.fetch(signed.clone());
    expect(accepted.status).toBe(200);
    expect(countingManager.activeAuthorizationCalls).toBe(1);
    expect(await accepted.json()).toEqual(expect.objectContaining({
      schema: "ssrl-device-trust-http-challenge-v1",
    }));
    fixture.store.close();
  });

  it("uses the same public authentication failure for unknown and revoked management keys", async () => {
    const fixture = await runningFixture();
    const { offer } = await phoneOffer();
    const startUrl = new URL(DEVICE_TRUST_HTTP_ROUTES.startEnrollment, fixture.server.baseUrl);
    const unknown = await keyPair();
    const unknownResponse = await signedFetch(unknown.keyId, unknown.privateKey)(startUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offer }),
    });
    const unknownBody = await unknownResponse.json();
    expect(unknownResponse.status).toBe(401);

    const enrolled = await enrollPhone(fixture);
    await fixture.client.revokeKey("revoke-phone-before-auth-test", enrolled.phone.keyId);
    const next = await keyPair();
    const rotationUrl = new URL(DEVICE_TRUST_HTTP_ROUTES.startRotation, fixture.server.baseUrl);
    const revokedResponse = await signedFetch(enrolled.phone.keyId, enrolled.phone.privateKey)(rotationUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKeyJwk: next.publicKeyJwk }),
    });
    expect(revokedResponse.status).toBe(401);
    expect(await revokedResponse.json()).toEqual(unknownBody);
    expect(unknownBody).toEqual(expect.objectContaining({
      schema: DEVICE_TRUST_HTTP_ERROR_SCHEMA,
      code: "authentication-failed",
    }));
    await fixture.server.close();
    fixture.store.close();
  });

  it("does not consume a challenge on invalid candidate proof and replays a committed completion idempotently", async () => {
    const fixture = await runningFixture();
    const { phone, offer } = await phoneOffer();
    const challenge = await fixture.client.startEnrollment(offer);

    await expect(fixture.client.completeEnrollment({
      eventId: "enroll-phone",
      challengeId: challenge.challengeId,
      signature: new Uint8Array(64),
    })).rejects.toMatchObject({ status: 401, code: "proof-failed" });

    const signature = await signEnrollmentChallengeForOffer(challenge, offer, phone.privateKey);
    const inserted = await fixture.client.completeEnrollment({
      eventId: "enroll-phone",
      challengeId: challenge.challengeId,
      signature,
    });
    expect(inserted.outcome).toBe("inserted");
    const replay = await fixture.client.completeEnrollment({
      eventId: "enroll-phone",
      challengeId: challenge.challengeId,
      signature,
    });
    expect(replay.outcome).toBe("replayed");
    await fixture.server.close();
    fixture.store.close();
  });

  it("rotates the authorizing key over HTTP, rejects the predecessor, and supports signed key/device revocation", async () => {
    const fixture = await runningFixture();
    const enrolled = await enrollPhone(fixture);
    const next = await keyPair();
    const rotation = await fixture.client.startRotation(next.publicKeyJwk);
    const rotationSignature = await signDeviceTrustChallenge(rotation, next.privateKey);
    const rotated = await fixture.client.completeRotation({
      eventId: "rotate-laptop",
      challengeId: rotation.challengeId,
      signature: rotationSignature,
    });
    expect(rotated.outcome).toBe("inserted");
    expect(rotated.key?.predecessorKeyId).toBe(fixture.laptop.keyId);

    await expect(fixture.client.startRotation((await keyPair()).publicKeyJwk))
      .rejects.toMatchObject({ status: 401, code: "authentication-failed" });

    const currentClient = new DeviceTrustHttpClient({
      baseUrl: fixture.server.baseUrl,
      trustedFetch: signedFetch(next.keyId, next.privateKey),
    });
    const keyRevoked = await currentClient.revokeKey("revoke-phone-key", enrolled.phone.keyId);
    expect(keyRevoked.event.type).toBe("revoke-key");
    expect(await fixture.store.resolve(enrolled.phone.keyId)).toBeUndefined();

    const deviceRevoked = await currentClient.revokeDevice("revoke-phone-device", "device:phone");
    expect(deviceRevoked.event.type).toBe("revoke-device");
    expect((await fixture.store.device("device:phone"))?.status).toBe("revoked");
    await fixture.server.close();
    fixture.store.close();
  });

  it("fails closed when verified principal/device metadata disagree with the durable authorizer", async () => {
    const fixture = await bootstrapped();
    const fakeAuthenticator = {
      async authenticate(): Promise<DeviceTrustHttpAuthentication> {
        return {
          principal: { subject: "user:mallory", scopes: ["device-trust"] },
          device: { keyId: fixture.laptop.keyId, deviceId: "device:other" },
          verifyBody: () => true,
        };
      },
    };
    const handler = createDeviceTrustHttpHandler({
      manager: fixture.manager,
      authenticator: fakeAuthenticator,
      audience,
      allowedHostnames: ["localhost"],
    });
    const { offer } = await phoneOffer();
    const response = await handler.fetch(new Request(
      `http://localhost${DEVICE_TRUST_HTTP_ROUTES.startEnrollment}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ offer }),
      },
    ));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(expect.objectContaining({ code: "authentication-failed" }));
    fixture.store.close();
  });

  it("rejects an enrollment offer for another trust-registry audience", async () => {
    const fixture = await runningFixture();
    const phone = await keyPair();
    const wrongAudience = await createDeviceEnrollmentOffer({
      deviceId: "device:wrong-audience",
      displayName: "Wrong Audience",
      publicKeyJwk: phone.publicKeyJwk,
      audience: "ssrl://device-trust/another-registry",
    });

    await expect(fixture.client.startEnrollment(wrongAudience))
      .rejects.toMatchObject({ status: 400, code: "invalid-request" });
    expect(await fixture.store.device("device:wrong-audience")).toBeUndefined();
    await fixture.server.close();
    fixture.store.close();
  });

  it("requires HTTPS for non-loopback management endpoints", () => {
    expect(() => new DeviceTrustHttpClient({
      baseUrl: new URL("http://trust.example"),
      trustedFetch: async () => new Response(null, { status: 500 }),
    })).toThrow(/requires HTTPS outside loopback/);
    expect(() => new DeviceTrustHttpClient({
      baseUrl: new URL("http://127.0.0.1:8080"),
      trustedFetch: async () => new Response(null, { status: 500 }),
    })).not.toThrow();
  });

  it("fails closed on malformed successful challenge and mutation responses", async () => {
    const malformedChallenge = new DeviceTrustHttpClient({
      baseUrl: new URL("https://trust.test"),
      trustedFetch: async () => new Response(JSON.stringify({
        schema: "ssrl-device-trust-http-challenge-v1",
        challenge: { operation: "enroll-device" },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const { offer } = await phoneOffer();
    await expect(malformedChallenge.startEnrollment(offer))
      .rejects.toBeInstanceOf(InvalidDeviceTrustHttpResponseError);

    const malformedMutation = new DeviceTrustHttpClient({
      baseUrl: new URL("https://trust.test"),
      trustedFetch: async () => new Response(null, { status: 500 }),
      candidateFetch: async () => new Response(JSON.stringify({
        schema: "ssrl-device-trust-http-mutation-v1",
        result: {
          outcome: "inserted",
          event: { type: "enroll-device" },
          device: { deviceId: "device:phone" },
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    await expect(malformedMutation.completeEnrollment({
      eventId: "bad-response",
      challengeId: "challenge",
      signature: new Uint8Array(64),
    })).rejects.toBeInstanceOf(InvalidDeviceTrustHttpResponseError);
  });

  it("enforces host, origin, method, media type, body limit and route bounds before domain work", async () => {
    const fixture = await bootstrapped();
    const handler = createDeviceTrustHttpHandler({
      manager: fixture.manager,
      authenticator: authenticator(fixture.store),
      audience,
      allowedHostnames: ["localhost"],
      allowedOriginHostnames: ["trusted.example"],
      maxRequestBytes: 64,
    });
    const route = DEVICE_TRUST_HTTP_ROUTES.completeEnrollment;

    const badHost = await handler.fetch(new Request(`http://evil.example${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }));
    expect(badHost.status).toBe(421);

    const badOrigin = await handler.fetch(new Request(`http://localhost${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    }));
    expect(badOrigin.status).toBe(403);

    const badMethod = await handler.fetch(new Request(`http://localhost${route}`, { method: "GET" }));
    expect(badMethod.status).toBe(405);

    const badMedia = await handler.fetch(new Request(`http://localhost${route}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    }));
    expect(badMedia.status).toBe(415);

    const oversized = await handler.fetch(new Request(`http://localhost${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(100) }),
    }));
    expect(oversized.status).toBe(413);

    const missing = await handler.fetch(new Request("http://localhost/v1/device-trust/nope", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }));
    expect(missing.status).toBe(404);
    fixture.store.close();
  });
});
