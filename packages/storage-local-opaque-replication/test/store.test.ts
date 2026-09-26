import { createHash } from "node:crypto";
import { readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { generateVaultEpoch, type VaultEpoch } from "@ssrl/e2e";
import { canonicalJson } from "@ssrl/core";
import {
  InvalidOpaqueDescriptorCatalogCursorError,
  OpaqueDescriptorCatalogEntryTooLargeError,
  OpaqueReplicationObjectNotFoundError,
  OpaqueReplicationObjectReadLimitError,
  OpaqueReplicationStoreCorruptionError,
  type OpaqueDescriptorCatalogCursor,
} from "@ssrl/opaque-replication-store";
import {
  createReplicationRecord,
  type ReplicationRecord,
} from "@ssrl/replication";
import {
  EncryptedReplicationValidationError,
  OpaqueReplicationCollisionError,
  encryptArtifactBlob,
  encryptedReplicationObjectJson,
  encryptReplicationRecord,
  type EncryptedReplicationObject,
} from "@ssrl/replication/encrypted";
import {
  buildOpaquePrefixMerkleIndex,
  opaquePrefixMerkleSnapshotJson,
} from "@ssrl/replication/opaque-merkle";
import { temporalObservationJson } from "@ssrl/state-store";
import { LocalOpaqueReplicationStore } from "../src/index.js";

const roots: string[] = [];
const project = "entity://project/relay-secret-atlas" as const;

async function storeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ssrl-opaque-store-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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
      property: "Project.secretStatus",
      value,
      source: { provider: "fixture", externalId: id, revision: id },
      validFrom: "2026-09-01T00:00:00Z",
      recordedAt: "2026-09-01T00:00:00Z",
    }),
  });
}

async function encryptedRecord(
  epoch: VaultEpoch,
  id: string,
  value: string,
): Promise<EncryptedReplicationObject> {
  return encryptReplicationRecord({
    epochId: epoch.epochId,
    epochSecret: epoch.secret,
    record: await observationRecord(id, value),
  });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}


async function sameOpaqueKeyInEpoch(
  object: EncryptedReplicationObject,
  epoch: VaultEpoch,
): Promise<EncryptedReplicationObject> {
  const material = {
    schema: object.descriptor.schema,
    epochId: epoch.epochId,
    objectKind: object.descriptor.objectKind,
    opaqueKey: object.descriptor.opaqueKey,
    opaqueContentTag: object.descriptor.opaqueContentTag,
    ciphertextBytes: object.descriptor.ciphertextBytes,
  };
  const fingerprint = await sha256(new TextEncoder().encode(canonicalJson(material)));
  return {
    schema: object.schema,
    descriptor: { ...material, fingerprint },
    envelope: {
      ...object.envelope,
      epochId: epoch.epochId,
      objectId: object.descriptor.opaqueKey,
    },
  };
}

async function filesRecursively(root: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) output.push(child);
    }
  }
  await walk(root);
  return output.sort((left, right) => left.localeCompare(right));
}

async function objectBodyFiles(root: string): Promise<string[]> {
  return (await filesRecursively(join(root, "objects"))).filter((path) => path.endsWith(".json"));
}

async function installRecords(
  store: LocalOpaqueReplicationStore,
  epoch: VaultEpoch,
  ids: readonly string[],
): Promise<EncryptedReplicationObject[]> {
  const objects: EncryptedReplicationObject[] = [];
  for (const id of ids) {
    const object = await encryptedRecord(epoch, id, `private-${id}`);
    await store.install(object);
    objects.push(object);
  }
  return objects;
}


function locator(object: EncryptedReplicationObject) {
  return {
    epochId: object.descriptor.epochId,
    opaqueKey: object.descriptor.opaqueKey,
  };
}

async function readStoredObject(
  store: LocalOpaqueReplicationStore,
  object: EncryptedReplicationObject,
  maxBytes = 1024 * 1024,
) {
  return store.readObject(locator(object), { maxBytes });
}

function objectBodyPath(root: string, storage: string): string {
  return join(root, "objects", "sha256", storage.slice(0, 2), `${storage.slice(2)}.json`);
}

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`missing ${label}`);
  return value;
}

function deleteObjectMetadata(root: string, object: EncryptedReplicationObject): void {
  const db = new DatabaseSync(join(root, "opaque-replication.sqlite"));
  try {
    db.prepare(`
      DELETE FROM opaque_replication_objects
      WHERE epoch_id = ? AND opaque_key = ?
    `).run(object.descriptor.epochId, object.descriptor.opaqueKey);
  } finally {
    db.close();
  }
}

describe("LocalOpaqueReplicationStore", () => {
  it("persists an encrypted replication-record object exactly across reopen", async () => {
    const root = await storeRoot();
    const epoch = generateVaultEpoch();
    const object = await encryptedRecord(epoch, "record-reopen", "private-value");
    const first = new LocalOpaqueReplicationStore({ root });

    const installed = await first.install(object);
    expect(installed.inserted).toBe(true);
    expect(installed.descriptor).toEqual(object.descriptor);
    expect(installed.storedBytes).toBe(
      new TextEncoder().encode(await encryptedReplicationObjectJson(object)).byteLength,
    );
    first.close();

    const reopened = new LocalOpaqueReplicationStore({ root });
    expect(await reopened.descriptor({
      epochId: object.descriptor.epochId,
      opaqueKey: object.descriptor.opaqueKey,
    })).toEqual(object.descriptor);
    expect(await readStoredObject(reopened, object, installed.storedBytes)).toEqual(object);
    reopened.close();
  });

  it("persists encrypted artifact blobs without learning the plaintext digest", async () => {
    const root = await storeRoot();
    const epoch = generateVaultEpoch();
    const bytes = new TextEncoder().encode("top-secret-binary-content");
    const plaintextDigest = await sha256(bytes);
    const object = await encryptArtifactBlob({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      plaintextDigest,
      bytes,
    });
    const store = new LocalOpaqueReplicationStore({ root });

    expect((await store.install(object)).inserted).toBe(true);
    const read = await readStoredObject(store, object);
    expect(read).toEqual(object);
    store.close();

    const physical = Buffer.concat(await Promise.all(
      (await filesRecursively(root)).map((path) => readFile(path)),
    )).toString("latin1");
    expect(physical).not.toContain(plaintextDigest);
    expect(physical).not.toContain("top-secret-binary-content");
  });

  it("treats exact replay and independently randomized encryption as descriptor-idempotent", async () => {
    const root = await storeRoot();
    const epoch = generateVaultEpoch();
    const record = await observationRecord("same-logical-record", "same-private-value");
    const firstObject = await encryptReplicationRecord({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      record,
    });
    const secondObject = await encryptReplicationRecord({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      record,
    });
    expect(secondObject.descriptor).toEqual(firstObject.descriptor);
    expect(secondObject.envelope.nonce).not.toBe(firstObject.envelope.nonce);

    const store = new LocalOpaqueReplicationStore({ root });
    expect((await store.install(firstObject)).inserted).toBe(true);
    expect((await store.install(firstObject)).inserted).toBe(false);
    expect((await store.install(secondObject)).inserted).toBe(false);

    const retained = await readStoredObject(store, firstObject);
    expect(retained).toEqual(firstObject);
    store.close();
  });

  it("rejects same opaque key with different content tag and preserves the first object", async () => {
    const root = await storeRoot();
    const epoch = generateVaultEpoch();
    const first = await encryptedRecord(epoch, "collision-record", "active");
    const second = await encryptedRecord(epoch, "collision-record", "paused");
    expect(second.descriptor.opaqueKey).toBe(first.descriptor.opaqueKey);
    expect(second.descriptor.opaqueContentTag).not.toBe(first.descriptor.opaqueContentTag);

    const store = new LocalOpaqueReplicationStore({ root });
    await store.install(first);
    await expect(store.install(second)).rejects.toBeInstanceOf(OpaqueReplicationCollisionError);
    expect(await readStoredObject(store, first)).toEqual(first);
    store.close();
  });

  it("rejects inconsistent public descriptor metadata before persistence", async () => {
    const root = await storeRoot();
    const epoch = generateVaultEpoch();
    const object = await encryptedRecord(epoch, "invalid-metadata", "private");
    const invalid = {
      ...object,
      descriptor: {
        ...object.descriptor,
        ciphertextBytes: object.descriptor.ciphertextBytes + 1,
      },
    } as EncryptedReplicationObject;
    const store = new LocalOpaqueReplicationStore({ root });

    await expect(store.install(invalid)).rejects.toBeInstanceOf(EncryptedReplicationValidationError);
    expect(await store.descriptor({
      epochId: object.descriptor.epochId,
      opaqueKey: object.descriptor.opaqueKey,
    })).toBeUndefined();
    store.close();
  });

  it("uses the tuple (epochId, opaqueKey) instead of assuming opaqueKey is globally unique", async () => {
    const root = await storeRoot();
    const epochA = generateVaultEpoch();
    const epochB = generateVaultEpoch();
    const first = await encryptedRecord(epochA, "epoch-tuple", "private");
    const structurallyValidOtherEpoch = await sameOpaqueKeyInEpoch(first, epochB);
    expect(structurallyValidOtherEpoch.descriptor.opaqueKey).toBe(first.descriptor.opaqueKey);

    const store = new LocalOpaqueReplicationStore({ root });
    expect((await store.install(first)).inserted).toBe(true);
    expect((await store.install(structurallyValidOtherEpoch)).inserted).toBe(true);
    expect(await store.descriptor({
      epochId: epochA.epochId,
      opaqueKey: first.descriptor.opaqueKey,
    })).toEqual(first.descriptor);
    expect(await store.descriptor({
      epochId: epochB.epochId,
      opaqueKey: first.descriptor.opaqueKey,
    })).toEqual(structurallyValidOtherEpoch.descriptor);
    store.close();
  });

  it("keeps epoch catalogs isolated and rebuilds identical opaque Merkle roots after reopen", async () => {
    const root = await storeRoot();
    const epochA = generateVaultEpoch();
    const epochB = generateVaultEpoch();
    const store = new LocalOpaqueReplicationStore({ root });
    await installRecords(store, epochA, ["a-1", "a-2", "a-3"]);
    await installRecords(store, epochB, ["b-1", "b-2"]);

    const aPage = await store.descriptorPage({ epochId: epochA.epochId, maxDescriptors: 100 });
    const bPage = await store.descriptorPage({ epochId: epochB.epochId, maxDescriptors: 100 });
    expect(aPage.descriptors).toHaveLength(3);
    expect(bPage.descriptors).toHaveLength(2);
    expect(aPage.descriptors.every((item) => item.epochId === epochA.epochId)).toBe(true);
    expect(bPage.descriptors.every((item) => item.epochId === epochB.epochId)).toBe(true);
    const before = await buildOpaquePrefixMerkleIndex(aPage.descriptors, { epochId: epochA.epochId });
    const beforeJson = opaquePrefixMerkleSnapshotJson(before);
    store.close();

    const reopened = new LocalOpaqueReplicationStore({ root });
    const afterPage = await reopened.descriptorPage({ epochId: epochA.epochId, maxDescriptors: 100 });
    const after = await buildOpaquePrefixMerkleIndex(afterPage.descriptors, { epochId: epochA.epochId });
    expect(opaquePrefixMerkleSnapshotJson(after)).toBe(beforeJson);
    reopened.close();
  });

  it("produces deterministic descriptor catalogs independent of install order", async () => {
    const epoch = generateVaultEpoch();
    const objects = await Promise.all(
      ["order-a", "order-b", "order-c", "order-d"].map((id) => encryptedRecord(epoch, id, id)),
    );
    const rootA = await storeRoot();
    const rootB = await storeRoot();
    const first = new LocalOpaqueReplicationStore({ root: rootA });
    const second = new LocalOpaqueReplicationStore({ root: rootB });
    for (const object of objects) await first.install(object);
    for (const object of [...objects].reverse()) await second.install(object);

    const firstPage = await first.descriptorPage({ epochId: epoch.epochId, maxDescriptors: 100 });
    const secondPage = await second.descriptorPage({ epochId: epoch.epochId, maxDescriptors: 100 });
    expect(secondPage.descriptors).toEqual(firstPage.descriptors);
    expect(secondPage.descriptorBytes).toBe(firstPage.descriptorBytes);
    first.close();
    second.close();
  });

  it("paginates with store/epoch-bound HMAC cursors and rejects forged cursors", async () => {
    const root = await storeRoot();
    const otherRoot = await storeRoot();
    const epoch = generateVaultEpoch();
    const otherEpoch = generateVaultEpoch();
    const store = new LocalOpaqueReplicationStore({ root });
    const other = new LocalOpaqueReplicationStore({ root: otherRoot });
    await installRecords(store, epoch, ["page-1", "page-2", "page-3", "page-4", "page-5"]);
    await installRecords(other, epoch, ["other-1"]);

    const first = await store.descriptorPage({ epochId: epoch.epochId, maxDescriptors: 2 });
    expect(first.descriptors).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const cursor = requireValue(first.nextCursor, "first descriptor page cursor");
    const second = await store.descriptorPage({
      epochId: epoch.epochId,
      cursor,
      maxDescriptors: 10,
    });
    expect(second.descriptors).toHaveLength(3);
    expect(second.hasMore).toBe(false);

    await expect(other.descriptorPage({
      epochId: epoch.epochId,
      cursor,
    })).rejects.toBeInstanceOf(InvalidOpaqueDescriptorCatalogCursorError);
    await expect(store.descriptorPage({
      epochId: otherEpoch.epochId,
      cursor,
    })).rejects.toBeInstanceOf(InvalidOpaqueDescriptorCatalogCursorError);
    const last = requireValue(cursor.at(-1), "cursor signature character");
    const forged = `${cursor.slice(0, -1)}${last === "A" ? "B" : "A"}` as OpaqueDescriptorCatalogCursor;
    await expect(store.descriptorPage({
      epochId: epoch.epochId,
      cursor: forged,
    })).rejects.toBeInstanceOf(InvalidOpaqueDescriptorCatalogCursorError);
    store.close();
    other.close();
  });

  it("enforces catalog byte bounds without returning a non-advancing empty page", async () => {
    const root = await storeRoot();
    const epoch = generateVaultEpoch();
    const store = new LocalOpaqueReplicationStore({ root });
    await installRecords(store, epoch, ["bytes-1", "bytes-2"]);
    const page = await store.descriptorPage({ epochId: epoch.epochId, maxDescriptors: 10 });
    expect(page.descriptorBytes).toBeGreaterThan(1);

    await expect(store.descriptorPage({
      epochId: epoch.epochId,
      maxDescriptors: 10,
      maxBytes: 1,
    })).rejects.toBeInstanceOf(OpaqueDescriptorCatalogEntryTooLargeError);
    store.close();
  });

  it("enforces object read limits before reading the body", async () => {
    const root = await storeRoot();
    const epoch = generateVaultEpoch();
    const object = await encryptedRecord(epoch, "read-limit", "private");
    const store = new LocalOpaqueReplicationStore({ root, maxReadBytes: 1024 * 1024 });
    await store.install(object);

    await expect(readStoredObject(store, object, 1))
      .rejects.toBeInstanceOf(OpaqueReplicationObjectReadLimitError);
    store.close();
  });

  it("fails closed when committed metadata points to a missing or corrupted body", async () => {
    const root = await storeRoot();
    const epoch = generateVaultEpoch();
    const first = await encryptedRecord(epoch, "missing-body", "private-a");
    const second = await encryptedRecord(epoch, "corrupt-body", "private-b");
    const store = new LocalOpaqueReplicationStore({ root });
    await store.install(first);
    await store.install(second);
    const files = await objectBodyFiles(root);
    expect(files).toHaveLength(2);

    const db = new DatabaseSync(join(root, "opaque-replication.sqlite"));
    const rows = db.prepare(`
      SELECT opaque_key, storage_key
      FROM opaque_replication_objects
      ORDER BY opaque_key
    `).all() as unknown as { readonly opaque_key: string; readonly storage_key: string }[];
    db.close();
    const firstRow = requireValue(
      rows.find((row) => row.opaque_key === first.descriptor.opaqueKey),
      "first opaque object row",
    );
    const secondRow = requireValue(
      rows.find((row) => row.opaque_key === second.descriptor.opaqueKey),
      "second opaque object row",
    );
    await unlink(objectBodyPath(root, firstRow.storage_key));
    await writeFile(objectBodyPath(root, secondRow.storage_key), "{}", { mode: 0o600 });

    await expect(readStoredObject(store, first))
      .rejects.toBeInstanceOf(OpaqueReplicationStoreCorruptionError);
    await expect(readStoredObject(store, second))
      .rejects.toBeInstanceOf(OpaqueReplicationStoreCorruptionError);
    store.close();
  });

  it("can recover a valid orphan body by committing metadata on a later equivalent install", async () => {
    const root = await storeRoot();
    const epoch = generateVaultEpoch();
    const record = await observationRecord("orphan-recovery", "private");
    const first = await encryptReplicationRecord({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      record,
    });
    const alternate = await encryptReplicationRecord({
      epochId: epoch.epochId,
      epochSecret: epoch.secret,
      record,
    });
    const store = new LocalOpaqueReplicationStore({ root });
    await store.install(first);

    deleteObjectMetadata(root, first);

    const recovered = await store.install(alternate);
    expect(recovered.inserted).toBe(true);
    expect(await readStoredObject(store, first)).toEqual(first);
    store.close();
  });

  it("rejects non-canonical body JSON even if attacker updates stored size and digest metadata", async () => {
    const root = await storeRoot();
    const epoch = generateVaultEpoch();
    const object = await encryptedRecord(epoch, "noncanonical-body", "private");
    const store = new LocalOpaqueReplicationStore({ root });
    await store.install(object);

    const db = new DatabaseSync(join(root, "opaque-replication.sqlite"));
    const row = db.prepare(`
      SELECT storage_key FROM opaque_replication_objects
      WHERE epoch_id = ? AND opaque_key = ?
    `).get(object.descriptor.epochId, object.descriptor.opaqueKey) as { readonly storage_key: string };
    const path = objectBodyPath(root, row.storage_key);
    const parsed = JSON.parse(await encryptedReplicationObjectJson(object)) as Record<string, unknown>;
    const nonCanonical = JSON.stringify({ envelope: parsed.envelope, schema: parsed.schema, descriptor: parsed.descriptor });
    const bytes = new TextEncoder().encode(nonCanonical);
    await writeFile(path, bytes, { mode: 0o600 });
    db.prepare(`
      UPDATE opaque_replication_objects
      SET body_json_bytes = ?, body_digest = ?
      WHERE epoch_id = ? AND opaque_key = ?
    `).run(bytes.byteLength, await sha256(bytes), object.descriptor.epochId, object.descriptor.opaqueKey);
    db.close();

    await expect(readStoredObject(store, object))
      .rejects.toBeInstanceOf(OpaqueReplicationStoreCorruptionError);
    store.close();
  });

  it("keeps an orphan body invisible when metadata is absent", async () => {
    const root = await storeRoot();
    const epoch = generateVaultEpoch();
    const object = await encryptedRecord(epoch, "orphan-body", "private");
    const store = new LocalOpaqueReplicationStore({ root });
    await store.install(object);

    deleteObjectMetadata(root, object);

    expect(await store.descriptor(locator(object))).toBeUndefined();
    await expect(store.readObject(locator(object)))
      .rejects.toBeInstanceOf(OpaqueReplicationObjectNotFoundError);
    expect(await objectBodyFiles(root)).toHaveLength(1);
    store.close();
  });

  it("does not persist fixture plaintext record identity or values in DB, bodies, or filenames", async () => {
    const root = await storeRoot();
    const epoch = generateVaultEpoch();
    const secretId = "ULTRA-SECRET-RECORD-ID-DO-NOT-LEAK";
    const secretValue = "ULTRA-SECRET-PERSONAL-VALUE-DO-NOT-LEAK";
    const object = await encryptedRecord(epoch, secretId, secretValue);
    const record = await observationRecord(secretId, secretValue);
    const store = new LocalOpaqueReplicationStore({ root });
    await store.install(object);
    store.close();

    const paths = await filesRecursively(root);
    const filenames = paths.join("\n");
    const physical = Buffer.concat(await Promise.all(paths.map((path) => readFile(path))))
      .toString("latin1");
    for (const forbidden of [secretId, secretValue, record.key, record.payloadDigest, project]) {
      expect(filenames).not.toContain(forbidden);
      expect(physical).not.toContain(forbidden);
    }
  });
});
