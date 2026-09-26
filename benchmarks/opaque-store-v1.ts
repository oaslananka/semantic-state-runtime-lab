import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../packages/core/dist/index.js";
import { normalizeVaultEpochId } from "../packages/e2e/dist/index.js";
import {
  OPAQUE_REPLICATION_DESCRIPTOR_SCHEMA,
  normalizeOpaqueReplicationDescriptor,
  opaqueReplicationDescriptorJson,
} from "../packages/replication/dist/encrypted.js";
import { LocalOpaqueReplicationStore } from "../packages/storage-local-opaque-replication/dist/index.js";

const RECORDS = 100_000;
const PAGE_DESCRIPTORS = 256;
const PAGE_BYTES = 256 * 1024;

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function syntheticTag(domain: string, index: number): string {
  const material = `${domain}:${index}`;
  return `hmac-sha256:${sha256Base64Url(material)}`;
}

async function descriptor(epochId: ReturnType<typeof normalizeVaultEpochId>, index: number) {
  const material = {
    schema: OPAQUE_REPLICATION_DESCRIPTOR_SCHEMA,
    epochId,
    objectKind: "replication-record" as const,
    opaqueKey: syntheticTag("key", index),
    opaqueContentTag: syntheticTag("content", index),
    ciphertextBytes: 128,
  };
  const fingerprint = `sha256:${sha256Hex(canonicalJson(material))}`;
  return normalizeOpaqueReplicationDescriptor({ ...material, fingerprint });
}

const root = mkdtempSync(join(tmpdir(), "ssrl-opaque-store-bench-"));
try {
  const bootstrap = new LocalOpaqueReplicationStore({ root });
  bootstrap.close();
  const epochId = normalizeVaultEpochId("urn:ssrl:vault-epoch:AAAAAAAAAAAAAAAAAAAAAA");
  const db = new DatabaseSync(join(root, "opaque-replication.sqlite"));
  db.exec("BEGIN IMMEDIATE");
  try {
    const insert = db.prepare(`
      INSERT INTO opaque_replication_objects(
        epoch_id, opaque_key, opaque_content_tag, object_kind,
        ciphertext_bytes, descriptor_fingerprint, storage_key,
        body_json_bytes, body_digest, descriptor_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let index = 0; index < RECORDS; index += 1) {
      const item = await descriptor(epochId, index);
      const json = await opaqueReplicationDescriptorJson(item);
      const storage = sha256Hex(canonicalJson([item.epochId, item.opaqueKey]));
      insert.run(
        item.epochId,
        item.opaqueKey,
        item.opaqueContentTag,
        item.objectKind,
        item.ciphertextBytes,
        item.fingerprint,
        storage,
        1,
        `sha256:${"0".repeat(64)}`,
        json,
      );
    }
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  } finally {
    db.close();
  }

  const store = new LocalOpaqueReplicationStore({ root });
  const started = performance.now();
  let cursor: Awaited<ReturnType<typeof store.descriptorPage>>["nextCursor"];
  let total = 0;
  let pages = 0;
  let maxDescriptorsSeen = 0;
  let maxBytesSeen = 0;
  let hasMore = true;
  while (hasMore) {
    const page = await store.descriptorPage({
      epochId,
      ...(cursor === undefined ? {} : { cursor }),
      maxDescriptors: PAGE_DESCRIPTORS,
      maxBytes: PAGE_BYTES,
    });
    total += page.descriptors.length;
    pages += 1;
    maxDescriptorsSeen = Math.max(maxDescriptorsSeen, page.descriptors.length);
    maxBytesSeen = Math.max(maxBytesSeen, page.descriptorBytes);
    cursor = page.nextCursor;
    hasMore = page.hasMore;
  }
  const elapsedMs = performance.now() - started;
  store.close();

  if (total !== RECORDS) throw new Error(`expected ${RECORDS} descriptors, got ${total}`);
  if (maxDescriptorsSeen > PAGE_DESCRIPTORS) throw new Error("descriptor page count bound exceeded");
  if (maxBytesSeen > PAGE_BYTES) throw new Error("descriptor page byte bound exceeded");

  console.log(JSON.stringify({
    benchmark: "opaque-store-v1",
    records: RECORDS,
    pageDescriptorsLimit: PAGE_DESCRIPTORS,
    pageBytesLimit: PAGE_BYTES,
    pages,
    maxDescriptorsSeen,
    maxBytesSeen,
    elapsedMs: Number(elapsedMs.toFixed(1)),
    note: "Synthetic descriptor-catalog benchmark; ciphertext bodies are intentionally not generated. This measures bounded public descriptor paging, not end-to-end upload latency.",
  }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
