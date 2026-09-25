import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeviceTrustManager,
  ed25519JwkThumbprintUri,
  normalizeEd25519PublicJwk,
  signDeviceTrustChallenge,
} from "@ssrl/device-trust";
import { SQLiteDeviceTrustStore } from "@ssrl/storage-sqlite-device-trust";
import {
  HttpMessageSignatureAuthenticator,
  createHttpMessageSigningFetch,
} from "../src/index.js";

const roots: string[] = [];

async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ssrl-http-trust-"));
  roots.push(root);
  return join(root, "trust.sqlite");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function keyPair() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKeyJwk = normalizeEd25519PublicJwk(await crypto.subtle.exportKey("jwk", pair.publicKey));
  return { ...pair, publicKeyJwk, keyId: await ed25519JwkThumbprintUri(publicKeyJwk) };
}

async function signedRequest(input: {
  readonly keyId: string;
  readonly privateKey: CryptoKey;
  readonly now: number;
  readonly nonce: string;
  readonly body: string;
}): Promise<Request> {
  let captured: Request | undefined;
  const sign = createHttpMessageSigningFetch({
    keyId: input.keyId,
    privateKey: input.privateKey,
    now: () => input.now,
    nonce: () => input.nonce,
    fetch: async (requestInput, init) => {
      captured = new Request(requestInput, init);
      return new Response(null, { status: 204 });
    },
  });
  await sign("http://localhost/v1/replication/open-projection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: input.body,
  });
  if (captured === undefined) throw new Error("expected signed request");
  return captured;
}

function authenticated(value: Awaited<ReturnType<HttpMessageSignatureAuthenticator["authenticate"]>>) {
  if (value instanceof Response) throw new Error(`expected authentication, got ${value.status}`);
  return value;
}

describe("durable trusted-device replication authentication", () => {
  it("authenticates through SQLite trust and does not burn the durable nonce on tampered body", async () => {
    const path = await databasePath();
    const now = Date.parse("2026-09-25T00:00:00Z");
    const store = new SQLiteDeviceTrustStore({ path });
    const keys = await keyPair();
    const trust = new DeviceTrustManager({ repository: store, now: () => now });
    await trust.bootstrapLocal({
      eventId: "bootstrap-http",
      deviceId: "device:laptop",
      displayName: "Laptop",
      principal: { subject: "user:alice", scopes: ["replication"] },
      publicKeyJwk: keys.publicKeyJwk,
    });
    const body = JSON.stringify({ projectionId: "personal" });
    const request = await signedRequest({
      keyId: keys.keyId,
      privateKey: keys.privateKey,
      now,
      nonce: "nonce-durable-000000000001",
      body,
    });
    const authenticator = new HttpMessageSignatureAuthenticator({
      keys: store,
      replayStore: store,
      now: () => now,
    });

    const tampered = authenticated(await authenticator.authenticate(request.clone()));
    await expect(tampered.verifyBody!(new TextEncoder().encode(`${body}x`))).resolves.toBe(false);

    const authentic = authenticated(await authenticator.authenticate(request.clone()));
    await expect(authentic.verifyBody!(new TextEncoder().encode(body))).resolves.toBe(true);
    expect(authentic.principal).toEqual({ subject: "user:alice", scopes: ["replication"] });
    store.close();

    const reopened = new SQLiteDeviceTrustStore({ path });
    const afterRestart = new HttpMessageSignatureAuthenticator({
      keys: reopened,
      replayStore: reopened,
      now: () => now,
    });
    const replay = authenticated(await afterRestart.authenticate(request.clone()));
    await expect(replay.verifyBody!(new TextEncoder().encode(body))).resolves.toBe(false);
    reopened.close();
  });

  it("stops authenticating the predecessor key immediately after durable rotation", async () => {
    const path = await databasePath();
    const clock = { now: Date.parse("2026-09-25T00:00:00Z") };
    const store = new SQLiteDeviceTrustStore({ path });
    const first = await keyPair();
    const trust = new DeviceTrustManager({ repository: store, now: () => clock.now });
    await trust.bootstrapLocal({
      eventId: "bootstrap-rotation-http",
      deviceId: "device:laptop",
      displayName: "Laptop",
      principal: { subject: "user:alice", scopes: ["replication"] },
      publicKeyJwk: first.publicKeyJwk,
    });
    const oldRequest = await signedRequest({
      keyId: first.keyId,
      privateKey: first.privateKey,
      now: clock.now,
      nonce: "nonce-old-key-000000000001",
      body: "{}",
    });

    const next = await keyPair();
    const challenge = await trust.startRotation({
      authorizingKeyId: first.keyId,
      publicKeyJwk: next.publicKeyJwk,
      audience: "ssrl://device-trust/local",
    });
    await trust.completeRotation({
      eventId: "rotate-http-key",
      challengeId: challenge.challengeId,
      signature: await signDeviceTrustChallenge(challenge, next.privateKey),
    });

    const authenticator = new HttpMessageSignatureAuthenticator({
      keys: store,
      replayStore: store,
      now: () => clock.now,
    });
    expect(await authenticator.authenticate(oldRequest)).toBeInstanceOf(Response);

    const newRequest = await signedRequest({
      keyId: next.keyId,
      privateKey: next.privateKey,
      now: clock.now,
      nonce: "nonce-new-key-000000000001",
      body: "{}",
    });
    const accepted = authenticated(await authenticator.authenticate(newRequest.clone()));
    await expect(accepted.verifyBody!(new TextEncoder().encode("{}"))).resolves.toBe(true);
    store.close();
  });
});
