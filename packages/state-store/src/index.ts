import {
  canonicalJson,
  normalizeEntityAlias,
  type EntityId,
  type StateValue,
  type TemporalObservation,
  type TemporalRelationEdge,
  type TypedEntity,
} from "@ssrl/core";

export const SEMANTIC_STATE_SNAPSHOT_SCHEMA = "ssrl-semantic-state-snapshot-v1" as const;

export interface SemanticEntity {
  readonly entityId: EntityId;
  readonly entityType: string;
}

export interface EntityAliasRecord {
  readonly id: string;
  readonly entityId: EntityId;
  readonly value: string;
  readonly recordedAt: string;
  readonly evidenceRefs?: readonly string[];
}

export interface SemanticStateBatch {
  readonly entities?: readonly SemanticEntity[];
  readonly aliases?: readonly EntityAliasRecord[];
  readonly observations?: readonly TemporalObservation[];
  readonly relations?: readonly TemporalRelationEdge[];
}

export interface SemanticAppendCounts {
  readonly entities: number;
  readonly aliases: number;
  readonly observations: number;
  readonly relations: number;
}


/** Backend-defined opaque cursor. Consumers must not parse or increment it. */
declare const semanticChangeCursorBrand: unique symbol;
export type SemanticChangeCursor = string & {
  readonly [semanticChangeCursorBrand]: true;
};

export interface SemanticChange {
  readonly cursor: SemanticChangeCursor;
  readonly kind: SemanticRecordKind;
  readonly recordId: string;
  readonly primaryEntityId: EntityId;
  readonly affectedEntityIds: readonly EntityId[];
}

export interface SemanticChangePage {
  readonly changes: readonly SemanticChange[];
  readonly nextCursor?: SemanticChangeCursor;
  readonly hasMore: boolean;
}

export interface SemanticStateSnapshot {
  readonly schema: typeof SEMANTIC_STATE_SNAPSHOT_SCHEMA;
  readonly entities: readonly SemanticEntity[];
  readonly aliases: readonly EntityAliasRecord[];
  readonly observations: readonly TemporalObservation[];
  readonly relations: readonly TemporalRelationEdge[];
}

export interface AliasLookupMatch {
  readonly entity: SemanticEntity;
  readonly alias: EntityAliasRecord;
}

export interface AliasLookupResult {
  readonly normalizedValue: string;
  readonly matches: readonly AliasLookupMatch[];
}

export interface SemanticStateStore {
  append(batch: SemanticStateBatch): Promise<SemanticAppendCounts>;
  snapshot(): Promise<SemanticStateSnapshot>;
  entity(entityId: EntityId): Promise<SemanticEntity | undefined>;
  aliasesForEntity(entityId: EntityId): Promise<readonly EntityAliasRecord[]>;
  observationsForEntity(entityId: EntityId): Promise<readonly TemporalObservation[]>;
  relationsFromEntity(entityId: EntityId): Promise<readonly TemporalRelationEdge[]>;
  lookupAlias(value: string): Promise<AliasLookupResult>;
  changesAfter(cursor?: SemanticChangeCursor, limit?: number): Promise<SemanticChangePage>;
}

export type SemanticRecordKind = "entity" | "alias" | "observation" | "relation";

export class SemanticRecordCollisionError extends Error {
  constructor(
    readonly kind: SemanticRecordKind,
    readonly recordId: string,
  ) {
    super(`Semantic ${kind} record ${recordId} already exists with different content`);
    this.name = "SemanticRecordCollisionError";
  }
}

export class UnknownSemanticEntityError extends Error {
  constructor(readonly entityId: EntityId) {
    super(`Semantic record references unknown entity ${entityId}`);
    this.name = "UnknownSemanticEntityError";
  }
}


export class InvalidSemanticChangeCursorError extends Error {
  constructor(readonly cursor: string) {
    super(`Invalid semantic change cursor: ${cursor}`);
    this.name = "InvalidSemanticChangeCursorError";
  }
}

export class CorruptSemanticStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptSemanticStateError";
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function entityIdValue(value: unknown, label: string): EntityId {
  const id = requiredString(value, label);
  if (!id.startsWith("entity://") || id.length <= "entity://".length) {
    throw new TypeError(`${label} must use the entity:// scheme`);
  }
  return id as EntityId;
}

function isoTimestamp(value: unknown, label: string): string {
  const timestamp = requiredString(value, label);
  const millis = Date.parse(timestamp);
  if (!Number.isFinite(millis)) throw new TypeError(`${label} must be a valid timestamp`);
  return new Date(millis).toISOString();
}

function plainObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function normalizedStateValue(value: unknown, label: string): StateValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizedStateValue(item, `${label}[${index}]`));
  }
  const object = plainObject(value, label);
  return Object.fromEntries(
    Object.entries(object)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalizedStateValue(child, `${label}.${key}`)]),
  );
}

function normalizedEvidenceRefs(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const refs = value.map((ref, index) => requiredString(ref, `${label}[${index}]`));
  return [...new Set(refs)].sort((left, right) => left.localeCompare(right));
}

export function normalizeSemanticEntity(value: SemanticEntity): SemanticEntity {
  return {
    entityId: entityIdValue(value.entityId, "entity.entityId"),
    entityType: requiredString(value.entityType, "entity.entityType"),
  };
}

export function normalizeEntityAliasRecord(value: EntityAliasRecord): EntityAliasRecord {
  const alias = requiredString(value.value, "alias.value");
  if (normalizeEntityAlias(alias).length === 0) {
    throw new TypeError("alias.value must contain at least one letter or number");
  }
  const refs = normalizedEvidenceRefs(value.evidenceRefs, "alias.evidenceRefs");
  return {
    id: requiredString(value.id, "alias.id"),
    entityId: entityIdValue(value.entityId, "alias.entityId"),
    value: alias,
    recordedAt: isoTimestamp(value.recordedAt, "alias.recordedAt"),
    ...(refs === undefined ? {} : { evidenceRefs: refs }),
  };
}

export function normalizeTemporalObservation(value: TemporalObservation): TemporalObservation {
  const source = plainObject(value.source, "observation.source");
  const validFrom = isoTimestamp(value.validFrom, "observation.validFrom");
  const validTo = value.validTo === undefined
    ? undefined
    : isoTimestamp(value.validTo, "observation.validTo");
  if (validTo !== undefined && Date.parse(validTo) <= Date.parse(validFrom)) {
    throw new TypeError("observation.validTo must be after validFrom");
  }
  const revision = source.revision === undefined
    ? undefined
    : requiredString(source.revision, "observation.source.revision");
  return {
    id: requiredString(value.id, "observation.id"),
    entityId: entityIdValue(value.entityId, "observation.entityId"),
    property: requiredString(value.property, "observation.property"),
    value: normalizedStateValue(value.value, "observation.value"),
    source: {
      provider: requiredString(source.provider, "observation.source.provider"),
      externalId: requiredString(source.externalId, "observation.source.externalId"),
      ...(revision === undefined ? {} : { revision }),
    },
    validFrom,
    ...(validTo === undefined ? {} : { validTo }),
    recordedAt: isoTimestamp(value.recordedAt, "observation.recordedAt"),
  };
}

export function normalizeTemporalRelation(value: TemporalRelationEdge): TemporalRelationEdge {
  const validFrom = isoTimestamp(value.validFrom, "relation.validFrom");
  const validTo = value.validTo === undefined
    ? undefined
    : isoTimestamp(value.validTo, "relation.validTo");
  if (validTo !== undefined && Date.parse(validTo) <= Date.parse(validFrom)) {
    throw new TypeError("relation.validTo must be after validFrom");
  }
  const refs = normalizedEvidenceRefs(value.evidenceRefs, "relation.evidenceRefs");
  return {
    id: requiredString(value.id, "relation.id"),
    from: entityIdValue(value.from, "relation.from"),
    to: entityIdValue(value.to, "relation.to"),
    relationType: requiredString(value.relationType, "relation.relationType"),
    validFrom,
    ...(validTo === undefined ? {} : { validTo }),
    recordedAt: isoTimestamp(value.recordedAt, "relation.recordedAt"),
    ...(refs === undefined ? {} : { evidenceRefs: refs }),
  };
}

export function semanticEntityJson(value: SemanticEntity): string {
  return canonicalJson(normalizeSemanticEntity(value));
}

export function entityAliasJson(value: EntityAliasRecord): string {
  return canonicalJson(normalizeEntityAliasRecord(value));
}

export function temporalObservationJson(value: TemporalObservation): string {
  return canonicalJson(normalizeTemporalObservation(value));
}

export function temporalRelationJson(value: TemporalRelationEdge): string {
  return canonicalJson(normalizeTemporalRelation(value));
}

function parseJsonObject(value: string, label: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new CorruptSemanticStateError(`${label} is not valid JSON`);
  }
  try {
    return plainObject(parsed, label);
  } catch (cause) {
    throw new CorruptSemanticStateError(cause instanceof Error ? cause.message : `${label} is invalid`);
  }
}

function parseNormalized<T>(
  value: string,
  label: string,
  normalize: (record: never) => T,
): T {
  const parsed = parseJsonObject(value, label);
  try {
    return normalize(parsed as never);
  } catch (cause) {
    throw new CorruptSemanticStateError(cause instanceof Error ? cause.message : `${label} is invalid`);
  }
}

export function parseSemanticEntityJson(value: string): SemanticEntity {
  return parseNormalized(value, "semantic entity", normalizeSemanticEntity as (record: never) => SemanticEntity);
}

export function parseEntityAliasJson(value: string): EntityAliasRecord {
  return parseNormalized(value, "entity alias", normalizeEntityAliasRecord as (record: never) => EntityAliasRecord);
}

export function parseTemporalObservationJson(value: string): TemporalObservation {
  return parseNormalized(value, "temporal observation", normalizeTemporalObservation as (record: never) => TemporalObservation);
}

export function parseTemporalRelationJson(value: string): TemporalRelationEdge {
  return parseNormalized(value, "temporal relation", normalizeTemporalRelation as (record: never) => TemporalRelationEdge);
}

export function emptySemanticStateSnapshot(): SemanticStateSnapshot {
  return {
    schema: SEMANTIC_STATE_SNAPSHOT_SCHEMA,
    entities: [],
    aliases: [],
    observations: [],
    relations: [],
  };
}

export function typedEntityFromAliasRecords(
  entity: SemanticEntity,
  aliases: readonly EntityAliasRecord[],
): TypedEntity {
  return {
    id: entity.entityId,
    type: entity.entityType,
    aliases: [...aliases]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((alias) => ({
        value: alias.value,
        ...(alias.evidenceRefs === undefined ? {} : { evidenceRefs: alias.evidenceRefs }),
      })),
  };
}

export function typedEntitiesFromStateSnapshot(
  snapshot: SemanticStateSnapshot,
): TypedEntity[] {
  const aliasesByEntity = new Map<EntityId, EntityAliasRecord[]>();
  for (const alias of snapshot.aliases) {
    const current = aliasesByEntity.get(alias.entityId) ?? [];
    current.push(alias);
    aliasesByEntity.set(alias.entityId, current);
  }

  return snapshot.entities.map((entity) => {
    const aliases = aliasesByEntity.get(entity.entityId) ?? [];
    if (aliases.length === 0) {
      throw new Error(`Entity ${entity.entityId} cannot hydrate TypedEntity without an alias`);
    }
    return typedEntityFromAliasRecords(entity, aliases);
  });
}
