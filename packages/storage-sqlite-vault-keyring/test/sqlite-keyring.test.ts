import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AccessPrincipal } from "@ssrl/access";
import {
  encryptionKeyIdentity,
  normalizeEd25519PublicJwk,
  normalizeTrustedEncryptionKeyBinding,
  ed25519JwkThumbprintUri,
  type ActiveDeviceAuthorization,
  type TrustedDevice,
  type TrustedDeviceKey,
  type TrustedEncryptionKeyBinding,
} from "@ssrl/device-trust";
import {
  base64UrlEncode,
  bytesCopy,
  decryptPayload,
  encryptPayload,
  epochKeyGrantJson,
  generateX25519KeyPair,
  openEpochKeyGrant,
} from "@ssrl/e2e";
import {
  InMemoryVaultKeyringRepository,
  VaultKeyringConflictError,
  VAULT_KEYRING_EVENT_SCHEMA,
  VaultKeyringManager,
  vaultKeyringTransitionBytes,
  type AuthorizedVaultKeyringEvent,
  type VaultKeyringRepository,
} from "@ssrl/vault-keyring";
import {
  CorruptVaultKeyringDatabaseError,
  SharedVaultKeyringDatabaseNotSupportedError,
  SQLiteVaultKeyringRepository,
  UnsupportedVaultKeyringSchemaError,
} from "../src/index.js";

const principal: AccessPrincipal = { subject: "user:alice", scopes: ["vault:owner"] };
const audience = "urn:ssrl:vault-keyring:sqlite-test";
const nowMs = Date.parse("2026-09-25T12:00:00Z");
const roots: string[] = [];

async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ssrl-vault-keyring-"));
  roots.push(root);
  return join(root, "vault-keyring.sqlite");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function activeDevice(deviceId: string): TrustedDevice {
  return {
    deviceId,
    principal,
    displayName: `SQLite ${deviceId}`,
    enrolledAt: "2026-09-01T00:00:00.000Z",
    status: "active",
  };
}

function activeSigningKey(
  deviceId: string,
  keyId: string,
  publicKeyJwk: TrustedDeviceKey["publicKeyJwk"],
): TrustedDeviceKey {
  return {
    deviceId,
    keyId,
    publicKeyJwk,
    status: "active",
    activatedAt: "2026-09-01T00:00:00.000Z",
  };
}

async function signingIdentity(deviceId = "device-laptop") {
  const pair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const publicKeyJwk = normalizeEd25519PublicJwk(
    await crypto.subtle.exportKey("jwk", pair.publicKey),
  );
  const keyId = await ed25519JwkThumbprintUri(publicKeyJwk);
  return {
    device: activeDevice(deviceId),
    key: activeSigningKey(deviceId, keyId, publicKeyJwk),
    privateKey: pair.privateKey,
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
}

async function recipient(
  subjectKeyId: string,
  deviceId: string,
  pair: Awaited<ReturnType<typeof generateX25519KeyPair>>,
): Promise<TrustedEncryptionKeyBinding> {
  const identity = await encryptionKeyIdentity(pair.publicKeyJwk);
  return normalizeTrustedEncryptionKeyBinding({
    subjectKind: "device-signing-key",
    subjectKeyId,
    deviceId,
    principal,
    encryptionKeyId: identity.encryptionKeyId,
    publicKeyJwk: identity.publicKeyJwk,
    boundAt: "2026-09-01T00:00:00Z",
  });
}

function mutableTrust(
  authorization: ActiveDeviceAuthorization,
  initialRecipients: TrustedEncryptionKeyBinding[],
) {
  const state = { recipients: initialRecipients };
  return {
    get recipients() {
      return state.recipients;
    },
    set recipients(value: TrustedEncryptionKeyBinding[]) {
      state.recipients = value;
    },
    manager: {
      activeAuthorization: async (keyId: string) => {
        if (keyId !== authorization.key.keyId) throw new Error("inactive authorizer");
        return authorization;
      },
    },
    repository: {
      activeEncryptionRecipients: async (_principal: AccessPrincipal) => state.recipients,
    },
  };
}

function keyringManager(
  repository: VaultKeyringRepository,
  trust: ReturnType<typeof mutableTrust>,
): VaultKeyringManager {
  return new VaultKeyringManager({
    repository,
    deviceTrustManager: trust.manager,
    deviceTrustRepository: trust.repository,
    now: () => nowMs,
  });
}

async function fixture(repository: VaultKeyringRepository) {
  const authorizer = await signingIdentity();
  const deviceX = await generateX25519KeyPair();
  const trustedRecipient = await recipient(
    authorizer.key.keyId,
    authorizer.device.deviceId,
    deviceX,
  );
  const trust = mutableTrust(
    { device: authorizer.device, key: authorizer.key },
    [trustedRecipient],
  );
  const manager = keyringManager(repository, trust);
  return { authorizer, deviceX, trust, manager };
}

async function bootstrap(
  repository: VaultKeyringRepository,
  eventId = "sqlite-bootstrap",
) {
  const f = await fixture(repository);
  const result = await f.manager.bootstrapEpoch({
    eventId,
    authorizingKeyId: f.authorizer.key.keyId,
    authorizingPrivateKey: f.authorizer.privateKey,
    audience,
  });
  return { ...f, result };
}

type SQLiteKeyringFixture = Awaited<ReturnType<typeof bootstrap>>;

function authorizedMutation(f: SQLiteKeyringFixture, eventId: string) {
  const { authorizer } = f;
  return Object.freeze({
    audience,
    eventId,
    authorizingPrivateKey: authorizer.privateKey,
    authorizingKeyId: authorizer.key.keyId,
  });
}

async function extendWithReplacement(
  f: SQLiteKeyringFixture,
  eventId: string,
  deviceId: string,
) {
  const replacement = await generateX25519KeyPair();
  const replacementRecipient = await recipient(
    f.authorizer.key.keyId,
    deviceId,
    replacement,
  );
  f.trust.recipients = [f.trust.recipients[0]!, replacementRecipient];
  const result = await f.manager.extendHistoricalGrants({
    ...authorizedMutation(f, eventId),
    epochId: f.result.epoch.epochId,
    sourceRecipientPrivateKeyJwk: f.deviceX.privateKeyJwk,
  });
  return { replacement, replacementRecipient, result };
}

async function forkedRotation(
  f: SQLiteKeyringFixture,
  eventId: string,
) {
  const memory = new InMemoryVaultKeyringRepository();
  await memory.commit(f.result.event);
  const manager = keyringManager(memory, f.trust);
  return manager.rotateEpoch({ ...authorizedMutation(f, eventId), reason: "manual" });
}

async function signEvent(
  transition: AuthorizedVaultKeyringEvent["transition"],
  privateKey: CryptoKey,
): Promise<AuthorizedVaultKeyringEvent> {
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    bytesCopy(await vaultKeyringTransitionBytes(transition)),
  );
  return {
    schema: VAULT_KEYRING_EVENT_SCHEMA,
    transition,
    signature: base64UrlEncode(signature),
  };
}

function rawContains(bytes: Buffer, value: string | Uint8Array): boolean {
  const needle = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  return bytes.indexOf(needle) >= 0;
}

describe("SQLiteVaultKeyringRepository", () => {
  it("persists canonical epoch/event/grants across restart and replays exact grant bytes", async () => {
    const path = await databasePath();
    const firstRepository = new SQLiteVaultKeyringRepository({ path });
    const first = await bootstrap(firstRepository, "durable-bootstrap");
    const expectedGrantJson = await Promise.all(first.result.grants.map(epochKeyGrantJson));
    firstRepository.close();

    const reopened = new SQLiteVaultKeyringRepository({ path });
    expect(await reopened.activeEpoch(principal)).toEqual(first.result.epoch);
    expect(await Promise.all((await reopened.grantsForEpoch(first.result.epoch.epochId)).map(epochKeyGrantJson)))
      .toEqual(expectedGrantJson);
    expect(await reopened.event("durable-bootstrap")).toEqual(first.result.event);

    const replayManager = new VaultKeyringManager({
      repository: reopened,
      deviceTrustManager: first.trust.manager,
      deviceTrustRepository: first.trust.repository,
      now: () => nowMs,
    });
    const replay = await replayManager.bootstrapEpoch({
      eventId: "durable-bootstrap",
      authorizingKeyId: first.authorizer.key.keyId,
      authorizingPrivateKey: first.authorizer.privateKey,
      audience,
    });
    expect(replay.outcome).toBe("replayed");
    expect(replay.epochSecret).toBeUndefined();
    expect(await Promise.all(replay.grants.map(epochKeyGrantJson))).toEqual(expectedGrantJson);
    reopened.close();
  });

  it("never persists raw epoch secret or private Ed25519/X25519 JWK material", async () => {
    const path = await databasePath();
    const repository = new SQLiteVaultKeyringRepository({ path });
    const f = await bootstrap(repository, "secret-at-rest");
    const { replacement } = await extendWithReplacement(
      f,
      "secret-at-rest-extend",
      "device-replacement",
    );
    repository.close();

    const bytes = await readFile(path);
    expect(rawContains(bytes, f.result.epochSecret!)).toBe(false);
    expect(rawContains(bytes, base64UrlEncode(f.result.epochSecret!))).toBe(false);
    expect(rawContains(bytes, f.deviceX.privateKeyJwk.d)).toBe(false);
    expect(rawContains(bytes, replacement.privateKeyJwk.d)).toBe(false);
    expect(typeof f.authorizer.privateJwk.d).toBe("string");
    expect(rawContains(bytes, f.authorizer.privateJwk.d!)).toBe(false);
  });

  it("replays an earlier event with its exact signed grant inventory after later extension", async () => {
    const path = await databasePath();
    const repository = new SQLiteVaultKeyringRepository({ path });
    const f = await bootstrap(repository, "sqlite-exact-replay-bootstrap");
    const initialGrantJson = await Promise.all(f.result.grants.map(epochKeyGrantJson));

    await extendWithReplacement(
      f,
      "sqlite-exact-replay-extend",
      "device-replay-replacement",
    );
    expect(await repository.grantsForEpoch(f.result.epoch.epochId)).toHaveLength(2);

    const directReplay = await repository.commit(f.result.event);
    expect(directReplay.outcome).toBe("replayed");
    expect(await Promise.all(directReplay.grants.map(epochKeyGrantJson))).toEqual(initialGrantJson);
    expect(directReplay.grants).toHaveLength(1);

    const replayManager = keyringManager(repository, f.trust);
    const managerReplay = await replayManager.bootstrapEpoch(
      authorizedMutation(f, "sqlite-exact-replay-bootstrap"),
    );
    expect(await Promise.all(managerReplay.grants.map(epochKeyGrantJson))).toEqual(initialGrantJson);
    repository.close();
  });

  it("rotates to one active head while retaining the historical grant after restart", async () => {
    const path = await databasePath();
    const repository = new SQLiteVaultKeyringRepository({ path });
    const f = await bootstrap(repository, "rotate-bootstrap");
    const oldGrant = f.result.grants[0]!;
    const rotated = await f.manager.rotateEpoch({
      eventId: "rotate-next",
      authorizingKeyId: f.authorizer.key.keyId,
      authorizingPrivateKey: f.authorizer.privateKey,
      audience,
      reason: "manual",
    });
    expect(rotated.epoch.predecessorEpochId).toBe(f.result.epoch.epochId);
    repository.close();

    const reopened = new SQLiteVaultKeyringRepository({ path });
    expect((await reopened.activeEpoch(principal))?.epochId).toBe(rotated.epoch.epochId);
    expect((await reopened.epochsForPrincipal(principal)).map((epoch) => epoch.epochId))
      .toEqual(
        [f.result.epoch.epochId, rotated.epoch.epochId]
          .toSorted((left, right) => left.localeCompare(right)),
      );
    expect(await reopened.grant(f.result.epoch.epochId, oldGrant.recipientKeyId)).toEqual(oldGrant);
    reopened.close();
  });

  it("re-wraps a historical epoch durably without changing an encrypted payload envelope", async () => {
    const path = await databasePath();
    const repository = new SQLiteVaultKeyringRepository({ path });
    const f = await bootstrap(repository, "rewrap-bootstrap");
    const plaintext = new TextEncoder().encode("durable historical vault payload");
    const envelope = await encryptPayload({
      epochId: f.result.epoch.epochId,
      epochSecret: f.result.epochSecret!,
      objectKind: "replication-record",
      objectId: "record:durable-history",
      plaintext,
    });
    const envelopeBefore = JSON.stringify(envelope);

    const { replacement, replacementRecipient, result: extended }
      = await extendWithReplacement(f, "rewrap-extend", "device-replacement");
    expect(JSON.stringify(envelope)).toBe(envelopeBefore);
    repository.close();

    const reopened = new SQLiteVaultKeyringRepository({ path });
    const newGrant = (await reopened.grantsForEpoch(f.result.epoch.epochId))
      .find((grant) => grant.recipientKeyId === replacementRecipient.encryptionKeyId);
    expect(newGrant).toBeDefined();
    const recovered = await openEpochKeyGrant(newGrant!, replacement.privateKeyJwk);
    const decrypted = await decryptPayload(envelope, recovered);
    expect(new TextDecoder().decode(decrypted)).toBe("durable historical vault payload");
    expect(extended.grants).toHaveLength(2);
    reopened.close();
  });

  it("rejects a stale forked rotation and rolls back the whole transition", async () => {
    const path = await databasePath();
    const sqlite = new SQLiteVaultKeyringRepository({ path });
    const f = await bootstrap(sqlite, "fork-bootstrap");

    const firstFork = await forkedRotation(f, "fork-one");
    const secondFork = await forkedRotation(f, "fork-two");
    expect(firstFork.epoch.predecessorEpochId).toBe(f.result.epoch.epochId);
    expect(secondFork.epoch.predecessorEpochId).toBe(f.result.epoch.epochId);
    await sqlite.commit(firstFork.event);
    await expect(sqlite.commit(secondFork.event)).rejects.toBeInstanceOf(VaultKeyringConflictError);
    expect(await sqlite.event("fork-two")).toBeUndefined();
    expect((await sqlite.activeEpoch(principal))?.epochId).toBe(firstFork.epoch.epochId);
    sqlite.close();
  });

  it("rejects the same event id with different signed transition content atomically", async () => {
    const path = await databasePath();
    const sqlite = new SQLiteVaultKeyringRepository({ path });
    const f = await bootstrap(sqlite, "event-collision-bootstrap");

    const first = await forkedRotation(f, "same-rotation-event");
    const second = await forkedRotation(f, "same-rotation-event");
    expect(second.epoch.epochId).not.toBe(first.epoch.epochId);
    await sqlite.commit(first.event);
    await expect(sqlite.commit(second.event)).rejects.toBeInstanceOf(VaultKeyringConflictError);
    expect((await sqlite.activeEpoch(principal))?.epochId).toBe(first.epoch.epochId);
    expect(await sqlite.event("same-rotation-event")).toEqual(first.event);
    expect(await sqlite.epoch(second.epoch.epochId)).toBeUndefined();
    sqlite.close();
  });

  it("never allows a later signed event to replace an immutable recipient grant", async () => {
    const path = await databasePath();
    const repository = new SQLiteVaultKeyringRepository({ path });
    const f = await bootstrap(repository, "grant-collision-bootstrap");
    const { result: extended } = await extendWithReplacement(
      f,
      "grant-collision-extend",
      "device-replacement",
    );
    const added = extended.event.transition.grantsAdded[0]!;
    const ciphertext = added.ciphertext.slice(0, -1)
      + (added.ciphertext.endsWith("A") ? "B" : "A");
    const collisionTransition = {
      ...extended.event.transition,
      eventId: "grant-collision-second-event",
      grantsAdded: [{ ...added, ciphertext }],
      createdAt: "2026-09-25T12:00:01.000Z",
    };
    const collisionEvent = await signEvent(collisionTransition, f.authorizer.privateKey);

    await expect(repository.commit(collisionEvent)).rejects
      .toBeInstanceOf(VaultKeyringConflictError);
    expect(await repository.event("grant-collision-second-event")).toBeUndefined();
    expect(await repository.grant(f.result.epoch.epochId, added.recipientKeyId)).toEqual(added);
    repository.close();
  });

  it("fails closed when indexed epoch columns disagree with canonical record JSON", async () => {
    const path = await databasePath();
    const repository = new SQLiteVaultKeyringRepository({ path });
    const f = await bootstrap(repository, "corrupt-bootstrap");
    repository.close();

    const raw = new DatabaseSync(path);
    raw.prepare(`
      UPDATE vault_epochs
      SET created_by_device_id = ?
      WHERE epoch_id = ?
    `).run("tampered-device", f.result.epoch.epochId);
    raw.close();

    const reopened = new SQLiteVaultKeyringRepository({ path });
    await expect(reopened.activeEpoch(principal)).rejects
      .toBeInstanceOf(CorruptVaultKeyringDatabaseError);
    reopened.close();
  });

  it("fails closed when signed event JSON is corrupted", async () => {
    const path = await databasePath();
    const repository = new SQLiteVaultKeyringRepository({ path });
    await bootstrap(repository, "event-corrupt-bootstrap");
    repository.close();

    const raw = new DatabaseSync(path);
    const row = raw.prepare(`
      SELECT event_json FROM vault_keyring_events WHERE event_id = ?
    `).get("event-corrupt-bootstrap") as { readonly event_json: string };
    const parsed = JSON.parse(row.event_json) as { signature: string };
    const replacement = parsed.signature.endsWith("A") ? "B" : "A";
    parsed.signature = parsed.signature.slice(0, -1) + replacement;
    raw.prepare(`
      UPDATE vault_keyring_events SET event_json = ? WHERE event_id = ?
    `).run(JSON.stringify(parsed), "event-corrupt-bootstrap");
    raw.close();

    const reopened = new SQLiteVaultKeyringRepository({ path });
    await expect(reopened.event("event-corrupt-bootstrap")).rejects
      .toBeInstanceOf(CorruptVaultKeyringDatabaseError);
    reopened.close();
  });

  it("requires a dedicated database and fails closed on a newer schema", async () => {
    const sharedPath = await databasePath();
    const shared = new DatabaseSync(sharedPath);
    shared.exec("CREATE TABLE unrelated(id TEXT PRIMARY KEY) STRICT;");
    shared.close();
    expect(() => new SQLiteVaultKeyringRepository({ path: sharedPath }))
      .toThrow(SharedVaultKeyringDatabaseNotSupportedError);

    const newerPath = await databasePath();
    const initial = new SQLiteVaultKeyringRepository({ path: newerPath });
    initial.close();
    const raw = new DatabaseSync(newerPath);
    raw.prepare(`
      UPDATE vault_keyring_meta SET schema_version = 99 WHERE component = 'vault-keyring'
    `).run();
    raw.close();
    expect(() => new SQLiteVaultKeyringRepository({ path: newerPath }))
      .toThrow(UnsupportedVaultKeyringSchemaError);
  });
});
