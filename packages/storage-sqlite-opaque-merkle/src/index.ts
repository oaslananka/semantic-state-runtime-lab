import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "@ssrl/core";
import { normalizeVaultEpochId, type VaultEpochId } from "@ssrl/e2e";
import {
  OpaqueMerkleSourceCheckpointError,
  type OpaqueMerkleCatchUpResult,
  type OpaqueMerkleViewProvider,
} from "@ssrl/opaque-merkle-view-store";
import {
  InvalidOpaqueDescriptorChangeCursorError,
  type OpaqueDescriptorChangeCursor,
  type OpaqueReplicationObjectStore,
} from "@ssrl/opaque-replication-store";
import {
  assertSameOpaqueReplicationDescriptor,
  normalizeOpaqueReplicationDescriptor,
  type OpaqueReplicationDescriptor,
  type OpaqueReplicationTag,
} from "@ssrl/replication/encrypted";
import {
  buildOpaquePrefixMerkleIndex,
  opaquePrefixMerkleEmptyHashes,
  compareOpaqueReplicationTags,
  opaquePrefixMerkleLeafHash,
  opaquePrefixMerkleLeafId,
  opaqueReplicationTagOrderKey,
  opaquePrefixMerkleParentHash,
  type PrefixMerkleBits,
} from "@ssrl/replication/opaque-merkle";
import {
  DEFAULT_PREFIX_MERKLE_BITS,
  SUPPORTED_PREFIX_MERKLE_BITS,
} from "@ssrl/replication/merkle";
import {
  DEFAULT_MAX_LEAF_BYTES,
  DEFAULT_MAX_LEAF_DESCRIPTORS,
  DEFAULT_MAX_NODE_REFS,
  InvalidReconciliationCursorError,
  MAX_LEAF_BYTES,
  MAX_LEAF_DESCRIPTORS,
  MAX_NODE_REFS,
  ReconciliationLimitError,
  StaleReconciliationViewError,
  type MerkleNodeRef,
  type NodeQueryOptions,
} from "@ssrl/replication/opaque-sync";
import {
  OPAQUE_RECONCILIATION_PROTOCOL_SCHEMA,
  type OpaqueLeafPageOptions,
  type OpaqueMerkleNodeHashResponse,
  type OpaqueReconciliationLeafCursor,
  type OpaqueReconciliationLeafPage,
  type OpaqueReconciliationViewInfo,
} from "@ssrl/replication/opaque-sync";

const COMPONENT = "sqlite-opaque-merkle-view-store";
const SCHEMA_VERSION = 1;
const LEAF_CURSOR_PREFIX = "ssrl-opaque-sql-leaf-v1:";
const encoder = new TextEncoder();

export interface SQLiteOpaqueMerkleViewStoreOptions {
  readonly path: string;
  readonly source: OpaqueReplicationObjectStore;
  readonly prefixBits?: PrefixMerkleBits;
  readonly sourcePageDescriptors?: number;
  readonly sourcePageBytes?: number;
  readonly timeoutMs?: number;
  readonly wal?: boolean;
  readonly viewTtlMs?: number;
  readonly maxViews?: number;
}

interface MetaRow { readonly schema_version: number | bigint; readonly prefix_bits: number | bigint }
interface SourceStateRow { readonly initialized: number | bigint; readonly cursor: string | null }
interface HeadRow {
  readonly epoch_id: string;
  readonly prefix_bits: number | bigint;
  readonly current_version: number | bigint;
  readonly record_count: number | bigint;
  readonly root_digest: string;
}
interface DescriptorRow {
  readonly epoch_id: string;
  readonly opaque_key: string;
  readonly sort_key: string;
  readonly leaf_id: number | bigint;
  readonly inserted_version: number | bigint;
  readonly descriptor_json: string;
}
interface NodeRow { readonly hash: string }
interface FrozenView {
  readonly info: OpaqueReconciliationViewInfo;
  readonly version: number;
  readonly secret: Buffer;
  readonly expiresAt: number;
}
interface IncrementalPlan {
  readonly descriptor: OpaqueReplicationDescriptor;
  readonly descriptorJson: string;
  readonly leafId: number;
  readonly version: number;
  readonly recordCount: number;
  readonly rootDigest: string;
  readonly nodes: readonly { readonly level: number; readonly index: number; readonly hash: string }[];
}
interface BootstrapEpoch {
  readonly epochId: VaultEpochId;
  readonly descriptors: readonly OpaqueReplicationDescriptor[];
  readonly descriptorJson: ReadonlyMap<OpaqueReplicationTag, string>;
  readonly head: { readonly version: number; readonly recordCount: number; readonly rootDigest: string };
  readonly leafIds: ReadonlyMap<OpaqueReplicationTag, number>;
  readonly nodes: readonly { readonly level: number; readonly index: number; readonly hash: string }[];
}

export class UnsupportedOpaqueMerkleViewSchemaError extends Error {
  constructor(readonly found: number, readonly supported: number) {
    super(`Opaque Merkle view schema version ${found} is newer than supported version ${supported}`);
    this.name = "UnsupportedOpaqueMerkleViewSchemaError";
  }
}

export class CorruptOpaqueMerkleViewStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptOpaqueMerkleViewStoreError";
  }
}

function safeInteger(value: number | bigint, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new CorruptOpaqueMerkleViewStoreError(`${label} is invalid`);
  return result;
}

function prefixBits(value?: PrefixMerkleBits): PrefixMerkleBits {
  const resolved = value ?? DEFAULT_PREFIX_MERKLE_BITS;
  if (!SUPPORTED_PREFIX_MERKLE_BITS.includes(resolved)) {
    throw new RangeError(`prefixBits must be one of ${SUPPORTED_PREFIX_MERKLE_BITS.join(", ")}`);
  }
  return resolved;
}

function positiveInteger(value: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${label} must be an integer between 1 and ${max}`);
  }
  return value;
}

function digest(value: string, label: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new CorruptOpaqueMerkleViewStoreError(`${label} is invalid`);
  return value;
}

async function canonicalDescriptor(value: unknown): Promise<{ descriptor: OpaqueReplicationDescriptor; json: string }> {
  const descriptor = await normalizeOpaqueReplicationDescriptor(value);
  return { descriptor, json: canonicalJson(descriptor) };
}

function listBytes(json: readonly string[]): number {
  if (json.length === 0) return 2;
  return 2 + json.reduce((sum, value, index) => sum + encoder.encode(value).byteLength + (index === 0 ? 0 : 1), 0);
}

function leafCount(bits: PrefixMerkleBits): number { return 2 ** bits }
function nodesAtLevel(bits: PrefixMerkleBits, level: number): number { return 2 ** (bits - level) }

function leafCursorSignature(secret: Buffer, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function leafCursor(view: FrozenView, leafId: number, afterKey: string): OpaqueReconciliationLeafCursor {
  const material = canonicalJson({
    viewId: view.info.viewId,
    epochId: view.info.epochId,
    rootDigest: view.info.rootDigest,
    leafId,
    afterKey,
  });
  const payload = Buffer.from(material, "utf8").toString("base64url");
  return `${LEAF_CURSOR_PREFIX}${payload}.${leafCursorSignature(view.secret, payload)}` as OpaqueReconciliationLeafCursor;
}

function decodeLeafCursor(
  cursor: OpaqueReconciliationLeafCursor,
  view: FrozenView,
  leafId: number,
): string {
  if (!cursor.startsWith(LEAF_CURSOR_PREFIX)) throw new InvalidReconciliationCursorError();
  const encoded = cursor.slice(LEAF_CURSOR_PREFIX.length);
  const separator = encoded.indexOf(".");
  if (separator < 1 || separator !== encoded.lastIndexOf(".")) throw new InvalidReconciliationCursorError();
  const payload = encoded.slice(0, separator);
  const signature = encoded.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) {
    throw new InvalidReconciliationCursorError();
  }
  const expected = Buffer.from(leafCursorSignature(view.secret, payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new InvalidReconciliationCursorError();
  }
  let parsed: unknown;
  try {
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.toString("base64url") !== payload) throw new InvalidReconciliationCursorError();
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof InvalidReconciliationCursorError) throw error;
    throw new InvalidReconciliationCursorError();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || canonicalJson(parsed) !== Buffer.from(payload, "base64url").toString("utf8")) {
    throw new InvalidReconciliationCursorError();
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.viewId !== view.info.viewId
    || value.epochId !== view.info.epochId
    || value.rootDigest !== view.info.rootDigest
    || value.leafId !== leafId
    || typeof value.afterKey !== "string"
  ) throw new InvalidReconciliationCursorError("Reconciliation cursor does not belong to this view/leaf");
  return value.afterKey;
}

export class SQLiteOpaqueMerkleViewStore implements OpaqueMerkleViewProvider {
  readonly #db: DatabaseSync;
  readonly #source: OpaqueReplicationObjectStore;
  readonly #prefixBits: PrefixMerkleBits;
  readonly #sourcePageDescriptors: number;
  readonly #sourcePageBytes: number;
  readonly #viewTtlMs: number;
  readonly #maxViews: number;
  readonly #views = new Map<string, FrozenView>();
  readonly #emptyHashes: readonly string[];

  private constructor(options: SQLiteOpaqueMerkleViewStoreOptions, db: DatabaseSync, emptyHashes: readonly string[]) {
    this.#db = db;
    this.#source = options.source;
    this.#prefixBits = prefixBits(options.prefixBits);
    this.#sourcePageDescriptors = positiveInteger(options.sourcePageDescriptors ?? 1024, 4096, "sourcePageDescriptors");
    this.#sourcePageBytes = positiveInteger(options.sourcePageBytes ?? 4 * 1024 * 1024, 8 * 1024 * 1024, "sourcePageBytes");
    this.#viewTtlMs = positiveInteger(options.viewTtlMs ?? 5 * 60_000, 24 * 60 * 60_000, "viewTtlMs");
    this.#maxViews = positiveInteger(options.maxViews ?? 256, 4096, "maxViews");
    this.#emptyHashes = emptyHashes;
    this.#initialize();
  }

  static async open(options: SQLiteOpaqueMerkleViewStoreOptions): Promise<SQLiteOpaqueMerkleViewStore> {
    if (options.path.trim().length === 0) throw new TypeError("Opaque Merkle view path must not be empty");
    const bits = prefixBits(options.prefixBits);
    const db = new DatabaseSync(options.path, { timeout: options.timeoutMs ?? 5_000, defensive: true });
    try {
      db.exec("PRAGMA foreign_keys = ON");
      if (options.wal === true) db.exec("PRAGMA journal_mode = WAL");
      return new SQLiteOpaqueMerkleViewStore(options, db, await opaquePrefixMerkleEmptyHashes(bits));
    } catch (error) {
      db.close();
      throw error;
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #initialize(): void {
    const meta = this.#db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='opaque_merkle_meta'`).get() as { name: string } | undefined;
    if (meta === undefined) {
      const tables = this.#db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as unknown as { name: string }[];
      if (tables.length > 0) throw new CorruptOpaqueMerkleViewStoreError(`Derived Merkle DB is not empty: ${tables.map((row) => row.name).join(", ")}`);
      this.#createSchema();
      return;
    }
    const row = this.#db.prepare(`SELECT schema_version, prefix_bits FROM opaque_merkle_meta WHERE component=?`).get(COMPONENT) as MetaRow | undefined;
    if (row === undefined) throw new CorruptOpaqueMerkleViewStoreError("Opaque Merkle schema marker is missing");
    const version = safeInteger(row.schema_version, "schema version");
    if (version > SCHEMA_VERSION) throw new UnsupportedOpaqueMerkleViewSchemaError(version, SCHEMA_VERSION);
    if (version !== SCHEMA_VERSION) throw new CorruptOpaqueMerkleViewStoreError(`Unsupported opaque Merkle schema version ${version}`);
    if (safeInteger(row.prefix_bits, "prefix bits") !== this.#prefixBits) {
      throw new CorruptOpaqueMerkleViewStoreError("Configured prefixBits disagrees with derived database");
    }
  }

  #createSchema(): void {
    this.#transaction(() => {
      this.#db.exec(`
        CREATE TABLE opaque_merkle_meta (
          component TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL,
          prefix_bits INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE opaque_merkle_source_state (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          initialized INTEGER NOT NULL CHECK(initialized IN (0,1)),
          cursor TEXT
        ) STRICT;
        INSERT INTO opaque_merkle_source_state(singleton, initialized, cursor) VALUES (1,0,NULL);
        CREATE TABLE opaque_merkle_epoch_heads (
          epoch_id TEXT PRIMARY KEY,
          prefix_bits INTEGER NOT NULL,
          current_version INTEGER NOT NULL,
          record_count INTEGER NOT NULL,
          root_digest TEXT NOT NULL
        ) STRICT;
        CREATE TABLE opaque_merkle_descriptors (
          epoch_id TEXT NOT NULL,
          opaque_key TEXT NOT NULL,
          sort_key TEXT NOT NULL,
          leaf_id INTEGER NOT NULL,
          inserted_version INTEGER NOT NULL,
          descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json)),
          PRIMARY KEY(epoch_id, opaque_key),
          UNIQUE(epoch_id, sort_key)
        ) STRICT;
        CREATE INDEX opaque_merkle_leaf_descriptors
          ON opaque_merkle_descriptors(epoch_id, leaf_id, sort_key, inserted_version);
        CREATE TABLE opaque_merkle_node_versions (
          epoch_id TEXT NOT NULL,
          level INTEGER NOT NULL,
          node_index INTEGER NOT NULL,
          version INTEGER NOT NULL,
          hash TEXT NOT NULL,
          PRIMARY KEY(epoch_id, level, node_index, version)
        ) STRICT;
        CREATE INDEX opaque_merkle_node_latest
          ON opaque_merkle_node_versions(epoch_id, level, node_index, version DESC);
      `);
      this.#db.prepare(`INSERT INTO opaque_merkle_meta(component,schema_version,prefix_bits) VALUES (?,?,?)`).run(COMPONENT, SCHEMA_VERSION, this.#prefixBits);
    });
  }

  #sourceState(): { initialized: boolean; cursor?: OpaqueDescriptorChangeCursor } {
    const row = this.#db.prepare(`SELECT initialized, cursor FROM opaque_merkle_source_state WHERE singleton=1`).get() as SourceStateRow | undefined;
    if (row === undefined) throw new CorruptOpaqueMerkleViewStoreError("Opaque Merkle source state is missing");
    const initialized = safeInteger(row.initialized, "source initialized") === 1;
    return { initialized, ...(row.cursor === null ? {} : { cursor: row.cursor as OpaqueDescriptorChangeCursor }) };
  }

  #setSourceState(initialized: boolean, cursor?: OpaqueDescriptorChangeCursor): void {
    this.#db.prepare(`UPDATE opaque_merkle_source_state SET initialized=?, cursor=? WHERE singleton=1`).run(initialized ? 1 : 0, cursor ?? null);
  }

  #head(epochId: VaultEpochId): { version: number; recordCount: number; rootDigest: string } | undefined {
    const row = this.#db.prepare(`SELECT epoch_id,prefix_bits,current_version,record_count,root_digest FROM opaque_merkle_epoch_heads WHERE epoch_id=?`).get(epochId) as HeadRow | undefined;
    if (row === undefined) return undefined;
    if (normalizeVaultEpochId(row.epoch_id) !== epochId || safeInteger(row.prefix_bits, "head prefix bits") !== this.#prefixBits) {
      throw new CorruptOpaqueMerkleViewStoreError(`Epoch head ${epochId} is invalid`);
    }
    const version = safeInteger(row.current_version, "head version");
    const recordCount = safeInteger(row.record_count, "head record count");
    const rootDigest = digest(row.root_digest, "head root digest");
    const persistedRoot = this.#nodeHashAt(epochId, this.#prefixBits, 0, version);
    if (persistedRoot !== rootDigest) {
      throw new CorruptOpaqueMerkleViewStoreError(
        `Epoch head ${epochId} root disagrees with persisted root node`,
      );
    }
    return { version, recordCount, rootDigest };
  }

  async #validatedDescriptorRow(row: DescriptorRow): Promise<OpaqueReplicationDescriptor> {
    let parsed: unknown;
    try { parsed = JSON.parse(row.descriptor_json) as unknown; } catch { throw new CorruptOpaqueMerkleViewStoreError("Descriptor JSON is invalid"); }
    const { descriptor, json } = await canonicalDescriptor(parsed);
    if (
      json !== row.descriptor_json
      || descriptor.epochId !== row.epoch_id
      || descriptor.opaqueKey !== row.opaque_key
      || opaqueReplicationTagOrderKey(descriptor.opaqueKey) !== row.sort_key
      || await opaquePrefixMerkleLeafId(descriptor.opaqueKey, this.#prefixBits) !== safeInteger(row.leaf_id, "descriptor leaf")
    ) throw new CorruptOpaqueMerkleViewStoreError(`Derived descriptor ${row.opaque_key} disagrees with indexed columns`);
    safeInteger(row.inserted_version, "descriptor inserted version");
    return descriptor;
  }

  #nodeHashAt(epochId: VaultEpochId, level: number, index: number, version: number): string {
    const row = this.#db.prepare(`
      SELECT hash FROM opaque_merkle_node_versions
      WHERE epoch_id=? AND level=? AND node_index=? AND version<=?
      ORDER BY version DESC LIMIT 1
    `).get(epochId, level, index, version) as NodeRow | undefined;
    return row === undefined ? this.#emptyHashes[level]! : digest(row.hash, "node hash");
  }

  async #bootstrapEpoch(epochId: VaultEpochId, descriptors: readonly OpaqueReplicationDescriptor[]): Promise<BootstrapEpoch> {
    const index = await buildOpaquePrefixMerkleIndex(descriptors, { prefixBits: this.#prefixBits, epochId });
    const snapshot = index.snapshot();
    const leafIds = new Map<OpaqueReplicationTag, number>();
    const descriptorJson = new Map<OpaqueReplicationTag, string>();
    const refs = new Set<string>();
    for (const leaf of snapshot.nonEmptyLeaves) {
      for (const descriptor of leaf.descriptors) {
        leafIds.set(descriptor.opaqueKey, leaf.leafId);
        descriptorJson.set(descriptor.opaqueKey, canonicalJson(descriptor));
      }
      let indexAtLevel = leaf.leafId;
      for (let level = 0; level <= this.#prefixBits; level += 1) {
        refs.add(`${level}:${indexAtLevel}`);
        indexAtLevel = Math.floor(indexAtLevel / 2);
      }
    }
    const nodes = [...refs].map((value) => {
      const [levelText, indexText] = value.split(":");
      const level = Number(levelText);
      const nodeIndex = Number(indexText);
      return { level, index: nodeIndex, hash: index.nodeHash(level, nodeIndex) };
    }).toSorted((left, right) => left.level - right.level || left.index - right.index);
    return {
      epochId,
      descriptors: [...snapshot.nonEmptyLeaves.flatMap((leaf) => leaf.descriptors)].toSorted((a, b) => compareOpaqueReplicationTags(a.opaqueKey, b.opaqueKey)),
      descriptorJson,
      head: { version: 1, recordCount: index.recordCount, rootDigest: index.rootDigest },
      leafIds,
      nodes,
    };
  }

  async #sourceChangePage(cursor?: OpaqueDescriptorChangeCursor) {
    return this.#source.descriptorChangesAfter({
      ...(cursor === undefined ? {} : { cursor }),
      maxDescriptors: this.#sourcePageDescriptors,
      maxBytes: this.#sourcePageBytes,
    });
  }

  async #bootstrap(): Promise<OpaqueMerkleCatchUpResult> {
    const groups = new Map<VaultEpochId, OpaqueReplicationDescriptor[]>();
    let cursor: OpaqueDescriptorChangeCursor | undefined;
    let pages = 0;
    let descriptorsRead = 0;
    while (true) {
      const page = await this.#sourceChangePage(cursor);
      pages += 1;
      for (const value of page.descriptors) {
        const { descriptor } = await canonicalDescriptor(value);
        const current = groups.get(descriptor.epochId) ?? [];
        current.push(descriptor);
        groups.set(descriptor.epochId, current);
        descriptorsRead += 1;
      }
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    const epochs: BootstrapEpoch[] = [];
    for (const [epochId, descriptors] of groups) epochs.push(await this.#bootstrapEpoch(epochId, descriptors));
    this.#transaction(() => {
      const descriptorInsert = this.#db.prepare(`INSERT INTO opaque_merkle_descriptors(epoch_id,opaque_key,sort_key,leaf_id,inserted_version,descriptor_json) VALUES (?,?,?,?,?,?)`);
      const nodeInsert = this.#db.prepare(`INSERT INTO opaque_merkle_node_versions(epoch_id,level,node_index,version,hash) VALUES (?,?,?,?,?)`);
      const headInsert = this.#db.prepare(`INSERT INTO opaque_merkle_epoch_heads(epoch_id,prefix_bits,current_version,record_count,root_digest) VALUES (?,?,?,?,?)`);
      for (const epoch of epochs) {
        headInsert.run(epoch.epochId, this.#prefixBits, epoch.head.version, epoch.head.recordCount, epoch.head.rootDigest);
        for (const descriptor of epoch.descriptors) descriptorInsert.run(
          epoch.epochId,
          descriptor.opaqueKey,
          opaqueReplicationTagOrderKey(descriptor.opaqueKey),
          epoch.leafIds.get(descriptor.opaqueKey)!,
          1,
          epoch.descriptorJson.get(descriptor.opaqueKey)!,
        );
        for (const node of epoch.nodes) nodeInsert.run(epoch.epochId, node.level, node.index, 1, node.hash);
      }
      this.#setSourceState(true, cursor);
    });
    return { bootstrapped: true, pages, descriptorsRead, descriptorsInserted: descriptorsRead };
  }

  async #planIncremental(descriptorValue: OpaqueReplicationDescriptor): Promise<IncrementalPlan | undefined> {
    const { descriptor, json } = await canonicalDescriptor(descriptorValue);
    const existing = this.#db.prepare(`SELECT epoch_id,opaque_key,sort_key,leaf_id,inserted_version,descriptor_json FROM opaque_merkle_descriptors WHERE epoch_id=? AND opaque_key=?`).get(descriptor.epochId, descriptor.opaqueKey) as DescriptorRow | undefined;
    if (existing !== undefined) {
      assertSameOpaqueReplicationDescriptor(await this.#validatedDescriptorRow(existing), descriptor);
      return undefined;
    }
    const head = this.#head(descriptor.epochId) ?? { version: 0, recordCount: 0, rootDigest: this.#emptyHashes[this.#prefixBits]! };
    const leafId = await opaquePrefixMerkleLeafId(descriptor.opaqueKey, this.#prefixBits);
    const rows = this.#db.prepare(`SELECT epoch_id,opaque_key,sort_key,leaf_id,inserted_version,descriptor_json FROM opaque_merkle_descriptors WHERE epoch_id=? AND leaf_id=? ORDER BY sort_key`).all(descriptor.epochId, leafId) as unknown as DescriptorRow[];
    const leafDescriptors = await Promise.all(rows.map((row) => this.#validatedDescriptorRow(row)));
    const childHash = await opaquePrefixMerkleLeafHash([...leafDescriptors, descriptor]);
    const nodes: { level:number; index:number; hash:string }[] = [{ level: 0, index: leafId, hash: childHash }];
    let childIndex = leafId;
    let pathHash = childHash;
    for (let level = 1; level <= this.#prefixBits; level += 1) {
      const parentIndex = Math.floor(childIndex / 2);
      const leftIndex = parentIndex * 2;
      const rightIndex = leftIndex + 1;
      const left = childIndex === leftIndex ? pathHash : this.#nodeHashAt(descriptor.epochId, level - 1, leftIndex, head.version);
      const right = childIndex === rightIndex ? pathHash : this.#nodeHashAt(descriptor.epochId, level - 1, rightIndex, head.version);
      pathHash = await opaquePrefixMerkleParentHash(level, left, right);
      nodes.push({ level, index: parentIndex, hash: pathHash });
      childIndex = parentIndex;
    }
    return {
      descriptor,
      descriptorJson: json,
      leafId,
      version: head.version + 1,
      recordCount: head.recordCount + 1,
      rootDigest: pathHash,
      nodes,
    };
  }

  #commitIncremental(plan: IncrementalPlan): void {
    this.#transaction(() => {
      this.#db.prepare(`INSERT INTO opaque_merkle_descriptors(epoch_id,opaque_key,sort_key,leaf_id,inserted_version,descriptor_json) VALUES (?,?,?,?,?,?)`).run(
        plan.descriptor.epochId,
        plan.descriptor.opaqueKey,
        opaqueReplicationTagOrderKey(plan.descriptor.opaqueKey),
        plan.leafId,
        plan.version,
        plan.descriptorJson,
      );
      const node = this.#db.prepare(`INSERT INTO opaque_merkle_node_versions(epoch_id,level,node_index,version,hash) VALUES (?,?,?,?,?)`);
      for (const value of plan.nodes) node.run(plan.descriptor.epochId, value.level, value.index, plan.version, value.hash);
      this.#db.prepare(`
        INSERT INTO opaque_merkle_epoch_heads(epoch_id,prefix_bits,current_version,record_count,root_digest)
        VALUES (?,?,?,?,?)
        ON CONFLICT(epoch_id) DO UPDATE SET current_version=excluded.current_version, record_count=excluded.record_count, root_digest=excluded.root_digest
      `).run(plan.descriptor.epochId, this.#prefixBits, plan.version, plan.recordCount, plan.rootDigest);
    });
  }

  async catchUp(): Promise<OpaqueMerkleCatchUpResult> {
    const state = this.#sourceState();
    if (!state.initialized) return this.#bootstrap();
    let cursor = state.cursor;
    let pages = 0;
    let descriptorsRead = 0;
    let descriptorsInserted = 0;
    while (true) {
      let page;
      try {
        page = await this.#sourceChangePage(cursor);
      } catch (error) {
        if (error instanceof InvalidOpaqueDescriptorChangeCursorError) throw new OpaqueMerkleSourceCheckpointError();
        throw error;
      }
      pages += 1;
      for (const descriptor of page.descriptors) {
        descriptorsRead += 1;
        const plan = await this.#planIncremental(descriptor);
        if (plan !== undefined) {
          this.#commitIncremental(plan);
          descriptorsInserted += 1;
        }
      }
      const nextCursor = page.nextCursor;
      if (nextCursor !== cursor) this.#transaction(() => this.#setSourceState(true, nextCursor));
      cursor = nextCursor;
      if (!page.hasMore) break;
    }
    return { bootstrapped: false, pages, descriptorsRead, descriptorsInserted };
  }

  #pruneViews(): void {
    const now = Date.now();
    for (const [id, view] of this.#views) if (view.expiresAt <= now) this.#views.delete(id);
    while (this.#views.size >= this.#maxViews) {
      const oldest = this.#views.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#views.delete(oldest);
    }
  }

  #view(viewId: string): FrozenView {
    const view = this.#views.get(viewId);
    if (view === undefined || view.expiresAt <= Date.now()) {
      if (view !== undefined) this.#views.delete(viewId);
      throw new StaleReconciliationViewError(viewId);
    }
    return view;
  }

  async openView(epochValue: VaultEpochId): Promise<OpaqueReconciliationViewInfo> {
    await this.catchUp();
    this.#pruneViews();
    const epochId = normalizeVaultEpochId(epochValue);
    const head = this.#head(epochId) ?? { version: 0, recordCount: 0, rootDigest: this.#emptyHashes[this.#prefixBits]! };
    const viewId = `sql-opaque-view-${randomUUID()}`;
    const info: OpaqueReconciliationViewInfo = {
      schema: OPAQUE_RECONCILIATION_PROTOCOL_SCHEMA,
      epochId,
      viewId,
      prefixBits: this.#prefixBits,
      rootDigest: head.rootDigest,
      recordCount: head.recordCount,
    };
    this.#views.set(viewId, { info, version: head.version, secret: randomBytes(32), expiresAt: Date.now() + this.#viewTtlMs });
    return info;
  }

  expireView(viewId: string): boolean { return this.#views.delete(viewId) }
  viewInfo(viewId: string): OpaqueReconciliationViewInfo { return { ...this.#view(viewId).info } }

  async nodeHashes(viewId: string, refs: readonly MerkleNodeRef[], options: NodeQueryOptions = {}): Promise<OpaqueMerkleNodeHashResponse> {
    const view = this.#view(viewId);
    const max = positiveInteger(options.maxNodeRefs ?? DEFAULT_MAX_NODE_REFS, MAX_NODE_REFS, "maxNodeRefs");
    if (refs.length > max) throw new ReconciliationLimitError(`Node query contains ${refs.length} refs; maxNodeRefs is ${max}`);
    const nodes = refs.map((ref) => {
      if (!Number.isSafeInteger(ref.level) || ref.level < 0 || ref.level > this.#prefixBits) throw new ReconciliationLimitError(`Merkle level must be between 0 and ${this.#prefixBits}`);
      if (!Number.isSafeInteger(ref.index) || ref.index < 0 || ref.index >= nodesAtLevel(this.#prefixBits, ref.level)) throw new ReconciliationLimitError(`Merkle node index ${ref.index} is outside level ${ref.level}`);
      return { ...ref, hash: this.#nodeHashAt(view.info.epochId, ref.level, ref.index, view.version) };
    });
    return { viewId, rootDigest: view.info.rootDigest, nodes };
  }

  async leafPage(viewId: string, options: OpaqueLeafPageOptions): Promise<OpaqueReconciliationLeafPage> {
    const view = this.#view(viewId);
    const maxDescriptors = positiveInteger(options.maxDescriptors ?? DEFAULT_MAX_LEAF_DESCRIPTORS, MAX_LEAF_DESCRIPTORS, "maxDescriptors");
    const maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_MAX_LEAF_BYTES, MAX_LEAF_BYTES, "maxBytes");
    if (!Number.isSafeInteger(options.leafId) || options.leafId < 0 || options.leafId >= leafCount(this.#prefixBits)) throw new ReconciliationLimitError(`Merkle leaf ${options.leafId} is outside the tree`);
    let afterKey: string | undefined;
    let afterSortKey = "";
    if (options.cursor !== undefined) {
      afterKey = decodeLeafCursor(options.cursor, view, options.leafId);
      const known = this.#db.prepare(`SELECT sort_key FROM opaque_merkle_descriptors WHERE epoch_id=? AND leaf_id=? AND opaque_key=? AND inserted_version<=?`).get(
        view.info.epochId,
        options.leafId,
        afterKey,
        view.version,
      ) as { readonly sort_key: string } | undefined;
      if (known === undefined) throw new InvalidReconciliationCursorError("Reconciliation cursor points to a missing leaf key");
      afterSortKey = known.sort_key;
    }
    const rows = this.#db.prepare(`
      SELECT epoch_id,opaque_key,sort_key,leaf_id,inserted_version,descriptor_json
      FROM opaque_merkle_descriptors
      WHERE epoch_id=? AND leaf_id=? AND inserted_version<=? AND sort_key>?
      ORDER BY sort_key LIMIT ?
    `).all(
      view.info.epochId,
      options.leafId,
      view.version,
      afterSortKey,
      maxDescriptors + 1,
    ) as unknown as DescriptorRow[];
    const descriptors: OpaqueReplicationDescriptor[] = [];
    const json: string[] = [];
    let consumed = 0;
    for (const row of rows.slice(0, maxDescriptors)) {
      const descriptor = await this.#validatedDescriptorRow(row);
      const nextJson = [...json, row.descriptor_json];
      if (listBytes(nextJson) > maxBytes) {
        if (descriptors.length === 0) throw new ReconciliationLimitError(`Descriptor ${descriptor.opaqueKey} cannot fit inside maxBytes=${maxBytes}`);
        break;
      }
      descriptors.push(descriptor);
      json.push(row.descriptor_json);
      consumed += 1;
    }
    const completed = consumed >= rows.length;
    const last = descriptors.at(-1);
    const nextCursor = completed || last === undefined ? undefined : leafCursor(view, options.leafId, last.opaqueKey);
    return {
      viewId,
      rootDigest: view.info.rootDigest,
      leafId: options.leafId,
      descriptors,
      estimatedBytes: listBytes(json),
      ...(nextCursor === undefined ? {} : { nextCursor }),
      completed,
    };
  }

  close(): void { this.#views.clear(); this.#db.close() }
}
