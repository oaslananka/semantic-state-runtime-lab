import { describe, expect, it } from "vitest";
import {
  E2E_EPOCH_KEY_GRANT_SCHEMA,
  E2E_PAYLOAD_ENVELOPE_SCHEMA,
  E2E_SUITE_V1,
  MAX_E2E_PAYLOAD_BYTES,
  E2ECryptoError,
  E2EValidationError,
  createEpochKeyGrant,
  decryptPayload,
  encryptedPayloadEnvelopeJson,
  encryptPayload,
  epochKeyGrantJson,
  generateVaultEpoch,
  generateX25519KeyPair,
  normalizeEncryptedPayloadEnvelope,
  normalizeEpochKeyGrant,
  normalizeX25519PublicJwk,
  openEpochKeyGrant,
  parseEncryptedPayloadEnvelopeJson,
  parseEpochKeyGrantJson,
  vaultEpochSecret,
  x25519JwkThumbprintUri,
  x25519PublicJwkJson,
  type EncryptedPayloadEnvelope,
  type HpkeEpochKeyGrant,
  type X25519PublicJwk,
} from "../src/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function flippedBase64Url(value: string): string {
  const first = value[0];
  if (first === undefined) throw new Error("expected non-empty base64url");
  const replacement = first === "A" ? "B" : "A";
  return replacement + value.slice(1);
}

function withEnvelope(
  envelope: EncryptedPayloadEnvelope,
  patch: Partial<EncryptedPayloadEnvelope>,
): EncryptedPayloadEnvelope {
  return { ...envelope, ...patch };
}

function withGrant(
  grant: HpkeEpochKeyGrant,
  patch: Partial<HpkeEpochKeyGrant>,
): HpkeEpochKeyGrant {
  return { ...grant, ...patch };
}

describe("E2E vault envelope", () => {
  it("generates strict X25519 public identity without leaking private JWK material", async () => {
    const pair = await generateX25519KeyPair();
    const publicJson = x25519PublicJwkJson(pair.publicKeyJwk);

    expect(pair.publicKeyJwk).toEqual({
      kty: "OKP",
      crv: "X25519",
      x: expect.any(String),
    });
    expect(pair.privateKeyJwk.d).toEqual(expect.any(String));
    expect(publicJson).not.toContain('"d"');
    expect(JSON.parse(publicJson)).toEqual(pair.publicKeyJwk);
    expect(pair.keyId).toBe(await x25519JwkThumbprintUri(pair.publicKeyJwk));
  });

  it("rejects Ed25519, P-256, private and extra-field JWKs at the public protocol boundary", async () => {
    const pair = await generateX25519KeyPair();
    expect(() => normalizeX25519PublicJwk(pair.privateKeyJwk)).toThrow(E2EValidationError);
    expect(() => normalizeX25519PublicJwk({
      kty: "OKP",
      crv: "Ed25519",
      x: pair.publicKeyJwk.x,
    })).toThrow(/X25519/);
    expect(() => normalizeX25519PublicJwk({
      kty: "EC",
      crv: "P-256",
      x: pair.publicKeyJwk.x,
    })).toThrow(/X25519/);
    expect(() => normalizeX25519PublicJwk({
      ...pair.publicKeyJwk,
      ext: true,
    })).toThrow(/unexpected or missing fields/);
  });

  it("generates a 32-byte vault epoch secret and rejects other lengths", () => {
    const epoch = generateVaultEpoch();
    expect(epoch.secret).toHaveLength(32);
    expect(epoch.epochId).toMatch(/^urn:ssrl:vault-epoch:[A-Za-z0-9_-]{22}$/);
    expect(() => vaultEpochSecret(new Uint8Array(31))).toThrow(/exactly 32 bytes/);
    expect(() => vaultEpochSecret(new Uint8Array(33))).toThrow(/exactly 32 bytes/);
  });

  it("round-trips canonical semantic JSON bytes exactly", async () => {
    const epoch = generateVaultEpoch();
    const plaintext = encoder.encode('{"entityId":"entity://project/atlas","value":"GraphQL"}');
    const envelope = await encryptPayload({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      objectKind: "replication-record",
      objectId: '["semantic-observation","obs:atlas-api"]',
      plaintext,
    });

    const decrypted = await decryptPayload(envelope, epoch.secret);
    expect(decoder.decode(decrypted)).toBe(decoder.decode(plaintext));
    expect(envelope.plaintextBytes).toBe(plaintext.byteLength);
  });

  it("round-trips arbitrary binary artifact bytes exactly", async () => {
    const epoch = generateVaultEpoch();
    const plaintext = new Uint8Array([0, 255, 19, 44, 128, 7, 1, 0, 222]);
    const envelope = await encryptPayload({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      objectKind: "artifact-blob",
      objectId: "sha256:artifact-fixture",
      plaintext,
    });

    expect(await decryptPayload(envelope, epoch.secret)).toEqual(plaintext);
  });

  it("binds ciphertext to nonce and all authenticated object metadata", async () => {
    const epoch = generateVaultEpoch();
    const envelope = await encryptPayload({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      objectKind: "replication-record",
      objectId: "record:1",
      plaintext: encoder.encode("private personal state"),
    });
    const anotherEpoch = generateVaultEpoch();

    const tampered = [
      withEnvelope(envelope, { ciphertext: flippedBase64Url(envelope.ciphertext) }),
      withEnvelope(envelope, { nonce: flippedBase64Url(envelope.nonce) }),
      withEnvelope(envelope, { epochId: anotherEpoch.epochId }),
      withEnvelope(envelope, { objectKind: "artifact-blob" }),
      withEnvelope(envelope, { objectId: "record:2" }),
    ];
    for (const candidate of tampered) {
      await expect(decryptPayload(candidate, epoch.secret)).rejects.toBeInstanceOf(E2ECryptoError);
    }
  });

  it("fails closed when the wrong epoch secret is used", async () => {
    const epoch = generateVaultEpoch();
    const wrongEpoch = generateVaultEpoch();
    const envelope = await encryptPayload({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      objectKind: "replication-record",
      objectId: "record:wrong-secret",
      plaintext: encoder.encode("private state"),
    });

    await expect(decryptPayload(envelope, wrongEpoch.secret))
      .rejects.toBeInstanceOf(E2ECryptoError);
  });

  it("uses randomized immutable envelopes for the same plaintext", async () => {
    const epoch = generateVaultEpoch();
    const input = {
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      objectKind: "replication-record" as const,
      objectId: "record:stable",
      plaintext: encoder.encode("same plaintext"),
    };
    const first = await encryptPayload(input);
    const second = await encryptPayload(input);

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(await decryptPayload(first, epoch.secret)).toEqual(input.plaintext);
    expect(await decryptPayload(second, epoch.secret)).toEqual(input.plaintext);
  });

  it("does not expose plaintext content or plaintext digest in the public envelope", async () => {
    const epoch = generateVaultEpoch();
    const secretText = "very-low-entropy-personal-secret";
    const envelope = await encryptPayload({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      objectKind: "replication-record",
      objectId: "record:no-digest",
      plaintext: encoder.encode(secretText),
    });
    const encoded = encryptedPayloadEnvelopeJson(envelope);

    expect(encoded).not.toContain(secretText);
    expect(encoded).not.toContain("payloadDigest");
    expect(encoded).not.toContain("plaintextDigest");
    expect(Object.keys(JSON.parse(encoded))).toEqual([
      "ciphertext",
      "epochId",
      "nonce",
      "objectId",
      "objectKind",
      "plaintextBytes",
      "schema",
      "suite",
    ]);
  });

  it("strictly validates envelope schema, extra fields, sizes and suite", async () => {
    const epoch = generateVaultEpoch();
    const envelope = await encryptPayload({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      objectKind: "artifact-blob",
      objectId: "blob:1",
      plaintext: new Uint8Array([1, 2, 3]),
    });

    expect(parseEncryptedPayloadEnvelopeJson(encryptedPayloadEnvelopeJson(envelope))).toEqual(envelope);
    expect(() => normalizeEncryptedPayloadEnvelope({ ...envelope, extra: true }))
      .toThrow(/unexpected or missing fields/);
    expect(() => normalizeEncryptedPayloadEnvelope({ ...envelope, suite: "wrong" }))
      .toThrow(/unsupported E2E suite/);
    expect(() => normalizeEncryptedPayloadEnvelope({ ...envelope, ciphertext: envelope.ciphertext.slice(1) }))
      .toThrow(E2EValidationError);
    expect(MAX_E2E_PAYLOAD_BYTES).toBe(64 * 1024 * 1024);
  });
});

describe("HPKE epoch-key grants", () => {
  it("wraps the same epoch secret independently for device and recovery encryption keys", async () => {
    const epoch = generateVaultEpoch();
    const device = await generateX25519KeyPair();
    const recovery = await generateX25519KeyPair();
    const deviceGrant = await createEpochKeyGrant({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      recipientPublicKeyJwk: device.publicKeyJwk,
    });
    const recoveryGrant = await createEpochKeyGrant({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      recipientPublicKeyJwk: recovery.publicKeyJwk,
    });

    expect(await openEpochKeyGrant(deviceGrant, device.privateKeyJwk)).toEqual(epoch.secret);
    expect(await openEpochKeyGrant(recoveryGrant, recovery.privateKeyJwk)).toEqual(epoch.secret);
    expect(deviceGrant.recipientKeyId).toBe(device.keyId);
    expect(recoveryGrant.recipientKeyId).toBe(recovery.keyId);
    expect(deviceGrant.encapsulatedKey).not.toBe(recoveryGrant.encapsulatedKey);
  });

  it("fails closed for the wrong recipient private key", async () => {
    const epoch = generateVaultEpoch();
    const recipient = await generateX25519KeyPair();
    const wrong = await generateX25519KeyPair();
    const grant = await createEpochKeyGrant({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      recipientPublicKeyJwk: recipient.publicKeyJwk,
    });

    await expect(openEpochKeyGrant(grant, wrong.privateKeyJwk))
      .rejects.toBeInstanceOf(E2ECryptoError);
  });

  it("authenticates grant metadata, encapsulated key and ciphertext", async () => {
    const epoch = generateVaultEpoch();
    const recipient = await generateX25519KeyPair();
    const grant = await createEpochKeyGrant({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      recipientPublicKeyJwk: recipient.publicKeyJwk,
    });
    const anotherEpoch = generateVaultEpoch();
    const anotherRecipient = await generateX25519KeyPair();

    const candidates = [
      withGrant(grant, { epochId: anotherEpoch.epochId }),
      withGrant(grant, { recipientKeyId: anotherRecipient.keyId }),
      withGrant(grant, { encapsulatedKey: flippedBase64Url(grant.encapsulatedKey) }),
      withGrant(grant, { ciphertext: flippedBase64Url(grant.ciphertext) }),
    ];
    for (const candidate of candidates) {
      await expect(openEpochKeyGrant(candidate, recipient.privateKeyJwk))
        .rejects.toBeInstanceOf(E2ECryptoError);
    }
  });

  it("strictly validates grants and never serializes private keys or plaintext epoch secrets", async () => {
    const epoch = generateVaultEpoch();
    const recipient = await generateX25519KeyPair();
    const grant = await createEpochKeyGrant({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      recipientPublicKeyJwk: recipient.publicKeyJwk,
    });
    const encoded = epochKeyGrantJson(grant);

    expect(parseEpochKeyGrantJson(encoded)).toEqual(grant);
    expect(encoded).not.toContain('"d"');
    expect(encoded).not.toContain(Buffer.from(epoch.secret).toString("base64url"));
    expect(Object.keys(JSON.parse(encoded))).toEqual([
      "ciphertext",
      "encapsulatedKey",
      "epochId",
      "recipientKeyId",
      "schema",
      "suite",
    ]);
    expect(grant.schema).toBe(E2E_EPOCH_KEY_GRANT_SCHEMA);
    expect(grant.suite).toBe(E2E_SUITE_V1);
    expect(() => normalizeEpochKeyGrant({ ...grant, extra: true }))
      .toThrow(/unexpected or missing fields/);
    expect(() => normalizeEpochKeyGrant({ ...grant, schema: "wrong" }))
      .toThrow(/unsupported epoch key grant schema/);
    expect(() => parseEpochKeyGrantJson("x".repeat(5_000))).toThrow(/size limit/);
  });

  it("does not accept a private JWK where a public recipient key is required", async () => {
    const epoch = generateVaultEpoch();
    const recipient = await generateX25519KeyPair();
    await expect(createEpochKeyGrant({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      recipientPublicKeyJwk: recipient.privateKeyJwk as unknown as X25519PublicJwk,
    })).rejects.toBeInstanceOf(E2EValidationError);
  });
});
