import { normalizeEntityAlias, type EntityId, type SemanticRetraction, type TemporalObservation, type TemporalRelationEdge } from "@ssrl/core";
import {
  SEMANTIC_STATE_SNAPSHOT_SCHEMA,
  SemanticRecordCollisionError,
  UnknownSemanticEntityError,
  UnknownSemanticTargetError,
  entityAliasJson,
  normalizeEntityAliasRecord,
  normalizeSemanticEntity,
  normalizeSemanticRetraction,
  normalizeTemporalObservation,
  normalizeTemporalRelation,
  semanticEntityJson,
  semanticRetractionJson,
  temporalObservationJson,
  temporalRelationJson,
  type AliasLookupResult,
  type EntityAliasRecord,
  type SemanticAppendCounts,
  type SemanticEntity,
  type SemanticRecordKind,
  type SemanticStateBatch,
  type SemanticStateSnapshot,
  type SemanticStateStore,
} from "@ssrl/state-store";

interface Stored<T> {
  readonly record: T;
  readonly json: string;
}

function insertRecord<T>(
  map: Map<string, Stored<T>>,
  kind: SemanticRecordKind,
  id: string,
  record: T,
  json: string,
): boolean {
  const existing = map.get(id);
  if (existing !== undefined) {
    if (existing.json !== json) throw new SemanticRecordCollisionError(kind, id);
    return false;
  }
  map.set(id, { record, json });
  return true;
}

function sortedRecords<T extends { readonly id: string }>(map: ReadonlyMap<string, Stored<T>>): T[] {
  return [...map.values()].map((item) => item.record).toSorted((a, b) => a.id.localeCompare(b.id));
}

interface MutableAppendCounts {
  entities: number;
  aliases: number;
  observations: number;
  relations: number;
  retractions: number;
}

interface WorkingState {
  readonly entities: Map<string, Stored<SemanticEntity>>;
  readonly aliases: Map<string, Stored<EntityAliasRecord>>;
  readonly observations: Map<string, Stored<TemporalObservation>>;
  readonly relations: Map<string, Stored<TemporalRelationEdge>>;
  readonly retractions: Map<string, Stored<SemanticRetraction>>;
}

function appendEntities(
  batch: SemanticStateBatch,
  state: WorkingState,
  counts: MutableAppendCounts,
): void {
  const records = (batch.entities ?? [])
    .map((entity) => normalizeSemanticEntity(entity))
    .toSorted((a, b) => a.entityId.localeCompare(b.entityId));
  for (const record of records) {
    if (insertRecord(state.entities, "entity", record.entityId, record, semanticEntityJson(record))) {
      counts.entities += 1;
    }
  }
}

function requireEntity(state: WorkingState, entityId: EntityId): void {
  if (!state.entities.has(entityId)) throw new UnknownSemanticEntityError(entityId);
}

function appendAliases(
  batch: SemanticStateBatch,
  state: WorkingState,
  counts: MutableAppendCounts,
): void {
  const records = (batch.aliases ?? [])
    .map((alias) => normalizeEntityAliasRecord(alias))
    .toSorted((a, b) => a.id.localeCompare(b.id));
  for (const record of records) {
    requireEntity(state, record.entityId);
    if (insertRecord(state.aliases, "alias", record.id, record, entityAliasJson(record))) {
      counts.aliases += 1;
    }
  }
}

function appendObservations(
  batch: SemanticStateBatch,
  state: WorkingState,
  counts: MutableAppendCounts,
): void {
  const records = (batch.observations ?? [])
    .map((observation) => normalizeTemporalObservation(observation))
    .toSorted((a, b) => a.id.localeCompare(b.id));
  for (const record of records) {
    requireEntity(state, record.entityId);
    if (insertRecord(
      state.observations,
      "observation",
      record.id,
      record,
      temporalObservationJson(record),
    )) {
      counts.observations += 1;
    }
  }
}

function appendRelations(
  batch: SemanticStateBatch,
  state: WorkingState,
  counts: MutableAppendCounts,
): void {
  const records = (batch.relations ?? [])
    .map((relation) => normalizeTemporalRelation(relation))
    .toSorted((a, b) => a.id.localeCompare(b.id));
  for (const record of records) {
    requireEntity(state, record.from);
    requireEntity(state, record.to);
    if (insertRecord(state.relations, "relation", record.id, record, temporalRelationJson(record))) {
      counts.relations += 1;
    }
  }
}

function appendRetractions(
  batch: SemanticStateBatch,
  state: WorkingState,
  counts: MutableAppendCounts,
): void {
  const records = (batch.retractions ?? [])
    .map((retraction) => normalizeSemanticRetraction(retraction))
    .toSorted((a, b) => a.id.localeCompare(b.id));
  for (const record of records) {
    const targetExists = record.targetKind === "observation"
      ? state.observations.has(record.targetId)
      : state.relations.has(record.targetId);
    if (!targetExists) throw new UnknownSemanticTargetError(record.targetKind, record.targetId);
    if (insertRecord(
      state.retractions,
      "retraction",
      record.id,
      record,
      semanticRetractionJson(record),
    )) {
      counts.retractions += 1;
    }
  }
}

export class TestSemanticStateStore implements SemanticStateStore {
  #entities = new Map<string, Stored<SemanticEntity>>();
  #aliases = new Map<string, Stored<EntityAliasRecord>>();
  #observations = new Map<string, Stored<TemporalObservation>>();
  #relations = new Map<string, Stored<TemporalRelationEdge>>();
  #retractions = new Map<string, Stored<SemanticRetraction>>();

  async append(batch: SemanticStateBatch): Promise<SemanticAppendCounts> {
    const state: WorkingState = {
      entities: new Map(this.#entities),
      aliases: new Map(this.#aliases),
      observations: new Map(this.#observations),
      relations: new Map(this.#relations),
      retractions: new Map(this.#retractions),
    };
    const counts: MutableAppendCounts = {
      entities: 0,
      aliases: 0,
      observations: 0,
      relations: 0,
      retractions: 0,
    };

    appendEntities(batch, state, counts);
    appendAliases(batch, state, counts);
    appendObservations(batch, state, counts);
    appendRelations(batch, state, counts);
    appendRetractions(batch, state, counts);

    this.#entities = state.entities;
    this.#aliases = state.aliases;
    this.#observations = state.observations;
    this.#relations = state.relations;
    this.#retractions = state.retractions;
    return counts;
  }

  async snapshot(): Promise<SemanticStateSnapshot> {
    return {
      schema: SEMANTIC_STATE_SNAPSHOT_SCHEMA,
      entities: [...this.#entities.values()]
        .map((item) => item.record)
        .toSorted((a, b) => a.entityId.localeCompare(b.entityId)),
      aliases: sortedRecords(this.#aliases),
      observations: sortedRecords(this.#observations),
      relations: sortedRecords(this.#relations),
      retractions: sortedRecords(this.#retractions),
    };
  }

  async entity(entityId: EntityId): Promise<SemanticEntity | undefined> {
    return this.#entities.get(entityId)?.record;
  }

  async aliasesForEntity(entityId: EntityId): Promise<readonly EntityAliasRecord[]> {
    return sortedRecords(this.#aliases).filter((item) => item.entityId === entityId);
  }

  async observationsForEntity(entityId: EntityId): Promise<readonly TemporalObservation[]> {
    return sortedRecords(this.#observations).filter((item) => item.entityId === entityId);
  }

  async relationsFromEntity(entityId: EntityId): Promise<readonly TemporalRelationEdge[]> {
    return sortedRecords(this.#relations).filter((item) => item.from === entityId);
  }

  async retractionsForEntity(entityId: EntityId): Promise<readonly SemanticRetraction[]> {
    const observationIds = new Set(
      sortedRecords(this.#observations).filter((item) => item.entityId === entityId).map((item) => item.id),
    );
    const relationIds = new Set(
      sortedRecords(this.#relations).filter((item) => item.from === entityId).map((item) => item.id),
    );
    return sortedRecords(this.#retractions).filter((item) => (
      item.targetKind === "observation"
        ? observationIds.has(item.targetId)
        : relationIds.has(item.targetId)
    ));
  }

  async lookupAlias(value: string): Promise<AliasLookupResult> {
    const normalizedValue = normalizeEntityAlias(value);
    const matches = sortedRecords(this.#aliases)
      .filter((alias) => normalizeEntityAlias(alias.value) === normalizedValue)
      .flatMap((alias) => {
        const entity = this.#entities.get(alias.entityId)?.record;
        return entity === undefined ? [] : [{ entity, alias }];
      });
    return { normalizedValue, matches };
  }

  async bootstrapView(): Promise<{ readonly entityIds: readonly EntityId[] }> {
    return {
      entityIds: [...this.#entities.keys()]
        .map((value) => value as EntityId)
        .toSorted((left, right) => left.localeCompare(right)),
    };
  }

  async changesAfter(): Promise<{ readonly changes: readonly []; readonly hasMore: false }> {
    return { changes: [], hasMore: false };
  }

  close(): void {
    this.#entities.clear();
    this.#aliases.clear();
    this.#observations.clear();
    this.#relations.clear();
    this.#retractions.clear();
  }
}
