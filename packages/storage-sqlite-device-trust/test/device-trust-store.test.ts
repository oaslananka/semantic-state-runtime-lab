import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DeviceTrustAuthorizationError,
  DeviceTrustChallengeError,
  DeviceTrustConflictError,
  DeviceTrustProofError,
  DeviceTrustManager,
  ed25519JwkThumbprintUri,
  normalizeEd25519PublicJwk,
  signDeviceRecoveryChallenge,
  signDeviceTrustChallenge,
  signEncryptionBindingProof,
  signRecoveryProvisioningProof,
  type DeviceTrustRepository,
} from "@ssrl/device-trust";
import { generateX25519KeyPair } from "@ssrl/e2e";
import { SQLiteDeviceTrustStore } from "../src/index.js";

const roots: string[] = [];
const principal = { subject: "user:alice", scopes: ["replication"] } as const;

async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ssrl-device-trust-"));
  roots.push(root);
  return join(root, "device-trust.sqlite");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function keyPair() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKeyJwk = normalizeEd25519PublicJwk(await crypto.subtle.exportKey("jwk", pair.publicKey));
  const encryption = await generateX25519KeyPair();
  return {
    ...pair,
    publicKeyJwk,
    keyId: await ed25519JwkThumbprintUri(publicKeyJwk),
    encryptionPublicKeyJwk: encryption.publicKeyJwk,
    encryptionPrivateKeyJwk: encryption.privateKeyJwk,
    encryptionKeyId: encryption.keyId,
  };
}

function manager(repository: DeviceTrustRepository, clock: { now: number }) {
  return new DeviceTrustManager({ repository, now: () => clock.now });
}

async function bootstrapped(path: string) {
  const clock = { now: Date.parse("2026-09-25T00:00:00Z") };
  const store = new SQLiteDeviceTrustStore({ path, wal: true });
  const laptop = await keyPair();
  const trust = manager(store, clock);
  const result = await trust.bootstrapLocal({
    eventId: "event-bootstrap",
    deviceId: "device:laptop",
    displayName: "Alice Laptop",
    principal,
    publicKeyJwk: laptop.publicKeyJwk,
    encryptionPublicKeyJwk: laptop.encryptionPublicKeyJwk,
  });
  return { clock, store, trust, laptop, result };
}


type BootstrapFixture = Awaited<ReturnType<typeof bootstrapped>>;
type TestKeyPair = Awaited<ReturnType<typeof keyPair>>;


function reopen(path: string, clock: { now: number }) {
  const store = new SQLiteDeviceTrustStore({ path });
  return { store, trust: manager(store, clock) };
}

async function enrollmentChallenge(
  fixture: BootstrapFixture,
  keys: TestKeyPair,
  deviceId = "device:phone",
  displayName = "Alice Phone",
) {
  return fixture.trust.startEnrollment({
    authorizingKeyId: fixture.laptop.keyId,
    deviceId,
    displayName,
    publicKeyJwk: keys.publicKeyJwk,
    encryptionPublicKeyJwk: keys.encryptionPublicKeyJwk,
    audience: "ssrl://device-trust/local",
  });
}

async function enroll(
  fixture: BootstrapFixture,
  keys: TestKeyPair,
  eventId: string,
  deviceId = "device:phone",
  displayName = "Alice Phone",
) {
  const challenge = await enrollmentChallenge(fixture, keys, deviceId, displayName);
  const signature = await signDeviceTrustChallenge(challenge, keys.privateKey);
  const result = await fixture.trust.completeEnrollment({
    eventId,
    challengeId: challenge.challengeId,
    signature,
  });
  return { challenge, signature, result };
}

async function rotationChallenge(fixture: BootstrapFixture, keys: TestKeyPair) {
  return fixture.trust.startRotation({
    authorizingKeyId: fixture.laptop.keyId,
    publicKeyJwk: keys.publicKeyJwk,
    encryptionPublicKeyJwk: keys.encryptionPublicKeyJwk,
    audience: "ssrl://device-trust/local",
  });
}


async function provisionRecovery(
  fixture: BootstrapFixture,
  recovery: TestKeyPair,
  eventId: string,
  authorizingKeyId = fixture.laptop.keyId,
) {
  const input = {
    eventId,
    authorizingKeyId,
    publicKeyJwk: recovery.publicKeyJwk,
    encryptionPublicKeyJwk: recovery.encryptionPublicKeyJwk,
    audience: "ssrl://device-trust/recovery",
  } as const;
  const proof = await fixture.trust.prepareRecoveryCredential(input);
  const signature = await signRecoveryProvisioningProof(proof, recovery.privateKey);
  const result = await fixture.trust.setRecoveryCredential({ ...input, signature });
  return { input, proof, signature, result };
}

async function recoveryAttempt(
  fixture: BootstrapFixture,
  recovery: TestKeyPair,
  replacement: TestKeyPair,
  nextRecovery: TestKeyPair,
  eventId: string,
  deviceId = "device:replacement",
  displayName = "Alice Replacement",
) {
  const challenge = await fixture.trust.startRecovery({
    recoveryKeyId: recovery.keyId,
    deviceId,
    displayName,
    publicKeyJwk: replacement.publicKeyJwk,
    deviceEncryptionPublicKeyJwk: replacement.encryptionPublicKeyJwk,
    nextRecoveryPublicKeyJwk: nextRecovery.publicKeyJwk,
    nextRecoveryEncryptionPublicKeyJwk: nextRecovery.encryptionPublicKeyJwk,
    audience: "ssrl://device-trust/recovery",
  });
  const recoverySignature = await signDeviceRecoveryChallenge(challenge, recovery.privateKey);
  const deviceSignature = await signDeviceRecoveryChallenge(challenge, replacement.privateKey);
  const nextRecoverySignature = await signDeviceRecoveryChallenge(
    challenge,
    nextRecovery.privateKey,
  );
  const complete = () => fixture.trust.completeRecovery({
    eventId,
    challengeId: challenge.challengeId,
    recoverySignature,
    deviceSignature,
    nextRecoverySignature,
  });
  return {
    challenge,
    recoverySignature,
    deviceSignature,
    nextRecoverySignature,
    complete,
  };
}

async function provisionedRecoveryAttempt(
  fixture: BootstrapFixture,
  provisionEventId: string,
  recoveryEventId: string,
  deviceId = "device:replacement",
  displayName = "Alice Replacement",
) {
  const recovery = await keyPair();
  await provisionRecovery(fixture, recovery, provisionEventId);
  const replacement = await keyPair();
  const nextRecovery = await keyPair();
  const attempt = await recoveryAttempt(
    fixture,
    recovery,
    replacement,
    nextRecovery,
    recoveryEventId,
    deviceId,
    displayName,
  );
  return { recovery, replacement, nextRecovery, attempt };
}

async function expectRecoveryCredentialRejected(
  fixture: BootstrapFixture,
  recoveryKeyId: string,
  deviceId: string,
): Promise<void> {
  const replacement = await keyPair();
  const nextRecovery = await keyPair();
  await expect(fixture.trust.startRecovery({
    recoveryKeyId,
    deviceId,
    displayName: "Rejected Recovery",
    publicKeyJwk: replacement.publicKeyJwk,
    deviceEncryptionPublicKeyJwk: replacement.encryptionPublicKeyJwk,
    nextRecoveryPublicKeyJwk: nextRecovery.publicKeyJwk,
    nextRecoveryEncryptionPublicKeyJwk: nextRecovery.encryptionPublicKeyJwk,
    audience: "ssrl://device-trust/recovery",
  })).rejects.toBeInstanceOf(DeviceTrustAuthorizationError);
}

function downgradeToV2(path: string): void {
  const raw = new DatabaseSync(path);
  raw.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE trusted_encryption_key_bindings;
    DROP INDEX device_trust_events_device_time;
    ALTER TABLE device_trust_events RENAME TO device_trust_events_v3;
    CREATE TABLE device_trust_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL CHECK(event_type IN (
        'bootstrap-device', 'enroll-device', 'rotate-key', 'revoke-key', 'revoke-device',
        'set-recovery-credential', 'recover-trust-set'
      )),
      device_id TEXT NOT NULL,
      key_id TEXT,
      occurred_at TEXT NOT NULL,
      event_json TEXT NOT NULL CHECK(json_valid(event_json))
    ) STRICT;
    INSERT INTO device_trust_events(event_id, event_type, device_id, key_id, occurred_at, event_json)
    SELECT event_id, event_type, device_id, key_id, occurred_at, event_json
    FROM device_trust_events_v3;
    DROP TABLE device_trust_events_v3;
    CREATE INDEX device_trust_events_device_time
      ON device_trust_events(device_id, occurred_at, event_id);
    UPDATE device_trust_meta
    SET schema_version = 2
    WHERE component = 'device-trust';
    PRAGMA foreign_keys = ON;
  `);
  raw.close();
}

function downgradeToV1(path: string): void {
  const raw = new DatabaseSync(path);
  raw.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE device_recovery_challenges;
    DROP TABLE trusted_recovery_credentials;
    DROP TABLE trusted_encryption_key_bindings;
    DROP INDEX device_trust_events_device_time;
    ALTER TABLE device_trust_events RENAME TO device_trust_events_v2;
    CREATE TABLE device_trust_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL CHECK(event_type IN (
        'bootstrap-device', 'enroll-device', 'rotate-key', 'revoke-key', 'revoke-device'
      )),
      device_id TEXT NOT NULL,
      key_id TEXT,
      occurred_at TEXT NOT NULL,
      event_json TEXT NOT NULL CHECK(json_valid(event_json))
    ) STRICT;
    INSERT INTO device_trust_events(event_id, event_type, device_id, key_id, occurred_at, event_json)
    SELECT event_id, event_type, device_id, key_id, occurred_at, event_json
    FROM device_trust_events_v2;
    DROP TABLE device_trust_events_v2;
    CREATE INDEX device_trust_events_device_time
      ON device_trust_events(device_id, occurred_at, event_id);
    UPDATE device_trust_meta
    SET schema_version = 1
    WHERE component = 'device-trust';
    PRAGMA foreign_keys = ON;
  `);
  raw.close();
}

describe("SQLiteDeviceTrustStore", () => {
  it("bootstraps exactly one local device and derives RFC-thumbprint key identity", async () => {
    const path = await databasePath();
    const { store, trust, laptop, result } = await bootstrapped(path);

    expect(result.outcome).toBe("inserted");
    expect(result.key?.keyId).toBe(laptop.keyId);
    await expect(store.resolve(laptop.keyId)).resolves.toEqual(expect.objectContaining({
      keyId: laptop.keyId,
      deviceId: "device:laptop",
      principal,
      status: "active",
    }));

    const second = await keyPair();
    await expect(trust.bootstrapLocal({
      eventId: "event-bootstrap-2",
      deviceId: "device:second",
      displayName: "Second",
      principal,
      publicKeyJwk: second.publicKeyJwk,
      encryptionPublicKeyJwk: second.encryptionPublicKeyJwk,
    })).rejects.toBeInstanceOf(DeviceTrustConflictError);
    store.close();
  });

  it("replays the exact local bootstrap event but rejects the same event id with changed bootstrap input", async () => {
    const path = await databasePath();
    const fixture = await bootstrapped(path);
    fixture.clock.now = Date.parse("2026-09-25T01:00:00Z");

    const replay = await fixture.trust.bootstrapLocal({
      eventId: "event-bootstrap",
      deviceId: "device:laptop",
      displayName: "Alice Laptop",
      principal,
      publicKeyJwk: fixture.laptop.publicKeyJwk,
      encryptionPublicKeyJwk: fixture.laptop.encryptionPublicKeyJwk,
    });
    expect(replay.outcome).toBe("replayed");

    await expect(fixture.trust.bootstrapLocal({
      eventId: "event-bootstrap",
      deviceId: "device:laptop",
      displayName: "Renamed Laptop",
      principal,
      publicKeyJwk: fixture.laptop.publicKeyJwk,
      encryptionPublicKeyJwk: fixture.laptop.encryptionPublicKeyJwk,
    })).rejects.toBeInstanceOf(DeviceTrustConflictError);
    fixture.store.close();
  });

  it("refuses caller-supplied keyId that does not match the public key material", async () => {
    const path = await databasePath();
    const store = new SQLiteDeviceTrustStore({ path });
    const keys = await keyPair();
    const occurredAt = "2026-09-25T00:00:00.000Z";

    await expect(store.bootstrapDevice({
      event: {
        eventId: "bad-bootstrap",
        type: "bootstrap-device",
        occurredAt,
        principal,
        deviceId: "device:laptop",
        keyId: "urn:ietf:params:oauth:jwk-thumbprint:sha-256:not-the-key",
        actor: { mode: "local-bootstrap" },
      },
      device: {
        deviceId: "device:laptop",
        principal,
        displayName: "Laptop",
        enrolledAt: occurredAt,
        status: "active",
      },
      key: {
        keyId: "urn:ietf:params:oauth:jwk-thumbprint:sha-256:not-the-key",
        deviceId: "device:laptop",
        publicKeyJwk: keys.publicKeyJwk,
        activatedAt: occurredAt,
        status: "active",
      },
    })).rejects.toThrow(/does not match RFC 9278/);
    expect(await store.isEmpty()).toBe(true);
    store.close();
  });

  it("persists an enrollment challenge across restart and derives principal from the active authorizer", async () => {
    const path = await databasePath();
    const fixture = await bootstrapped(path);
    const phone = await keyPair();
    const challenge = await enrollmentChallenge(fixture, phone);
    expect(challenge.principal).toEqual(principal);
    fixture.store.close();

    const { store: reopened, trust: reopenedTrust } = reopen(path, fixture.clock);
    expect((await reopened.challenge(challenge.challengeId))?.consumedAt).toBeUndefined();
    const signature = await signDeviceTrustChallenge(challenge, phone.privateKey);
    const enrolled = await reopenedTrust.completeEnrollment({
      eventId: "event-enroll-phone",
      challengeId: challenge.challengeId,
      signature,
    });

    expect(enrolled.outcome).toBe("inserted");
    expect(enrolled.device.principal).toEqual(principal);
    expect(enrolled.key?.deviceId).toBe("device:phone");
    expect((await reopened.challenge(challenge.challengeId))?.consumedAt).toBeDefined();
    expect(await reopened.resolve(phone.keyId)).toEqual(expect.objectContaining({
      principal,
      deviceId: "device:phone",
    }));
    reopened.close();
  });

  it("ignores a client-supplied principal field and derives enrollment principal from the authorizer", async () => {
    const path = await databasePath();
    const fixture = await bootstrapped(path);
    const phone = await keyPair();
    const request = {
      authorizingKeyId: fixture.laptop.keyId,
      deviceId: "device:phone",
      displayName: "Alice Phone",
      publicKeyJwk: phone.publicKeyJwk,
      encryptionPublicKeyJwk: phone.encryptionPublicKeyJwk,
      audience: "ssrl://device-trust/local",
      principal: { subject: "user:bob", scopes: ["replication"] },
    };
    const challenge = await fixture.trust.startEnrollment(
      request as unknown as Parameters<DeviceTrustManager["startEnrollment"]>[0],
    );

    expect(challenge.principal).toEqual(principal);
    expect(challenge.principal.subject).not.toBe("user:bob");
    fixture.store.close();
  });

  it("does not consume a challenge when proof-of-possession verification fails", async () => {
    const path = await databasePath();
    const fixture = await bootstrapped(path);
    const phone = await keyPair();
    const attacker = await keyPair();
    const challenge = await enrollmentChallenge(fixture, phone);

    await expect(fixture.trust.completeEnrollment({
      eventId: "event-enroll-phone",
      challengeId: challenge.challengeId,
      signature: await signDeviceTrustChallenge(challenge, attacker.privateKey),
    })).rejects.toBeInstanceOf(DeviceTrustProofError);
    expect((await fixture.store.challenge(challenge.challengeId))?.consumedAt).toBeUndefined();

    await expect(fixture.trust.completeEnrollment({
      eventId: "event-enroll-phone",
      challengeId: challenge.challengeId,
      signature: await signDeviceTrustChallenge(challenge, phone.privateKey),
    })).resolves.toEqual(expect.objectContaining({ outcome: "inserted" }));
    fixture.store.close();
  });

  it("keeps a consumed challenge single-use but allows exact event retry even after challenge expiry", async () => {
    const path = await databasePath();
    const fixture = await bootstrapped(path);
    const phone = await keyPair();
    const challenge = await enrollmentChallenge(fixture, phone);
    const signature = await signDeviceTrustChallenge(challenge, phone.privateKey);
    const first = await fixture.trust.completeEnrollment({
      eventId: "event-enroll-phone",
      challengeId: challenge.challengeId,
      signature,
    });
    expect(first.outcome).toBe("inserted");

    fixture.clock.now = Date.parse("2026-09-25T01:00:00Z");
    const replay = await fixture.trust.completeEnrollment({
      eventId: "event-enroll-phone",
      challengeId: challenge.challengeId,
      signature,
    });
    expect(replay.outcome).toBe("replayed");

    await expect(fixture.trust.completeEnrollment({
      eventId: "event-enroll-phone-again",
      challengeId: challenge.challengeId,
      signature,
    })).rejects.toBeInstanceOf(DeviceTrustChallengeError);
    fixture.store.close();
  });

  it("rolls back an enrollment when its event id collides with a different completed enrollment", async () => {
    const path = await databasePath();
    const fixture = await bootstrapped(path);
    const phone = await keyPair();
    const firstChallenge = await enrollmentChallenge(fixture, phone);
    await fixture.trust.completeEnrollment({
      eventId: "shared-event-id",
      challengeId: firstChallenge.challengeId,
      signature: await signDeviceTrustChallenge(firstChallenge, phone.privateKey),
    });

    const tablet = await keyPair();
    const secondChallenge = await enrollmentChallenge(fixture, tablet, "device:tablet", "Alice Tablet");
    await expect(fixture.trust.completeEnrollment({
      eventId: "shared-event-id",
      challengeId: secondChallenge.challengeId,
      signature: await signDeviceTrustChallenge(secondChallenge, tablet.privateKey),
    })).rejects.toBeInstanceOf(DeviceTrustConflictError);

    expect(await fixture.store.device("device:tablet")).toBeUndefined();
    expect((await fixture.store.challenge(secondChallenge.challengeId))?.consumedAt).toBeUndefined();
    fixture.store.close();
  });

  it("expires unused challenges durably and pruning cannot make them reusable", async () => {
    const path = await databasePath();
    const fixture = await bootstrapped(path);
    const phone = await keyPair();
    const challenge = await enrollmentChallenge(fixture, phone);
    const signature = await signDeviceTrustChallenge(challenge, phone.privateKey);
    fixture.store.close();

    fixture.clock.now = Date.parse("2026-09-25T00:10:00Z");
    const { store: reopened, trust: reopenedTrust } = reopen(path, fixture.clock);
    await expect(reopenedTrust.completeEnrollment({
      eventId: "expired-enrollment",
      challengeId: challenge.challengeId,
      signature,
    })).rejects.toBeInstanceOf(DeviceTrustChallengeError);
    expect(await reopened.pruneExpired("2026-09-25T00:10:00Z")).toBeGreaterThanOrEqual(1);
    expect(await reopened.challenge(challenge.challengeId)).toBeUndefined();
    reopened.close();
  });

  it("rotates a key atomically and old key stops resolving immediately", async () => {
    const path = await databasePath();
    const fixture = await bootstrapped(path);
    const next = await keyPair();
    const challenge = await rotationChallenge(fixture, next);
    const signature = await signDeviceTrustChallenge(challenge, next.privateKey);
    const rotated = await fixture.trust.completeRotation({
      eventId: "event-rotate-laptop",
      challengeId: challenge.challengeId,
      signature,
    });

    expect(rotated.key).toEqual(expect.objectContaining({
      keyId: next.keyId,
      deviceId: "device:laptop",
      predecessorKeyId: fixture.laptop.keyId,
      status: "active",
    }));
    expect((await fixture.store.key(fixture.laptop.keyId))?.status).toBe("revoked");
    expect(await fixture.store.resolve(fixture.laptop.keyId)).toBeUndefined();
    expect(await fixture.store.resolve(next.keyId)).toBeDefined();
    fixture.store.close();

    const reopened = new SQLiteDeviceTrustStore({ path });
    expect(await reopened.resolve(fixture.laptop.keyId)).toBeUndefined();
    expect(await reopened.resolve(next.keyId)).toBeDefined();
    reopened.close();
  });

  it("keeps historical encryption bindings but changes active recipients across rotation and revocation", async () => {
    const path = await databasePath();
    const fixture = await bootstrapped(path);
    expect(await fixture.store.activeEncryptionRecipients(principal)).toEqual([
      expect.objectContaining({
        subjectKind: "device-signing-key",
        subjectKeyId: fixture.laptop.keyId,
        encryptionKeyId: fixture.laptop.encryptionKeyId,
      }),
    ]);

    const next = await keyPair();
    const challenge = await rotationChallenge(fixture, next);
    await fixture.trust.completeRotation({
      eventId: "rotate-encryption-recipient",
      challengeId: challenge.challengeId,
      signature: await signDeviceTrustChallenge(challenge, next.privateKey),
    });

    expect(await fixture.store.encryptionBinding(fixture.laptop.encryptionKeyId)).toBeDefined();
    expect(await fixture.store.encryptionBinding(next.encryptionKeyId)).toBeDefined();
    expect(await fixture.store.activeEncryptionRecipients(principal)).toEqual([
      expect.objectContaining({
        subjectKeyId: next.keyId,
        encryptionKeyId: next.encryptionKeyId,
      }),
    ]);

    await fixture.trust.revokeDevice({
      eventId: "revoke-encryption-recipient-device",
      authorizingKeyId: next.keyId,
      targetDeviceId: "device:laptop",
    });
    expect(await fixture.store.activeEncryptionRecipients(principal)).toEqual([]);
    expect(await fixture.store.encryptionBinding(next.encryptionKeyId)).toBeDefined();
    fixture.store.close();
  });

  it("revokes a device and every active key remains unusable after restart", async () => {
    const path = await databasePath();
    const fixture = await bootstrapped(path);
    const next = await keyPair();
    const rotation = await rotationChallenge(fixture, next);
    await fixture.trust.completeRotation({
      eventId: "rotate-before-revoke",
      challengeId: rotation.challengeId,
      signature: await signDeviceTrustChallenge(rotation, next.privateKey),
    });
    await fixture.trust.revokeDevice({
      eventId: "revoke-laptop",
      authorizingKeyId: next.keyId,
      targetDeviceId: "device:laptop",
    });

    expect((await fixture.store.device("device:laptop"))?.status).toBe("revoked");
    expect((await fixture.store.key(next.keyId))?.status).toBe("revoked");
    expect(await fixture.store.resolve(next.keyId)).toBeUndefined();
    await expect(fixture.trust.startRotation({
      authorizingKeyId: next.keyId,
      publicKeyJwk: (await keyPair()).publicKeyJwk,
      encryptionPublicKeyJwk: (await keyPair()).encryptionPublicKeyJwk,
      audience: "ssrl://device-trust/local",
    })).rejects.toThrow(/not active/);
    fixture.store.close();

    const reopened = new SQLiteDeviceTrustStore({ path });
    expect(await reopened.resolve(next.keyId)).toBeUndefined();
    reopened.close();
  });

  it("revokes an individual key and never allows the same key material to be rebound", async () => {
    const path = await databasePath();
    const fixture = await bootstrapped(path);
    const phone = await keyPair();
    await enroll(fixture, phone, "enroll-phone-for-key-revoke");
    await fixture.trust.revokeKey({
      eventId: "revoke-phone-key",
      authorizingKeyId: fixture.laptop.keyId,
      targetKeyId: phone.keyId,
    });

    expect(await fixture.store.resolve(phone.keyId)).toBeUndefined();
    expect((await fixture.store.key(phone.keyId))?.status).toBe("revoked");
    await expect(fixture.trust.startEnrollment({
      authorizingKeyId: fixture.laptop.keyId,
      deviceId: "device:replacement-phone",
      displayName: "Replacement Phone",
      publicKeyJwk: phone.publicKeyJwk,
      encryptionPublicKeyJwk: phone.encryptionPublicKeyJwk,
      audience: "ssrl://device-trust/local",
    })).rejects.toBeInstanceOf(DeviceTrustConflictError);
    fixture.store.close();
  });

  it("replays key and device revocation events idempotently after state is already revoked", async () => {
    const firstPath = await databasePath();
    const keyFixture = await bootstrapped(firstPath);
    const phone = await keyPair();
    await enroll(keyFixture, phone, "enroll-phone-for-replay");
    const firstKeyRevoke = await keyFixture.trust.revokeKey({
      eventId: "revoke-phone-key-replay",
      authorizingKeyId: keyFixture.laptop.keyId,
      targetKeyId: phone.keyId,
    });
    const replayedKeyRevoke = await keyFixture.trust.revokeKey({
      eventId: "revoke-phone-key-replay",
      authorizingKeyId: keyFixture.laptop.keyId,
      targetKeyId: phone.keyId,
    });
    expect(firstKeyRevoke.outcome).toBe("inserted");
    expect(replayedKeyRevoke.outcome).toBe("replayed");
    keyFixture.store.close();

    const secondPath = await databasePath();
    const deviceFixture = await bootstrapped(secondPath);
    const firstDeviceRevoke = await deviceFixture.trust.revokeDevice({
      eventId: "revoke-device-replay",
      authorizingKeyId: deviceFixture.laptop.keyId,
      targetDeviceId: "device:laptop",
    });
    const replayedDeviceRevoke = await deviceFixture.trust.revokeDevice({
      eventId: "revoke-device-replay",
      authorizingKeyId: deviceFixture.laptop.keyId,
      targetDeviceId: "device:laptop",
    });
    expect(firstDeviceRevoke.outcome).toBe("inserted");
    expect(replayedDeviceRevoke.outcome).toBe("replayed");
    deviceFixture.store.close();
  });

  it("provisions, replays and rotates recovery credentials with monotonic generations", async () => {
    const path = await databasePath();
    const fixture = await bootstrapped(path);
    const recoveryOne = await keyPair();
    const first = await provisionRecovery(fixture, recoveryOne, "set-recovery-1");

    expect(first.result.outcome).toBe("inserted");
    expect(first.result.credential).toEqual(expect.objectContaining({
      keyId: recoveryOne.keyId,
      generation: 1,
      status: "active",
    }));
    const replay = await fixture.trust.setRecoveryCredential({
      ...first.input,
      signature: first.signature,
    });
    expect(replay.outcome).toBe("replayed");

    const recoveryTwo = await keyPair();
    const second = await provisionRecovery(fixture, recoveryTwo, "set-recovery-2");
    expect(second.result.credential).toEqual(expect.objectContaining({
      keyId: recoveryTwo.keyId,
      generation: 2,
      predecessorKeyId: recoveryOne.keyId,
      status: "active",
    }));
    expect((await fixture.store.recoveryCredential(recoveryOne.keyId))?.status).toBe("retired");
    expect((await fixture.store.recoveryCredential(recoveryTwo.keyId))?.status).toBe("active");
    await expectRecoveryCredentialRejected(
      fixture,
      recoveryOne.keyId,
      "device:replacement-old-recovery",
    );
    fixture.store.close();
  });

  it("rejects invalid recovery provisioning PoP and device/recovery key role reuse", async () => {
    const path = await databasePath();
    const fixture = await bootstrapped(path);
    const recovery = await keyPair();
    const attacker = await keyPair();
    const input = {
      eventId: "set-recovery-invalid",
      authorizingKeyId: fixture.laptop.keyId,
      publicKeyJwk: recovery.publicKeyJwk,
      encryptionPublicKeyJwk: recovery.encryptionPublicKeyJwk,
      audience: "ssrl://device-trust/recovery",
    } as const;
    const proof = await fixture.trust.prepareRecoveryCredential(input);

    await expect(fixture.trust.setRecoveryCredential({
      ...input,
      signature: await signRecoveryProvisioningProof(proof, attacker.privateKey),
    })).rejects.toBeInstanceOf(DeviceTrustProofError);
    expect(await fixture.store.activeRecoveryCredential(principal)).toBeUndefined();

    const reusedInput = {
      eventId: "set-recovery-reused-device-key",
      authorizingKeyId: fixture.laptop.keyId,
      publicKeyJwk: fixture.laptop.publicKeyJwk,
      encryptionPublicKeyJwk: fixture.laptop.encryptionPublicKeyJwk,
      audience: "ssrl://device-trust/recovery",
    } as const;
    const reusedProof = await fixture.trust.prepareRecoveryCredential(reusedInput);
    await expect(fixture.trust.setRecoveryCredential({
      ...reusedInput,
      signature: await signRecoveryProvisioningProof(reusedProof, fixture.laptop.privateKey),
    })).rejects.toBeInstanceOf(DeviceTrustConflictError);
    expect(await fixture.store.activeRecoveryCredential(principal)).toBeUndefined();
    fixture.store.close();
  });

  it("rejects reuse of one X25519 encryption key across device and recovery subjects", async () => {
    const path = await databasePath();
    const fixture = await bootstrapped(path);
    const recovery = await keyPair();
    const input = {
      eventId: "set-recovery-reused-encryption-key",
      authorizingKeyId: fixture.laptop.keyId,
      publicKeyJwk: recovery.publicKeyJwk,
      encryptionPublicKeyJwk: fixture.laptop.encryptionPublicKeyJwk,
      audience: "ssrl://device-trust/recovery",
    } as const;
    const proof = await fixture.trust.prepareRecoveryCredential(input);
    const signature = await signRecoveryProvisioningProof(proof, recovery.privateKey);

    await expect(fixture.trust.setRecoveryCredential({ ...input, signature }))
      .rejects.toBeInstanceOf(DeviceTrustConflictError);
    expect(await fixture.store.activeRecoveryCredential(principal)).toBeUndefined();
    expect(await fixture.store.encryptionBinding(fixture.laptop.encryptionKeyId)).toEqual(
      expect.objectContaining({ subjectKeyId: fixture.laptop.keyId }),
    );
    fixture.store.close();
  });

  it("derives recovery principal from the active recovery credential and rejects key-role reuse", async () => {
    const path = await databasePath();
    const fixture = await bootstrapped(path);
    const recovery = await keyPair();
    await provisionRecovery(fixture, recovery, "set-recovery-derived-principal");
    const replacement = await keyPair();
    const nextRecovery = await keyPair();
    const request = {
      recoveryKeyId: recovery.keyId,
      deviceId: "device:derived-principal",
      displayName: "Derived Principal Device",
      publicKeyJwk: replacement.publicKeyJwk,
      deviceEncryptionPublicKeyJwk: replacement.encryptionPublicKeyJwk,
      nextRecoveryPublicKeyJwk: nextRecovery.publicKeyJwk,
      nextRecoveryEncryptionPublicKeyJwk: nextRecovery.encryptionPublicKeyJwk,
      audience: "ssrl://device-trust/recovery",
      principal: { subject: "user:mallory", scopes: ["replication"] },
    };
    const challenge = await fixture.trust.startRecovery(
      request as unknown as Parameters<DeviceTrustManager["startRecovery"]>[0],
    );
    expect(challenge.principal).toEqual(principal);
    expect(challenge.principal.subject).not.toBe("user:mallory");

    await expect(fixture.trust.startRecovery({
      recoveryKeyId: recovery.keyId,
      deviceId: "device:reused-recovery-key",
      displayName: "Reused Key Device",
      publicKeyJwk: replacement.publicKeyJwk,
      deviceEncryptionPublicKeyJwk: replacement.encryptionPublicKeyJwk,
      nextRecoveryPublicKeyJwk: recovery.publicKeyJwk,
      nextRecoveryEncryptionPublicKeyJwk: recovery.encryptionPublicKeyJwk,
      audience: "ssrl://device-trust/recovery",
    })).rejects.toBeInstanceOf(DeviceTrustConflictError);
    await expect(fixture.trust.startRecovery({
      recoveryKeyId: recovery.keyId,
      deviceId: "device:same-device-next-key",
      displayName: "Same Role Key Device",
      publicKeyJwk: replacement.publicKeyJwk,
      deviceEncryptionPublicKeyJwk: replacement.encryptionPublicKeyJwk,
      nextRecoveryPublicKeyJwk: replacement.publicKeyJwk,
      nextRecoveryEncryptionPublicKeyJwk: replacement.encryptionPublicKeyJwk,
      audience: "ssrl://device-trust/recovery",
    })).rejects.toBeInstanceOf(DeviceTrustConflictError);
    fixture.store.close();
  });

  it("recovers destructively, rotates recovery authority, and safely replays after expiry", async () => {
    const path = await databasePath();
    const fixture = await bootstrapped(path);
    const phone = await keyPair();
    await enroll(fixture, phone, "enroll-phone-before-recovery");
    const { recovery, replacement, nextRecovery, attempt } = await provisionedRecoveryAttempt(
      fixture,
      "set-recovery-before-loss",
      "recover-all-devices",
    );

    const attacker = await keyPair();
    await expect(fixture.trust.completeRecovery({
      eventId: "recover-all-devices",
      challengeId: attempt.challenge.challengeId,
      recoverySignature: attempt.recoverySignature,
      deviceSignature: await signDeviceRecoveryChallenge(attempt.challenge, attacker.privateKey),
      nextRecoverySignature: attempt.nextRecoverySignature,
    })).rejects.toBeInstanceOf(DeviceTrustProofError);
    expect((await fixture.store.recoveryChallenge(attempt.challenge.challengeId))?.consumedAt)
      .toBeUndefined();
    expect(await fixture.store.resolve(fixture.laptop.keyId)).toBeDefined();
    expect(await fixture.store.resolve(phone.keyId)).toBeDefined();

    const recovered = await attempt.complete();
    expect(recovered.outcome).toBe("inserted");
    expect(recovered.device).toEqual(expect.objectContaining({
      deviceId: "device:replacement",
      status: "active",
    }));
    expect(recovered.key.keyId).toBe(replacement.keyId);
    expect(recovered.recoveryCredential).toEqual(expect.objectContaining({
      keyId: nextRecovery.keyId,
      generation: 2,
      predecessorKeyId: recovery.keyId,
      status: "active",
    }));
    expect((await fixture.store.device("device:laptop"))?.status).toBe("revoked");
    expect((await fixture.store.device("device:phone"))?.status).toBe("revoked");
    expect(await fixture.store.resolve(fixture.laptop.keyId)).toBeUndefined();
    expect(await fixture.store.resolve(phone.keyId)).toBeUndefined();
    expect(await fixture.store.resolve(replacement.keyId)).toEqual(expect.objectContaining({
      deviceId: "device:replacement",
    }));
    expect((await fixture.store.recoveryCredential(recovery.keyId))?.status).toBe("retired");
    expect((await fixture.store.recoveryCredential(nextRecovery.keyId))?.status).toBe("active");
    await expectRecoveryCredentialRejected(
      fixture,
      recovery.keyId,
      "device:old-recovery-reuse",
    );

    fixture.clock.now = Date.parse("2026-09-25T01:00:00Z");
    const replay = await attempt.complete();
    expect(replay.outcome).toBe("replayed");
    expect(replay.key.keyId).toBe(replacement.keyId);

    const replacementTwo = await keyPair();
    const recoveryThree = await keyPair();
    const conflict = await recoveryAttempt(
      fixture,
      nextRecovery,
      replacementTwo,
      recoveryThree,
      "recover-all-devices",
      "device:replacement-two",
      "Alice Replacement Two",
    );
    await expect(conflict.complete()).rejects.toBeInstanceOf(DeviceTrustConflictError);
    expect((await fixture.store.recoveryChallenge(conflict.challenge.challengeId))?.consumedAt)
      .toBeUndefined();
    expect(await fixture.store.resolve(replacement.keyId)).toBeDefined();
    fixture.store.close();
  });

  it("persists recovery state across restart and never writes private recovery JWK material", async () => {
    const path = await databasePath();
    const fixture = await bootstrapped(path);
    const { recovery, nextRecovery, attempt } = await provisionedRecoveryAttempt(
      fixture,
      "set-recovery-persist",
      "recover-after-restart",
    );
    const privateRecoveryJwk = await crypto.subtle.exportKey("jwk", recovery.privateKey);
    const privateNextRecoveryJwk = await crypto.subtle.exportKey("jwk", nextRecovery.privateKey);
    fixture.store.close();

    const { store: reopened, trust: reopenedTrust } = reopen(path, fixture.clock);
    expect((await reopened.recoveryChallenge(attempt.challenge.challengeId))?.consumedAt)
      .toBeUndefined();
    const result = await reopenedTrust.completeRecovery({
      eventId: "recover-after-restart",
      challengeId: attempt.challenge.challengeId,
      recoverySignature: attempt.recoverySignature,
      deviceSignature: attempt.deviceSignature,
      nextRecoverySignature: attempt.nextRecoverySignature,
    });
    expect(result.outcome).toBe("inserted");
    reopened.close();

    const bytes = await readFile(path);
    expect(bytes.toString("utf8")).not.toContain(privateRecoveryJwk.d!);
    expect(bytes.toString("utf8")).not.toContain(privateNextRecoveryJwk.d!);
  });

  it("fails closed when durable recovery credential JSON disagrees with indexed columns", async () => {
    const path = await databasePath();
    const fixture = await bootstrapped(path);
    const recovery = await keyPair();
    await provisionRecovery(fixture, recovery, "set-recovery-corrupt");
    fixture.store.close();

    const raw = new DatabaseSync(path);
    raw.prepare(`
      UPDATE trusted_recovery_credentials
      SET record_json = ?
      WHERE key_id = ?
    `).run(JSON.stringify({ keyId: recovery.keyId }), recovery.keyId);
    raw.close();

    const reopened = new SQLiteDeviceTrustStore({ path });
    await expect(reopened.recoveryCredential(recovery.keyId)).rejects.toThrow(/recovery credential/i);
    reopened.close();
  });

  it("fails closed when encryption binding indexed columns disagree with canonical record JSON", async () => {
    const path = await databasePath();
    const fixture = await bootstrapped(path);
    const encryptionKeyId = fixture.laptop.encryptionKeyId;
    fixture.store.close();

    const raw = new DatabaseSync(path);
    raw.prepare(`
      UPDATE trusted_encryption_key_bindings
      SET subject_key_id = ?
      WHERE encryption_key_id = ?
    `).run("corrupt-subject-key", encryptionKeyId);
    raw.close();

    const reopened = new SQLiteDeviceTrustStore({ path });
    await expect(reopened.encryptionBinding(encryptionKeyId)).rejects
      .toThrow(/encryption binding/i);
    reopened.close();
  });

  it("migrates v2 with zero synthetic bindings and lets a legacy active device bind exactly one X25519 key", async () => {
    const path = await databasePath();
    const fixture = await bootstrapped(path);
    fixture.store.close();
    downgradeToV2(path);

    const migrated = new SQLiteDeviceTrustStore({ path });
    const trust = manager(migrated, fixture.clock);
    expect(await migrated.activeEncryptionRecipients(principal)).toEqual([]);
    expect(await migrated.encryptionBindingForSubject(
      "device-signing-key",
      fixture.laptop.keyId,
    )).toBeUndefined();

    const encryption = await generateX25519KeyPair();
    const input = {
      eventId: "bind-legacy-laptop-encryption",
      authorizingKeyId: fixture.laptop.keyId,
      subjectKind: "device-signing-key",
      subjectKeyId: fixture.laptop.keyId,
      encryptionPublicKeyJwk: encryption.publicKeyJwk,
      audience: "ssrl://device-trust/encryption-binding",
    } as const;
    const proof = await trust.prepareEncryptionBinding(input);
    const subjectSignature = await signEncryptionBindingProof(proof, fixture.laptop.privateKey);
    const inserted = await trust.bindEncryptionKey({ ...input, subjectSignature });

    expect(inserted.outcome).toBe("inserted");
    expect(inserted.binding).toEqual(expect.objectContaining({
      subjectKind: "device-signing-key",
      subjectKeyId: fixture.laptop.keyId,
      encryptionKeyId: encryption.keyId,
      deviceId: "device:laptop",
    }));
    expect(await migrated.activeEncryptionRecipients(principal)).toEqual([
      expect.objectContaining({ encryptionKeyId: encryption.keyId }),
    ]);

    const replay = await trust.bindEncryptionKey({ ...input, subjectSignature });
    expect(replay.outcome).toBe("replayed");
    const otherEncryption = await generateX25519KeyPair();
    await expect(trust.prepareEncryptionBinding({
      ...input,
      eventId: "bind-legacy-laptop-encryption-2",
      encryptionPublicKeyJwk: otherEncryption.publicKeyJwk,
    })).rejects.toBeInstanceOf(DeviceTrustConflictError);
    migrated.close();

    const reopened = new SQLiteDeviceTrustStore({ path });
    expect(await reopened.encryptionBinding(encryption.keyId)).toEqual(inserted.binding);
    expect(await reopened.activeEncryptionRecipients(principal)).toHaveLength(1);
    const raw = await readFile(path);
    expect(raw.toString("utf8")).not.toContain(encryption.privateKeyJwk.d!);
    reopened.close();
  });

  it("binds a migrated recovery credential by recovery-key proof and drops eligibility when retired", async () => {
    const path = await databasePath();
    const fixture = await bootstrapped(path);
    const recovery = await keyPair();
    await provisionRecovery(fixture, recovery, "set-recovery-before-v2-migration");
    fixture.store.close();
    downgradeToV2(path);

    const migrated = new SQLiteDeviceTrustStore({ path });
    const trust = manager(migrated, fixture.clock);
    expect(await migrated.activeEncryptionRecipients(principal)).toEqual([]);
    const encryption = await generateX25519KeyPair();
    const input = {
      eventId: "bind-legacy-recovery-encryption",
      authorizingKeyId: fixture.laptop.keyId,
      subjectKind: "recovery-credential",
      subjectKeyId: recovery.keyId,
      encryptionPublicKeyJwk: encryption.publicKeyJwk,
      audience: "ssrl://device-trust/encryption-binding",
    } as const;
    const proof = await trust.prepareEncryptionBinding(input);
    const subjectSignature = await signEncryptionBindingProof(proof, recovery.privateKey);
    await trust.bindEncryptionKey({ ...input, subjectSignature });
    expect(await migrated.activeEncryptionRecipients(principal)).toEqual([
      expect.objectContaining({
        subjectKind: "recovery-credential",
        subjectKeyId: recovery.keyId,
        recoveryGeneration: 1,
      }),
    ]);

    const nextRecovery = await keyPair();
    await provisionRecovery(
      { ...fixture, store: migrated, trust },
      nextRecovery,
      "set-recovery-after-legacy-binding",
    );
    const active = await migrated.activeEncryptionRecipients(principal);
    expect(active.some((recipient) => recipient.subjectKeyId === recovery.keyId)).toBe(false);
    expect(active.some((recipient) => recipient.subjectKeyId === nextRecovery.keyId)).toBe(true);
    expect(await migrated.encryptionBinding(encryption.keyId)).toBeDefined();
    migrated.close();
  });

  it("migrates a v1 registry without losing device, challenge or replay state", async () => {
    const path = await databasePath();
    const fixture = await bootstrapped(path);
    const phone = await keyPair();
    const challenge = await enrollmentChallenge(fixture, phone);
    const replay = {
      keyId: fixture.laptop.keyId,
      nonce: "nonce_migration_1234567890",
      now: 1_000,
      expiresAt: 2_000,
    };
    expect(fixture.store.consume(replay)).toBe(true);
    fixture.store.close();
    downgradeToV1(path);

    const migrated = new SQLiteDeviceTrustStore({ path });
    expect(await migrated.resolve(fixture.laptop.keyId)).toBeDefined();
    expect((await migrated.challenge(challenge.challengeId))?.challenge.challengeId)
      .toBe(challenge.challengeId);
    expect(migrated.consume({ ...replay, now: 1_100 })).toBe(false);
    expect(await migrated.activeRecoveryCredential(principal)).toBeUndefined();
    migrated.close();

    const raw = new DatabaseSync(path);
    expect(raw.prepare(`
      SELECT schema_version FROM device_trust_meta WHERE component = 'device-trust'
    `).get()).toEqual(expect.objectContaining({ schema_version: 3 }));
    raw.close();
  });

  it("expires and prunes unused recovery challenges but preserves committed replayability", async () => {
    const path = await databasePath();
    const fixture = await bootstrapped(path);
    const { attempt } = await provisionedRecoveryAttempt(
      fixture,
      "set-recovery-expiry",
      "expired-recovery",
      "device:expired-replacement",
      "Expired Replacement",
    );
    fixture.clock.now = Date.parse("2026-09-25T00:10:00Z");

    await expect(attempt.complete()).rejects.toBeInstanceOf(DeviceTrustChallengeError);
    expect((await fixture.store.recoveryChallenge(attempt.challenge.challengeId))?.consumedAt)
      .toBeUndefined();
    expect(await fixture.store.pruneExpired("2026-09-25T00:10:00Z")).toBeGreaterThanOrEqual(1);
    expect(await fixture.store.recoveryChallenge(attempt.challenge.challengeId)).toBeUndefined();
    fixture.store.close();
  });

  it("persists replay nonces across restart and prunes only after their accepted lifetime", async () => {
    const path = await databasePath();
    const fixture = await bootstrapped(path);
    const replay = {
      keyId: fixture.laptop.keyId,
      nonce: "nonce_1234567890123456",
      now: 1_000,
      expiresAt: 1_060,
    };
    expect(fixture.store.consume(replay)).toBe(true);
    expect(fixture.store.consume(replay)).toBe(false);
    fixture.store.close();

    const reopened = new SQLiteDeviceTrustStore({ path });
    expect(reopened.consume({ ...replay, now: 1_030 })).toBe(false);
    expect(await reopened.pruneExpired(new Date(1_030_000).toISOString())).toBe(0);
    expect(reopened.consume({ ...replay, now: 1_030 })).toBe(false);
    expect(await reopened.pruneExpired(new Date(1_061_000).toISOString())).toBeGreaterThanOrEqual(1);
    expect(reopened.consume({ ...replay, now: 1_061 })).toBe(false);
    reopened.close();
  });

  it("never persists private JWK material", async () => {
    const path = await databasePath();
    const fixture = await bootstrapped(path);
    const privateJwk = await crypto.subtle.exportKey("jwk", fixture.laptop.privateKey);
    expect(privateJwk.d).toBeDefined();
    fixture.store.close();

    const bytes = await readFile(path);
    expect(bytes.toString("utf8")).not.toContain(privateJwk.d!);
  });

  it("fails closed on a newer schema", async () => {
    const path = await databasePath();
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE device_trust_meta (
        component TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL
      ) STRICT;
      INSERT INTO device_trust_meta(component, schema_version) VALUES ('device-trust', 99);
    `);
    raw.close();
    expect(() => new SQLiteDeviceTrustStore({ path })).toThrow(/newer than supported/);
  });
});
