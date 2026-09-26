import { describe, expect, it } from "vitest";
import { canonicalJson } from "@ssrl/core";
import {
  base64UrlEncode,
  encryptPayload,
  generateVaultEpoch,
  utf8,
} from "@ssrl/e2e";
import { temporalObservationJson } from "@ssrl/state-store";
import {
  createReplicationRecord,
  type ReplicationRecord,
} from "../src/index.js";
import {
  EncryptedReplicationValidationError,
  OpaqueReplicationCollisionError,
  assertSameOpaqueReplicationDescriptor,
  decryptArtifactBlob,
  decryptReplicationRecord,
  encryptArtifactBlob,
  encryptedReplicationObjectJson,
  encryptReplicationRecord,
  opaqueArtifactBlobDescriptor,
  opaqueReplicationRecordDescriptor,
  parseEncryptedReplicationObjectJson,
} from "../src/encrypted.js";

const project = "entity://project/secret-atlas" as const;

async function observationRecord(
  id: string,
  value: string,
): Promise<ReplicationRecord> {
  return createReplicationRecord({
    kind: "semantic-observation",
    recordId: id,
    payload: temporalObservationJson({
      id,
      entityId: project,
      property: "Project.status",
      value,
      source: { provider: "fixture", externalId: id, revision: id },
      validFrom: "2026-09-01T00:00:00Z",
      recordedAt: "2026-09-01T00:00:00Z",
    }),
  });
}

function fullRecordJson(record: ReplicationRecord): string {
  return canonicalJson({
    key: record.key,
    kind: record.kind,
    recordId: record.recordId,
    payloadDigest: record.payloadDigest,
    fingerprint: record.fingerprint,
    payloadBytes: record.payloadBytes,
    payload: record.payload,
  });
}

async function sha256Digest(bytes: Uint8Array): Promise<string> {
  const owned = Uint8Array.from(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", owned.buffer));
  return `sha256:${[...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function mutateBase64Url(value: string): string {
  const replacement = value.startsWith("A") ? "B" : "A";
  return replacement + value.slice(1);
}

describe("opaque encrypted replication objects", () => {
  it("round-trips a canonical replication record exactly", async () => {
    const epoch = generateVaultEpoch();
    const record = await observationRecord("secret-record-1", "private");
    const encrypted = await encryptReplicationRecord({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      record,
    });

    expect(await decryptReplicationRecord(encrypted, epoch.secret)).toEqual(record);
    expect(await parseEncryptedReplicationObjectJson(
      await encryptedReplicationObjectJson(encrypted),
    )).toEqual(encrypted);
  });

  it("keeps the descriptor deterministic while randomized encryption changes ciphertext", async () => {
    const epoch = generateVaultEpoch();
    const record = await observationRecord("secret-record-2", "private");
    const first = await encryptReplicationRecord({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      record,
    });
    const second = await encryptReplicationRecord({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      record,
    });

    expect(second.descriptor).toEqual(first.descriptor);
    expect(second.envelope.nonce).not.toBe(first.envelope.nonce);
    expect(second.envelope.ciphertext).not.toBe(first.envelope.ciphertext);
  });

  it("preserves the immutable collision law without exposing the plaintext key or digest", async () => {
    const epoch = generateVaultEpoch();
    const firstRecord = await observationRecord("shared-record", "active");
    const secondRecord = await observationRecord("shared-record", "paused");
    const first = await opaqueReplicationRecordDescriptor({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      record: firstRecord,
    });
    const second = await opaqueReplicationRecordDescriptor({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      record: secondRecord,
    });

    expect(second.opaqueKey).toBe(first.opaqueKey);
    expect(second.opaqueContentTag).not.toBe(first.opaqueContentTag);
    expect(() => assertSameOpaqueReplicationDescriptor(first, second))
      .toThrow(OpaqueReplicationCollisionError);
  });

  it("does not serialize semantic identifiers, plaintext digests, payloads, or the epoch secret", async () => {
    const epoch = generateVaultEpoch();
    const privateValue = "ultra-private-low-entropy-secret";
    const record = await observationRecord("super-secret-record-id", privateValue);
    const encrypted = await encryptReplicationRecord({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      record,
    });
    const serialized = await encryptedReplicationObjectJson(encrypted);
    const secretEncoding = base64UrlEncode(epoch.secret);

    expect(Object.hasOwn(encrypted.descriptor, "kind")).toBe(false);
    expect(Object.hasOwn(encrypted.descriptor, "recordId")).toBe(false);
    expect(Object.hasOwn(encrypted.descriptor, "payloadDigest")).toBe(false);
    expect(Object.hasOwn(encrypted.descriptor, "payload")).toBe(false);
    expect(serialized).not.toContain(record.recordId);
    expect(serialized).not.toContain(record.key);
    expect(serialized).not.toContain(record.payloadDigest);
    expect(serialized).not.toContain(project);
    expect(serialized).not.toContain(privateValue);
    expect(serialized).not.toContain(secretEncoding);
  });

  it("fails closed on descriptor, envelope identity, ciphertext, and wrong-secret tampering", async () => {
    const epoch = generateVaultEpoch();
    const otherEpoch = generateVaultEpoch();
    const record = await observationRecord("tamper-record", "private");
    const encrypted = await encryptReplicationRecord({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      record,
    });

    await expect(decryptReplicationRecord({
      ...encrypted,
      descriptor: {
        ...encrypted.descriptor,
        fingerprint: `sha256:${"0".repeat(64)}`,
      },
    }, epoch.secret)).rejects.toThrow(/fingerprint mismatch/);

    await expect(decryptReplicationRecord({
      ...encrypted,
      envelope: {
        ...encrypted.envelope,
        objectId: encrypted.descriptor.opaqueContentTag,
      },
    }, epoch.secret)).rejects.toThrow(/identity disagrees/);

    await expect(decryptReplicationRecord({
      ...encrypted,
      envelope: {
        ...encrypted.envelope,
        ciphertext: mutateBase64Url(encrypted.envelope.ciphertext),
      },
    }, epoch.secret)).rejects.toThrow(/decryption failed/);

    await expect(decryptReplicationRecord(encrypted, otherEpoch.secret))
      .rejects.toThrow(/decryption failed/);
  });

  it("rejects valid ciphertext for a different replication identity before returning plaintext", async () => {
    const epoch = generateVaultEpoch();
    const firstRecord = await observationRecord("record-aa", "active1");
    const secondRecord = await observationRecord("record-bb", "active2");
    const first = await encryptReplicationRecord({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      record: firstRecord,
    });
    const secondPlaintext = utf8(fullRecordJson(secondRecord));
    expect(secondPlaintext.byteLength).toBe(first.envelope.plaintextBytes);
    const mismatchedEnvelope = await encryptPayload({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      objectKind: "replication-record",
      objectId: first.descriptor.opaqueKey,
      plaintext: secondPlaintext,
    });

    await expect(decryptReplicationRecord({
      ...first,
      envelope: mismatchedEnvelope,
    }, epoch.secret)).rejects.toBeInstanceOf(EncryptedReplicationValidationError);
  });

  it("enforces exact public object and descriptor fields", async () => {
    const epoch = generateVaultEpoch();
    const record = await observationRecord("strict-parser", "private");
    const encrypted = await encryptReplicationRecord({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      record,
    });
    const parsed = JSON.parse(await encryptedReplicationObjectJson(encrypted)) as {
      descriptor: Record<string, unknown>;
    };
    parsed.descriptor.extra = true;

    await expect(parseEncryptedReplicationObjectJson(JSON.stringify(parsed)))
      .rejects.toThrow(/unexpected or missing fields/);
  });

  it("uses opaque epoch-scoped artifact identities and verifies decrypted blob bytes", async () => {
    const epoch = generateVaultEpoch();
    const nextEpoch = generateVaultEpoch();
    const bytes = new TextEncoder().encode("private artifact bytes");
    const digest = await sha256Digest(bytes);
    const first = await encryptArtifactBlob({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      plaintextDigest: digest,
      bytes,
    });
    const second = await encryptArtifactBlob({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      plaintextDigest: digest,
      bytes,
    });
    const rotated = await opaqueArtifactBlobDescriptor({
      epochId: nextEpoch.epochId,
      epochSecret: nextEpoch.secret,
      plaintextDigest: digest,
      plaintextBytes: bytes.byteLength,
    });

    expect(second.descriptor).toEqual(first.descriptor);
    expect(second.envelope.ciphertext).not.toBe(first.envelope.ciphertext);
    expect(rotated.opaqueKey).not.toBe(first.descriptor.opaqueKey);
    const serialized = await encryptedReplicationObjectJson(first);
    expect(serialized).not.toContain(digest);
    expect(serialized).not.toContain("private artifact bytes");
    expect(await decryptArtifactBlob(first, epoch.secret, digest)).toEqual(bytes);
    await expect(decryptArtifactBlob(
      first,
      epoch.secret,
      `sha256:${"0".repeat(64)}`,
    )).rejects.toThrow(/do not match/);
  });

  it("binds descriptor equality to one epoch", async () => {
    const firstEpoch = generateVaultEpoch();
    const secondEpoch = generateVaultEpoch();
    const record = await observationRecord("epoch-scoped", "private");
    const first = await opaqueReplicationRecordDescriptor({
      epochId: firstEpoch.epochId,
      epochSecret: firstEpoch.secret,
      record,
    });
    const second = await opaqueReplicationRecordDescriptor({
      epochId: secondEpoch.epochId,
      epochSecret: secondEpoch.secret,
      record,
    });

    expect(second.opaqueKey).not.toBe(first.opaqueKey);
    expect(second.opaqueContentTag).not.toBe(first.opaqueContentTag);
    expect(() => assertSameOpaqueReplicationDescriptor(first, second))
      .toThrow(/do not identify the same object/);
  });
});
