import { describe, expect, it } from "vitest";
import type { AccessPrincipal } from "@ssrl/access";
import {
  encryptionKeyIdentity,
  normalizeTrustedEncryptionKeyBinding,
  type ActiveDeviceAuthorization,
  type TrustedDevice,
  type TrustedDeviceKey,
  type TrustedEncryptionKeyBinding,
} from "@ssrl/device-trust";
import {
  decryptPayload,
  encryptPayload,
  epochKeyGrantJson,
  generateX25519KeyPair,
  openEpochKeyGrant,
} from "@ssrl/e2e";
import {
  InMemoryVaultKeyringRepository,
  VAULT_KEYRING_EVENT_SCHEMA,
  VaultKeyringConflictError,
  VaultKeyringManager,
  VaultKeyringProofError,
  normalizeVaultKeyringTransition,
  verifyAuthorizedVaultKeyringEvent,
} from "../src/index.js";

const principal: AccessPrincipal = { subject: "user:alice", scopes: ["vault:owner"] };
const nowMs = Date.parse("2026-09-25T12:00:00Z");
const audience = "urn:ssrl:vault-keyring:test";

async function ed25519Identity(deviceId = "device-laptop") {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const { ed25519JwkThumbprintUri, normalizeEd25519PublicJwk } = await import("@ssrl/device-trust");
  const normalized = normalizeEd25519PublicJwk(publicJwk);
  const keyId = await ed25519JwkThumbprintUri(normalized);
  const device: TrustedDevice = {
    deviceId,
    displayName: deviceId,
    principal,
    enrolledAt: "2026-09-01T00:00:00.000Z",
    status: "active",
  };
  const key: TrustedDeviceKey = {
    keyId,
    deviceId,
    publicKeyJwk: normalized,
    activatedAt: "2026-09-01T00:00:00.000Z",
    status: "active",
  };
  return { device, key, privateKey: pair.privateKey };
}

async function recipientBase(
  subjectKeyId: string,
  keyPair: Awaited<ReturnType<typeof generateX25519KeyPair>>,
) {
  const encryption = await encryptionKeyIdentity(keyPair.publicKeyJwk);
  return {
    subjectKeyId,
    principal,
    encryptionKeyId: encryption.encryptionKeyId,
    publicKeyJwk: encryption.publicKeyJwk,
    boundAt: "2026-09-01T00:00:00Z",
  } as const;
}

async function deviceRecipient(
  subjectKeyId: string,
  deviceId: string,
  keyPair: Awaited<ReturnType<typeof generateX25519KeyPair>>,
): Promise<TrustedEncryptionKeyBinding> {
  return normalizeTrustedEncryptionKeyBinding({
    ...(await recipientBase(subjectKeyId, keyPair)),
    subjectKind: "device-signing-key",
    deviceId,
  });
}

async function recoveryRecipient(
  subjectKeyId: string,
  generation: number,
  keyPair: Awaited<ReturnType<typeof generateX25519KeyPair>>,
): Promise<TrustedEncryptionKeyBinding> {
  return normalizeTrustedEncryptionKeyBinding({
    ...(await recipientBase(subjectKeyId, keyPair)),
    subjectKind: "recovery-credential",
    recoveryGeneration: generation,
  });
}

class MutableTrust {
  recipients: TrustedEncryptionKeyBinding[];
  readonly authorization: ActiveDeviceAuthorization;
  reads = 0;
  mutateOnSecondRead?: () => void;
  mutateOnThirdRead?: () => void;

  constructor(
    authorization: ActiveDeviceAuthorization,
    recipients: TrustedEncryptionKeyBinding[],
  ) {
    this.authorization = authorization;
    this.recipients = recipients;
  }

  readonly manager = {
    activeAuthorization: async (keyId: string) => {
      if (keyId !== this.authorization.key.keyId) throw new Error("inactive authorizer");
      return this.authorization;
    },
  };

  readonly repository = {
    activeEncryptionRecipients: async (_principal: AccessPrincipal) => {
      this.reads += 1;
      if (this.reads === 2) this.mutateOnSecondRead?.();
      if (this.reads === 3) this.mutateOnThirdRead?.();
      return this.recipients;
    },
  };
}

async function fixture() {
  const authorizer = await ed25519Identity();
  const deviceX = await generateX25519KeyPair();
  const recoveryX = await generateX25519KeyPair();
  const recipients = [
    await deviceRecipient(authorizer.key.keyId, authorizer.device.deviceId, deviceX),
    await recoveryRecipient("urn:ssrl:recovery:1", 1, recoveryX),
  ];
  const trust = new MutableTrust(
    { device: authorizer.device, key: authorizer.key },
    recipients,
  );
  const repository = new InMemoryVaultKeyringRepository();
  const manager = new VaultKeyringManager({
    repository,
    deviceTrustManager: trust.manager,
    deviceTrustRepository: trust.repository,
    now: () => nowMs,
  });
  return { authorizer, deviceX, recoveryX, trust, repository, manager };
}

type KeyringFixture = Awaited<ReturnType<typeof fixture>>;

function mutationInput(f: KeyringFixture, eventId: string) {
  return {
    eventId,
    authorizingKeyId: f.authorizer.key.keyId,
    authorizingPrivateKey: f.authorizer.privateKey,
    audience,
  } as const;
}

async function bootstrapFixture(f: KeyringFixture, eventId: string) {
  return f.manager.bootstrapEpoch(mutationInput(f, eventId));
}

async function addTrustedDeviceRecipient(f: KeyringFixture, deviceId: string) {
  const signing = await ed25519Identity(deviceId);
  const x25519 = await generateX25519KeyPair();
  const binding = await deviceRecipient(signing.key.keyId, signing.device.deviceId, x25519);
  f.trust.recipients = [...f.trust.recipients, binding];
  f.trust.reads = 0;
  return { signing, x25519, binding };
}

async function extendToNewDevice(
  f: KeyringFixture,
  epochId: Parameters<VaultKeyringManager["extendHistoricalGrants"]>[0]["epochId"],
  eventId: string,
  deviceId: string,
) {
  const added = await addTrustedDeviceRecipient(f, deviceId);
  const result = await f.manager.extendHistoricalGrants({
    ...mutationInput(f, eventId),
    epochId,
    sourceRecipientPrivateKeyJwk: f.deviceX.privateKeyJwk,
  });
  return { ...added, result };
}

async function expectBootstrapRecipientMutationRejected(
  f: KeyringFixture,
  eventId: string,
): Promise<void> {
  await expect(f.manager.bootstrapEpoch(mutationInput(f, eventId)))
    .rejects.toBeInstanceOf(VaultKeyringConflictError);
  expect(await f.repository.event(eventId)).toBeUndefined();
  expect(await f.repository.activeEpoch(principal)).toBeUndefined();
}

describe("authenticated vault keyring", () => {
  it("bootstraps an epoch only to the exact active trusted recipient set", async () => {
    const f = await fixture();
    const result = await bootstrapFixture(f, "vault-bootstrap-1");

    expect(result.outcome).toBe("inserted");
    expect(result.epochSecret).toBeDefined();
    expect(result.grants.map((grant) => grant.recipientKeyId)).toEqual(
      f.trust.recipients.map((recipient) => recipient.encryptionKeyId).toSorted((left, right) => left.localeCompare(right)),
    );
    expect(await verifyAuthorizedVaultKeyringEvent(result.event)).toBe(true);
    expect(await f.repository.activeEpoch(principal)).toEqual(result.epoch);
  });

  it("signs the exact randomized grants so grant substitution fails", async () => {
    const f = await fixture();
    const result = await bootstrapFixture(f, "vault-bootstrap-tamper");
    const first = result.event.transition.grantsAdded[0]!;
    const tampered = {
      ...result.event,
      transition: {
        ...result.event.transition,
        grantsAdded: [
          { ...first, ciphertext: first.ciphertext.slice(0, -1) + (first.ciphertext.endsWith("A") ? "B" : "A") },
          ...result.event.transition.grantsAdded.slice(1),
        ],
      },
    };

    expect(await verifyAuthorizedVaultKeyringEvent(tampered)).toBe(false);
  });

  it("replays the persisted grant bytes without regenerating HPKE ciphertext", async () => {
    const f = await fixture();
    const input = mutationInput(f, "vault-bootstrap-replay");
    const first = await f.manager.bootstrapEpoch(input);
    const grantJson = await Promise.all(first.grants.map(epochKeyGrantJson));
    const replay = await f.manager.bootstrapEpoch(input);

    expect(replay.outcome).toBe("replayed");
    expect(replay.epochSecret).toBeUndefined();
    expect(await Promise.all(replay.grants.map(epochKeyGrantJson))).toEqual(grantJson);
    expect(replay.event).toEqual(first.event);
  });

  it("fails closed when the trusted recipient snapshot changes before commit", async () => {
    const f = await fixture();
    f.trust.mutateOnSecondRead = () => {
      f.trust.recipients = f.trust.recipients.slice(0, 1);
    };

    await expectBootstrapRecipientMutationRejected(f, "vault-bootstrap-toctou");
  });

  it("re-checks trusted recipients after signing and immediately before commit", async () => {
    const f = await fixture();
    f.trust.mutateOnThirdRead = () => {
      f.trust.recipients = f.trust.recipients.slice(0, 1);
    };

    await expectBootstrapRecipientMutationRejected(f, "vault-bootstrap-post-sign-toctou");
    expect(f.trust.reads).toBe(3);
  });

  it("rejects a signing private key that does not match the active trusted authorizer", async () => {
    const f = await fixture();
    const wrong = await ed25519Identity("wrong-device");
    await expect(f.manager.bootstrapEpoch({
      eventId: "vault-bootstrap-wrong-signature",
      authorizingKeyId: f.authorizer.key.keyId,
      authorizingPrivateKey: wrong.privateKey,
      audience,
    })).rejects.toBeInstanceOf(VaultKeyringProofError);
    expect(await f.repository.activeEpoch(principal)).toBeUndefined();
  });

  it("rotates for forward revocation while preserving historical grants", async () => {
    const f = await fixture();
    const first = await bootstrapFixture(f, "vault-bootstrap-forward");
    const oldRecoveryGrant = await f.repository.grant(
      first.epoch.epochId,
      f.trust.recipients[1]!.encryptionKeyId,
    );
    expect(oldRecoveryGrant).toBeDefined();

    f.trust.recipients = [f.trust.recipients[0]!];
    f.trust.reads = 0;
    const rotated = await f.manager.rotateEpoch({ ...mutationInput(f, "vault-rotate-forward"), reason: "recipient-set-change" });

    expect(rotated.epoch.predecessorEpochId).toBe(first.epoch.epochId);
    expect(rotated.grants.map((grant) => grant.recipientKeyId)).toEqual([
      f.trust.recipients[0]!.encryptionKeyId,
    ]);
    expect(await f.repository.grant(first.epoch.epochId, oldRecoveryGrant!.recipientKeyId))
      .toEqual(oldRecoveryGrant);
    expect(await f.repository.grant(rotated.epoch.epochId, oldRecoveryGrant!.recipientKeyId))
      .toBeUndefined();
  });

  it("re-wraps a historical epoch to a newly trusted device without changing its payload envelope", async () => {
    const f = await fixture();
    f.trust.recipients = [f.trust.recipients[0]!];
    const first = await bootstrapFixture(f, "vault-bootstrap-rewrap");
    const plaintext = new TextEncoder().encode("historical personal state");
    const envelope = await encryptPayload({
      epochId: first.epoch.epochId,
      epochSecret: first.epochSecret!,
      objectKind: "replication-record",
      objectId: "record:historical",
      plaintext,
    });
    const envelopeBefore = JSON.stringify(envelope);

    const { x25519: replacementX, binding: replacementBinding, result: extended }
      = await extendToNewDevice(f, first.epoch.epochId, "vault-extend-rewrap", "device-phone");
    const newGrant = extended.grants.find(
      (grant) => grant.recipientKeyId === replacementBinding.encryptionKeyId,
    );
    expect(newGrant).toBeDefined();
    const recoveredSecret = await openEpochKeyGrant(newGrant!, replacementX.privateKeyJwk);
    expect(new TextDecoder().decode(await decryptPayload(envelope, recoveredSecret)))
      .toBe("historical personal state");
    expect(JSON.stringify(envelope)).toBe(envelopeBefore);
  });

  it("replays the exact signed event inventory even after later grants were added", async () => {
    const f = await fixture();
    f.trust.recipients = [f.trust.recipients[0]!];
    const input = mutationInput(f, "vault-bootstrap-inventory-replay");
    const first = await f.manager.bootstrapEpoch(input);
    const firstGrantJson = await Promise.all(first.grants.map(epochKeyGrantJson));

    await extendToNewDevice(
      f,
      first.epoch.epochId,
      "vault-extend-inventory-replay",
      "device-inventory-replay",
    );
    expect(await f.repository.grantsForEpoch(first.epoch.epochId)).toHaveLength(2);

    const replay = await f.manager.bootstrapEpoch(input);
    expect(replay.outcome).toBe("replayed");
    expect(await Promise.all(replay.grants.map(epochKeyGrantJson))).toEqual(firstGrantJson);
    expect(replay.grants).toHaveLength(1);
  });

  it("rejects an extension transition whose resulting inventory omits an active recipient", async () => {
    const f = await fixture();
    f.trust.recipients = [f.trust.recipients[0]!];
    const first = await bootstrapFixture(f, "vault-bootstrap-resulting-inventory");
    const { result: extended } = await extendToNewDevice(
      f,
      first.epoch.epochId,
      "vault-extend-resulting-inventory",
      "device-resulting-inventory",
    );
    const originalRecipientId = f.trust.recipients[0]!.encryptionKeyId;
    const tampered = {
      ...extended.event.transition,
      resultingRecipientKeyIds: extended.event.transition.resultingRecipientKeyIds
        .filter((id) => id !== originalRecipientId),
    };

    await expect(normalizeVaultKeyringTransition(tampered)).rejects
      .toThrow(/omits an active trusted recipient/);
  });

  it("rejects historical re-wrap with a private key that has no existing grant", async () => {
    const f = await fixture();
    const first = await bootstrapFixture(f, "vault-bootstrap-wrong-rewrap");
    const unknownX = await generateX25519KeyPair();
    const newX = await generateX25519KeyPair();
    const newSigning = await ed25519Identity("device-new");
    f.trust.recipients = [
      ...f.trust.recipients,
      await deviceRecipient(newSigning.key.keyId, newSigning.device.deviceId, newX),
    ];
    f.trust.reads = 0;

    await expect(f.manager.extendHistoricalGrants({
      eventId: "vault-extend-wrong-source",
      authorizingKeyId: f.authorizer.key.keyId,
      authorizingPrivateKey: f.authorizer.privateKey,
      audience,
      epochId: first.epoch.epochId,
      sourceRecipientPrivateKeyJwk: unknownX.privateKeyJwk,
    })).rejects.toThrow(/no historical grant/);
    expect(await f.repository.event("vault-extend-wrong-source")).toBeUndefined();
  });

  it("rejects same event id with different rotation request content", async () => {
    const f = await fixture();
    await bootstrapFixture(f, "vault-bootstrap-collision");
    await f.manager.rotateEpoch({ ...mutationInput(f, "vault-rotate-collision"), reason: "manual" });
    await expect(f.manager.rotateEpoch({ ...mutationInput(f, "vault-rotate-collision"), reason: "recipient-set-change" })).rejects.toBeInstanceOf(VaultKeyringConflictError);
  });
});
