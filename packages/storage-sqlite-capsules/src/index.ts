import { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  entityAliasScore,
  normalizeEntityAlias,
  type EntityId,
} from "@ssrl/core";
import {
  CorruptContextCapsuleError,
  contextCapsuleJson,
  contextCapsuleMaterialJson,
  parseContextCapsuleJson,
  type CapsuleWriteResult,
  type ContextCapsule,
  type ContextCapsuleStore,
} from "@ssrl/materializer";
import type { SemanticChangeCursor } from "@ssrl/state-store";

const CACHE_COMPONENT = "context-capsule-cache";
const CACHE_SCHEMA_VERSION = 1;

export interface SQLiteContextCapsuleStoreOptions {
  readonly path: string;
  readonly timeoutMs?: number;
  readonly wal?: boolean;
}

interface VersionRow {
  readonly schema_version: number | bigint;
}

interface CapsuleRow {
  readonly entity_id: string;
  readonly materialized_at: string;
  readonly configuration_version: string;
  readonly change_cursor: string | null;
  readonly next_temporal_boundary: string | null;
  readonly capsule_json: string;
}

interface AliasIndexRow {
  readonly normalized_alias: string;
  readonly alias_score: number | bigint;
  readonly token_count: number | bigint;
}

interface CheckpointRow {
  readonly cursor: string;
}

export class UnsupportedCapsuleCacheSchemaError extends Error {
  constructor(readonly found: number, readonly supported: number) {
    super(`Context capsule cache schema version ${found} is newer than supported version ${supported}`);
    this.name = "UnsupportedCapsuleCacheSchemaError";
  }
}

export class CorruptCapsuleCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptCapsuleCacheError";
  }
}

export class SharedCapsuleCacheDatabaseNotSupportedError extends Error {
  constructor(readonly tableNames: readonly string[]) {
    super(`Context capsule cache requires a dedicated SQLite database; found ${tableNames.join(", ")}`);
    this.name = "SharedCapsuleCacheDatabaseNotSupportedError";
  }
}

function entityId(value: string): EntityId {
  if (!value.startsWith("entity://") || value.length <= "entity://".length) {
    throw new CorruptCapsuleCacheError(`Invalid capsule entity id ${value}`);
  }
  return value as EntityId;
}

function canonicalTimestamp(value: string, label: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new TypeError(`${label} must be a valid timestamp`);
  return new Date(millis).toISOString();
}

function aliasTokenCount(normalizedAlias: string): number {
  return normalizedAlias.length === 0 ? 0 : normalizedAlias.split(" ").length;
}

function expectedAliasIndex(capsule: ContextCapsule): AliasIndexRow[] {
  const aliases = new Map<string, AliasIndexRow>();
  for (const alias of capsule.material.entity.aliases) {
    const normalizedAlias = normalizeEntityAlias(alias.value);
    if (normalizedAlias.length === 0) {
      throw new CorruptContextCapsuleError(`Capsule ${capsule.entityId} contains an empty normalized alias`);
    }
    const row: AliasIndexRow = {
      normalized_alias: normalizedAlias,
      alias_score: entityAliasScore(alias.value),
      token_count: aliasTokenCount(normalizedAlias),
    };
    const current = aliases.get(normalizedAlias);
    if (current === undefined || Number(row.alias_score) > Number(current.alias_score)) {
      aliases.set(normalizedAlias, row);
    }
  }
  return [...aliases.values()].toSorted((left, right) => (
    left.normalized_alias.localeCompare(right.normalized_alias)
  ));
}

function rowAliasIndexJson(rows: readonly AliasIndexRow[]): string {
  return canonicalJson(rows.map((row) => ({
    normalizedAlias: row.normalized_alias,
    aliasScore: Number(row.alias_score),
    tokenCount: Number(row.token_count),
  })));
}

function queryNgrams(normalizedQuery: string, lengths: readonly number[]): string[] {
  if (normalizedQuery.length === 0) return [];
  const tokens = normalizedQuery.split(" ");
  const values = new Set<string>();
  for (const length of lengths) {
    if (!Number.isSafeInteger(length) || length < 1 || length > tokens.length) continue;
    for (let start = 0; start + length <= tokens.length; start += 1) {
      values.add(tokens.slice(start, start + length).join(" "));
    }
  }
  return [...values].toSorted((left, right) => left.localeCompare(right));
}

export class SQLiteContextCapsuleStore implements ContextCapsuleStore {
  readonly #db: DatabaseSync;

  constructor(options: SQLiteContextCapsuleStoreOptions) {
    if (options.path.trim().length === 0) throw new TypeError("Capsule cache path must not be empty");
    this.#db = new DatabaseSync(options.path, {
      timeout: options.timeoutMs ?? 5_000,
      defensive: true,
    });
    try {
      this.#db.exec("PRAGMA foreign_keys = ON");
      if (options.wal === true) this.#db.exec("PRAGMA journal_mode = WAL");
      this.#initialize();
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
    const metaExists = this.#db.prepare(`
      SELECT 1 AS present
      FROM sqlite_master
      WHERE type = 'table' AND name = 'capsule_cache_meta'
    `).get() as { readonly present: number } | undefined;
    if (metaExists === undefined) {
      const existing = this.#db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all() as unknown as { readonly name: string }[];
      if (existing.length > 0) {
        throw new SharedCapsuleCacheDatabaseNotSupportedError(existing.map((row) => row.name));
      }
      this.#createSchema();
      return;
    }

    const row = this.#db.prepare(`
      SELECT schema_version
      FROM capsule_cache_meta
      WHERE component = ?
    `).get(CACHE_COMPONENT) as VersionRow | undefined;
    if (row === undefined) throw new CorruptCapsuleCacheError("Capsule cache schema marker is missing");
    const version = Number(row.schema_version);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new CorruptCapsuleCacheError(`Invalid capsule cache schema version ${String(row.schema_version)}`);
    }
    if (version > CACHE_SCHEMA_VERSION) {
      throw new UnsupportedCapsuleCacheSchemaError(version, CACHE_SCHEMA_VERSION);
    }
    if (version !== CACHE_SCHEMA_VERSION) {
      throw new CorruptCapsuleCacheError(`Unsupported capsule cache schema version ${version}`);
    }
  }

  #createSchema(): void {
    this.#transaction(() => {
      this.#db.exec(`
        CREATE TABLE capsule_cache_meta (
          component TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE context_capsules (
          entity_id TEXT PRIMARY KEY,
          materialized_at TEXT NOT NULL,
          configuration_version TEXT NOT NULL,
          change_cursor TEXT,
          next_temporal_boundary TEXT,
          capsule_json TEXT NOT NULL CHECK(json_valid(capsule_json))
        ) STRICT;

        CREATE INDEX context_capsules_stale
          ON context_capsules(configuration_version, next_temporal_boundary, entity_id);

        CREATE TABLE context_capsule_aliases (
          entity_id TEXT NOT NULL REFERENCES context_capsules(entity_id) ON DELETE CASCADE,
          normalized_alias TEXT NOT NULL,
          alias_score INTEGER NOT NULL,
          token_count INTEGER NOT NULL,
          PRIMARY KEY(entity_id, normalized_alias)
        ) STRICT;

        CREATE INDEX context_capsule_alias_lookup
          ON context_capsule_aliases(normalized_alias, alias_score DESC, entity_id);

        CREATE INDEX context_capsule_alias_lengths
          ON context_capsule_aliases(token_count, normalized_alias);

        CREATE TABLE context_capsule_checkpoint (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          cursor TEXT NOT NULL
        ) STRICT;
      `);
      this.#db.prepare(`
        INSERT INTO capsule_cache_meta(component, schema_version)
        VALUES (?, ?)
      `).run(CACHE_COMPONENT, CACHE_SCHEMA_VERSION);
    });
  }

  #aliasRows(entity: EntityId): AliasIndexRow[] {
    return this.#db.prepare(`
      SELECT normalized_alias, alias_score, token_count
      FROM context_capsule_aliases
      WHERE entity_id = ?
      ORDER BY normalized_alias
    `).all(entity) as unknown as AliasIndexRow[];
  }

  #validatedCapsuleRow(row: CapsuleRow): ContextCapsule {
    let capsule: ContextCapsule;
    try {
      capsule = parseContextCapsuleJson(row.capsule_json);
    } catch (cause) {
      if (cause instanceof CorruptContextCapsuleError) {
        throw new CorruptCapsuleCacheError(cause.message);
      }
      throw cause;
    }
    const parsedBoundary = capsule.material.nextTemporalBoundary ?? null;
    const parsedCursor = capsule.changeCursor ?? null;
    if (
      capsule.entityId !== row.entity_id
      || capsule.materializedAt !== row.materialized_at
      || capsule.configurationVersion !== row.configuration_version
      || parsedCursor !== row.change_cursor
      || parsedBoundary !== row.next_temporal_boundary
    ) {
      throw new CorruptCapsuleCacheError(`Capsule row ${row.entity_id} disagrees with capsule_json`);
    }
    const expectedAliases = expectedAliasIndex(capsule);
    const storedAliases = this.#aliasRows(entityId(row.entity_id));
    if (rowAliasIndexJson(storedAliases) !== rowAliasIndexJson(expectedAliases)) {
      throw new CorruptCapsuleCacheError(`Capsule alias index ${row.entity_id} disagrees with capsule_json`);
    }
    return capsule;
  }

  async get(id: EntityId): Promise<ContextCapsule | undefined> {
    const row = this.#db.prepare(`
      SELECT entity_id, materialized_at, configuration_version,
             change_cursor, next_temporal_boundary, capsule_json
      FROM context_capsules
      WHERE entity_id = ?
    `).get(id) as CapsuleRow | undefined;
    return row === undefined ? undefined : this.#validatedCapsuleRow(row);
  }

  async search(query: string, limit: number): Promise<readonly ContextCapsule[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Context capsule search limit must be an integer between 1 and 1000");
    }
    const normalizedQuery = normalizeEntityAlias(query);
    if (normalizedQuery.length === 0) return [];
    const tokenLength = normalizedQuery.split(" ").length;
    const lengths = this.#db.prepare(`
      SELECT DISTINCT token_count
      FROM context_capsule_aliases
      WHERE token_count <= ?
      ORDER BY token_count
    `).all(tokenLength) as unknown as { readonly token_count: number | bigint }[];
    const ngrams = queryNgrams(
      normalizedQuery,
      lengths.map((row) => Number(row.token_count)),
    );
    if (ngrams.length === 0) return [];
    const rows = this.#db.prepare(`
      WITH query_aliases AS (
        SELECT value AS normalized_alias
        FROM json_each(?)
      ), candidate_scores AS (
        SELECT a.entity_id, MAX(a.alias_score) AS score
        FROM context_capsule_aliases a
        JOIN query_aliases q ON q.normalized_alias = a.normalized_alias
        GROUP BY a.entity_id
        ORDER BY score DESC, a.entity_id ASC
        LIMIT ?
      )
      SELECT c.entity_id, c.materialized_at, c.configuration_version,
             c.change_cursor, c.next_temporal_boundary, c.capsule_json
      FROM candidate_scores s
      JOIN context_capsules c ON c.entity_id = s.entity_id
      ORDER BY s.score DESC, c.entity_id ASC
    `).all(canonicalJson(ngrams), limit) as unknown as CapsuleRow[];
    return rows.map((row) => this.#validatedCapsuleRow(row));
  }

  async put(capsule: ContextCapsule): Promise<CapsuleWriteResult> {
    const json = contextCapsuleJson(capsule);
    const aliases = expectedAliasIndex(capsule);
    return this.#transaction(() => {
      const previous = this.#db.prepare(`
        SELECT entity_id, materialized_at, configuration_version,
               change_cursor, next_temporal_boundary, capsule_json
        FROM context_capsules
        WHERE entity_id = ?
      `).get(capsule.entityId) as CapsuleRow | undefined;
      let result: CapsuleWriteResult = "inserted";
      if (previous !== undefined) {
        const parsed = this.#validatedCapsuleRow(previous);
        const sameMaterial = contextCapsuleMaterialJson(parsed.material)
          === contextCapsuleMaterialJson(capsule.material);
        result = sameMaterial && parsed.configurationVersion === capsule.configurationVersion
          ? "unchanged"
          : "updated";
      }
      this.#db.prepare(`
        INSERT INTO context_capsules(
          entity_id, materialized_at, configuration_version,
          change_cursor, next_temporal_boundary, capsule_json
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_id) DO UPDATE SET
          materialized_at = excluded.materialized_at,
          configuration_version = excluded.configuration_version,
          change_cursor = excluded.change_cursor,
          next_temporal_boundary = excluded.next_temporal_boundary,
          capsule_json = excluded.capsule_json
      `).run(
        capsule.entityId,
        canonicalTimestamp(capsule.materializedAt, "capsule materializedAt"),
        capsule.configurationVersion,
        capsule.changeCursor ?? null,
        capsule.material.nextTemporalBoundary === undefined
          ? null
          : canonicalTimestamp(capsule.material.nextTemporalBoundary, "capsule nextTemporalBoundary"),
        json,
      );
      this.#db.prepare("DELETE FROM context_capsule_aliases WHERE entity_id = ?")
        .run(capsule.entityId);
      const insertAlias = this.#db.prepare(`
        INSERT INTO context_capsule_aliases(entity_id, normalized_alias, alias_score, token_count)
        VALUES (?, ?, ?, ?)
      `);
      for (const alias of aliases) {
        insertAlias.run(
          capsule.entityId,
          alias.normalized_alias,
          Number(alias.alias_score),
          Number(alias.token_count),
        );
      }
      return result;
    });
  }

  async delete(id: EntityId): Promise<boolean> {
    return this.#transaction(() => {
      const result = this.#db.prepare("DELETE FROM context_capsules WHERE entity_id = ?").run(id);
      return Number(result.changes) > 0;
    });
  }

  async checkpoint(): Promise<SemanticChangeCursor | undefined> {
    const row = this.#db.prepare(`
      SELECT cursor FROM context_capsule_checkpoint WHERE singleton = 1
    `).get() as CheckpointRow | undefined;
    return row?.cursor as SemanticChangeCursor | undefined;
  }

  async setCheckpoint(cursor: SemanticChangeCursor): Promise<void> {
    if (cursor.length === 0) throw new TypeError("Context capsule checkpoint must not be empty");
    this.#db.prepare(`
      INSERT INTO context_capsule_checkpoint(singleton, cursor)
      VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET cursor = excluded.cursor
    `).run(cursor);
  }

  async reset(): Promise<void> {
    this.#transaction(() => {
      this.#db.prepare("DELETE FROM context_capsule_aliases").run();
      this.#db.prepare("DELETE FROM context_capsules").run();
      this.#db.prepare("DELETE FROM context_capsule_checkpoint").run();
    });
  }

  async staleEntityIds(at: string, configurationVersion: string): Promise<readonly EntityId[]> {
    const normalizedAt = canonicalTimestamp(at, "capsule stale check time");
    if (configurationVersion.length === 0) {
      throw new TypeError("configurationVersion must not be empty");
    }
    const rows = this.#db.prepare(`
      SELECT entity_id
      FROM context_capsules
      WHERE configuration_version <> ?
         OR (next_temporal_boundary IS NOT NULL AND next_temporal_boundary <= ?)
      ORDER BY entity_id
    `).all(configurationVersion, normalizedAt) as unknown as { readonly entity_id: string }[];
    return rows.map((row) => entityId(row.entity_id));
  }

  close(): void {
    this.#db.close();
  }
}
