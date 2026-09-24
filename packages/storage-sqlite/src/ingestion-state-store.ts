import { DatabaseSync } from "node:sqlite";
import {
  FullSyncCompletionCollisionError,
  MappedProjectionCollisionError,
  SourceChangeCollisionError,
  canonicalSourceChangeDraftJson,
  canonicalSourceChangeJson,
  fullSyncGenerationId,
  mappedIngestionPlanJson,
  ingestionSourceKey,
  newFullSyncGeneration,
  normalizeSourceChange,
  normalizeSourceChangeDraft,
  parseMappedIngestionPlanJson,
  parseSourceChangeJson,
  parseResourceProjectionJson,
  resolvedSourceChangeMatchesDraft,
  resourceProjectionJson,
  sourceCheckpoint,
  type FullSyncGeneration,
  type MappedIngestionPlan,
  type IngestionSourceKey,
  type IngestionStateStore,
  type ResourceProjection,
  type SourceChange,
  type SourceChangeDraft,
  type SourceCheckpoint,
} from "@ssrl/ingestion";

const INGESTION_COMPONENT = "ingestion-state-store";
const INGESTION_SCHEMA_VERSION = 3;

export interface SQLiteIngestionStateStoreOptions {
  readonly path: string;
  readonly timeoutMs?: number;
  readonly wal?: boolean;
}

interface VersionRow {
  readonly schema_version: number | bigint;
}

interface CheckpointRow {
  readonly checkpoint: string;
}

interface ProjectionRow {
  readonly source_key: string;
  readonly external_type: string;
  readonly external_id: string;
  readonly deleted: number | bigint;
  readonly projection_json: string;
}

interface ReceiptRow {
  readonly provider_change_json: string;
  readonly resolved_change_json: string;
  readonly mapped_plan_json: string | null;
}

interface GenerationRow {
  readonly generation_id: string;
  readonly source_key: string;
  readonly observed_at: string;
  readonly status: string;
  readonly final_checkpoint: string | null;
}

export class UnsupportedIngestionStateSchemaError extends Error {
  constructor(readonly found: number, readonly supported: number) {
    super(`Ingestion state schema version ${found} is newer than supported version ${supported}`);
    this.name = "UnsupportedIngestionStateSchemaError";
  }
}

export class CorruptIngestionStateDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptIngestionStateDatabaseError";
  }
}

export class SharedSQLiteIngestionDatabaseNotSupportedError extends Error {
  constructor(readonly conflictingTable: string) {
    super(`Ingestion state store requires a dedicated SQLite database; found ${conflictingTable}`);
    this.name = "SharedSQLiteIngestionDatabaseNotSupportedError";
  }
}

function bool(value: number | bigint, label: string): boolean {
  const numeric = Number(value);
  if (numeric !== 0 && numeric !== 1) {
    throw new CorruptIngestionStateDatabaseError(`${label} must be 0 or 1`);
  }
  return numeric === 1;
}

function generation(row: GenerationRow): FullSyncGeneration {
  const sourceKey = ingestionSourceKey(row.source_key);
  const observedAtMillis = Date.parse(row.observed_at);
  if (!Number.isFinite(observedAtMillis)) {
    throw new CorruptIngestionStateDatabaseError(`Generation ${row.generation_id} observedAt is invalid`);
  }
  const observedAt = new Date(observedAtMillis).toISOString();
  if (row.status !== "active" && row.status !== "completed") {
    throw new CorruptIngestionStateDatabaseError(`Generation ${row.generation_id} status is invalid`);
  }
  if (row.status === "active" && row.final_checkpoint !== null) {
    throw new CorruptIngestionStateDatabaseError(`Active generation ${row.generation_id} has final checkpoint`);
  }
  if (row.status === "completed" && (row.final_checkpoint === null || row.final_checkpoint.length === 0)) {
    throw new CorruptIngestionStateDatabaseError(`Completed generation ${row.generation_id} lacks final checkpoint`);
  }
  if (row.generation_id !== fullSyncGenerationId(sourceKey, observedAt)) {
    throw new CorruptIngestionStateDatabaseError(`Generation ${row.generation_id} id disagrees with content`);
  }
  return { id: row.generation_id, sourceKey, observedAt };
}

export class SQLiteIngestionStateStore implements IngestionStateStore {
  readonly #db: DatabaseSync;

  constructor(options: SQLiteIngestionStateStoreOptions) {
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
    const conflicting = this.#db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('runtime_events', 'semantic_state_meta', 'semantic_entities')
      ORDER BY name
      LIMIT 1
    `).get() as { readonly name: string } | undefined;
    if (conflicting !== undefined) {
      throw new SharedSQLiteIngestionDatabaseNotSupportedError(conflicting.name);
    }

    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS ingestion_state_meta (
        component TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL
      ) STRICT;
    `);
    const versionRow = this.#db.prepare(`
      SELECT schema_version
      FROM ingestion_state_meta
      WHERE component = ?
    `).get(INGESTION_COMPONENT) as VersionRow | undefined;

    if (versionRow === undefined) {
      this.#createFreshSchema();
      return;
    }
    const version = Number(versionRow.schema_version);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new CorruptIngestionStateDatabaseError(
        `Invalid ingestion state schema version ${String(versionRow.schema_version)}`,
      );
    }
    if (version > INGESTION_SCHEMA_VERSION) {
      throw new UnsupportedIngestionStateSchemaError(version, INGESTION_SCHEMA_VERSION);
    }
    if (version === INGESTION_SCHEMA_VERSION) return;
    if (version === 1) {
      this.#migrateV1ToV2();
      this.#migrateV2ToV3();
      return;
    }
    if (version === 2) {
      this.#migrateV2ToV3();
      return;
    }
    throw new CorruptIngestionStateDatabaseError(`Unsupported ingestion state schema version ${version}`);
  }

  #createFreshSchema(): void {
    const preexisting = this.#db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name IN (
          'ingestion_checkpoints',
          'ingestion_projections',
          'ingestion_change_receipts',
          'ingestion_full_sync_generations',
          'ingestion_full_sync_seen'
        )
      ORDER BY name
      LIMIT 1
    `).get() as { readonly name: string } | undefined;
    if (preexisting !== undefined) {
      throw new CorruptIngestionStateDatabaseError(
        `Ingestion tables exist without schema marker: ${preexisting.name}`,
      );
    }

    this.#transaction(() => {
      this.#db.exec(`
        CREATE TABLE ingestion_checkpoints (
          source_key TEXT PRIMARY KEY,
          checkpoint TEXT NOT NULL
        ) STRICT;

        CREATE TABLE ingestion_projections (
          source_key TEXT NOT NULL,
          external_type TEXT NOT NULL,
          external_id TEXT NOT NULL,
          deleted INTEGER NOT NULL CHECK(deleted IN (0, 1)),
          projection_json TEXT NOT NULL CHECK(json_valid(projection_json)),
          PRIMARY KEY(source_key, external_type, external_id)
        ) STRICT;

        CREATE INDEX ingestion_projections_source_deleted
          ON ingestion_projections(source_key, deleted, external_type, external_id);

        CREATE TABLE ingestion_change_receipts (
          source_key TEXT NOT NULL,
          change_id TEXT NOT NULL,
          provider_change_json TEXT NOT NULL CHECK(json_valid(provider_change_json)),
          resolved_change_json TEXT NOT NULL CHECK(json_valid(resolved_change_json)),
          mapped_plan_json TEXT CHECK(mapped_plan_json IS NULL OR json_valid(mapped_plan_json)),
          PRIMARY KEY(source_key, change_id)
        ) STRICT;

        CREATE TABLE ingestion_full_sync_generations (
          generation_id TEXT PRIMARY KEY,
          source_key TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active', 'completed')),
          final_checkpoint TEXT
        ) STRICT;

        CREATE UNIQUE INDEX ingestion_one_active_generation_per_source
          ON ingestion_full_sync_generations(source_key)
          WHERE status = 'active';

        CREATE TABLE ingestion_full_sync_seen (
          generation_id TEXT NOT NULL
            REFERENCES ingestion_full_sync_generations(generation_id) ON DELETE CASCADE,
          external_type TEXT NOT NULL,
          external_id TEXT NOT NULL,
          PRIMARY KEY(generation_id, external_type, external_id)
        ) STRICT;
      `);
      this.#db.prepare(`
        INSERT INTO ingestion_state_meta(component, schema_version)
        VALUES (?, ?)
      `).run(INGESTION_COMPONENT, INGESTION_SCHEMA_VERSION);
    });
  }

  #migrateV1ToV2(): void {
    this.#transaction(() => {
      this.#db.exec(`
        ALTER TABLE ingestion_change_receipts RENAME TO ingestion_change_receipts_v1;

        CREATE TABLE ingestion_change_receipts (
          source_key TEXT NOT NULL,
          change_id TEXT NOT NULL,
          provider_change_json TEXT NOT NULL CHECK(json_valid(provider_change_json)),
          resolved_change_json TEXT NOT NULL CHECK(json_valid(resolved_change_json)),
          projection_json TEXT CHECK(projection_json IS NULL OR json_valid(projection_json)),
          PRIMARY KEY(source_key, change_id)
        ) STRICT;

        INSERT INTO ingestion_change_receipts(
          source_key,
          change_id,
          provider_change_json,
          resolved_change_json,
          projection_json
        )
        SELECT source_key, change_id, change_json, change_json, projection_json
        FROM ingestion_change_receipts_v1;

        DROP TABLE ingestion_change_receipts_v1;
      `);
      this.#db.prepare(`
        UPDATE ingestion_state_meta
        SET schema_version = ?
        WHERE component = ?
      `).run(2, INGESTION_COMPONENT);
    });
  }

  #migrateV2ToV3(): void {
    this.#transaction(() => {
      this.#db.exec(`
        ALTER TABLE ingestion_change_receipts RENAME TO ingestion_change_receipts_v2;

        CREATE TABLE ingestion_change_receipts (
          source_key TEXT NOT NULL,
          change_id TEXT NOT NULL,
          provider_change_json TEXT NOT NULL CHECK(json_valid(provider_change_json)),
          resolved_change_json TEXT NOT NULL CHECK(json_valid(resolved_change_json)),
          mapped_plan_json TEXT CHECK(mapped_plan_json IS NULL OR json_valid(mapped_plan_json)),
          PRIMARY KEY(source_key, change_id)
        ) STRICT;
      `);
      const rows = this.#db.prepare(`
        SELECT source_key, change_id, provider_change_json, resolved_change_json, projection_json
        FROM ingestion_change_receipts_v2
        ORDER BY source_key, change_id
      `).all() as unknown as {
        readonly source_key: string;
        readonly change_id: string;
        readonly provider_change_json: string;
        readonly resolved_change_json: string;
        readonly projection_json: string | null;
      }[];
      const insert = this.#db.prepare(`
        INSERT INTO ingestion_change_receipts(
          source_key, change_id, provider_change_json, resolved_change_json, mapped_plan_json
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const row of rows) {
        let planJson: string | null = null;
        if (row.projection_json !== null) {
          let semantic;
          try {
            semantic = JSON.parse(row.projection_json) as unknown;
          } catch {
            throw new CorruptIngestionStateDatabaseError(
              `Mapped projection ${row.source_key}/${row.change_id} is invalid JSON`,
            );
          }
          try {
            planJson = mappedIngestionPlanJson({
              semantic: semantic as never,
              artifactAction: { kind: "preserve" },
            });
          } catch (cause) {
            throw new CorruptIngestionStateDatabaseError(
              cause instanceof Error ? cause.message : "Mapped projection is invalid",
            );
          }
        }
        insert.run(
          row.source_key,
          row.change_id,
          row.provider_change_json,
          row.resolved_change_json,
          planJson,
        );
      }
      this.#db.exec("DROP TABLE ingestion_change_receipts_v2");
      this.#db.prepare(`
        UPDATE ingestion_state_meta
        SET schema_version = ?
        WHERE component = ?
      `).run(INGESTION_SCHEMA_VERSION, INGESTION_COMPONENT);
    });
  }

  async checkpoint(sourceKey: IngestionSourceKey): Promise<SourceCheckpoint | undefined> {
    const row = this.#db.prepare(`
      SELECT checkpoint FROM ingestion_checkpoints WHERE source_key = ?
    `).get(sourceKey) as CheckpointRow | undefined;
    return row === undefined ? undefined : sourceCheckpoint(row.checkpoint);
  }

  async setCheckpoint(sourceKey: IngestionSourceKey, checkpoint: SourceCheckpoint): Promise<void> {
    this.#db.prepare(`
      INSERT INTO ingestion_checkpoints(source_key, checkpoint)
      VALUES (?, ?)
      ON CONFLICT(source_key) DO UPDATE SET checkpoint = excluded.checkpoint
    `).run(sourceKey, checkpoint);
  }

  #projectionRow(row: ProjectionRow): ResourceProjection {
    let projection: ResourceProjection;
    try {
      projection = parseResourceProjectionJson(row.projection_json);
    } catch (cause) {
      throw new CorruptIngestionStateDatabaseError(
        cause instanceof Error ? cause.message : "Projection JSON is invalid",
      );
    }
    if (
      projection.sourceKey !== row.source_key
      || projection.externalType !== row.external_type
      || projection.externalId !== row.external_id
      || projection.deleted !== bool(row.deleted, `Projection ${row.external_id} deleted`)
      || resourceProjectionJson(projection) !== row.projection_json
    ) {
      throw new CorruptIngestionStateDatabaseError(
        `Projection ${row.source_key}/${row.external_type}/${row.external_id} disagrees with indexed columns`,
      );
    }
    return projection;
  }

  async projection(
    sourceKey: IngestionSourceKey,
    externalType: string,
    externalId: string,
  ): Promise<ResourceProjection | undefined> {
    const row = this.#db.prepare(`
      SELECT source_key, external_type, external_id, deleted, projection_json
      FROM ingestion_projections
      WHERE source_key = ? AND external_type = ? AND external_id = ?
    `).get(sourceKey, externalType, externalId) as ProjectionRow | undefined;
    return row === undefined ? undefined : this.#projectionRow(row);
  }

  async putProjection(projection: ResourceProjection): Promise<void> {
    const json = resourceProjectionJson(projection);
    const normalized = parseResourceProjectionJson(json);
    this.#db.prepare(`
      INSERT INTO ingestion_projections(
        source_key, external_type, external_id, deleted, projection_json
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_key, external_type, external_id) DO UPDATE SET
        deleted = excluded.deleted,
        projection_json = excluded.projection_json
    `).run(
      normalized.sourceKey,
      normalized.externalType,
      normalized.externalId,
      normalized.deleted ? 1 : 0,
      json,
    );
  }

  async listProjections(sourceKey: IngestionSourceKey): Promise<readonly ResourceProjection[]> {
    const rows = this.#db.prepare(`
      SELECT source_key, external_type, external_id, deleted, projection_json
      FROM ingestion_projections
      WHERE source_key = ?
      ORDER BY external_type, external_id
    `).all(sourceKey) as unknown as ProjectionRow[];
    return rows.map((row) => this.#projectionRow(row));
  }

  #receiptRow(sourceKey: IngestionSourceKey, changeId: string): ReceiptRow | undefined {
    return this.#db.prepare(`
      SELECT provider_change_json, resolved_change_json, mapped_plan_json
      FROM ingestion_change_receipts
      WHERE source_key = ? AND change_id = ?
    `).get(sourceKey, changeId) as ReceiptRow | undefined;
  }

  #resolvedReceipt<TPayload>(
    sourceKey: IngestionSourceKey,
    draft: SourceChangeDraft<TPayload>,
    row: ReceiptRow,
  ): SourceChange<TPayload> {
    const providerJson = canonicalSourceChangeDraftJson(draft);
    if (row.provider_change_json !== providerJson) {
      throw new SourceChangeCollisionError(sourceKey, draft.changeId);
    }
    let resolved: SourceChange<TPayload>;
    try {
      resolved = parseSourceChangeJson<TPayload>(row.resolved_change_json);
    } catch (cause) {
      throw new CorruptIngestionStateDatabaseError(
        cause instanceof Error ? cause.message : "Resolved source change JSON is invalid",
      );
    }
    if (!resolvedSourceChangeMatchesDraft(draft, resolved)) {
      throw new CorruptIngestionStateDatabaseError(
        `Resolved source change disagrees with provider receipt ${draft.changeId}`,
      );
    }
    return resolved;
  }

  async changeReceipt<TPayload>(
    sourceKey: IngestionSourceKey,
    change: SourceChangeDraft<TPayload>,
  ): Promise<SourceChange<TPayload> | undefined> {
    const draft = normalizeSourceChangeDraft(change);
    const row = this.#receiptRow(sourceKey, draft.changeId);
    return row === undefined ? undefined : this.#resolvedReceipt(sourceKey, draft, row);
  }

  async putChangeReceipt<TPayload>(
    sourceKey: IngestionSourceKey,
    change: SourceChangeDraft<TPayload>,
    resolved: SourceChange<TPayload>,
  ): Promise<SourceChange<TPayload>> {
    const draft = normalizeSourceChangeDraft(change);
    const normalizedResolved = normalizeSourceChange(resolved);
    if (!resolvedSourceChangeMatchesDraft(draft, normalizedResolved)) {
      throw new SourceChangeCollisionError(sourceKey, draft.changeId);
    }
    const existing = this.#receiptRow(sourceKey, draft.changeId);
    if (existing !== undefined) return this.#resolvedReceipt(sourceKey, draft, existing);

    const providerJson = canonicalSourceChangeDraftJson(draft);
    const resolvedJson = canonicalSourceChangeJson(normalizedResolved);
    try {
      this.#db.prepare(`
        INSERT INTO ingestion_change_receipts(
          source_key,
          change_id,
          provider_change_json,
          resolved_change_json,
          mapped_plan_json
        ) VALUES (?, ?, ?, ?, NULL)
      `).run(sourceKey, draft.changeId, providerJson, resolvedJson);
      return normalizedResolved;
    } catch (cause) {
      const raced = this.#receiptRow(sourceKey, draft.changeId);
      if (raced !== undefined) return this.#resolvedReceipt(sourceKey, draft, raced);
      throw cause;
    }
  }

  async mappedPlan(
    sourceKey: IngestionSourceKey,
    changeId: string,
  ): Promise<MappedIngestionPlan | undefined> {
    const row = this.#db.prepare(`
      SELECT provider_change_json, resolved_change_json, mapped_plan_json
      FROM ingestion_change_receipts
      WHERE source_key = ? AND change_id = ?
    `).get(sourceKey, changeId) as ReceiptRow | undefined;
    if (row?.mapped_plan_json == null) return undefined;
    try {
      return parseMappedIngestionPlanJson(row.mapped_plan_json);
    } catch (cause) {
      throw new CorruptIngestionStateDatabaseError(
        cause instanceof Error ? cause.message : "Mapped ingestion plan JSON is invalid",
      );
    }
  }

  async putMappedPlan(
    sourceKey: IngestionSourceKey,
    changeId: string,
    plan: MappedIngestionPlan,
  ): Promise<"inserted" | "existing"> {
    const json = mappedIngestionPlanJson(plan);
    const row = this.#db.prepare(`
      SELECT provider_change_json, resolved_change_json, mapped_plan_json
      FROM ingestion_change_receipts
      WHERE source_key = ? AND change_id = ?
    `).get(sourceKey, changeId) as ReceiptRow | undefined;
    if (row === undefined) {
      throw new Error(`Cannot persist mapped ingestion plan before source change receipt ${changeId}`);
    }
    if (row.mapped_plan_json !== null) {
      if (row.mapped_plan_json !== json) {
        throw new MappedProjectionCollisionError(sourceKey, changeId);
      }
      return "existing";
    }
    const updated = this.#db.prepare(`
      UPDATE ingestion_change_receipts
      SET mapped_plan_json = ?
      WHERE source_key = ? AND change_id = ? AND mapped_plan_json IS NULL
    `).run(json, sourceKey, changeId);
    if (Number(updated.changes) === 1) return "inserted";

    const raced = this.#db.prepare(`
      SELECT provider_change_json, resolved_change_json, mapped_plan_json
      FROM ingestion_change_receipts
      WHERE source_key = ? AND change_id = ?
    `).get(sourceKey, changeId) as ReceiptRow | undefined;
    if (raced?.mapped_plan_json === json) return "existing";
    throw new MappedProjectionCollisionError(sourceKey, changeId);
  }

  async activeFullSyncGeneration(
    sourceKey: IngestionSourceKey,
  ): Promise<FullSyncGeneration | undefined> {
    const row = this.#db.prepare(`
      SELECT generation_id, source_key, observed_at, status, final_checkpoint
      FROM ingestion_full_sync_generations
      WHERE source_key = ? AND status = 'active'
    `).get(sourceKey) as GenerationRow | undefined;
    return row === undefined ? undefined : generation(row);
  }

  #insertFullSyncGeneration(value: FullSyncGeneration): FullSyncGeneration {
    this.#db.prepare(`
      INSERT INTO ingestion_full_sync_generations(
        generation_id, source_key, observed_at, status, final_checkpoint
      ) VALUES (?, ?, ?, 'active', NULL)
    `).run(value.id, value.sourceKey, value.observedAt);
    return value;
  }

  async beginFullSyncGeneration(
    sourceKey: IngestionSourceKey,
    observedAt: string,
  ): Promise<FullSyncGeneration> {
    const active = await this.activeFullSyncGeneration(sourceKey);
    return active ?? this.#insertFullSyncGeneration(newFullSyncGeneration(sourceKey, observedAt));
  }

  #generationRowById(generationId: string): GenerationRow {
    const row = this.#db.prepare(`
      SELECT generation_id, source_key, observed_at, status, final_checkpoint
      FROM ingestion_full_sync_generations
      WHERE generation_id = ?
    `).get(generationId) as GenerationRow | undefined;
    if (row === undefined) throw new Error(`Unknown full sync generation ${generationId}`);
    generation(row);
    return row;
  }

  #activeGenerationById(generationId: string): FullSyncGeneration {
    const row = this.#generationRowById(generationId);
    if (row.status !== "active") throw new Error(`Full sync generation ${generationId} is completed`);
    return generation(row);
  }

  async markSeen(generationId: string, externalType: string, externalId: string): Promise<void> {
    this.#activeGenerationById(generationId);
    this.#db.prepare(`
      INSERT INTO ingestion_full_sync_seen(generation_id, external_type, external_id)
      VALUES (?, ?, ?)
      ON CONFLICT(generation_id, external_type, external_id) DO NOTHING
    `).run(generationId, externalType, externalId);
  }

  async unseenProjections(generationId: string): Promise<readonly ResourceProjection[]> {
    const current = this.#activeGenerationById(generationId);
    const rows = this.#db.prepare(`
      SELECT p.source_key, p.external_type, p.external_id, p.deleted, p.projection_json
      FROM ingestion_projections p
      LEFT JOIN ingestion_full_sync_seen s
        ON s.generation_id = ?
       AND s.external_type = p.external_type
       AND s.external_id = p.external_id
      WHERE p.source_key = ?
        AND s.generation_id IS NULL
      ORDER BY p.external_type, p.external_id
    `).all(generationId, current.sourceKey) as unknown as ProjectionRow[];
    return rows.map((row) => this.#projectionRow(row));
  }

  async completeFullSyncGeneration(
    generationId: string,
    checkpoint: SourceCheckpoint,
  ): Promise<void> {
    const row = this.#generationRowById(generationId);
    if (row.status === "completed") {
      if (row.final_checkpoint !== checkpoint) {
        throw new FullSyncCompletionCollisionError(generationId);
      }
      return;
    }
    const current = generation(row);
    this.#transaction(() => {
      this.#db.prepare(`
        INSERT INTO ingestion_checkpoints(source_key, checkpoint)
        VALUES (?, ?)
        ON CONFLICT(source_key) DO UPDATE SET checkpoint = excluded.checkpoint
      `).run(current.sourceKey, checkpoint);
      const updated = this.#db.prepare(`
        UPDATE ingestion_full_sync_generations
        SET status = 'completed', final_checkpoint = ?
        WHERE generation_id = ? AND status = 'active'
      `).run(checkpoint, generationId);
      if (Number(updated.changes) !== 1) {
        throw new Error(`Full sync generation ${generationId} changed during completion`);
      }
      this.#db.prepare(`
        DELETE FROM ingestion_full_sync_seen WHERE generation_id = ?
      `).run(generationId);
    });
  }

  close(): void {
    this.#db.close();
  }
}
