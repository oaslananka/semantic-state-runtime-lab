import { DatabaseSync } from "node:sqlite";
import {
  normalizeEntityAlias,
  type EntityId,
  type TemporalObservation,
  type TemporalRelationEdge,
} from "@ssrl/core";
import {
  CorruptSemanticStateError,
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
  type SemanticEntity,
  type SemanticStateBatch,
  type SemanticStateSnapshot,
  type SemanticStateStore,
} from "@ssrl/state-store";

const STATE_STORE_COMPONENT = "semantic-state-store";
const STATE_STORE_SCHEMA_VERSION = 1;

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

function semanticTableNames(): readonly string[] {
  return [
    "semantic_entities",
    "semantic_aliases",
    "semantic_observations",
    "semantic_relations",
  ];
}

export class SQLiteSemanticStateStore implements SemanticStateStore {
  readonly #db: DatabaseSync;

  constructor(options: SQLiteSemanticStateStoreOptions) {
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

    if (versionRow !== undefined) {
      const version = Number(versionRow.schema_version);
      if (!Number.isSafeInteger(version) || version < 1) {
        throw new CorruptSemanticStateDatabaseError(`Invalid semantic state schema version ${String(versionRow.schema_version)}`);
      }
      if (version > STATE_STORE_SCHEMA_VERSION) {
        throw new UnsupportedSemanticStateSchemaError(version, STATE_STORE_SCHEMA_VERSION);
      }
      if (version === STATE_STORE_SCHEMA_VERSION) return;
    }

    const existing = this.#db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name IN (?, ?, ?, ?)
      ORDER BY name
    `).all(...semanticTableNames()) as unknown as { readonly name: string }[];
    if (existing.length > 0) {
      throw new CorruptSemanticStateDatabaseError(
        `Semantic state tables exist without a schema marker: ${existing.map((row) => row.name).join(", ")}`,
      );
    }

    this.#db.exec("BEGIN IMMEDIATE");
    try {
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
      this.#db.prepare(`
        INSERT INTO semantic_state_meta(component, schema_version)
        VALUES (?, ?)
      `).run(STATE_STORE_COMPONENT, STATE_STORE_SCHEMA_VERSION);
      this.#db.exec("COMMIT");
    } catch (cause) {
      this.#db.exec("ROLLBACK");
      throw cause;
    }
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
      inserted += 1;
    }
    return inserted;
  }

  async append(batch: SemanticStateBatch): Promise<SemanticAppendCounts> {
    const entities = (batch.entities ?? []).map(normalizeSemanticEntity);
    const aliases = (batch.aliases ?? []).map(normalizeEntityAliasRecord);
    const observations = (batch.observations ?? []).map(normalizeTemporalObservation);
    const relations = (batch.relations ?? []).map(normalizeTemporalRelation);

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const counts: SemanticAppendCounts = {
        entities: this.#appendEntities(entities),
        aliases: this.#appendAliases(aliases),
        observations: this.#appendObservations(observations),
        relations: this.#appendRelations(relations),
      };
      this.#db.exec("COMMIT");
      return counts;
    } catch (cause) {
      this.#db.exec("ROLLBACK");
      throw cause;
    }
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

  close(): void {
    this.#db.close();
  }
}
