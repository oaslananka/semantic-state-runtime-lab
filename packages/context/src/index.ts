import {
  TypedEntityResolver,
  activeRelationEdges,
  resolveTemporalState,
  validateUniqueRetractionIds,
  type AuthorityRule,
  type Conflict,
  type EntityId,
  type EntityResolution,
  type EntityTypeDescriptor,
  type RelationTypeDescriptor,
  type SemanticRetraction,
  type StateValue,
  type TemporalObservation,
  type TemporalRelationEdge,
  type TemporalStateResolution,
  type TypedEntity,
} from "@ssrl/core";

export type ContextKind =
  | "state"
  | "decision"
  | "commitment"
  | "event"
  | "artifact"
  | "relationship";

export interface EntityDescriptor {
  readonly id: string;
  readonly aliases: readonly string[];
}

export interface ContextRecord {
  readonly id: string;
  readonly entityId: string;
  readonly kind: ContextKind;
  readonly text: string;
  readonly current?: boolean;
  readonly importance?: number;
  readonly relatedEntityIds?: readonly string[];
  readonly evidenceRefs?: readonly string[];
}

export interface ContextCorpus {
  readonly entities: readonly EntityDescriptor[];
  readonly records: readonly ContextRecord[];
}

export interface ContextRequest {
  readonly query: string;
  readonly budgetTokens: number;
}

export interface ContextPackage {
  readonly records: readonly ContextRecord[];
  readonly resolvedEntityIds: readonly string[];
  readonly estimatedTokens: number;
  readonly consideredRecords: number;
}

interface RankedRecord {
  readonly record: ContextRecord;
  readonly score: number;
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function termList(value: string): string[] {
  return normalize(value)
    .split(" ")
    .filter((term) => term.length >= 2);
}

function terms(value: string): Set<string> {
  return new Set(termList(value));
}

export function estimateTokens(value: string): number {
  if (value.length === 0) return 0;
  return Math.max(1, Math.ceil(value.length / 4));
}

function recordTokens(record: ContextRecord): number {
  return estimateTokens(record.text) + 8;
}

function overlapScore(queryTerms: ReadonlySet<string>, record: ContextRecord): number {
  const recordTerms = terms(record.text);
  let overlap = 0;
  for (const term of queryTerms) {
    if (recordTerms.has(term)) overlap += 1;
  }
  return overlap;
}

function selectWithinBudget(
  ranked: readonly RankedRecord[],
  budgetTokens: number,
): { records: ContextRecord[]; estimatedTokens: number } {
  const records: ContextRecord[] = [];
  let estimatedTokens = 0;

  for (const candidate of ranked) {
    const cost = recordTokens(candidate.record);
    if (estimatedTokens + cost > budgetTokens) continue;
    records.push(candidate.record);
    estimatedTokens += cost;
  }

  return { records, estimatedTokens };
}

function entityNameMap(corpus: ContextCorpus): ReadonlyMap<string, string> {
  return new Map(corpus.entities.map((entity) => [entity.id, entity.aliases.join(" ")]));
}

const kindPriority: Readonly<Record<ContextKind, number>> = {
  state: 18,
  decision: 16,
  commitment: 14,
  relationship: 10,
  event: 6,
  artifact: 4,
};

export class ContextIndex {
  readonly #corpus: ContextCorpus;
  readonly #recordsByEntity = new Map<string, ContextRecord[]>();
  readonly #aliases: readonly { alias: string; entityId: string }[];

  constructor(corpus: ContextCorpus) {
    this.#corpus = corpus;

    for (const record of corpus.records) {
      const current = this.#recordsByEntity.get(record.entityId) ?? [];
      current.push(record);
      this.#recordsByEntity.set(record.entityId, current);
    }

    this.#aliases = corpus.entities
      .flatMap((entity) => entity.aliases.map((alias) => ({
        alias: normalize(alias),
        entityId: entity.id,
      })))
      .filter((entry) => entry.alias.length > 0)
      .sort((a, b) => b.alias.length - a.alias.length || a.entityId.localeCompare(b.entityId));
  }

  resolveEntities(query: string): string[] {
    const normalizedQuery = ` ${normalize(query)} `;
    const resolved = new Set<string>();
    for (const entry of this.#aliases) {
      if (normalizedQuery.includes(` ${entry.alias} `)) {
        resolved.add(entry.entityId);
      }
    }
    return [...resolved].sort((a, b) => a.localeCompare(b));
  }

  compile(request: ContextRequest): ContextPackage {
    const resolvedEntityIds = this.resolveEntities(request.query);
    const directEntityIds = new Set(resolvedEntityIds);
    const candidateIds = new Set<string>(resolvedEntityIds);

    for (const entityId of resolvedEntityIds) {
      for (const record of this.#recordsByEntity.get(entityId) ?? []) {
        for (const related of record.relatedEntityIds ?? []) {
          candidateIds.add(related);
        }
      }
    }

    const candidates = resolvedEntityIds.length === 0
      ? [...this.#corpus.records]
      : [...candidateIds].flatMap((entityId) => this.#recordsByEntity.get(entityId) ?? []);

    const queryTerms = terms(request.query);
    const ranked = candidates
      .map((record) => {
        const direct = directEntityIds.has(record.entityId) ? 30 : 0;
        const lexical = overlapScore(queryTerms, record) * 8;
        const current = record.current === true ? 8 : 0;
        const importance = Math.round((record.importance ?? 0.5) * 10);
        return {
          record,
          score: direct + lexical + current + importance + kindPriority[record.kind],
        };
      })
      .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));

    const selected = selectWithinBudget(ranked, request.budgetTokens);
    return {
      records: selected.records,
      resolvedEntityIds,
      estimatedTokens: selected.estimatedTokens,
      consideredRecords: candidates.length,
    };
  }
}

export function lexicalBaseline(
  corpus: ContextCorpus,
  request: ContextRequest,
): ContextPackage {
  const queryTerms = terms(request.query);
  const entityNames = entityNameMap(corpus);

  const ranked = corpus.records
    .map((record) => {
      const searchable = {
        ...record,
        text: `${entityNames.get(record.entityId) ?? ""} ${record.text}`,
      };
      return { record, score: overlapScore(queryTerms, searchable) };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));

  const selected = selectWithinBudget(ranked, request.budgetTokens);
  return {
    records: selected.records,
    resolvedEntityIds: [],
    estimatedTokens: selected.estimatedTokens,
    consideredRecords: corpus.records.length,
  };
}

export function bm25Baseline(
  corpus: ContextCorpus,
  request: ContextRequest,
  filterEntityIds?: readonly string[],
): ContextPackage {
  const filterSet = filterEntityIds === undefined || filterEntityIds.length === 0
    ? undefined
    : new Set(filterEntityIds);
  const candidates = filterSet === undefined
    ? [...corpus.records]
    : corpus.records.filter((record) => filterSet.has(record.entityId));

  if (candidates.length === 0) {
    return {
      records: [],
      resolvedEntityIds: filterEntityIds ?? [],
      estimatedTokens: 0,
      consideredRecords: 0,
    };
  }

  const entityNames = entityNameMap(corpus);
  const documents = candidates.map((record) => ({
    record,
    tokens: termList(`${entityNames.get(record.entityId) ?? ""} ${record.text}`),
  }));
  const averageLength = documents.reduce((sum, document) => sum + document.tokens.length, 0)
    / documents.length;
  const queryTerms = [...new Set(termList(request.query))];
  const k1 = 1.2;
  const b = 0.75;

  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    let frequency = 0;
    for (const document of documents) {
      if (document.tokens.includes(term)) frequency += 1;
    }
    documentFrequency.set(term, frequency);
  }

  const ranked = documents
    .map((document) => {
      const frequencies = new Map<string, number>();
      for (const token of document.tokens) {
        frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      }

      let score = 0;
      for (const term of queryTerms) {
        const tf = frequencies.get(term) ?? 0;
        if (tf === 0) continue;
        const df = documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
        const denominator = tf + k1 * (1 - b + b * document.tokens.length / averageLength);
        score += idf * (tf * (k1 + 1)) / denominator;
      }
      return { record: document.record, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));

  const selected = selectWithinBudget(ranked, request.budgetTokens);
  return {
    records: selected.records,
    resolvedEntityIds: filterEntityIds ?? [],
    estimatedTokens: selected.estimatedTokens,
    consideredRecords: candidates.length,
  };
}

export function metadataFilteredBm25Baseline(
  corpus: ContextCorpus,
  request: ContextRequest,
): ContextPackage {
  const resolvedEntityIds = new ContextIndex(corpus).resolveEntities(request.query);
  return bm25Baseline(
    corpus,
    request,
    resolvedEntityIds.length === 0 ? undefined : resolvedEntityIds,
  );
}

export function rawContext(corpus: ContextCorpus): ContextPackage {
  return {
    records: [...corpus.records],
    resolvedEntityIds: [],
    estimatedTokens: corpus.records.reduce((sum, record) => sum + recordTokens(record), 0),
    consideredRecords: corpus.records.length,
  };
}


export interface TemporalEntityDescriptor extends EntityDescriptor {
  readonly id: EntityId;
}

export interface TemporalContextRequest extends ContextRequest {
  /** World-valid time to compile. */
  readonly validAt: string;
  /** Knowledge/transaction cutoff to replay. */
  readonly knownAt: string;
}

export interface TemporalContextCompilerOptions {
  readonly entities: readonly TemporalEntityDescriptor[];
  readonly observations: readonly TemporalObservation[];
  readonly retractions?: readonly SemanticRetraction[];
  readonly authorityByEntity?: ReadonlyMap<EntityId, readonly AuthorityRule[]>;
}

function contextValue(value: StateValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function readableProperty(property: string): string {
  return property
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[._]+/g, " ")
    .trim();
}

function resolvedContextRecord(
  id: string,
  entityId: EntityId,
  text: string,
  evidenceRefs: readonly string[],
): ContextRecord {
  return { id, entityId, kind: "state", text, importance: 1, evidenceRefs };
}

function stateContextRecord(
  prefix: "temporal" | "graph",
  entityId: EntityId,
  property: string,
  label: string,
  state: TemporalStateResolution["canonical"]["properties"][string],
  resolution: TemporalStateResolution,
  includeClockMetadata: boolean,
): ContextRecord {
  const metadata = includeClockMetadata
    ? ` source=${state.source.provider}. validAt=${resolution.validAt}. knownAt=${resolution.knownAt}.`
    : "";
  return resolvedContextRecord(
    `${prefix}-state:${entityId}:${property}`,
    entityId,
    `${label}: ${contextValue(state.value)}.${metadata}`,
    resolution.evidence[property]?.map((item) => item.observationId) ?? [],
  );
}

function conflictContextRecord(
  prefix: "temporal" | "graph",
  entityId: EntityId,
  conflict: Conflict,
  label: string,
  resolution: TemporalStateResolution,
  includeInstruction: boolean,
): ContextRecord {
  const instruction = includeInstruction ? " Do not assert a single value." : "";
  return resolvedContextRecord(
    `${prefix}-conflict:${entityId}:${conflict.property}`,
    entityId,
    `Unresolved conflict for ${label}: ${conflictValues(conflict)}.${instruction}`,
    resolution.conflictEvidence[conflict.property]?.map((item) => item.observationId) ?? [],
  );
}

function groupTemporalObservations(
  observations: readonly TemporalObservation[],
  knownEntities?: ReadonlySet<EntityId>,
): Map<EntityId, TemporalObservation[]> {
  const grouped = new Map<EntityId, TemporalObservation[]>();
  for (const observation of observations) {
    if (knownEntities !== undefined && !knownEntities.has(observation.entityId)) {
      throw new Error(`Temporal observation ${observation.id} references an unknown entity`);
    }
    const current = grouped.get(observation.entityId) ?? [];
    current.push(observation);
    grouped.set(observation.entityId, current);
  }
  return grouped;
}

function groupSemanticRetractions(
  retractions: readonly SemanticRetraction[],
  observations: readonly TemporalObservation[],
  relations: readonly TemporalRelationEdge[],
): Map<EntityId, SemanticRetraction[]> {
  validateUniqueRetractionIds(retractions);
  const observationEntities = new Map(observations.map((observation) => [
    observation.id,
    observation.entityId,
  ]));
  const relationEntities = new Map(relations.map((relation) => [relation.id, relation.from]));
  const grouped = new Map<EntityId, SemanticRetraction[]>();
  for (const retraction of retractions) {
    const entityId = retraction.targetKind === "observation"
      ? observationEntities.get(retraction.targetId)
      : relationEntities.get(retraction.targetId);
    if (entityId === undefined) {
      throw new Error(
        `Semantic retraction ${retraction.id} references unknown ${retraction.targetKind} ${retraction.targetId}`,
      );
    }
    const current = grouped.get(entityId) ?? [];
    current.push(retraction);
    grouped.set(entityId, current);
  }
  return grouped;
}

function resolveEntityTemporalState(
  entityId: EntityId,
  observationsByEntity: ReadonlyMap<EntityId, readonly TemporalObservation[]>,
  authorityByEntity: ReadonlyMap<EntityId, readonly AuthorityRule[]>,
  retractionsByEntity: ReadonlyMap<EntityId, readonly SemanticRetraction[]>,
  request: TemporalContextRequest,
): TemporalStateResolution {
  return resolveTemporalState({
    entityId,
    observations: observationsByEntity.get(entityId) ?? [],
    validAt: request.validAt,
    knownAt: request.knownAt,
    authority: authorityByEntity.get(entityId) ?? [],
    retractions: (retractionsByEntity.get(entityId) ?? []).filter(
      (retraction) => retraction.targetKind === "observation",
    ),
  });
}

function conflictValues(conflict: Conflict): string {
  return conflict.candidates
    .map((candidate) => `${candidate.provider}=${contextValue(candidate.value)}`)
    .join("; ");
}

function recordsForResolution(resolution: TemporalStateResolution): ContextRecord[] {
  const canonical = Object.entries(resolution.canonical.properties)
    .map(([property, state]) => stateContextRecord(
      "temporal",
      resolution.entityId,
      property,
      readableProperty(property),
      state,
      resolution,
      true,
    ));
  const conflicts = resolution.conflicts
    .map((conflict) => conflictContextRecord(
      "temporal",
      resolution.entityId,
      conflict,
      readableProperty(conflict.property),
      resolution,
      true,
    ));
  return [...canonical, ...conflicts];
}

export class TemporalContextCompiler {
  readonly #entities: readonly TemporalEntityDescriptor[];
  readonly #observationsByEntity: ReadonlyMap<EntityId, readonly TemporalObservation[]>;
  readonly #authorityByEntity: ReadonlyMap<EntityId, readonly AuthorityRule[]>;
  readonly #retractionsByEntity: ReadonlyMap<EntityId, readonly SemanticRetraction[]>;
  readonly #entityResolver: ContextIndex;

  constructor(options: TemporalContextCompilerOptions) {
    this.#entities = options.entities;
    this.#authorityByEntity = options.authorityByEntity ?? new Map();
    this.#entityResolver = new ContextIndex({ entities: options.entities, records: [] });
    this.#observationsByEntity = groupTemporalObservations(options.observations);
    this.#retractionsByEntity = groupSemanticRetractions(
      options.retractions ?? [],
      options.observations,
      [],
    );
  }

  compile(request: TemporalContextRequest): ContextPackage {
    const resolvedEntityIds = this.#entityResolver
      .resolveEntities(request.query)
      .filter((entityId): entityId is EntityId => entityId.startsWith("entity://"));

    const records = resolvedEntityIds.flatMap((entityId) => recordsForResolution(
      resolveEntityTemporalState(
        entityId,
        this.#observationsByEntity,
        this.#authorityByEntity,
        this.#retractionsByEntity,
        request,
      ),
    ));

    if (resolvedEntityIds.length === 0 || records.length === 0) {
      return {
        records: [],
        resolvedEntityIds,
        estimatedTokens: 0,
        consideredRecords: records.length,
      };
    }

    return new ContextIndex({ entities: this.#entities, records }).compile(request);
  }
}


export interface ContextPropertyDescriptor {
  readonly property: string;
  readonly aliases: readonly string[];
}

export type ContextVisibilityRequest =
  | { readonly kind: "entity"; readonly entityId: EntityId }
  | {
    readonly kind: "property";
    readonly entityId: EntityId;
    readonly property: string;
  }
  | {
    readonly kind: "relation";
    readonly edgeId: string;
    readonly from: EntityId;
    readonly to: EntityId;
    readonly relationType: string;
  };

export interface ContextVisibilityPolicy {
  allow(request: ContextVisibilityRequest): boolean;
}

export interface GraphContextCompilerOptions {
  readonly entityTypes: readonly EntityTypeDescriptor[];
  readonly entities: readonly TypedEntity[];
  readonly relationTypes: readonly RelationTypeDescriptor[];
  readonly relations: readonly TemporalRelationEdge[];
  readonly observations: readonly TemporalObservation[];
  readonly retractions?: readonly SemanticRetraction[];
  readonly properties?: readonly ContextPropertyDescriptor[];
  readonly authorityByEntity?: ReadonlyMap<EntityId, readonly AuthorityRule[]>;
  readonly visibility?: ContextVisibilityPolicy;
  readonly maxRelationEdges?: number;
}

export interface GraphFrontierStats {
  readonly candidateEdges: number;
  readonly traversedEdges: number;
  readonly edgeIds: readonly string[];
  readonly relatedEntityIds: readonly EntityId[];
  readonly candidateRecords: number;
  readonly relationTraversalTokens: number;
}

export interface GraphContextFrontier {
  readonly entityResolution: EntityResolution;
  readonly resolvedEntityIds: readonly EntityId[];
  readonly expandedEntityIds: readonly EntityId[];
  readonly records: readonly ContextRecord[];
  readonly traversal: GraphFrontierStats;
}

export interface GraphTraversalStats extends GraphFrontierStats {
  readonly outputTokens: number;
}

export interface GraphContextPackage extends ContextPackage {
  readonly entityResolution: EntityResolution;
  readonly traversal: GraphTraversalStats;
}

const allowAllContext: ContextVisibilityPolicy = {
  allow: () => true,
};

function entityAliases(entity: TypedEntity): string[] {
  return entity.aliases.map((alias) => alias.value);
}

function entityName(entity: TypedEntity): string {
  return entity.aliases[0]?.value ?? entity.id;
}

function propertySearchText(
  property: string,
  descriptors: ReadonlyMap<string, ContextPropertyDescriptor>,
): string {
  const aliases = descriptors.get(property)?.aliases ?? [];
  return [readableProperty(property), ...aliases].join(" / ");
}



function stateValueVisible(
  value: StateValue,
  visibility: ContextVisibilityPolicy,
): boolean {
  if (typeof value === "string" && value.startsWith("entity://")) {
    return visibility.allow({ kind: "entity", entityId: value as EntityId });
  }
  if (Array.isArray(value)) {
    return value.every((item) => stateValueVisible(item, visibility));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).every((item) => stateValueVisible(item, visibility));
  }
  return true;
}

function recordsForVisibleResolution(
  resolution: TemporalStateResolution,
  visibility: ContextVisibilityPolicy,
  descriptors: ReadonlyMap<string, ContextPropertyDescriptor>,
): ContextRecord[] {
  const canonical = Object.entries(resolution.canonical.properties)
    .filter(([property, state]) => (
      visibility.allow({
        kind: "property",
        entityId: resolution.entityId,
        property,
      })
      && stateValueVisible(state.value, visibility)
    ))
    .map(([property, state]) => stateContextRecord(
      "graph",
      resolution.entityId,
      property,
      propertySearchText(property, descriptors),
      state,
      resolution,
      false,
    ));
  const conflicts = resolution.conflicts
    .filter((conflict) => visibility.allow({
      kind: "property",
      entityId: resolution.entityId,
      property: conflict.property,
    }))
    .map((conflict) => conflictContextRecord(
      "graph",
      resolution.entityId,
      conflict,
      propertySearchText(conflict.property, descriptors),
      resolution,
      false,
    ));
  return [...canonical, ...conflicts];
}

function relationText(
  edge: TemporalRelationEdge,
  entities: ReadonlyMap<EntityId, TypedEntity>,
  relationTypes: ReadonlyMap<string, RelationTypeDescriptor>,
): string {
  const from = entities.get(edge.from);
  const to = entities.get(edge.to);
  const aliases = relationTypes.get(edge.relationType)?.aliases ?? [edge.relationType];
  return `${from === undefined ? edge.from : entityName(from)} ${aliases.join(" / ")} ${to === undefined ? edge.to : entityName(to)}.`;
}

function relationRecord(
  edge: TemporalRelationEdge,
  entities: ReadonlyMap<EntityId, TypedEntity>,
  relationTypes: ReadonlyMap<string, RelationTypeDescriptor>,
): ContextRecord {
  return {
    id: `graph-relation:${edge.id}`,
    entityId: edge.from,
    kind: "relationship",
    text: relationText(edge, entities, relationTypes),
    importance: 1,
    relatedEntityIds: [edge.to],
    evidenceRefs: edge.evidenceRefs ?? [edge.id],
  };
}

function relationScore(
  edge: TemporalRelationEdge,
  queryTerms: ReadonlySet<string>,
  entities: ReadonlyMap<EntityId, TypedEntity>,
  relationTypes: ReadonlyMap<string, RelationTypeDescriptor>,
): number {
  const searchable = terms(relationText(edge, entities, relationTypes));
  let score = 0;
  for (const term of queryTerms) {
    if (searchable.has(term)) score += 1;
  }
  return score;
}

interface RelationCandidate {
  readonly edge: TemporalRelationEdge;
  readonly score: number;
  readonly tokenCost: number;
}

function relationCandidates(
  edges: readonly TemporalRelationEdge[],
  queryTerms: ReadonlySet<string>,
  entities: ReadonlyMap<EntityId, TypedEntity>,
  relationTypes: ReadonlyMap<string, RelationTypeDescriptor>,
): RelationCandidate[] {
  return edges
    .map((edge) => ({
      edge,
      score: relationScore(edge, queryTerms, entities, relationTypes),
      tokenCost: recordTokens(relationRecord(edge, entities, relationTypes)),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => (
      right.score - left.score
      || left.tokenCost - right.tokenCost
      || left.edge.id.localeCompare(right.edge.id)
    ));
}

function selectRelationCandidates(
  candidates: readonly RelationCandidate[],
  maxRelationEdges: number,
  budgetTokens: number,
): { readonly edges: readonly TemporalRelationEdge[]; readonly tokenCost: number } {
  const edges: TemporalRelationEdge[] = [];
  let tokenCost = 0;
  for (const candidate of candidates) {
    if (edges.length >= maxRelationEdges) break;
    if (tokenCost + candidate.tokenCost > budgetTokens) continue;
    edges.push(candidate.edge);
    tokenCost += candidate.tokenCost;
  }
  return { edges, tokenCost };
}

function emptyGraphFrontier(
  entityResolution: EntityResolution,
): GraphContextFrontier {
  return {
    entityResolution,
    resolvedEntityIds: [],
    expandedEntityIds: [],
    records: [],
    traversal: {
      candidateEdges: 0,
      traversedEdges: 0,
      edgeIds: [],
      relatedEntityIds: [],
      candidateRecords: 0,
      relationTraversalTokens: 0,
    },
  };
}

function packageFromEmptyFrontier(
  frontier: GraphContextFrontier,
): GraphContextPackage {
  return {
    records: [],
    resolvedEntityIds: frontier.resolvedEntityIds,
    estimatedTokens: 0,
    consideredRecords: frontier.records.length,
    entityResolution: frontier.entityResolution,
    traversal: {
      ...frontier.traversal,
      outputTokens: 0,
    },
  };
}

export class GraphContextCompiler {
  readonly #entityTypes: readonly EntityTypeDescriptor[];
  readonly #entities: readonly TypedEntity[];
  readonly #entityMap: ReadonlyMap<EntityId, TypedEntity>;
  readonly #relationTypes: ReadonlyMap<string, RelationTypeDescriptor>;
  readonly #relations: readonly TemporalRelationEdge[];
  readonly #observationsByEntity: ReadonlyMap<EntityId, readonly TemporalObservation[]>;
  readonly #retractionsByEntity: ReadonlyMap<EntityId, readonly SemanticRetraction[]>;
  readonly #properties: ReadonlyMap<string, ContextPropertyDescriptor>;
  readonly #authorityByEntity: ReadonlyMap<EntityId, readonly AuthorityRule[]>;
  readonly #visibility: ContextVisibilityPolicy;
  readonly #maxRelationEdges: number;

  constructor(options: GraphContextCompilerOptions) {
    this.#entityTypes = options.entityTypes;
    this.#entities = options.entities;
    this.#entityMap = new Map(options.entities.map((entity) => [entity.id, entity]));
    this.#relationTypes = new Map(options.relationTypes.map((type) => [type.id, type]));
    this.#relations = options.relations;
    this.#properties = new Map((options.properties ?? []).map((descriptor) => [descriptor.property, descriptor]));
    this.#authorityByEntity = options.authorityByEntity ?? new Map();
    this.#visibility = options.visibility ?? allowAllContext;
    const maxRelationEdges = options.maxRelationEdges ?? 4;
    if (!Number.isInteger(maxRelationEdges) || maxRelationEdges < 0) {
      throw new Error("maxRelationEdges must be a non-negative integer");
    }
    this.#maxRelationEdges = maxRelationEdges;

    if (this.#relationTypes.size !== options.relationTypes.length) {
      throw new Error("Relation type ids must be unique");
    }
    if (this.#properties.size !== (options.properties ?? []).length) {
      throw new Error("Context property descriptors must be unique by property");
    }
    for (const relation of options.relations) {
      if (!this.#relationTypes.has(relation.relationType)) {
        throw new Error(`Relation ${relation.id} references unknown relation type ${relation.relationType}`);
      }
      if (!this.#entityMap.has(relation.from) || !this.#entityMap.has(relation.to)) {
        throw new Error(`Relation ${relation.id} references an unknown entity`);
      }
    }
    this.#observationsByEntity = groupTemporalObservations(
      options.observations,
      new Set(this.#entityMap.keys()),
    );
    this.#retractionsByEntity = groupSemanticRetractions(
      options.retractions ?? [],
      options.observations,
      options.relations,
    );
  }

  #visibleEntities(): TypedEntity[] {
    return this.#entities.filter((entity) => this.#visibility.allow({
      kind: "entity",
      entityId: entity.id,
    }));
  }

  #stateRecords(
    entityIds: readonly EntityId[],
    request: TemporalContextRequest,
  ): ContextRecord[] {
    return entityIds.flatMap((entityId) => recordsForVisibleResolution(
      resolveEntityTemporalState(
        entityId,
        this.#observationsByEntity,
        this.#authorityByEntity,
        this.#retractionsByEntity,
        request,
      ),
      this.#visibility,
      this.#properties,
    ));
  }

  frontier(request: TemporalContextRequest): GraphContextFrontier {
    const visibleEntities = this.#visibleEntities();
    const resolution = new TypedEntityResolver({
      types: this.#entityTypes,
      entities: visibleEntities,
    }).resolve(request.query);
    if (resolution.status !== "resolved") return emptyGraphFrontier(resolution);

    const directEntityId = resolution.entityId;
    const activeEdges = activeRelationEdges({
      edges: this.#relations,
      fromEntityIds: [directEntityId],
      validAt: request.validAt,
      knownAt: request.knownAt,
      retractions: (this.#retractionsByEntity.get(directEntityId) ?? []).filter(
        (retraction) => retraction.targetKind === "relation",
      ),
    }).filter((edge) => (
      this.#visibility.allow({ kind: "entity", entityId: edge.to })
      && this.#visibility.allow({
        kind: "relation",
        edgeId: edge.id,
        from: edge.from,
        to: edge.to,
        relationType: edge.relationType,
      })
    ));

    const candidates = relationCandidates(
      activeEdges,
      terms(request.query),
      this.#entityMap,
      this.#relationTypes,
    );
    const selectedRelations = selectRelationCandidates(
      candidates,
      this.#maxRelationEdges,
      request.budgetTokens,
    );
    const traversed = selectedRelations.edges;
    const relatedEntityIds = [...new Set(traversed.map((edge) => edge.to))];
    const expandedEntityIds = [directEntityId, ...relatedEntityIds];
    const stateRecords = this.#stateRecords(expandedEntityIds, request);
    const relationRecords = traversed.map((edge) => relationRecord(
      edge,
      this.#entityMap,
      this.#relationTypes,
    ));
    const records = [...relationRecords, ...stateRecords];

    return {
      entityResolution: resolution,
      resolvedEntityIds: [directEntityId],
      expandedEntityIds,
      records,
      traversal: {
        candidateEdges: candidates.length,
        traversedEdges: traversed.length,
        edgeIds: traversed.map((edge) => edge.id),
        relatedEntityIds,
        candidateRecords: records.length,
        relationTraversalTokens: selectedRelations.tokenCost,
      },
    };
  }

  compile(request: TemporalContextRequest): GraphContextPackage {
    const frontier = this.frontier(request);
    if (frontier.entityResolution.status !== "resolved" || frontier.records.length === 0) {
      return packageFromEmptyFrontier(frontier);
    }

    const visibleEntities = this.#visibleEntities();
    const corpus: ContextCorpus = {
      entities: visibleEntities.map((entity) => ({
        id: entity.id,
        aliases: entityAliases(entity),
      })),
      records: frontier.records,
    };
    const ranked = bm25Baseline(corpus, request, frontier.expandedEntityIds);

    return {
      ...ranked,
      resolvedEntityIds: frontier.resolvedEntityIds,
      entityResolution: frontier.entityResolution,
      traversal: {
        ...frontier.traversal,
        outputTokens: ranked.estimatedTokens,
      },
    };
  }
}


export interface ContextCapsuleView {
  readonly entityId: EntityId;
  readonly material: {
    readonly entity: TypedEntity;
    readonly state: Pick<
      TemporalStateResolution,
      "canonical" | "conflicts" | "evidence" | "conflictEvidence"
    >;
    readonly activeRelations: readonly TemporalRelationEdge[];
  };
}

export interface CapsuleContextProjectionOptions {
  readonly relationTypes: readonly RelationTypeDescriptor[];
  readonly properties?: readonly ContextPropertyDescriptor[];
}

export function contextCorpusFromCapsules(
  capsules: readonly ContextCapsuleView[],
  options: CapsuleContextProjectionOptions,
): ContextCorpus {
  const entityMap = new Map<EntityId, TypedEntity>();
  for (const capsule of capsules) {
    entityMap.set(capsule.entityId, capsule.material.entity);
  }
  const relationTypes = new Map(options.relationTypes.map((type) => [type.id, type]));
  const properties = new Map(
    (options.properties ?? []).map((descriptor) => [descriptor.property, descriptor]),
  );
  const records: ContextRecord[] = [];

  for (const capsule of [...capsules].sort((left, right) => left.entityId.localeCompare(right.entityId))) {
    const state = capsule.material.state;
    for (const [property, value] of Object.entries(state.canonical.properties)) {
      records.push(resolvedContextRecord(
        `capsule-state:${capsule.entityId}:${property}`,
        capsule.entityId,
        `${propertySearchText(property, properties)}: ${contextValue(value.value)}.`,
        state.evidence[property]?.map((item) => item.observationId) ?? [],
      ));
    }
    for (const conflict of state.conflicts) {
      records.push(resolvedContextRecord(
        `capsule-conflict:${capsule.entityId}:${conflict.property}`,
        capsule.entityId,
        `Unresolved conflict for ${propertySearchText(conflict.property, properties)}: ${conflictValues(conflict)}.`,
        state.conflictEvidence[conflict.property]?.map((item) => item.observationId) ?? [],
      ));
    }
    for (const relation of capsule.material.activeRelations) {
      records.push(relationRecord(relation, entityMap, relationTypes));
    }
  }

  return {
    entities: [...entityMap.values()]
      .toSorted((left, right) => left.id.localeCompare(right.id))
      .map((entity) => ({ id: entity.id, aliases: entityAliases(entity) })),
    records: records.toSorted((left, right) => left.id.localeCompare(right.id)),
  };
}
