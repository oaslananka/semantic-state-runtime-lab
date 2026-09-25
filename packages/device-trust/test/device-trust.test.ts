import { describe, expect, it } from "vitest";
import {
  DeviceTrustProofError,
  ed25519JwkThumbprintUri,
  normalizeEd25519PublicJwk,
  signDeviceTrustChallenge,
  verifyDeviceTrustChallenge,
  type DeviceTrustChallenge,
} from "../src/index.js";

const rfc8037PublicJwk = {
  kty: "OKP",
  crv: "Ed25519",
  x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
} as const;

describe("device trust cryptographic identity", () => {
  it("matches the RFC 8037 Ed25519 JWK thumbprint known answer in RFC 9278 URI form", async () => {
    await expect(ed25519JwkThumbprintUri(rfc8037PublicJwk)).resolves.toBe(
      "urn:ietf:params:oauth:jwk-thumbprint:sha-256:kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k",
    );
  });

  it("strips non-thumbprint JWK metadata and rejects private/malformed keys", () => {
    const withMetadata = {
      ...rfc8037PublicJwk,
      kid: "caller-controlled",
      alg: "EdDSA",
    } as unknown as JsonWebKey;
    expect(normalizeEd25519PublicJwk(withMetadata)).toEqual(rfc8037PublicJwk);
    expect(() => normalizeEd25519PublicJwk({ ...rfc8037PublicJwk, d: "secret" }))
      .toThrow(/public Ed25519/);
    expect(() => normalizeEd25519PublicJwk({ ...rfc8037PublicJwk, x: "short" }))
      .toThrow(/public Ed25519/);
  });

  it("binds proof-of-possession to challenge operation, principal, device, key and audience", async () => {
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicKeyJwk = normalizeEd25519PublicJwk(await crypto.subtle.exportKey("jwk", keys.publicKey));
    const keyId = await ed25519JwkThumbprintUri(publicKeyJwk);
    const challenge: DeviceTrustChallenge = {
      challengeId: "challenge-1",
      challenge: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH",
      operation: "enroll-device",
      principal: { subject: "user:alice", scopes: ["replication"] },
      deviceId: "device:phone",
      displayName: "Alice Phone",
      publicKeyJwk,
      keyId,
      audience: "ssrl://trust-registry/local",
      authorizedByDeviceId: "device:laptop",
      authorizedByKeyId: "existing-key",
      createdAt: "2026-09-25T00:00:00Z",
      expiresAt: "2026-09-25T00:05:00Z",
    };
    const signature = await signDeviceTrustChallenge(challenge, keys.privateKey);

    await expect(verifyDeviceTrustChallenge(challenge, signature)).resolves.toBe(true);
    await expect(verifyDeviceTrustChallenge(
      { ...challenge, audience: "ssrl://other-registry" },
      signature,
    )).resolves.toBe(false);
    await expect(verifyDeviceTrustChallenge(
      { ...challenge, principal: { subject: "user:bob", scopes: ["replication"] } },
      signature,
    )).resolves.toBe(false);
  });
});
