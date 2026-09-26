import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import {
  link,
  mkdir,
  open,
  readFile,
  stat,
  unlink,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "@ssrl/core";
import { type VaultEpochId } from "@ssrl/e2e";
import {
  HARD_OPAQUE_OBJECT_READ_MAX_BYTES,
  InvalidOpaqueDescriptorCatalogCursorError,
  OpaqueDescriptorCatalogEntryTooLargeError,
  OpaqueReplicationObjectNotFoundError,
  OpaqueReplicationObjectReadLimitError,
  OpaqueReplicationStoreCorruptionError,
  normalizeOpaqueObjectLocator,
  opaqueCatalogLimits,
  opaqueObjectReadLimit,
  type OpaqueDescriptorCatalogCursor,
  type OpaqueDescriptorCatalogPage,
  type OpaqueDescriptorCatalogRequest,
  type OpaqueObjectInstallResult,
  type OpaqueObjectLocator,
  type OpaqueObjectReadOptions,
  type OpaqueReplicationObjectStore,
} from "@ssrl/opaque-replication-store";
import {
  EncryptedReplicationValidationError,
  OpaqueReplicationCollisionError,
  assertSameOpaqueReplicationDescriptor,
  encryptedReplicationObjectJson,
  normalizeOpaqueReplicationDescriptor,
  normalizeOpaqueReplicationTag,
  opaqueReplicationDescriptorJson,
  parseEncryptedReplicationObjectJson,
  type EncryptedReplicationObject,
  type OpaqueReplicationDescriptor,
  type OpaqueReplicationTag,
} from "@ssrl/replication/encrypted";

const STORE_COMPONENT = "local-opaque-replication-store";
const STORE_SCHEMA_VERSION = 1;
const CATALOG_CURSOR_PREFIX = "ssrl-opaque-catalog-v1:";

declare const opaqueStorePathBrand: unique symbol;
type OpaqueStorePath = string & { readonly [opaqueStorePathBrand]: true };

declare const opaqueStorageKeyBrand: unique symbol;
type OpaqueStorageKey = string & { readonly [opaqueStorageKeyBrand]: true };

function configuredStorePath(value: string): OpaqueStorePath {
  return resolve(value) as OpaqueStorePath;
}

function childStorePath(root: OpaqueStorePath, ...segments: readonly string[]): OpaqueStorePath {
  const candidate = resolve(root, ...segments);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new OpaqueReplicationStoreCorruptionError("Opaque store path escaped configured root");
  }
  return candidate as OpaqueStorePath;
}

function checkedStorageKey(value: string): OpaqueStorageKey {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new OpaqueReplicationStoreCorruptionError("Opaque storage key is invalid");
  }
  return value as OpaqueStorageKey;
}

function ensureDirectorySync(path: OpaqueStorePath): void {
  // nosemgrep -- path is branded and created only by configuredStorePath/childStorePath.
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

async function ensureDirectory(path: OpaqueStorePath): Promise<void> {
  // nosemgrep -- path is branded and confined to the configured store root.
  await mkdir(path, { recursive: true, mode: 0o700 });
}

async function openStorePath(
  path: OpaqueStorePath,
  flags: "r" | "wx",
  mode?: number,
) {
  // nosemgrep -- path is branded and confined to the configured store root.
  return mode === undefined ? open(path, flags) : open(path, flags, mode);
}

async function statStorePath(path: OpaqueStorePath) {
  // nosemgrep -- path is branded and confined to the configured store root.
  return stat(path);
}

async function readStorePath(path: OpaqueStorePath): Promise<Buffer> {
  // nosemgrep -- path is branded and confined to the configured store root.
  return readFile(path);
}

async function linkStorePath(source: OpaqueStorePath, target: OpaqueStorePath): Promise<void> {
  // nosemgrep -- both paths are branded and confined to the configured store root.
  await link(source, target);
}

async function unlinkStorePath(path: OpaqueStorePath): Promise<void> {
  // nosemgrep -- path is branded and confined to the configured store root.
  await unlink(path);
}

export interface LocalOpaqueReplicationStoreOptions {
  readonly root: string;
  readonly timeoutMs?: number;
  readonly maxObjectBytes?: number;
  readonly maxReadBytes?: number;
}

interface VersionRow {
  readonly schema_version: number | bigint;
}

interface CatalogMetaRow {
  readonly catalog_id: string;
  readonly cursor_secret: string;
}

interface ObjectRow {
  readonly epoch_id: string;
  readonly opaque_key: string;
  readonly opaque_content_tag: string;
  readonly object_kind: string;
  readonly ciphertext_bytes: number | bigint;
  readonly descriptor_fingerprint: string;
  readonly storage_key: string;
  readonly body_json_bytes: number | bigint;
  readonly body_digest: string;
  readonly descriptor_json: string;
}

interface PreparedOpaqueBody {
  readonly normalized: EncryptedReplicationObject;
  readonly descriptorJson: string;
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly storage: string;
}

interface InstalledBodyFacts {
  readonly bodyJsonBytes: number;
  readonly bodyDigest: string;
}

export class UnsupportedLocalOpaqueReplicationStoreSchemaError extends Error {
  constructor(readonly found: number, readonly supported: number) {
    super(`Opaque replication store schema ${found} is newer than supported ${supported}`);
    this.name = "UnsupportedLocalOpaqueReplicationStoreSchemaError";
  }
}

function positiveBounded(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved)
    || resolved < 1
    || resolved > HARD_OPAQUE_OBJECT_READ_MAX_BYTES
  ) {
    throw new RangeError(
      `${label} must be an integer between 1 and ${HARD_OPAQUE_OBJECT_READ_MAX_BYTES}`,
    );
  }
  return resolved;
}

function isFsCode(cause: unknown, code: string): boolean {
  return typeof cause === "object"
    && cause !== null
    && "code" in cause
    && (cause as { readonly code?: unknown }).code === code;
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Digest(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`;
}

function bodyBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function storageKey(locator: OpaqueObjectLocator): OpaqueStorageKey {
  return checkedStorageKey(sha256Hex(canonicalJson([locator.epochId, locator.opaqueKey])));
}

function cursorSignature(secret: string, payload: string): string {
  return createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(payload, "utf8")
    .digest("base64url");
}

function catalogCursor(
  catalogId: string,
  cursorSecret: string,
  epochId: VaultEpochId,
  opaqueKey: OpaqueReplicationTag,
): OpaqueDescriptorCatalogCursor {
  const material = canonicalJson([catalogId, epochId, opaqueKey]);
  const payload = Buffer.from(material, "utf8").toString("base64url");
  const signature = cursorSignature(cursorSecret, payload);
  return `${CATALOG_CURSOR_PREFIX}${payload}.${signature}` as OpaqueDescriptorCatalogCursor;
}

function decodeCatalogCursor(
  cursor: OpaqueDescriptorCatalogCursor,
  catalogId: string,
  cursorSecret: string,
  epochId: VaultEpochId,
): OpaqueReplicationTag {
  if (!cursor.startsWith(CATALOG_CURSOR_PREFIX)) {
    throw new InvalidOpaqueDescriptorCatalogCursorError(cursor);
  }
  const encoded = cursor.slice(CATALOG_CURSOR_PREFIX.length);
  const separator = encoded.indexOf(".");
  if (separator < 1 || separator !== encoded.lastIndexOf(".")) {
    throw new InvalidOpaqueDescriptorCatalogCursorError(cursor);
  }
  const payload = encoded.slice(0, separator);
  const signature = encoded.slice(separator + 1);
  if (
    !/^[A-Za-z0-9_-]+$/.test(payload)
    || !/^[A-Za-z0-9_-]{43}$/.test(signature)
    || cursorSignature(cursorSecret, payload) !== signature
  ) {
    throw new InvalidOpaqueDescriptorCatalogCursorError(cursor);
  }
  let material: string;
  try {
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.toString("base64url") !== payload) {
      throw new InvalidOpaqueDescriptorCatalogCursorError(cursor);
    }
    material = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    if (cause instanceof InvalidOpaqueDescriptorCatalogCursorError) throw cause;
    throw new InvalidOpaqueDescriptorCatalogCursorError(cursor);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(material) as unknown;
  } catch {
    throw new InvalidOpaqueDescriptorCatalogCursorError(cursor);
  }
  if (
    !Array.isArray(parsed)
    || parsed.length !== 3
    || canonicalJson(parsed) !== material
    || parsed[0] !== catalogId
    || parsed[1] !== epochId
  ) {
    throw new InvalidOpaqueDescriptorCatalogCursorError(cursor);
  }
  try {
    return normalizeOpaqueReplicationTag(parsed[2], "opaque catalog cursor key");
  } catch {
    throw new InvalidOpaqueDescriptorCatalogCursorError(cursor);
  }
}

async function canonicalDescriptor(value: unknown): Promise<{
  readonly descriptor: OpaqueReplicationDescriptor;
  readonly json: string;
}> {
  const descriptor = await normalizeOpaqueReplicationDescriptor(value);
  const json = await opaqueReplicationDescriptorJson(descriptor);
  return { descriptor, json };
}

export class LocalOpaqueReplicationStore implements OpaqueReplicationObjectStore {
  readonly #objectRoot: OpaqueStorePath;
  readonly #tempRoot: OpaqueStorePath;
  readonly #db: DatabaseSync;
  readonly #catalogId: string;
  readonly #cursorSecret: string;
  readonly #maxObjectBytes: number;
  readonly #maxReadBytes: number;

  constructor(options: LocalOpaqueReplicationStoreOptions) {
    if (options.root.trim().length === 0) {
      throw new TypeError("Opaque replication store root must not be empty");
    }
    this.#maxObjectBytes = positiveBounded(
      options.maxObjectBytes,
      HARD_OPAQUE_OBJECT_READ_MAX_BYTES,
      "maxObjectBytes",
    );
    this.#maxReadBytes = positiveBounded(
      options.maxReadBytes,
      8 * 1024 * 1024,
      "maxReadBytes",
    );
    const root = configuredStorePath(options.root);
    this.#objectRoot = childStorePath(root, "objects", "sha256");
    this.#tempRoot = childStorePath(root, "tmp");
    ensureDirectorySync(this.#objectRoot);
    ensureDirectorySync(this.#tempRoot);
    this.#db = new DatabaseSync(join(root, "opaque-replication.sqlite"), {
      timeout: options.timeoutMs ?? 5_000,
      defensive: true,
    });
    try {
      this.#initialize();
      const catalog = this.#readCatalogMeta();
      this.#catalogId = catalog.catalogId;
      this.#cursorSecret = catalog.cursorSecret;
    } catch (cause) {
      this.#db.close();
      throw cause;
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (cause) {
      this.#db.exec("ROLLBACK");
      throw cause;
    }
  }

  #initialize(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS opaque_replication_store_meta (
        component TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL
      ) STRICT;
    `);
    const row = this.#db.prepare(`
      SELECT schema_version
      FROM opaque_replication_store_meta
      WHERE component = ?
    `).get(STORE_COMPONENT) as VersionRow | undefined;
    if (row === undefined) {
      this.#createFreshSchema();
      return;
    }
    const version = Number(row.schema_version);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new OpaqueReplicationStoreCorruptionError(
        `Invalid opaque replication schema version ${String(row.schema_version)}`,
      );
    }
    if (version > STORE_SCHEMA_VERSION) {
      throw new UnsupportedLocalOpaqueReplicationStoreSchemaError(version, STORE_SCHEMA_VERSION);
    }
    if (version !== STORE_SCHEMA_VERSION) {
      throw new OpaqueReplicationStoreCorruptionError(
        `Unsupported opaque replication schema version ${version}`,
      );
    }
  }

  #createFreshSchema(): void {
    const existing = this.#db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name IN ('opaque_replication_objects', 'opaque_replication_catalog_meta')
      ORDER BY name
    `).all() as unknown as { readonly name: string }[];
    if (existing.length > 0) {
      throw new OpaqueReplicationStoreCorruptionError(
        `Opaque replication tables exist without schema marker: ${existing.map((item) => item.name).join(", ")}`,
      );
    }
    this.#transaction(() => {
      this.#db.exec(`
        CREATE TABLE opaque_replication_catalog_meta (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          catalog_id TEXT NOT NULL UNIQUE,
          cursor_secret TEXT NOT NULL
        ) STRICT;

        CREATE TABLE opaque_replication_objects (
          epoch_id TEXT NOT NULL,
          opaque_key TEXT NOT NULL,
          opaque_content_tag TEXT NOT NULL,
          object_kind TEXT NOT NULL,
          ciphertext_bytes INTEGER NOT NULL,
          descriptor_fingerprint TEXT NOT NULL,
          storage_key TEXT NOT NULL UNIQUE,
          body_json_bytes INTEGER NOT NULL,
          body_digest TEXT NOT NULL,
          descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json)),
          PRIMARY KEY(epoch_id, opaque_key)
        ) STRICT;

        CREATE INDEX opaque_replication_epoch_catalog
          ON opaque_replication_objects(epoch_id, opaque_key);
      `);
      this.#db.prepare(`
        INSERT INTO opaque_replication_catalog_meta(singleton, catalog_id, cursor_secret)
        VALUES (1, ?, ?)
      `).run(randomUUID(), randomBytes(32).toString("base64url"));
      this.#db.prepare(`
        INSERT INTO opaque_replication_store_meta(component, schema_version)
        VALUES (?, ?)
      `).run(STORE_COMPONENT, STORE_SCHEMA_VERSION);
    });
  }

  #readCatalogMeta(): { readonly catalogId: string; readonly cursorSecret: string } {
    const row = this.#db.prepare(`
      SELECT catalog_id, cursor_secret
      FROM opaque_replication_catalog_meta
      WHERE singleton = 1
    `).get() as CatalogMetaRow | undefined;
    if (
      row === undefined
      || row.catalog_id.length === 0
      || !/^[A-Za-z0-9_-]{43}$/.test(row.cursor_secret)
    ) {
      throw new OpaqueReplicationStoreCorruptionError("Opaque replication catalog metadata is invalid");
    }
    return { catalogId: row.catalog_id, cursorSecret: row.cursor_secret };
  }

  #row(locator: OpaqueObjectLocator): ObjectRow | undefined {
    return this.#db.prepare(`
      SELECT epoch_id, opaque_key, opaque_content_tag, object_kind,
             ciphertext_bytes, descriptor_fingerprint, storage_key,
             body_json_bytes, body_digest, descriptor_json
      FROM opaque_replication_objects
      WHERE epoch_id = ? AND opaque_key = ?
    `).get(locator.epochId, locator.opaqueKey) as ObjectRow | undefined;
  }

  async #validatedRow(row: ObjectRow): Promise<OpaqueReplicationDescriptor> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.descriptor_json) as unknown;
    } catch (cause) {
      throw new OpaqueReplicationStoreCorruptionError("Stored opaque descriptor JSON is invalid", {
        cause,
      });
    }
    let descriptor: OpaqueReplicationDescriptor;
    let json: string;
    try {
      ({ descriptor, json } = await canonicalDescriptor(parsed));
    } catch (cause) {
      throw new OpaqueReplicationStoreCorruptionError("Stored opaque descriptor is invalid", { cause });
    }
    if (
      json !== row.descriptor_json
      || descriptor.epochId !== row.epoch_id
      || descriptor.opaqueKey !== row.opaque_key
      || descriptor.opaqueContentTag !== row.opaque_content_tag
      || descriptor.objectKind !== row.object_kind
      || descriptor.ciphertextBytes !== Number(row.ciphertext_bytes)
      || descriptor.fingerprint !== row.descriptor_fingerprint
      || storageKey({ epochId: descriptor.epochId, opaqueKey: descriptor.opaqueKey }) !== row.storage_key
    ) {
      throw new OpaqueReplicationStoreCorruptionError(
        `Stored opaque descriptor row ${row.epoch_id}/${row.opaque_key} is inconsistent`,
      );
    }
    if (!Number.isSafeInteger(Number(row.body_json_bytes)) || Number(row.body_json_bytes) < 1) {
      throw new OpaqueReplicationStoreCorruptionError("Stored opaque body byte count is invalid");
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(row.body_digest)) {
      throw new OpaqueReplicationStoreCorruptionError("Stored opaque body digest is invalid");
    }
    return descriptor;
  }

  #objectPath(storageValue: string): OpaqueStorePath {
    const storage = checkedStorageKey(storageValue);
    return childStorePath(
      this.#objectRoot,
      storage.slice(0, 2),
      `${storage.slice(2)}.json`,
    );
  }

  async #syncDirectory(path: OpaqueStorePath): Promise<void> {
    let handle;
    try {
      handle = await openStorePath(path, "r");
      await handle.sync();
    } catch (cause) {
      if (
        process.platform === "win32"
        && (isFsCode(cause, "EPERM") || isFsCode(cause, "EISDIR") || isFsCode(cause, "EINVAL"))
      ) return;
      throw cause;
    } finally {
      await handle?.close();
    }
  }

  async #readStoredRow(
    row: ObjectRow,
    maxBytes: number,
  ): Promise<EncryptedReplicationObject> {
    const descriptor = await this.#validatedRow(row);
    const required = Number(row.body_json_bytes);
    if (required > maxBytes) throw new OpaqueReplicationObjectReadLimitError(required, maxBytes);
    const path = this.#objectPath(row.storage_key);
    let info;
    try {
      info = await statStorePath(path);
    } catch (cause) {
      if (isFsCode(cause, "ENOENT")) {
        throw new OpaqueReplicationStoreCorruptionError(
          `Opaque object body is missing for ${descriptor.epochId}/${descriptor.opaqueKey}`,
        );
      }
      throw cause;
    }
    if (!info.isFile() || info.size !== required) {
      throw new OpaqueReplicationStoreCorruptionError(
        `Opaque object body shape disagrees with metadata for ${descriptor.epochId}/${descriptor.opaqueKey}`,
      );
    }
    const bytes = await readStorePath(path);
    if (bytes.byteLength !== required || sha256Digest(bytes) !== row.body_digest) {
      throw new OpaqueReplicationStoreCorruptionError(
        `Opaque object body integrity check failed for ${descriptor.epochId}/${descriptor.opaqueKey}`,
      );
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (cause) {
      throw new OpaqueReplicationStoreCorruptionError("Opaque object body is not valid UTF-8", { cause });
    }
    let object: EncryptedReplicationObject;
    try {
      object = await parseEncryptedReplicationObjectJson(text);
      if (await encryptedReplicationObjectJson(object) !== text) {
        throw new Error("body is not canonical JSON");
      }
      assertSameOpaqueReplicationDescriptor(descriptor, object.descriptor);
    } catch (cause) {
      throw new OpaqueReplicationStoreCorruptionError("Opaque object body is invalid or disagrees with metadata", {
        cause,
      });
    }
    return object;
  }

  async #prepareBody(
    object: EncryptedReplicationObject,
  ): Promise<PreparedOpaqueBody> {
    const text = await encryptedReplicationObjectJson(object);
    if (bodyBytes(text).byteLength > this.#maxObjectBytes) {
      throw new OpaqueReplicationObjectReadLimitError(bodyBytes(text).byteLength, this.#maxObjectBytes);
    }
    const normalized = await parseEncryptedReplicationObjectJson(text);
    const descriptorJson = await opaqueReplicationDescriptorJson(normalized.descriptor);
    const bytes = bodyBytes(text);
    return {
      normalized,
      descriptorJson,
      text,
      bytes,
      digest: sha256Digest(bytes),
      storage: storageKey({
        epochId: normalized.descriptor.epochId,
        opaqueKey: normalized.descriptor.opaqueKey,
      }),
    };
  }

  async #installBody(
    prepared: PreparedOpaqueBody,
  ): Promise<InstalledBodyFacts> {
    const storage = checkedStorageKey(prepared.storage);
    const directory = childStorePath(this.#objectRoot, storage.slice(0, 2));
    await ensureDirectory(directory);
    const target = this.#objectPath(storage);
    const temporary = childStorePath(this.#tempRoot, `${randomUUID()}.json`);
    const handle = await openStorePath(temporary, "wx", 0o600);
    try {
      await handle.writeFile(prepared.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    let installed = false;
    try {
      await linkStorePath(temporary, target);
      installed = true;
    } catch (cause) {
      if (!isFsCode(cause, "EEXIST")) throw cause;
    } finally {
      await unlinkStorePath(temporary).catch((cause: unknown) => {
        if (!isFsCode(cause, "ENOENT")) throw cause;
      });
    }
    if (installed) await this.#syncDirectory(directory);

    try {
      const bytes = await readStorePath(target);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const body = await parseEncryptedReplicationObjectJson(text);
      if (await encryptedReplicationObjectJson(body) !== text) throw new Error("non-canonical body");
      assertSameOpaqueReplicationDescriptor(prepared.normalized.descriptor, body.descriptor);
      return {
        bodyJsonBytes: bytes.byteLength,
        bodyDigest: sha256Digest(bytes),
      };
    } catch (cause) {
      if (cause instanceof OpaqueReplicationCollisionError || cause instanceof EncryptedReplicationValidationError) {
        throw cause;
      }
      throw new OpaqueReplicationStoreCorruptionError("Opaque object target body is invalid", { cause });
    }
  }

  async install(object: EncryptedReplicationObject): Promise<OpaqueObjectInstallResult> {
    const prepared = await this.#prepareBody(object);
    const locator = {
      epochId: prepared.normalized.descriptor.epochId,
      opaqueKey: prepared.normalized.descriptor.opaqueKey,
    } satisfies OpaqueObjectLocator;
    const existing = this.#row(locator);
    if (existing !== undefined) {
      const descriptor = await this.#validatedRow(existing);
      assertSameOpaqueReplicationDescriptor(descriptor, prepared.normalized.descriptor);
      await this.#readStoredRow(existing, this.#maxObjectBytes);
      return {
        descriptor,
        inserted: false,
        storedBytes: Number(existing.body_json_bytes),
      };
    }

    const installedBody = await this.#installBody(prepared);
    try {
      this.#db.prepare(`
        INSERT INTO opaque_replication_objects(
          epoch_id, opaque_key, opaque_content_tag, object_kind,
          ciphertext_bytes, descriptor_fingerprint, storage_key,
          body_json_bytes, body_digest, descriptor_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        prepared.normalized.descriptor.epochId,
        prepared.normalized.descriptor.opaqueKey,
        prepared.normalized.descriptor.opaqueContentTag,
        prepared.normalized.descriptor.objectKind,
        prepared.normalized.descriptor.ciphertextBytes,
        prepared.normalized.descriptor.fingerprint,
        prepared.storage,
        installedBody.bodyJsonBytes,
        installedBody.bodyDigest,
        prepared.descriptorJson,
      );
    } catch (cause) {
      const raced = this.#row(locator);
      if (raced === undefined) throw cause;
      const descriptor = await this.#validatedRow(raced);
      assertSameOpaqueReplicationDescriptor(descriptor, prepared.normalized.descriptor);
      await this.#readStoredRow(raced, this.#maxObjectBytes);
      return {
        descriptor,
        inserted: false,
        storedBytes: Number(raced.body_json_bytes),
      };
    }
    const row = this.#row(locator);
    if (row === undefined) {
      throw new OpaqueReplicationStoreCorruptionError("Opaque object metadata insert disappeared");
    }
    await this.#readStoredRow(row, this.#maxObjectBytes);
    return {
      descriptor: prepared.normalized.descriptor,
      inserted: true,
      storedBytes: installedBody.bodyJsonBytes,
    };
  }

  async descriptor(locatorValue: OpaqueObjectLocator): Promise<OpaqueReplicationDescriptor | undefined> {
    const locator = normalizeOpaqueObjectLocator(locatorValue);
    const row = this.#row(locator);
    if (row === undefined) return undefined;
    return this.#validatedRow(row);
  }

  async readObject(
    locatorValue: OpaqueObjectLocator,
    options: OpaqueObjectReadOptions = {},
  ): Promise<EncryptedReplicationObject> {
    const locator = normalizeOpaqueObjectLocator(locatorValue);
    const row = this.#row(locator);
    if (row === undefined) throw new OpaqueReplicationObjectNotFoundError(locator);
    const requestLimit = options.maxBytes === undefined
      ? this.#maxReadBytes
      : opaqueObjectReadLimit(options.maxBytes);
    return this.#readStoredRow(row, Math.min(this.#maxReadBytes, requestLimit));
  }

  async descriptorPage(request: OpaqueDescriptorCatalogRequest): Promise<OpaqueDescriptorCatalogPage> {
    const limits = opaqueCatalogLimits(request);
    const cursor = request.cursor;
    const after = cursor === undefined
      ? undefined
      : decodeCatalogCursor(cursor, this.#catalogId, this.#cursorSecret, limits.epochId);
    if (after !== undefined && cursor !== undefined) {
      const known = this.#db.prepare(`
        SELECT 1 AS present
        FROM opaque_replication_objects
        WHERE epoch_id = ? AND opaque_key = ?
      `).get(limits.epochId, after) as { readonly present: number } | undefined;
      if (known === undefined) throw new InvalidOpaqueDescriptorCatalogCursorError(cursor);
    }
    const rows = this.#db.prepare(`
      SELECT epoch_id, opaque_key, opaque_content_tag, object_kind,
             ciphertext_bytes, descriptor_fingerprint, storage_key,
             body_json_bytes, body_digest, descriptor_json
      FROM opaque_replication_objects
      WHERE epoch_id = ? AND (? IS NULL OR opaque_key > ?)
      ORDER BY opaque_key
      LIMIT ?
    `).all(
      limits.epochId,
      after ?? null,
      after ?? null,
      limits.maxDescriptors + 1,
    ) as unknown as ObjectRow[];

    const descriptors: OpaqueReplicationDescriptor[] = [];
    let descriptorBytes = 0;
    let consumedRows = 0;
    for (const row of rows.slice(0, limits.maxDescriptors)) {
      const descriptor = await this.#validatedRow(row);
      const bytes = new TextEncoder().encode(row.descriptor_json).byteLength;
      if (descriptorBytes + bytes > limits.maxBytes) {
        if (descriptors.length === 0) {
          throw new OpaqueDescriptorCatalogEntryTooLargeError(bytes, limits.maxBytes);
        }
        break;
      }
      descriptors.push(descriptor);
      descriptorBytes += bytes;
      consumedRows += 1;
    }
    const hasMore = consumedRows < rows.length;
    const last = descriptors.at(-1)?.opaqueKey;
    const nextCursor = last === undefined
      ? request.cursor
      : catalogCursor(this.#catalogId, this.#cursorSecret, limits.epochId, last);
    return {
      epochId: limits.epochId,
      descriptors,
      descriptorBytes,
      hasMore,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  close(): void {
    this.#db.close();
  }
}
