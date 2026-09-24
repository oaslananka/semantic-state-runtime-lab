import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  normalizeEntityAlias,
  type EntityId,
  type TemporalObservation,
  type TemporalRelationEdge,
} from "@ssrl/core";
import {
  CorruptSemanticStateError,
  InvalidSemanticChangeCursorError,
  SEMANTIC_STATE_SNAPSHOT_SCHEMA,
  SemanticRecordCollisionError,
  UnknownSemanticEntityError,
  entityAliasJson,
  normalizeEntityAliasRecord,
  normalizeSemanticEntity,
  normalizeTemporalObservation,
  normalizeTemporalRelation,
  parseEntityAliasJson,
  parseSemanticEntityJson,
  parseTemporalObservationJson,
  parseTemporalRelationJson,
  semanticEntityJson,
  temporalObservationJson,
  temporalRelationJson,
  type AliasLookupResult,
  type EntityAliasRecord,
  type SemanticAppendCounts,
  type SemanticChange,
  type SemanticChangeCursor,
  type SemanticChangePage,
  type SemanticEntity,
  type SemanticStateBatch,
  type SemanticRecordKind,
  type SemanticStateSnapshot,
  type SemanticStateStore,
} from "@ssrl/state-store";

const STATE_STORE_COMPONENT = "semantic-state-store";
const STATE_STORE_SCHEMA_VERSION = 2;
const CHANGE_CURSOR_PREFIX = "sqlite-semantic-v1:";

export interface SQLiteSemanticStateStoreOptions {
  readonly path: string;
  readonly timeoutMs?: number;
  /** Optional same-host reader concurrency optimization. Not a sync/replication format. */
  readonly wal?: boolean;
}

interface VersionRow {
  readonly schema_version: number | bigint;
}

interface JsonRow {
  readonly record_json: string;
}

interface EntityRow extends JsonRow {
  readonly entity_id: string;
  readonly entity_type: string;
}

interface AliasRow extends JsonRow {
  readonly alias_id: string;
  readonly entity_id: string;
  readonly alias_value: string;
  readonly normalized_value: string;
  readonly recorded_at: string;
}

interface ObservationRow extends JsonRow {
  readonly observation_id: string;
  readonly entity_id: string;
  readonly property: string;
  readonly provider: string;
  readonly external_id: string;
  readonly valid_from: string;
  readonly valid_to: string | null;
  readonly recorded_at: string;
}

interface RelationRow extends JsonRow {
  readonly relation_id: string;
  readonly from_entity_id: string;
  readonly to_entity_id: string;
  readonly relation_type: string;
  readonly valid_from: string;
  readonly valid_to: string | null;
  readonly recorded_at: string;
}

interface AliasLookupRow {
  readonly alias_json: string;
  readonly entity_json: string;
  readonly normalized_value: string;
}


interface ChangeRow {
  readonly sequence_text: string;
  readonly record_kind: string;
  readonly record_id: string;
  readonly primary_entity_id: string;
  readonly affected_entity_ids_json: string;
}

export class UnsupportedSemanticStateSchemaError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(`Semantic state schema version ${found} is newer than supported version ${supported}`);
    this.name = "UnsupportedSemanticStateSchemaError";
  }
}

export class CorruptSemanticStateDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptSemanticStateDatabaseError";
  }
}

export class SharedSQLiteDatabaseNotSupportedError extends Error {
  constructor(readonly conflictingTable: string) {
    super(`Semantic state store requires a dedicated SQLite database; found ${conflictingTable}`);
    this.name = "SharedSQLiteDatabaseNotSupportedError";
  }
}

function asEntityId(value: string): EntityId {
  return value as EntityId;
}

function sameNullable(left: string | null, right: string | undefined): boolean {
  return left === (right ?? null);
}

function entityRow(row: EntityRow): SemanticEntity {
  const parsed = parseSemanticEntityJson(row.record_json);
  if (parsed.entityId !== row.entity_id || parsed.entityType !== row.entity_type) {
    throw new CorruptSemanticStateError(`Semantic entity row ${row.entity_id} disagrees with record_json`);
  }
  return parsed;
}

function aliasRow(row: AliasRow): EntityAliasRecord {
  const parsed = parseEntityAliasJson(row.record_json);
  if (
    parsed.id !== row.alias_id
    || parsed.entityId !== row.entity_id
    || parsed.value !== row.alias_value
    || normalizeEntityAlias(parsed.value) !== row.normalized_value
    || parsed.recordedAt !== row.recorded_at
  ) {
    throw new CorruptSemanticStateError(`Semantic alias row ${row.alias_id} disagrees with record_json`);
  }
  return parsed;
}

function observationRow(row: ObservationRow): TemporalObservation {
  const parsed = parseTemporalObservationJson(row.record_json);
  if (
    parsed.id !== row.observation_id
    || parsed.entityId !== row.entity_id
    || parsed.property !== row.property
    || parsed.source.provider !== row.provider
    || parsed.source.externalId !== row.external_id
    || parsed.validFrom !== row.valid_from
    || !sameNullable(row.valid_to, parsed.validTo)
    || parsed.recordedAt !== row.recorded_at
  ) {
    throw new CorruptSemanticStateError(
      `Temporal observation row ${row.observation_id} disagrees with record_json`,
    );
  }
  return parsed;
}

function relationRow(row: RelationRow): TemporalRelationEdge {
  const parsed = parseTemporalRelationJson(row.record_json);
  if (
    parsed.id !== row.relation_id
    || parsed.from !== row.from_entity_id
    || parsed.to !== row.to_entity_id
    || parsed.relationType !== row.relation_type
    || parsed.validFrom !== row.valid_from
    || !sameNullable(row.valid_to, parsed.validTo)
    || parsed.recordedAt !== row.recorded_at
  ) {
    throw new CorruptSemanticStateError(`Temporal relation row ${row.relation_id} disagrees with record_json`);
  }
  return parsed;
}

function semanticRecordKind(value: string): SemanticRecordKind {
  if (value === "entity" || value === "alias" || value === "observation" || value === "relation") {
    return value;
  }
  throw new CorruptSemanticStateError(`Unknown semantic change record kind ${value}`);
}

function affectedEntityIdsJson(entityIds: readonly EntityId[]): string {
  return canonicalJson([...new Set(entityIds)].sort((left, right) => left.localeCompare(right)));
}

function parseAffectedEntityIds(value: string): EntityId[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new CorruptSemanticStateError("Semantic change affected entities are not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new CorruptSemanticStateError("Semantic change affected entities must be an array");
  }
  const ids = parsed.map((item) => {
    if (typeof item !== "string" || !item.startsWith("entity://") || item.length <= "entity://".length) {
      throw new CorruptSemanticStateError("Semantic change contains an invalid entity id");
    }
    return item as EntityId;
  });
  const canonical = [...new Set(ids)].sort((left, right) => left.localeCompare(right));
  if (canonicalJson(canonical) !== value) {
    throw new CorruptSemanticStateError("Semantic change affected entities are not canonical");
  }
  return canonical;
}

function cursorForSequence(feedId: string, sequenceText: string): SemanticChangeCursor {
  return `${CHANGE_CURSOR_PREFIX}${feedId}:${sequenceText}` as SemanticChangeCursor;
}

function sequenceAfter(cursor: SemanticChangeCursor | undefined, feedId: string): bigint {
  if (cursor === undefined) return 0n;
  const prefix = `${CHANGE_CURSOR_PREFIX}${feedId}:`;
  if (!cursor.startsWith(prefix)) throw new InvalidSemanticChangeCursorError(cursor);
  const raw = cursor.slice(prefix.length);
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) throw new InvalidSemanticChangeCursorError(cursor);
  try {
    return BigInt(raw);
  } catch {
    throw new InvalidSemanticChangeCursorError(cursor);
  }
}

function semanticChange(row: ChangeRow, feedId: string): SemanticChange {
  return {
    cursor: cursorForSequence(feedId, row.sequence_text),
    kind: semanticRecordKind(row.record_kind),
    recordId: row.record_id,
    primaryEntityId: asEntityId(row.primary_entity_id),
    affectedEntityIds: parseAffectedEntityIds(row.affected_entity_ids_json),
  };
}

function semanticTableNames(): readonly string[] {
  return [
    "semantic_entities",
    "semantic_aliases",
    "semantic_observations",
    "semantic_relations",
    "semantic_change_feed_meta",
    "semantic_changes",
  ];
}

export class SQLiteSemanticStateStore implements SemanticStateStore {
  readonly #db: DatabaseSync;
  readonly #feedId: string;

  constructor(options: SQLiteSemanticStateStoreOptions) {
    this.#db = new DatabaseSync(options.path, {
      timeout: options.timeoutMs ?? 5_000,
      defensive: true,
    });
    try {
      this.#db.exec("PRAGMA foreign_keys = ON");
      if (options.wal === true) this.#db.exec("PRAGMA journal_mode = WAL");
      this.#initialize();
      this.#feedId = this.#readFeedId();
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
    const runtimeJournal = this.#db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'runtime_events'
    `).get() as { readonly name: string } | undefined;
    if (runtimeJournal !== undefined) {
      throw new SharedSQLiteDatabaseNotSupportedError(runtimeJournal.name);
    }

    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_state_meta (
        component TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL
      ) STRICT;
    `);
    const versionRow = this.#db.prepare(`
      SELECT schema_version
      FROM semantic_state_meta
      WHERE component = ?
    `).get(STATE_STORE_COMPONENT) as VersionRow | undefined;

    if (versionRow === undefined) {
      this.#createFreshSchema();
      return;
    }

    const version = Number(versionRow.schema_version);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new CorruptSemanticStateDatabaseError(
        `Invalid semantic state schema version ${String(versionRow.schema_version)}`,
      );
    }
    if (version > STATE_STORE_SCHEMA_VERSION) {
      throw new UnsupportedSemanticStateSchemaError(version, STATE_STORE_SCHEMA_VERSION);
    }
    if (version === STATE_STORE_SCHEMA_VERSION) return;
    if (version === 1) {
      this.#migrateV1ToV2();
      return;
    }
    throw new CorruptSemanticStateDatabaseError(`Unsupported semantic state schema version ${version}`);
  }

  #assertFreshSemanticTables(): void {
    const names = semanticTableNames();
    const existing = this.#db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name IN (?, ?, ?, ?, ?, ?)
      ORDER BY name
    `).all(...names) as unknown as { readonly name: string }[];
    if (existing.length > 0) {
      throw new CorruptSemanticStateDatabaseError(
        `Semantic state tables exist without a schema marker: ${existing.map((row) => row.name).join(", ")}`,
      );
    }
  }

  #createChangeFeedMeta(): void {
    this.#db.exec(`
      CREATE TABLE semantic_change_feed_meta (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        feed_id TEXT NOT NULL UNIQUE
      ) STRICT;
    `);
    this.#db.prepare(`
      INSERT INTO semantic_change_feed_meta(singleton, feed_id)
      VALUES (1, ?)
    `).run(randomUUID());
  }

  #readFeedId(): string {
    const row = this.#db.prepare(`
      SELECT feed_id FROM semantic_change_feed_meta WHERE singleton = 1
    `).get() as { readonly feed_id: string } | undefined;
    if (row === undefined || row.feed_id.length === 0) {
      throw new CorruptSemanticStateDatabaseError("Semantic change feed id is missing");
    }
    return row.feed_id;
  }

  #createChangeTable(): void {
    this.#db.exec(`
      CREATE TABLE semantic_changes (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        record_kind TEXT NOT NULL CHECK(record_kind IN ('entity', 'alias', 'observation', 'relation')),
        record_id TEXT NOT NULL,
        primary_entity_id TEXT NOT NULL,
        affected_entity_ids_json TEXT NOT NULL CHECK(json_valid(affected_entity_ids_json)),
        UNIQUE(record_kind, record_id)
      ) STRICT;
    `);
  }

  #createFreshSchema(): void {
    this.#assertFreshSemanticTables();
    this.#transaction(() => {
      this.#db.exec(`
        CREATE TABLE semantic_entities (
          entity_id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL,
          record_json TEXT NOT NULL CHECK(json_valid(record_json))
        ) STRICT;

        CREATE TABLE semantic_aliases (
          alias_id TEXT PRIMARY KEY,
          entity_id TEXT NOT NULL REFERENCES semantic_entities(entity_id),
          alias_value TEXT NOT NULL,
          normalized_value TEXT NOT NULL,
          recorded_at TEXT NOT NULL,
          record_json TEXT NOT NULL CHECK(json_valid(record_json))
        ) STRICT;

        CREATE INDEX semantic_aliases_normalized
          ON semantic_aliases(normalized_value, entity_id, alias_id);

        CREATE TABLE semantic_observations (
          observation_id TEXT PRIMARY KEY,
          entity_id TEXT NOT NULL REFERENCES semantic_entities(entity_id),
          property TEXT NOT NULL,
          provider TEXT NOT NULL,
          external_id TEXT NOT NULL,
          valid_from TEXT NOT NULL,
          valid_to TEXT,
          recorded_at TEXT NOT NULL,
          record_json TEXT NOT NULL CHECK(json_valid(record_json))
        ) STRICT;

        CREATE INDEX semantic_observations_entity_time
          ON semantic_observations(entity_id, valid_from, recorded_at, observation_id);

        CREATE INDEX semantic_observations_entity_property_time
          ON semantic_observations(entity_id, property, valid_from, recorded_at, observation_id);

        CREATE TABLE semantic_relations (
          relation_id TEXT PRIMARY KEY,
          from_entity_id TEXT NOT NULL REFERENCES semantic_entities(entity_id),
          to_entity_id TEXT NOT NULL REFERENCES semantic_entities(entity_id),
          relation_type TEXT NOT NULL,
          valid_from TEXT NOT NULL,
          valid_to TEXT,
          recorded_at TEXT NOT NULL,
          record_json TEXT NOT NULL CHECK(json_valid(record_json))
        ) STRICT;

        CREATE INDEX semantic_relations_from_time
          ON semantic_relations(from_entity_id, valid_from, recorded_at, relation_id);

        CREATE INDEX semantic_relations_from_type_time
          ON semantic_relations(from_entity_id, relation_type, valid_from, recorded_at, relation_id);
      `);
      this.#createChangeFeedMeta();
      this.#createChangeTable();
      this.#db.prepare(`
        INSERT INTO semantic_state_meta(component, schema_version)
        VALUES (?, ?)
      `).run(STATE_STORE_COMPONENT, STATE_STORE_SCHEMA_VERSION);
    });
  }

  #recordChange(
    kind: SemanticRecordKind,
    recordId: string,
    primaryEntityId: EntityId,
    affectedEntityIds: readonly EntityId[],
  ): void {
    this.#db.prepare(`
      INSERT INTO semantic_changes(
        record_kind, record_id, primary_entity_id, affected_entity_ids_json
      ) VALUES (?, ?, ?, ?)
    `).run(kind, recordId, primaryEntityId, affectedEntityIdsJson(affectedEntityIds));
  }

  #bootstrapV1Changes(): void {
    const entities = this.#db.prepare(`
      SELECT entity_id FROM semantic_entities ORDER BY entity_id
    `).all() as unknown as { readonly entity_id: string }[];
    for (const row of entities) {
      const entityId = asEntityId(row.entity_id);
      this.#recordChange("entity", row.entity_id, entityId, [entityId]);
    }

    const aliases = this.#db.prepare(`
      SELECT alias_id, entity_id FROM semantic_aliases ORDER BY alias_id
    `).all() as unknown as { readonly alias_id: string; readonly entity_id: string }[];
    for (const row of aliases) {
      const entityId = asEntityId(row.entity_id);
      this.#recordChange("alias", row.alias_id, entityId, [entityId]);
    }

    const observations = this.#db.prepare(`
      SELECT observation_id, entity_id FROM semantic_observations ORDER BY observation_id
    `).all() as unknown as { readonly observation_id: string; readonly entity_id: string }[];
    for (const row of observations) {
      const entityId = asEntityId(row.entity_id);
      this.#recordChange("observation", row.observation_id, entityId, [entityId]);
    }

    const relations = this.#db.prepare(`
      SELECT relation_id, from_entity_id, to_entity_id
      FROM semantic_relations
      ORDER BY relation_id
    `).all() as unknown as {
      readonly relation_id: string;
      readonly from_entity_id: string;
      readonly to_entity_id: string;
    }[];
    for (const row of relations) {
      this.#recordChange("relation", row.relation_id, asEntityId(row.from_entity_id), [
        asEntityId(row.from_entity_id),
        asEntityId(row.to_entity_id),
      ]);
    }
  }

  #migrateV1ToV2(): void {
    const existing = this.#db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'semantic_changes'
    `).get() as { readonly name: string } | undefined;
    if (existing !== undefined) {
      throw new CorruptSemanticStateDatabaseError(
        "semantic_changes exists while schema marker is still v1",
      );
    }

    this.#transaction(() => {
      this.#createChangeFeedMeta();
      this.#createChangeTable();
      this.#bootstrapV1Changes();
      this.#db.prepare(`
        UPDATE semantic_state_meta
        SET schema_version = ?
        WHERE component = ?
      `).run(STATE_STORE_SCHEMA_VERSION, STATE_STORE_COMPONENT);
    });
  }

  #entityExists(entityId: EntityId): boolean {
    const row = this.#db.prepare(
      "SELECT 1 AS present FROM semantic_entities WHERE entity_id = ?",
    ).get(entityId) as { readonly present: number } | undefined;
    return row !== undefined;
  }

  #requireEntity(entityId: EntityId): void {
    if (!this.#entityExists(entityId)) throw new UnknownSemanticEntityError(entityId);
  }


  #isReplay(
    existing: JsonRow | undefined,
    kind: "entity" | "alias" | "observation" | "relation",
    id: string,
    json: string,
  ): boolean {
    if (existing === undefined) return false;
    if (existing.record_json !== json) throw new SemanticRecordCollisionError(kind, id);
    return true;
  }

  #appendEntities(entities: readonly SemanticEntity[]): number {
    const find = this.#db.prepare("SELECT record_json FROM semantic_entities WHERE entity_id = ?");
    const insert = this.#db.prepare(`
      INSERT INTO semantic_entities(entity_id, entity_type, record_json)
      VALUES (?, ?, ?)
    `);
    let inserted = 0;
    for (const entity of entities) {
      const json = semanticEntityJson(entity);
      const existing = find.get(entity.entityId) as JsonRow | undefined;
      if (this.#isReplay(existing, "entity", entity.entityId, json)) continue;
      insert.run(entity.entityId, entity.entityType, json);
      this.#recordChange("entity", entity.entityId, entity.entityId, [entity.entityId]);
      inserted += 1;
    }
    return inserted;
  }

  #appendAliases(aliases: readonly EntityAliasRecord[]): number {
    const find = this.#db.prepare("SELECT record_json FROM semantic_aliases WHERE alias_id = ?");
    const insert = this.#db.prepare(`
      INSERT INTO semantic_aliases(
        alias_id, entity_id, alias_value, normalized_value, recorded_at, record_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    for (const alias of aliases) {
      this.#requireEntity(alias.entityId);
      const json = entityAliasJson(alias);
      const existing = find.get(alias.id) as JsonRow | undefined;
      if (this.#isReplay(existing, "alias", alias.id, json)) continue;
      insert.run(
        alias.id,
        alias.entityId,
        alias.value,
        normalizeEntityAlias(alias.value),
        alias.recordedAt,
        json,
      );
      this.#recordChange("alias", alias.id, alias.entityId, [alias.entityId]);
      inserted += 1;
    }
    return inserted;
  }

  #appendObservations(observations: readonly TemporalObservation[]): number {
    const find = this.#db.prepare(
      "SELECT record_json FROM semantic_observations WHERE observation_id = ?",
    );
    const insert = this.#db.prepare(`
      INSERT INTO semantic_observations(
        observation_id, entity_id, property, provider, external_id,
        valid_from, valid_to, recorded_at, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    for (const observation of observations) {
      this.#requireEntity(observation.entityId);
      const json = temporalObservationJson(observation);
      const existing = find.get(observation.id) as JsonRow | undefined;
      if (this.#isReplay(existing, "observation", observation.id, json)) continue;
      insert.run(
        observation.id,
        observation.entityId,
        observation.property,
        observation.source.provider,
        observation.source.externalId,
        observation.validFrom,
        observation.validTo ?? null,
        observation.recordedAt,
        json,
      );
      this.#recordChange("observation", observation.id, observation.entityId, [observation.entityId]);
      inserted += 1;
    }
    return inserted;
  }

  #appendRelations(relations: readonly TemporalRelationEdge[]): number {
    const find = this.#db.prepare("SELECT record_json FROM semantic_relations WHERE relation_id = ?");
    const insert = this.#db.prepare(`
      INSERT INTO semantic_relations(
        relation_id, from_entity_id, to_entity_id, relation_type,
        valid_from, valid_to, recorded_at, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    for (const relation of relations) {
      this.#requireEntity(relation.from);
      this.#requireEntity(relation.to);
      const json = temporalRelationJson(relation);
      const existing = find.get(relation.id) as JsonRow | undefined;
      if (this.#isReplay(existing, "relation", relation.id, json)) continue;
      insert.run(
        relation.id,
        relation.from,
        relation.to,
        relation.relationType,
        relation.validFrom,
        relation.validTo ?? null,
        relation.recordedAt,
        json,
      );
      this.#recordChange("relation", relation.id, relation.from, [relation.from, relation.to]);
      inserted += 1;
    }
    return inserted;
  }

  async append(batch: SemanticStateBatch): Promise<SemanticAppendCounts> {
    const entities = (batch.entities ?? [])
      .map(normalizeSemanticEntity)
      .sort((left, right) => left.entityId.localeCompare(right.entityId));
    const aliases = (batch.aliases ?? [])
      .map(normalizeEntityAliasRecord)
      .sort((left, right) => left.id.localeCompare(right.id));
    const observations = (batch.observations ?? [])
      .map(normalizeTemporalObservation)
      .sort((left, right) => left.id.localeCompare(right.id));
    const relations = (batch.relations ?? [])
      .map(normalizeTemporalRelation)
      .sort((left, right) => left.id.localeCompare(right.id));

    return this.#transaction((): SemanticAppendCounts => ({
      entities: this.#appendEntities(entities),
      aliases: this.#appendAliases(aliases),
      observations: this.#appendObservations(observations),
      relations: this.#appendRelations(relations),
    }));
  }

  async snapshot(): Promise<SemanticStateSnapshot> {
    const entities = this.#db.prepare(`
      SELECT entity_id, entity_type, record_json
      FROM semantic_entities
      ORDER BY entity_id
    `).all() as unknown as EntityRow[];
    const aliases = this.#db.prepare(`
      SELECT alias_id, entity_id, alias_value, normalized_value, recorded_at, record_json
      FROM semantic_aliases
      ORDER BY alias_id
    `).all() as unknown as AliasRow[];
    const observations = this.#db.prepare(`
      SELECT observation_id, entity_id, property, provider, external_id,
             valid_from, valid_to, recorded_at, record_json
      FROM semantic_observations
      ORDER BY observation_id
    `).all() as unknown as ObservationRow[];
    const relations = this.#db.prepare(`
      SELECT relation_id, from_entity_id, to_entity_id, relation_type,
             valid_from, valid_to, recorded_at, record_json
      FROM semantic_relations
      ORDER BY relation_id
    `).all() as unknown as RelationRow[];

    return {
      schema: SEMANTIC_STATE_SNAPSHOT_SCHEMA,
      entities: entities.map(entityRow),
      aliases: aliases.map(aliasRow),
      observations: observations.map(observationRow),
      relations: relations.map(relationRow),
    };
  }

  async entity(entityId: EntityId): Promise<SemanticEntity | undefined> {
    const row = this.#db.prepare(`
      SELECT entity_id, entity_type, record_json
      FROM semantic_entities
      WHERE entity_id = ?
    `).get(entityId) as EntityRow | undefined;
    return row === undefined ? undefined : entityRow(row);
  }

  async aliasesForEntity(entityId: EntityId): Promise<readonly EntityAliasRecord[]> {
    const rows = this.#db.prepare(`
      SELECT alias_id, entity_id, alias_value, normalized_value, recorded_at, record_json
      FROM semantic_aliases
      WHERE entity_id = ?
      ORDER BY recorded_at, alias_id
    `).all(entityId) as unknown as AliasRow[];
    return rows.map(aliasRow);
  }

  async observationsForEntity(entityId: EntityId): Promise<readonly TemporalObservation[]> {
    const rows = this.#db.prepare(`
      SELECT observation_id, entity_id, property, provider, external_id,
             valid_from, valid_to, recorded_at, record_json
      FROM semantic_observations
      WHERE entity_id = ?
      ORDER BY valid_from, recorded_at, observation_id
    `).all(entityId) as unknown as ObservationRow[];
    return rows.map(observationRow);
  }

  async relationsFromEntity(entityId: EntityId): Promise<readonly TemporalRelationEdge[]> {
    const rows = this.#db.prepare(`
      SELECT relation_id, from_entity_id, to_entity_id, relation_type,
             valid_from, valid_to, recorded_at, record_json
      FROM semantic_relations
      WHERE from_entity_id = ?
      ORDER BY valid_from, recorded_at, relation_type, to_entity_id, relation_id
    `).all(entityId) as unknown as RelationRow[];
    return rows.map(relationRow);
  }

  async lookupAlias(value: string): Promise<AliasLookupResult> {
    const normalizedValue = normalizeEntityAlias(value);
    if (normalizedValue.length === 0) return { normalizedValue, matches: [] };
    const rows = this.#db.prepare(`
      SELECT a.record_json AS alias_json,
             e.record_json AS entity_json,
             a.normalized_value AS normalized_value
      FROM semantic_aliases a
      JOIN semantic_entities e ON e.entity_id = a.entity_id
      WHERE a.normalized_value = ?
      ORDER BY a.entity_id, a.alias_id
    `).all(normalizedValue) as unknown as AliasLookupRow[];

    return {
      normalizedValue,
      matches: rows.map((row) => {
        const alias = parseEntityAliasJson(row.alias_json);
        const entity = parseSemanticEntityJson(row.entity_json);
        if (row.normalized_value !== normalizeEntityAlias(alias.value)) {
          throw new CorruptSemanticStateError(`Alias ${alias.id} normalized index disagrees with record_json`);
        }
        if (alias.entityId !== entity.entityId) {
          throw new CorruptSemanticStateError(`Alias ${alias.id} points to a different entity in record_json`);
        }
        return { entity, alias };
      }),
    };
  }

  async changesAfter(
    cursor?: SemanticChangeCursor,
    limit = 100,
  ): Promise<SemanticChangePage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Semantic change page limit must be an integer between 1 and 1000");
    }
    const after = sequenceAfter(cursor, this.#feedId);
    if (cursor !== undefined) {
      const known = this.#db.prepare(
        "SELECT 1 AS present FROM semantic_changes WHERE sequence = ?",
      ).get(after) as { readonly present: number } | undefined;
      if (known === undefined) throw new InvalidSemanticChangeCursorError(cursor);
    }
    const rows = this.#db.prepare(`
      SELECT CAST(sequence AS TEXT) AS sequence_text,
             record_kind,
             record_id,
             primary_entity_id,
             affected_entity_ids_json
      FROM semantic_changes
      WHERE sequence > ?
      ORDER BY sequence
      LIMIT ?
    `).all(after, limit + 1) as unknown as ChangeRow[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const changes = pageRows.map((row) => semanticChange(row, this.#feedId));
    const nextCursor = changes.at(-1)?.cursor ?? cursor;
    return {
      changes,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      hasMore,
    };
  }

  close(): void {
    this.#db.close();
  }
}
