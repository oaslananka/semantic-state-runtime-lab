import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../packages/core/dist/index.js";
import { normalizeVaultEpochId } from "../packages/e2e/dist/index.js";
import type {
  OpaqueDescriptorCatalogRequest,
  OpaqueDescriptorChangeRequest,
  OpaqueReplicationObjectStore,
} from "../packages/opaque-replication-store/dist/index.js";
import {
  OPAQUE_REPLICATION_DESCRIPTOR_SCHEMA,
  normalizeOpaqueReplicationDescriptor,
  opaqueReplicationDescriptorJson,
  type OpaqueReplicationDescriptor,
} from "../packages/replication/dist/encrypted.js";
import { buildOpaquePrefixMerkleIndex } from "../packages/replication/dist/opaque-merkle.js";
import { LocalOpaqueReplicationStore } from "../packages/storage-local-opaque-replication/dist/index.js";
import { SQLiteOpaqueMerkleViewStore } from "../packages/storage-sqlite-opaque-merkle/dist/index.js";

const RECORDS = 100_000;
const PREFIX_BITS = 12 as const;
const SOURCE_PAGE_DESCRIPTORS = 4_096;
const SOURCE_PAGE_BYTES = 8 * 1024 * 1024;

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

async function descriptor(
  epochId: ReturnType<typeof normalizeVaultEpochId>,
  index: number,
): Promise<OpaqueReplicationDescriptor> {
  const material = {
    schema: OPAQUE_REPLICATION_DESCRIPTOR_SCHEMA,
    epochId,
    objectKind: "replication-record" as const,
    opaqueKey: syntheticTag("incremental-key", index),
    opaqueContentTag: syntheticTag("incremental-content", index),
    ciphertextBytes: 128 + (index % 64),
  };
  return normalizeOpaqueReplicationDescriptor({
    ...material,
    fingerprint: `sha256:${sha256Hex(canonicalJson(material))}`,
  });
}

async function insertSyntheticDescriptor(
  db: DatabaseSync,
  value: OpaqueReplicationDescriptor,
): Promise<void> {
  const json = await opaqueReplicationDescriptorJson(value);
  const storage = sha256Hex(canonicalJson([value.epochId, value.opaqueKey]));
  db.prepare(`
    INSERT INTO opaque_replication_objects(
      epoch_id, opaque_key, opaque_content_tag, object_kind,
      ciphertext_bytes, descriptor_fingerprint, storage_key,
      body_json_bytes, body_digest, descriptor_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    value.epochId,
    value.opaqueKey,
    value.opaqueContentTag,
    value.objectKind,
    value.ciphertextBytes,
    value.fingerprint,
    storage,
    1,
    `sha256:${"0".repeat(64)}`,
    json,
  );
  db.prepare(`
    INSERT INTO opaque_replication_changes(epoch_id, opaque_key, descriptor_json)
    VALUES (?, ?, ?)
  `).run(value.epochId, value.opaqueKey, json);
}

async function populateSource(
  path: string,
  epochId: ReturnType<typeof normalizeVaultEpochId>,
): Promise<number> {
  const started = performance.now();
  const db = new DatabaseSync(path);
  db.exec("BEGIN IMMEDIATE");
  try {
    const objectInsert = db.prepare(`
      INSERT INTO opaque_replication_objects(
        epoch_id, opaque_key, opaque_content_tag, object_kind,
        ciphertext_bytes, descriptor_fingerprint, storage_key,
        body_json_bytes, body_digest, descriptor_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const changeInsert = db.prepare(`
      INSERT INTO opaque_replication_changes(epoch_id, opaque_key, descriptor_json)
      VALUES (?, ?, ?)
    `);
    for (let index = 0; index < RECORDS; index += 1) {
      const value = await descriptor(epochId, index);
      const json = await opaqueReplicationDescriptorJson(value);
      objectInsert.run(
        value.epochId,
        value.opaqueKey,
        value.opaqueContentTag,
        value.objectKind,
        value.ciphertextBytes,
        value.fingerprint,
        sha256Hex(canonicalJson([value.epochId, value.opaqueKey])),
        1,
        `sha256:${"0".repeat(64)}`,
        json,
      );
      changeInsert.run(value.epochId, value.opaqueKey, json);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
  return performance.now() - started;
}

function sourceFacade(
  store: LocalOpaqueReplicationStore,
  counters: { catalogCalls: number; changeCalls: number },
): OpaqueReplicationObjectStore {
  const install = store.install.bind(store);
  const descriptor = store.descriptor.bind(store);
  const readObject = store.readObject.bind(store);
  return {
    install,
    descriptor,
    readObject,
    descriptorPage(request: OpaqueDescriptorCatalogRequest) {
      counters.catalogCalls += 1;
      return store.descriptorPage(request);
    },
    descriptorChangesAfter(request?: OpaqueDescriptorChangeRequest) {
      counters.changeCalls += 1;
      return store.descriptorChangesAfter(request);
    },
  };
}

function countRows(path: string, table: string): number {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      readonly count: number | bigint;
    };
    return Number(row.count);
  } finally {
    db.close();
  }
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

const root = mkdtempSync(join(tmpdir(), "ssrl-opaque-incremental-merkle-bench-"));
try {
  const sourceRoot = join(root, "source");
  const sourceBootstrap = new LocalOpaqueReplicationStore({ root: sourceRoot });
  sourceBootstrap.close();
  const sourceDbPath = join(sourceRoot, "opaque-replication.sqlite");
  const derivedDbPath = join(root, "derived.sqlite");
  const epochId = normalizeVaultEpochId("urn:ssrl:vault-epoch:AAAAAAAAAAAAAAAAAAAAAA");

  const sourcePopulationMs = await populateSource(sourceDbPath, epochId);
  const source = new LocalOpaqueReplicationStore({ root: sourceRoot });
  const counters = { catalogCalls: 0, changeCalls: 0 };
  const viewStore = await SQLiteOpaqueMerkleViewStore.open({
    path: derivedDbPath,
    source: sourceFacade(source, counters),
    prefixBits: PREFIX_BITS,
    sourcePageDescriptors: SOURCE_PAGE_DESCRIPTORS,
    sourcePageBytes: SOURCE_PAGE_BYTES,
  });

  const bootstrapStarted = performance.now();
  const bootstrap = await viewStore.catchUp();
  const bootstrapMs = performance.now() - bootstrapStarted;
  const bootstrapView = await viewStore.openView(epochId);
  if (bootstrapView.recordCount !== RECORDS) {
    throw new Error(`expected ${RECORDS} derived descriptors, got ${bootstrapView.recordCount}`);
  }

  const baselineCatalogCalls = counters.catalogCalls;
  const baselineChangeCalls = counters.changeCalls;
  const noChangeStarted = performance.now();
  const noChange = await viewStore.catchUp();
  const noChangeCatchUpMs = performance.now() - noChangeStarted;
  const openStarted = performance.now();
  const noChangeView = await viewStore.openView(epochId);
  const noChangeOpenViewMs = performance.now() - openStarted;
  const steadyCatalogCalls = counters.catalogCalls - baselineCatalogCalls;
  const steadyChangeCalls = counters.changeCalls - baselineChangeCalls;
  if (steadyCatalogCalls !== 0) throw new Error("steady-state path performed a full descriptor catalog call");
  if (noChange.descriptorsRead !== 0 || noChange.descriptorsInserted !== 0) {
    throw new Error("no-change catch-up unexpectedly consumed descriptors");
  }
  if (noChangeView.rootDigest !== bootstrapView.rootDigest) {
    throw new Error("no-change openView changed the root");
  }

  const nodesBefore = countRows(derivedDbPath, "opaque_merkle_node_versions");
  const incrementalDescriptor = await descriptor(epochId, RECORDS + 1_000_000);
  const sourceDb = new DatabaseSync(sourceDbPath);
  sourceDb.exec("BEGIN IMMEDIATE");
  try {
    await insertSyntheticDescriptor(sourceDb, incrementalDescriptor);
    sourceDb.exec("COMMIT");
  } catch (error) {
    sourceDb.exec("ROLLBACK");
    throw error;
  } finally {
    sourceDb.close();
  }

  const incrementalStarted = performance.now();
  const incremental = await viewStore.catchUp();
  const incrementalCatchUpMs = performance.now() - incrementalStarted;
  const incrementalView = await viewStore.openView(epochId);
  const nodesAfter = countRows(derivedDbPath, "opaque_merkle_node_versions");
  if (incremental.descriptorsRead !== 1 || incremental.descriptorsInserted !== 1) {
    throw new Error("incremental catch-up did not consume exactly one descriptor");
  }
  if (nodesAfter - nodesBefore !== PREFIX_BITS + 1) {
    throw new Error(`expected ${PREFIX_BITS + 1} new path nodes, got ${nodesAfter - nodesBefore}`);
  }
  if (incrementalView.recordCount !== RECORDS + 1) {
    throw new Error("incremental record count is incorrect");
  }

  const descriptorDb = new DatabaseSync(derivedDbPath);
  const rows = descriptorDb.prepare(`
    SELECT descriptor_json
    FROM opaque_merkle_descriptors
    WHERE epoch_id = ?
    ORDER BY opaque_key
  `).all(epochId) as unknown as { readonly descriptor_json: string }[];
  descriptorDb.close();
  const fullDescriptors = rows.map((row) => JSON.parse(row.descriptor_json) as OpaqueReplicationDescriptor);
  const rebuildStarted = performance.now();
  const rebuilt = await buildOpaquePrefixMerkleIndex(fullDescriptors, {
    prefixBits: PREFIX_BITS,
    epochId,
  });
  const referenceRebuildMs = performance.now() - rebuildStarted;
  if (rebuilt.rootDigest !== incrementalView.rootDigest) {
    throw new Error("incremental root disagrees with a full in-memory rebuild");
  }

  viewStore.close();
  source.close();

  console.log(JSON.stringify({
    benchmark: "opaque-incremental-merkle-v1",
    fixture: {
      records: RECORDS,
      prefixBits: PREFIX_BITS,
      sourcePageDescriptors: SOURCE_PAGE_DESCRIPTORS,
      sourcePageBytes: SOURCE_PAGE_BYTES,
    },
    preparation: {
      sourcePopulationMs: round(sourcePopulationMs),
    },
    bootstrap: {
      elapsedMs: round(bootstrapMs),
      pages: bootstrap.pages,
      descriptorsRead: bootstrap.descriptorsRead,
      descriptorsInserted: bootstrap.descriptorsInserted,
      rootDigest: bootstrapView.rootDigest,
    },
    steadyState: {
      noChangeCatchUpMs: round(noChangeCatchUpMs),
      noChangeOpenViewMs: round(noChangeOpenViewMs),
      sourceCatalogCalls: steadyCatalogCalls,
      sourceChangeFeedCalls: steadyChangeCalls,
      descriptorsRead: noChange.descriptorsRead,
    },
    incrementalOneDescriptor: {
      elapsedMs: round(incrementalCatchUpMs),
      descriptorsRead: incremental.descriptorsRead,
      descriptorsInserted: incremental.descriptorsInserted,
      newNodeVersions: nodesAfter - nodesBefore,
      expectedPathNodes: PREFIX_BITS + 1,
      recordCount: incrementalView.recordCount,
    },
    referenceFullRebuild: {
      elapsedMs: round(referenceRebuildMs),
      rootMatchesIncremental: rebuilt.rootDigest === incrementalView.rootDigest,
    },
    note: "Synthetic 100k relay-descriptor benchmark. Source population is reported separately. The benchmark establishes bounded steady-state and one-path incremental work; it is not an SLA or end-to-end encrypted upload latency claim.",
  }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
