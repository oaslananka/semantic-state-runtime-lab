import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "@ssrl/core";
import {
  ArtifactBlobCorruptError,
  ArtifactBlobReadLimitError,
  ArtifactMutationCollisionError,
  ArtifactMutationMissingBlobError,
  artifactDigest,
  resolveArtifact,
  type ArtifactBlobDescriptor,
  type ArtifactMutation,
  type ArtifactResourceIdentity,
} from "@ssrl/artifact-store";
import {
  CorruptLocalArtifactStoreError,
  LocalArtifactStore,
  UnsupportedArtifactStoreSchemaError,
} from "../src/index.js";

const roots: string[] = [];
const resourceA: ArtifactResourceIdentity = {
  sourceKey: "gmail/account-a/all-mail",
  externalType: "message",
  externalId: "msg-a",
};
const resourceB: ArtifactResourceIdentity = {
  sourceKey: "drive/account-a/root",
  externalType: "file",
  externalId: "file-b",
};

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "ssrl-artifacts-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

function upsert(
  id: string,
  resource: ArtifactResourceIdentity,
  blob: ArtifactBlobDescriptor,
  effectiveAt = "2026-09-24T00:00:00Z",
  recordedAt = "2026-09-24T00:01:00Z",
): ArtifactMutation {
  return {
    id,
    resource,
    kind: "upsert",
    effectiveAt,
    recordedAt,
    revision: id,
    blob,
  };
}

function casPath(storeRoot: string, digest: string): string {
  return join(storeRoot, "blobs", "sha256", digest.slice("sha256:".length));
}

function digestOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

describe("LocalArtifactStore", () => {
  it("deduplicates identical bytes across resources while allowing different MIME descriptors", async () => {
    const storeRoot = await root();
    const store = new LocalArtifactStore({ root: storeRoot });
    const bytes = new TextEncoder().encode("same bytes");
    const text = await store.putBlob(bytes, "text/plain");
    const binary = await store.putBlob(bytes, "application/octet-stream");

    expect(text.digest).toBe(binary.digest);
    expect(text.mediaType).toBe("text/plain");
    expect(binary.mediaType).toBe("application/octet-stream");
    expect(await store.append([
      upsert("a-v1", resourceA, text),
      upsert("b-v1", resourceB, binary),
    ])).toBe(2);
    expect((await store.snapshot()).blobs).toEqual([
      { digest: text.digest, size: bytes.byteLength },
    ]);
    store.close();
  });

  it("replays the same mutation idempotently and rolls back a different-content collision", async () => {
    const store = new LocalArtifactStore({ root: await root() });
    const blob = await store.putBlob(new TextEncoder().encode("version one"), "text/plain");
    const first = upsert("m1", resourceA, blob);
    expect(await store.append([first])).toBe(1);
    expect(await store.append([first])).toBe(0);

    await expect(store.append([
      upsert("a-new", resourceB, blob),
      { ...first, title: "changed identity" },
    ])).rejects.toBeInstanceOf(ArtifactMutationCollisionError);
    expect(await store.mutation("a-new")).toBeUndefined();
    expect((await store.snapshot()).mutations).toHaveLength(1);
    store.close();
  });

  it("stores update/delete/restore history and resolves it after close/reopen", async () => {
    const storeRoot = await root();
    const first = new LocalArtifactStore({ root: storeRoot });
    const blob1 = await first.putBlob(new TextEncoder().encode("one"), "text/plain");
    const blob2 = await first.putBlob(new TextEncoder().encode("two"), "text/plain");
    const history: ArtifactMutation[] = [
      upsert("v1", resourceA, blob1, "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"),
      upsert("v2", resourceA, blob2, "2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z"),
      {
        id: "deleted",
        resource: resourceA,
        kind: "delete",
        effectiveAt: "2026-05-01T00:00:00Z",
        recordedAt: "2026-05-02T00:00:00Z",
      },
      upsert("restored", resourceA, blob1, "2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z"),
    ];
    await first.append(history);
    const before = await first.snapshot();
    first.close();

    const reopened = new LocalArtifactStore({ root: storeRoot });
    expect(canonicalJson(await reopened.snapshot())).toBe(canonicalJson(before));
    const storedHistory = await reopened.mutationsForResource(resourceA);
    expect(storedHistory.map((item) => item.id)).toEqual(["v1", "v2", "deleted", "restored"]);
    expect(resolveArtifact({
      resource: resourceA,
      mutations: storedHistory,
      validAt: "2026-05-15T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
    }).status).toBe("deleted");
    expect(resolveArtifact({
      resource: resourceA,
      mutations: storedHistory,
      validAt: "2026-07-01T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
    }).status).toBe("present");
    reopened.close();
  });

  it("round-trips arbitrary binary bytes and returns exact bounded ranges", async () => {
    const store = new LocalArtifactStore({ root: await root(), maxReadBytes: 8 });
    const bytes = Uint8Array.from([0, 255, 10, 13, 128, 1, 2, 3, 4, 5]);
    const blob = await store.putBlob(bytes, "application/octet-stream");

    const slice = await store.readBlobRange(blob.digest, { offset: 2, length: 5, maxBytes: 5 });
    expect([...slice.bytes]).toEqual([10, 13, 128, 1, 2]);
    expect(slice.offset).toBe(2);
    expect(slice.complete).toBe(false);
    await expect(store.readBlobRange(blob.digest, { maxBytes: 8 }))
      .rejects.toBeInstanceOf(ArtifactBlobReadLimitError);
    store.close();
  });

  it("fails closed when stored blob bytes are corrupted after persistence", async () => {
    const storeRoot = await root();
    const store = new LocalArtifactStore({ root: storeRoot });
    const blob = await store.putBlob(new TextEncoder().encode("correct"), "text/plain");
    await writeFile(casPath(storeRoot, blob.digest), new TextEncoder().encode("corrupt"));

    // HEAD intentionally verifies metadata/type/size only; trusted content reads verify the digest.
    expect(await store.headBlob(blob.digest)).toEqual({
      digest: blob.digest,
      size: blob.size,
    });
    await expect(store.readBlobRange(blob.digest, { maxBytes: 100 }))
      .rejects.toBeInstanceOf(ArtifactBlobCorruptError);
    store.close();
  });

  it("fails closed when metadata references a missing blob file", async () => {
    const storeRoot = await root();
    const store = new LocalArtifactStore({ root: storeRoot });
    const blob = await store.putBlob(new TextEncoder().encode("missing later"), "text/plain");
    await store.append([upsert("v1", resourceA, blob)]);
    await unlink(casPath(storeRoot, blob.digest));

    await expect(store.headBlob(blob.digest)).rejects.toBeInstanceOf(ArtifactBlobCorruptError);
    await expect(store.readBlobRange(blob.digest, { maxBytes: 100 }))
      .rejects.toBeInstanceOf(ArtifactBlobCorruptError);
    store.close();
  });

  it("never overwrites an existing corrupt CAS path", async () => {
    const storeRoot = await root();
    const correct = new TextEncoder().encode("expected content");
    const digest = digestOf(correct);
    const path = casPath(storeRoot, digest);
    await mkdir(join(storeRoot, "blobs", "sha256"), { recursive: true });
    const corrupt = new TextEncoder().encode("malicious bytes");
    await writeFile(path, corrupt);

    const store = new LocalArtifactStore({ root: storeRoot });
    await expect(store.putBlob(correct, "text/plain"))
      .rejects.toBeInstanceOf(ArtifactBlobCorruptError);
    expect([...await readFile(path)]).toEqual([...corrupt]);
    store.close();
  });

  it("rejects mutations whose blob is not durably present", async () => {
    const store = new LocalArtifactStore({ root: await root() });
    const missing = artifactDigest(`sha256:${"f".repeat(64)}`);
    await expect(store.append([upsert("missing", resourceA, {
      digest: missing,
      size: 12,
      mediaType: "text/plain",
    })])).rejects.toBeInstanceOf(ArtifactMutationMissingBlobError);
    expect((await store.snapshot()).mutations).toEqual([]);
    store.close();
  });

  it("keeps unreferenced blobs harmless and detectable after a failed mutation batch", async () => {
    const store = new LocalArtifactStore({ root: await root() });
    const firstBlob = await store.putBlob(new TextEncoder().encode("first"), "text/plain");
    const orphan = await store.putBlob(new TextEncoder().encode("orphan"), "text/plain");
    await store.append([upsert("same", resourceA, firstBlob)]);

    await expect(store.append([
      upsert("a-orphan-reference", resourceB, orphan),
      { ...upsert("same", resourceA, firstBlob), title: "collision" },
    ])).rejects.toBeInstanceOf(ArtifactMutationCollisionError);

    expect(await store.mutation("a-orphan-reference")).toBeUndefined();
    expect((await store.unreferencedBlobs()).map((item) => item.digest)).toEqual([orphan.digest]);
    store.close();
  });

  it("exports portable snapshot metadata without embedding raw blob bytes", async () => {
    const store = new LocalArtifactStore({ root: await root() });
    const secretPayload = "RAW-PAYLOAD-MUST-NOT-BE-IN-SNAPSHOT";
    const blob = await store.putBlob(new TextEncoder().encode(secretPayload), "text/plain");
    await store.append([upsert("portable", resourceA, blob)]);

    const snapshot = await store.snapshot();
    const serialized = canonicalJson(snapshot);
    expect(serialized).not.toContain(secretPayload);
    expect(snapshot.blobs).toEqual([{ digest: blob.digest, size: blob.size }]);
    expect(snapshot.mutations[0]).toEqual(expect.objectContaining({
      id: "portable",
      kind: "upsert",
      blob: expect.objectContaining({ digest: blob.digest, size: blob.size, mediaType: "text/plain" }),
    }));
    store.close();
  });

  it("detects CAS files that have no metadata index entry", async () => {
    const storeRoot = await root();
    const store = new LocalArtifactStore({ root: storeRoot });
    const encoded = "d".repeat(64);
    await writeFile(join(storeRoot, "blobs", "sha256", encoded), Uint8Array.of(1, 2, 3));
    expect(await store.unindexedCasFiles()).toEqual([encoded]);
    store.close();
  });

  it("rejects a newer metadata schema without touching it", async () => {
    const storeRoot = await root();
    await mkdir(storeRoot, { recursive: true });
    const raw = new DatabaseSync(join(storeRoot, "artifacts.sqlite"));
    raw.exec(`
      CREATE TABLE artifact_store_meta (
        component TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL
      ) STRICT;
      INSERT INTO artifact_store_meta(component, schema_version)
      VALUES ('local-artifact-store', 99);
    `);
    raw.close();

    expect(() => new LocalArtifactStore({ root: storeRoot }))
      .toThrow(UnsupportedArtifactStoreSchemaError);
  });

  it("rejects a mutation descriptor whose size disagrees with indexed CAS metadata", async () => {
    const storeRoot = await root();
    const store = new LocalArtifactStore({ root: storeRoot });
    const blob = await store.putBlob(new TextEncoder().encode("payload"), "text/plain");
    await store.append([upsert("size-corrupt", resourceA, blob)]);
    store.close();

    const raw = new DatabaseSync(join(storeRoot, "artifacts.sqlite"));
    const row = raw.prepare(`
      SELECT record_json FROM artifact_mutations WHERE mutation_id = ?
    `).get("size-corrupt") as { readonly record_json: string };
    const record = JSON.parse(row.record_json) as Record<string, unknown>;
    record.blob = {
      ...(record.blob as Record<string, unknown>),
      size: blob.size + 1,
    };
    raw.prepare(`
      UPDATE artifact_mutations SET record_json = ? WHERE mutation_id = ?
    `).run(canonicalJson(record), "size-corrupt");
    raw.close();

    const reopened = new LocalArtifactStore({ root: storeRoot });
    await expect(reopened.mutation("size-corrupt"))
      .rejects.toBeInstanceOf(CorruptLocalArtifactStoreError);
    reopened.close();
  });

  it("rejects corrupted mutation JSON on read", async () => {
    const storeRoot = await root();
    const store = new LocalArtifactStore({ root: storeRoot });
    const blob = await store.putBlob(new TextEncoder().encode("payload"), "text/plain");
    await store.append([upsert("corrupt-me", resourceA, blob)]);
    store.close();

    const raw = new DatabaseSync(join(storeRoot, "artifacts.sqlite"));
    raw.prepare(`
      UPDATE artifact_mutations
      SET record_json = ?
      WHERE mutation_id = ?
    `).run(JSON.stringify({ id: "corrupt-me", kind: "upsert" }), "corrupt-me");
    raw.close();

    const reopened = new LocalArtifactStore({ root: storeRoot });
    await expect(reopened.mutation("corrupt-me"))
      .rejects.toBeInstanceOf(CorruptLocalArtifactStoreError);
    reopened.close();
  });
});
