import type { EntityId } from "./model.js";

export interface EntityAliasEvidence {
  readonly value: string;
  readonly evidenceRefs?: readonly string[];
}

export interface EntityTypeDescriptor {
  readonly id: string;
  /** Query cues such as person/kişi or project/proje. */
  readonly aliases: readonly string[];
}

export interface TypedEntity {
  readonly id: EntityId;
  readonly type: string;
  readonly aliases: readonly EntityAliasEvidence[];
}

export interface EntityResolutionCandidate {
  readonly entityId: EntityId;
  readonly entityType: string;
  readonly score: number;
  readonly matchedAliases: readonly string[];
  readonly matchedTypeCues: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export type EntityResolution =
  | {
    readonly status: "none";
    readonly candidates: readonly [];
  }
  | {
    readonly status: "resolved";
    readonly entityId: EntityId;
    readonly candidates: readonly EntityResolutionCandidate[];
  }
  | {
    readonly status: "ambiguous";
    readonly candidates: readonly EntityResolutionCandidate[];
  };

export interface TemporalRelationEdge {
  readonly id: string;
  readonly from: EntityId;
  readonly to: EntityId;
  readonly relationType: string;
  readonly validFrom: string;
  readonly validTo?: string;
  readonly recordedAt: string;
  readonly evidenceRefs?: readonly string[];
}

export interface RelationTypeDescriptor {
  readonly id: string;
  readonly aliases: readonly string[];
}

export interface ActiveRelationQuery {
  readonly edges: readonly TemporalRelationEdge[];
  readonly fromEntityIds: readonly EntityId[];
  readonly validAt: string;
  readonly knownAt: string;
}

export function normalizeEntityAlias(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function phraseMatch(query: string, phrase: string): boolean {
  if (phrase.length === 0) return false;
  return ` ${query} `.includes(` ${phrase} `);
}

function tokenCount(value: string): number {
  if (value.length === 0) return 0;
  return value.split(" ").length;
}

function matchAliases(
  normalizedQuery: string,
  aliases: readonly string[],
): string[] {
  return aliases
    .map((alias) => ({ raw: alias, normalized: normalizeEntityAlias(alias) }))
    .filter((alias) => phraseMatch(normalizedQuery, alias.normalized))
    .sort((left, right) => (
      tokenCount(right.normalized) - tokenCount(left.normalized)
      || right.normalized.length - left.normalized.length
      || left.raw.localeCompare(right.raw)
    ))
    .map((alias) => alias.raw);
}

function aliasScore(alias: string): number {
  const normalized = normalizeEntityAlias(alias);
  return tokenCount(normalized) * 100 + normalized.length;
}

function candidateFor(
  entity: TypedEntity,
  entityType: EntityTypeDescriptor,
  normalizedQuery: string,
): EntityResolutionCandidate | undefined {
  const matchedAliases = matchAliases(
    normalizedQuery,
    entity.aliases.map((alias) => alias.value),
  );
  if (matchedAliases.length === 0) return undefined;

  const matchedTypeCues = matchAliases(normalizedQuery, entityType.aliases);
  const strongestAlias = Math.max(...matchedAliases.map(aliasScore));
  const typeCueScore = matchedTypeCues.length === 0
    ? 0
    : 10_000 + Math.max(...matchedTypeCues.map(aliasScore));
  const matchedAliasSet = new Set(matchedAliases.map(normalizeEntityAlias));
  const evidenceRefs = entity.aliases
    .filter((alias) => matchedAliasSet.has(normalizeEntityAlias(alias.value)))
    .flatMap((alias) => alias.evidenceRefs ?? []);

  return {
    entityId: entity.id,
    entityType: entity.type,
    score: strongestAlias + typeCueScore,
    matchedAliases,
    matchedTypeCues,
    evidenceRefs: [...new Set(evidenceRefs)].sort((left, right) => left.localeCompare(right)),
  };
}

function validateEntityTypes(
  types: readonly EntityTypeDescriptor[],
): ReadonlyMap<string, EntityTypeDescriptor> {
  const typeMap = new Map<string, EntityTypeDescriptor>();
  for (const type of types) {
    if (type.id.length === 0) throw new Error("Entity type id must not be empty");
    if (typeMap.has(type.id)) throw new Error(`Duplicate entity type id: ${type.id}`);
    typeMap.set(type.id, type);
  }
  return typeMap;
}

function validateEntityAliases(entity: TypedEntity): void {
  if (entity.aliases.length === 0) {
    throw new Error(`Entity ${entity.id} must have at least one alias`);
  }
  for (const alias of entity.aliases) {
    if (normalizeEntityAlias(alias.value).length === 0) {
      throw new Error(`Entity ${entity.id} contains an empty alias`);
    }
  }
}

function validateEntities(
  entities: readonly TypedEntity[],
  typeMap: ReadonlyMap<string, EntityTypeDescriptor>,
): void {
  const entityIds = new Set<EntityId>();
  for (const entity of entities) {
    if (entityIds.has(entity.id)) throw new Error(`Duplicate entity id: ${entity.id}`);
    entityIds.add(entity.id);
    if (!typeMap.has(entity.type)) {
      throw new Error(`Entity ${entity.id} references unknown type ${entity.type}`);
    }
    validateEntityAliases(entity);
  }
}

function validateIdentitySchema(
  types: readonly EntityTypeDescriptor[],
  entities: readonly TypedEntity[],
): ReadonlyMap<string, EntityTypeDescriptor> {
  const typeMap = validateEntityTypes(types);
  validateEntities(entities, typeMap);
  return typeMap;
}

export class TypedEntityResolver {
  readonly #entities: readonly TypedEntity[];
  readonly #types: ReadonlyMap<string, EntityTypeDescriptor>;

  constructor(input: {
    readonly types: readonly EntityTypeDescriptor[];
    readonly entities: readonly TypedEntity[];
  }) {
    this.#entities = input.entities;
    this.#types = validateIdentitySchema(input.types, input.entities);
  }

  resolve(query: string): EntityResolution {
    const normalizedQuery = normalizeEntityAlias(query);
    const candidates = this.#entities
      .map((entity) => {
        const entityType = this.#types.get(entity.type);
        if (entityType === undefined) return undefined;
        return candidateFor(entity, entityType, normalizedQuery);
      })
      .filter((candidate): candidate is EntityResolutionCandidate => candidate !== undefined)
      .sort((left, right) => right.score - left.score || left.entityId.localeCompare(right.entityId));

    const first = candidates[0];
    if (first === undefined) return { status: "none", candidates: [] };
    const tied = candidates.filter((candidate) => candidate.score === first.score);
    if (tied.length > 1) return { status: "ambiguous", candidates: tied };
    return { status: "resolved", entityId: first.entityId, candidates };
  }
}

function timestamp(value: string, label: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(`Invalid ${label} timestamp: ${value}`);
  return result;
}

function validateRelation(edge: TemporalRelationEdge): void {
  if (edge.id.length === 0) throw new Error("Relation edge id must not be empty");
  const validFrom = timestamp(edge.validFrom, "relation validFrom");
  timestamp(edge.recordedAt, "relation recordedAt");
  if (edge.validTo === undefined) return;
  const validTo = timestamp(edge.validTo, "relation validTo");
  if (validTo <= validFrom) {
    throw new Error(`Relation edge ${edge.id} must have validTo after validFrom`);
  }
}

function relationIsActive(
  edge: TemporalRelationEdge,
  fromEntityIds: ReadonlySet<EntityId>,
  validAt: number,
  knownAt: number,
): boolean {
  if (!fromEntityIds.has(edge.from)) return false;
  const validTo = edge.validTo === undefined
    ? Number.POSITIVE_INFINITY
    : Date.parse(edge.validTo);
  return Date.parse(edge.validFrom) <= validAt
    && validAt < validTo
    && Date.parse(edge.recordedAt) <= knownAt;
}

export function activeRelationEdges(input: ActiveRelationQuery): TemporalRelationEdge[] {
  const validAt = timestamp(input.validAt, "relation validAt");
  const knownAt = timestamp(input.knownAt, "relation knownAt");
  const ids = new Set<string>();
  for (const edge of input.edges) {
    if (ids.has(edge.id)) throw new Error(`Duplicate relation edge id: ${edge.id}`);
    ids.add(edge.id);
    validateRelation(edge);
  }
  const fromEntityIds = new Set(input.fromEntityIds);
  return input.edges
    .filter((edge) => relationIsActive(edge, fromEntityIds, validAt, knownAt))
    .sort((left, right) => (
      left.from.localeCompare(right.from)
      || left.relationType.localeCompare(right.relationType)
      || left.to.localeCompare(right.to)
      || left.id.localeCompare(right.id)
    ));
}
