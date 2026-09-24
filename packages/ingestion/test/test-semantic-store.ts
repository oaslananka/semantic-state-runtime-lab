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

export class TestSemanticStateStore implements SemanticStateStore {
  #entities = new Map<string, Stored<SemanticEntity>>();
  #aliases = new Map<string, Stored<EntityAliasRecord>>();
  #observations = new Map<string, Stored<TemporalObservation>>();
  #relations = new Map<string, Stored<TemporalRelationEdge>>();
  #retractions = new Map<string, Stored<SemanticRetraction>>();

  async append(batch: SemanticStateBatch): Promise<SemanticAppendCounts> {
    const entities = new Map(this.#entities);
    const aliases = new Map(this.#aliases);
    const observations = new Map(this.#observations);
    const relations = new Map(this.#relations);
    const retractions = new Map(this.#retractions);
    const counts: {
      entities: number;
      aliases: number;
      observations: number;
      relations: number;
      retractions: number;
    } = {
      entities: 0,
      aliases: 0,
      observations: 0,
      relations: 0,
      retractions: 0,
    };

    for (const raw of (batch.entities ?? []).map(normalizeSemanticEntity).toSorted((a, b) => a.entityId.localeCompare(b.entityId))) {
      if (insertRecord(entities, "entity", raw.entityId, raw, semanticEntityJson(raw))) counts.entities += 1;
    }
    for (const raw of (batch.aliases ?? []).map(normalizeEntityAliasRecord).toSorted((a, b) => a.id.localeCompare(b.id))) {
      if (!entities.has(raw.entityId)) throw new UnknownSemanticEntityError(raw.entityId);
      if (insertRecord(aliases, "alias", raw.id, raw, entityAliasJson(raw))) counts.aliases += 1;
    }
    for (const raw of (batch.observations ?? []).map(normalizeTemporalObservation).toSorted((a, b) => a.id.localeCompare(b.id))) {
      if (!entities.has(raw.entityId)) throw new UnknownSemanticEntityError(raw.entityId);
      if (insertRecord(observations, "observation", raw.id, raw, temporalObservationJson(raw))) {
        counts.observations += 1;
      }
    }
    for (const raw of (batch.relations ?? []).map(normalizeTemporalRelation).toSorted((a, b) => a.id.localeCompare(b.id))) {
      if (!entities.has(raw.from)) throw new UnknownSemanticEntityError(raw.from);
      if (!entities.has(raw.to)) throw new UnknownSemanticEntityError(raw.to);
      if (insertRecord(relations, "relation", raw.id, raw, temporalRelationJson(raw))) counts.relations += 1;
    }
    for (const raw of (batch.retractions ?? []).map(normalizeSemanticRetraction).toSorted((a, b) => a.id.localeCompare(b.id))) {
      const targetExists = raw.targetKind === "observation"
        ? observations.has(raw.targetId)
        : relations.has(raw.targetId);
      if (!targetExists) throw new UnknownSemanticTargetError(raw.targetKind, raw.targetId);
      if (insertRecord(retractions, "retraction", raw.id, raw, semanticRetractionJson(raw))) {
        counts.retractions += 1;
      }
    }

    this.#entities = entities;
    this.#aliases = aliases;
    this.#observations = observations;
    this.#relations = relations;
    this.#retractions = retractions;
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

  async changesAfter(): Promise<{ readonly changes: readonly []; readonly hasMore: false }> {
    return { changes: [], hasMore: false };
  }

  close(): void {}
}
