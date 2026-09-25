import { describe, expect, it } from "vitest";
import {
  DeviceTrustChallengeError,
  DeviceTrustProofError,
  createDeviceEnrollmentOffer,
  deviceEnrollmentOfferFingerprint,
  deviceEnrollmentOfferJson,
  ed25519JwkThumbprintUri,
  normalizeEd25519PublicJwk,
  signDeviceRecoveryChallenge,
  signDeviceTrustChallenge,
  signEnrollmentChallengeForOffer,
  signRecoveryProvisioningProof,
  verifyDeviceRecoveryChallengeSignature,
  verifyDeviceTrustChallenge,
  verifyRecoveryProvisioningProof,
  type DeviceRecoveryChallenge,
  type DeviceTrustChallenge,
  type RecoveryProvisioningProof,
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

  it("creates a canonical key-bound enrollment offer and display-only fingerprint", async () => {
    const first = await createDeviceEnrollmentOffer({
      deviceId: "device:phone",
      displayName: "Alice Phone",
      publicKeyJwk: { ...rfc8037PublicJwk, kid: "ignored-metadata" } as unknown as JsonWebKey,
      audience: "https://home.example/v1/device-trust",
    });
    const reordered = {
      audience: first.audience,
      keyId: first.keyId,
      publicKeyJwk: { x: first.publicKeyJwk.x, kty: "OKP", crv: "Ed25519" },
      displayName: first.displayName,
      deviceId: first.deviceId,
      schema: first.schema,
    } as const;

    expect(first.keyId).toBe(
      "urn:ietf:params:oauth:jwk-thumbprint:sha-256:kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k",
    );
    await expect(deviceEnrollmentOfferJson(reordered)).resolves.toBe(
      await deviceEnrollmentOfferJson(first),
    );
    const fingerprint = await deviceEnrollmentOfferFingerprint(first);
    expect(fingerprint).toMatch(/^[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/);
    await expect(deviceEnrollmentOfferFingerprint(reordered)).resolves.toBe(fingerprint);

    const changedName = { ...first, displayName: "Mallory Phone" };
    await expect(deviceEnrollmentOfferFingerprint(changedName)).resolves.not.toBe(fingerprint);
    const changedAudience = { ...first, audience: "https://other.example/v1/device-trust" };
    await expect(deviceEnrollmentOfferFingerprint(changedAudience)).resolves.not.toBe(fingerprint);
  });

  it("signs enrollment only when the returned challenge matches the local offer", async () => {
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicKeyJwk = normalizeEd25519PublicJwk(await crypto.subtle.exportKey("jwk", keys.publicKey));
    const offer = await createDeviceEnrollmentOffer({
      deviceId: "device:phone",
      displayName: "Alice Phone",
      publicKeyJwk,
      audience: "https://home.example/v1/device-trust",
    });
    const challenge: DeviceTrustChallenge = {
      challengeId: "challenge-offer-1",
      challenge: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH",
      operation: "enroll-device",
      principal: { subject: "user:alice", scopes: ["replication"] },
      deviceId: offer.deviceId,
      displayName: offer.displayName,
      publicKeyJwk: offer.publicKeyJwk,
      keyId: offer.keyId,
      audience: offer.audience,
      authorizedByDeviceId: "device:laptop",
      authorizedByKeyId: "existing-key",
      createdAt: "2026-09-25T00:00:00Z",
      expiresAt: "2026-09-25T00:05:00Z",
    };

    const signature = await signEnrollmentChallengeForOffer(challenge, offer, keys.privateKey);
    await expect(verifyDeviceTrustChallenge(challenge, signature)).resolves.toBe(true);
    await expect(signEnrollmentChallengeForOffer(
      { ...challenge, displayName: "Different Device" },
      offer,
      keys.privateKey,
    )).rejects.toBeInstanceOf(DeviceTrustChallengeError);
    await expect(signEnrollmentChallengeForOffer(
      { ...challenge, audience: "https://evil.example/v1/device-trust" },
      offer,
      keys.privateKey,
    )).rejects.toBeInstanceOf(DeviceTrustChallengeError);
  });

  it("binds recovery provisioning PoP to principal, authorizer, generation and audience", async () => {
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicKeyJwk = normalizeEd25519PublicJwk(await crypto.subtle.exportKey("jwk", keys.publicKey));
    const recoveryKeyId = await ed25519JwkThumbprintUri(publicKeyJwk);
    const proof: RecoveryProvisioningProof = {
      schema: "ssrl-recovery-provisioning-proof-v1",
      eventId: "event-recovery-provision",
      principal: { subject: "user:alice", scopes: ["replication"] },
      authorizingDeviceId: "device:laptop",
      authorizingKeyId: "trusted-key",
      recoveryPublicKeyJwk: publicKeyJwk,
      recoveryKeyId,
      recoveryGeneration: 1,
      audience: "ssrl://device-trust/recovery",
    };
    const signature = await signRecoveryProvisioningProof(proof, keys.privateKey);

    await expect(verifyRecoveryProvisioningProof(proof, signature)).resolves.toBe(true);
    await expect(verifyRecoveryProvisioningProof(
      { ...proof, recoveryGeneration: 2 },
      signature,
    )).resolves.toBe(false);
    await expect(verifyRecoveryProvisioningProof(
      { ...proof, audience: "ssrl://other" },
      signature,
    )).resolves.toBe(false);
  });

  it("binds all three recovery signatures to the same replacement device, next recovery key and audience", async () => {
    const current = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const device = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const next = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const currentJwk = normalizeEd25519PublicJwk(await crypto.subtle.exportKey("jwk", current.publicKey));
    const deviceJwk = normalizeEd25519PublicJwk(await crypto.subtle.exportKey("jwk", device.publicKey));
    const nextJwk = normalizeEd25519PublicJwk(await crypto.subtle.exportKey("jwk", next.publicKey));
    const challenge: DeviceRecoveryChallenge = {
      schema: "ssrl-device-recovery-challenge-v1",
      challengeId: "recovery-challenge-1",
      challenge: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH",
      principal: { subject: "user:alice", scopes: ["replication"] },
      recoveryKeyId: await ed25519JwkThumbprintUri(currentJwk),
      recoveryGeneration: 1,
      recoveryPublicKeyJwk: currentJwk,
      deviceId: "device:replacement",
      displayName: "Alice Replacement",
      publicKeyJwk: deviceJwk,
      keyId: await ed25519JwkThumbprintUri(deviceJwk),
      nextRecoveryPublicKeyJwk: nextJwk,
      nextRecoveryKeyId: await ed25519JwkThumbprintUri(nextJwk),
      nextRecoveryGeneration: 2,
      audience: "ssrl://device-trust/recovery",
      createdAt: "2026-09-25T00:00:00Z",
      expiresAt: "2026-09-25T00:05:00Z",
    };
    const currentSignature = await signDeviceRecoveryChallenge(challenge, current.privateKey);
    const deviceSignature = await signDeviceRecoveryChallenge(challenge, device.privateKey);
    const nextSignature = await signDeviceRecoveryChallenge(challenge, next.privateKey);

    await expect(verifyDeviceRecoveryChallengeSignature(
      challenge,
      challenge.recoveryPublicKeyJwk,
      currentSignature,
    )).resolves.toBe(true);
    await expect(verifyDeviceRecoveryChallengeSignature(
      challenge,
      challenge.publicKeyJwk,
      deviceSignature,
    )).resolves.toBe(true);
    await expect(verifyDeviceRecoveryChallengeSignature(
      challenge,
      challenge.nextRecoveryPublicKeyJwk,
      nextSignature,
    )).resolves.toBe(true);

    const otherDevice = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const otherNext = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const otherDeviceJwk = normalizeEd25519PublicJwk(
      await crypto.subtle.exportKey("jwk", otherDevice.publicKey),
    );
    const otherNextJwk = normalizeEd25519PublicJwk(
      await crypto.subtle.exportKey("jwk", otherNext.publicKey),
    );
    for (const changed of [
      { ...challenge, deviceId: "device:mallory" },
      { ...challenge, displayName: "Mallory Device" },
      { ...challenge, audience: "ssrl://other" },
      {
        ...challenge,
        publicKeyJwk: otherDeviceJwk,
        keyId: await ed25519JwkThumbprintUri(otherDeviceJwk),
      },
      {
        ...challenge,
        nextRecoveryPublicKeyJwk: otherNextJwk,
        nextRecoveryKeyId: await ed25519JwkThumbprintUri(otherNextJwk),
      },
    ]) {
      await expect(verifyDeviceRecoveryChallengeSignature(
        changed,
        challenge.recoveryPublicKeyJwk,
        currentSignature,
      )).resolves.toBe(false);
      await expect(verifyDeviceRecoveryChallengeSignature(
        changed,
        challenge.publicKeyJwk,
        deviceSignature,
      )).resolves.toBe(false);
      await expect(verifyDeviceRecoveryChallengeSignature(
        changed,
        challenge.nextRecoveryPublicKeyJwk,
        nextSignature,
      )).resolves.toBe(false);
    }
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
