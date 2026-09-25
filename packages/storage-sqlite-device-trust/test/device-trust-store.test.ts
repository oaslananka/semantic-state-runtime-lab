import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DeviceTrustChallengeError,
  DeviceTrustConflictError,
  DeviceTrustProofError,
  DeviceTrustManager,
  ed25519JwkThumbprintUri,
  normalizeEd25519PublicJwk,
  signDeviceTrustChallenge,
  type DeviceTrustRepository,
} from "@ssrl/device-trust";
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
  return { ...pair, publicKeyJwk, keyId: await ed25519JwkThumbprintUri(publicKeyJwk) };
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
  });
  return { clock, store, trust, laptop, result };
}


type BootstrapFixture = Awaited<ReturnType<typeof bootstrapped>>;
type TestKeyPair = Awaited<ReturnType<typeof keyPair>>;

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
    audience: "ssrl://device-trust/local",
  });
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
    });
    expect(replay.outcome).toBe("replayed");

    await expect(fixture.trust.bootstrapLocal({
      eventId: "event-bootstrap",
      deviceId: "device:laptop",
      displayName: "Renamed Laptop",
      principal,
      publicKeyJwk: fixture.laptop.publicKeyJwk,
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

    const reopened = new SQLiteDeviceTrustStore({ path });
    const reopenedTrust = manager(reopened, fixture.clock);
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
    const reopened = new SQLiteDeviceTrustStore({ path });
    const reopenedTrust = manager(reopened, fixture.clock);
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
