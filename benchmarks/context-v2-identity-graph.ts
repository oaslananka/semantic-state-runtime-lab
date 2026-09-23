import type {
  AuthorityRule,
  EntityId,
  EntityTypeDescriptor,
  RelationTypeDescriptor,
  TemporalObservation,
  TemporalRelationEdge,
  TypedEntity,
} from "../packages/core/dist/index.js";
import {
  ContextIndex,
  GraphContextCompiler,
  bm25Baseline,
  estimateTokens,
  lexicalBaseline,
  type ContextCorpus,
  type ContextPackage,
  type ContextPropertyDescriptor,
  type ContextRecord,
  type GraphContextFrontier,
  type TemporalContextRequest,
} from "../packages/context/dist/index.js";

interface BenchmarkTask {
  readonly name: string;
  readonly query: string;
  readonly budgetTokens: number;
  readonly requiredEvidence: readonly string[];
  readonly expectedEntityId?: EntityId;
  readonly expectAmbiguous?: boolean;
}

interface BenchResult {
  readonly records: readonly ContextRecord[];
  readonly resolvedEntityIds: readonly string[];
  readonly estimatedTokens: number;
  readonly consideredRecords: number;
  readonly resolutionStatus: string;
  readonly candidateEdges: number;
  readonly traversedEdges: number;
}

const project = "entity://project/atlas" as const;
const atlasPerson = "entity://person/atlas" as const;
const alice = "entity://person/alice" as const;
const orion = "entity://robot/orion" as const;

function entityTypeRows(
  rows: readonly (readonly [string, ...string[]])[],
): EntityTypeDescriptor[] {
  return rows.map(([id, ...aliases]) => ({ id, aliases }));
}

function typedEntityRows(
  rows: readonly (readonly [EntityId, string, ...string[]])[],
): TypedEntity[] {
  return rows.map(([id, type, ...aliases]) => ({
    id,
    type,
    aliases: aliases.map((value) => ({ value })),
  }));
}

function relationTypeRows(
  rows: readonly (readonly [string, ...string[]])[],
): RelationTypeDescriptor[] {
  return rows.map(([id, ...aliases]) => ({ id, aliases }));
}

function propertyRows(
  rows: readonly (readonly [string, ...string[]])[],
): ContextPropertyDescriptor[] {
  return rows.map(([property, ...aliases]) => ({ property, aliases }));
}

const entityTypes = entityTypeRows([
  ["Project", "project", "proje", "projesi", "projesinin"],
  ["Person", "person", "kişi", "kişisi", "kişisinin"],
  ["Robot", "robot"],
]);

const typedEntities = typedEntityRows([
  [project, "Project", "Project Atlas", "Atlas"],
  [atlasPerson, "Person", "Atlas person", "Atlas"],
  [alice, "Person", "Alice"],
  [orion, "Robot", "Orion"],
]);

const relationTypes = relationTypeRows([
  ["Project.owner", "owner", "sahip", "sahibi", "sahibinin"],
  ["Project.robot", "robot", "cihaz"],
]);

const propertyDescriptors = propertyRows([
  ["Project.ownerEntityId", "owner", "sahip", "sahibi"],
  ["Person.timezone", "timezone", "saat dilimi", "saat diliminde"],
  ["Person.employer", "employer", "işveren", "işvereni"],
  ["Robot.status", "status", "durum"],
]);

type ObservationRow = readonly [
  id: string,
  entityId: EntityId,
  property: string,
  value: string,
  provider: string,
];

function observations(rows: readonly ObservationRow[]): TemporalObservation[] {
  return rows.map(([id, entityId, property, value, provider]) => ({
    id,
    entityId,
    property,
    value,
    source: { provider, externalId: id },
    validFrom: "2026-01-01T00:00:00Z",
    recordedAt: "2026-01-02T00:00:00Z",
  }));
}

const temporalObservations = observations([
  ["project-owner", project, "Project.ownerEntityId", alice, "directory"],
  ["alice-timezone", alice, "Person.timezone", "Europe/Istanbul", "profile"],
  ["atlas-employer", atlasPerson, "Person.employer", "Acme Robotics", "profile"],
  ["orion-status", orion, "Robot.status", "charging", "robot-registry"],
]);

const relations: readonly TemporalRelationEdge[] = [
  {
    id: "atlas-owner-alice",
    from: project,
    to: alice,
    relationType: "Project.owner",
    validFrom: "2026-01-01T00:00:00Z",
    recordedAt: "2026-01-02T00:00:00Z",
    evidenceRefs: ["owner-edge"],
  },
  {
    id: "atlas-robot-orion",
    from: project,
    to: orion,
    relationType: "Project.robot",
    validFrom: "2026-01-01T00:00:00Z",
    recordedAt: "2026-01-02T00:00:00Z",
    evidenceRefs: ["robot-edge"],
  },
];

const authorityByEntity: ReadonlyMap<EntityId, readonly AuthorityRule[]> = new Map([
  [project, [{ property: "Project.ownerEntityId", strategy: { kind: "provider", provider: "directory" } }]],
  [alice, [{ property: "Person.timezone", strategy: { kind: "provider", provider: "profile" } }]],
  [atlasPerson, [{ property: "Person.employer", strategy: { kind: "provider", provider: "profile" } }]],
  [orion, [{ property: "Robot.status", strategy: { kind: "provider", provider: "robot-registry" } }]],
]);

const graphCompiler = new GraphContextCompiler({
  entityTypes,
  entities: typedEntities,
  relationTypes,
  relations,
  observations: temporalObservations,
  properties: propertyDescriptors,
  authorityByEntity,
});

const legacyCorpus: ContextCorpus = {
  entities: typedEntities.map((entity) => ({
    id: entity.id,
    aliases: entity.aliases.map((alias) => alias.value),
  })),
  records: [
    {
      id: "legacy-owner-edge",
      entityId: project,
      kind: "relationship",
      text: "Project Atlas owner / sahibi Alice.",
      relatedEntityIds: [alice],
      evidenceRefs: ["owner-edge"],
    },
    {
      id: "legacy-robot-edge",
      entityId: project,
      kind: "relationship",
      text: "Project Atlas robot / cihaz Orion.",
      relatedEntityIds: [orion],
      evidenceRefs: ["robot-edge"],
    },
    {
      id: "legacy-owner-state",
      entityId: project,
      kind: "state",
      text: "project owner / proje sahibi: Alice.",
      evidenceRefs: ["project-owner"],
    },
    {
      id: "legacy-alice-timezone",
      entityId: alice,
      kind: "state",
      text: "timezone / saat dilimi: Europe/Istanbul.",
      evidenceRefs: ["alice-timezone"],
    },
    {
      id: "legacy-atlas-employer",
      entityId: atlasPerson,
      kind: "state",
      text: "employer / işveren / işvereni: Acme Robotics.",
      evidenceRefs: ["atlas-employer"],
    },
    {
      id: "legacy-orion-status",
      entityId: orion,
      kind: "state",
      text: "robot status / robot durum: charging.",
      evidenceRefs: ["orion-status"],
    },
  ],
};

function recordCost(record: ContextRecord): number {
  return estimateTokens(record.text) + 8;
}

function selectBudget(
  ranked: readonly ContextRecord[],
  budgetTokens: number,
): { readonly records: ContextRecord[]; readonly estimatedTokens: number } {
  const records: ContextRecord[] = [];
  let estimatedTokens = 0;
  for (const record of ranked) {
    const cost = recordCost(record);
    if (estimatedTokens + cost > budgetTokens) continue;
    records.push(record);
    estimatedTokens += cost;
  }
  return { records, estimatedTokens };
}

function legacyExpandedEntityIds(query: string): string[] {
  const index = new ContextIndex(legacyCorpus);
  const direct = index.resolveEntities(query);
  const expanded = new Set(direct);
  for (const record of legacyCorpus.records) {
    if (!expanded.has(record.entityId)) continue;
    for (const related of record.relatedEntityIds ?? []) expanded.add(related);
  }
  return [...expanded];
}

function legacyContextIndex(request: TemporalContextRequest): BenchResult {
  const result = new ContextIndex(legacyCorpus).compile(request);
  return {
    ...result,
    resolutionStatus: result.resolvedEntityIds.length > 1 ? "multiple" : "resolved",
    candidateEdges: 0,
    traversedEdges: 0,
  };
}

function legacyGraphBm25(request: TemporalContextRequest): BenchResult {
  const expanded = legacyExpandedEntityIds(request.query);
  const result = bm25Baseline(legacyCorpus, request, expanded);
  return {
    ...result,
    resolutionStatus: expanded.length === 0 ? "none" : (new ContextIndex(legacyCorpus).resolveEntities(request.query).length > 1 ? "multiple" : "resolved"),
    candidateEdges: 0,
    traversedEdges: Math.max(0, expanded.length - new ContextIndex(legacyCorpus).resolveEntities(request.query).length),
  };
}

function typedGraphBm25(request: TemporalContextRequest): BenchResult {
  const result = graphCompiler.compile(request);
  return {
    records: result.records,
    resolvedEntityIds: result.resolvedEntityIds,
    estimatedTokens: result.estimatedTokens,
    consideredRecords: result.consideredRecords,
    resolutionStatus: result.entityResolution.status,
    candidateEdges: result.traversal.candidateEdges,
    traversedEdges: result.traversal.traversedEdges,
  };
}

function rankIds(result: ContextPackage): string[] {
  return result.records.map((record) => record.id);
}

function rrfRanking(
  frontier: GraphContextFrontier,
  request: TemporalContextRequest,
): ContextRecord[] {
  if (frontier.entityResolution.status !== "resolved") return [];
  const entityMap = new Map(typedEntities.map((entity) => [entity.id, entity]));
  const corpus: ContextCorpus = {
    entities: frontier.expandedEntityIds.map((entityId) => ({
      id: entityId,
      aliases: entityMap.get(entityId)?.aliases.map((alias) => alias.value) ?? [entityId],
    })),
    records: frontier.records,
  };
  const wideRequest = { query: request.query, budgetTokens: 100_000 };
  const bm25 = bm25Baseline(corpus, wideRequest, frontier.expandedEntityIds);
  const lexical = lexicalBaseline(corpus, wideRequest);
  const scores = new Map<string, number>();
  for (const ranking of [rankIds(bm25), rankIds(lexical)]) {
    ranking.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + index + 1));
    });
  }
  return [...frontier.records]
    .filter((record) => scores.has(record.id))
    .sort((left, right) => (
      (scores.get(right.id) ?? 0) - (scores.get(left.id) ?? 0)
      || left.id.localeCompare(right.id)
    ));
}

function typedGraphHybrid(request: TemporalContextRequest): BenchResult {
  const frontier = graphCompiler.frontier(request);
  const selected = selectBudget(rrfRanking(frontier, request), request.budgetTokens);
  return {
    records: selected.records,
    resolvedEntityIds: frontier.resolvedEntityIds,
    estimatedTokens: selected.estimatedTokens,
    consideredRecords: frontier.records.length,
    resolutionStatus: frontier.entityResolution.status,
    candidateEdges: frontier.traversal.candidateEdges,
    traversedEdges: frontier.traversal.traversedEdges,
  };
}

const now = {
  validAt: "2026-09-24T00:00:00Z",
  knownAt: "2026-09-24T00:00:00Z",
};

const tasks: readonly BenchmarkTask[] = [
  {
    name: "unique-alice-timezone-control",
    query: "Alice hangi saat diliminde?",
    budgetTokens: 70,
    requiredEvidence: ["alice-timezone"],
    expectedEntityId: alice,
  },
  {
    name: "project-owner-timezone-tr",
    query: "Atlas projesinin sahibi kim ve sahibi hangi saat diliminde?",
    budgetTokens: 145,
    requiredEvidence: ["owner-edge", "alice-timezone"],
    expectedEntityId: project,
  },
  {
    name: "person-employer-tr",
    query: "Atlas kişisinin işvereni nedir?",
    budgetTokens: 85,
    requiredEvidence: ["atlas-employer"],
    expectedEntityId: atlasPerson,
  },
  {
    name: "project-robot-status-tr",
    query: "Atlas projesinin robot durumu nedir?",
    budgetTokens: 115,
    requiredEvidence: ["robot-edge", "orion-status"],
    expectedEntityId: project,
  },
  {
    name: "bare-atlas-ambiguity",
    query: "Atlas",
    budgetTokens: 80,
    requiredEvidence: [],
    expectAmbiguous: true,
  },
];

function evidenceIds(result: BenchResult): Set<string> {
  return new Set(result.records.flatMap((record) => record.evidenceRefs ?? []));
}

function evaluate(method: string, task: BenchmarkTask, result: BenchResult) {
  const evidence = evidenceIds(result);
  const requiredHits = task.requiredEvidence.filter((id) => evidence.has(id)).length;
  const evidenceRecall = task.requiredEvidence.length === 0
    ? 1
    : requiredHits / task.requiredEvidence.length;
  const identityCorrect = task.expectedEntityId === undefined
    || (result.resolvedEntityIds.length === 1 && result.resolvedEntityIds[0] === task.expectedEntityId);
  const ambiguityCorrect = task.expectAmbiguous !== true
    || (result.resolutionStatus === "ambiguous" && result.records.length === 0);
  const taskSuccess = evidenceRecall === 1 && identityCorrect && ambiguityCorrect;

  return {
    task: task.name,
    method,
    taskSuccess: taskSuccess ? 1 : 0,
    evidenceRecall: Number(evidenceRecall.toFixed(3)),
    identityCorrect,
    resolutionStatus: result.resolutionStatus,
    estimatedTokens: result.estimatedTokens,
    returnedRecords: result.records.length,
    consideredRecords: result.consideredRecords,
    candidateEdges: result.candidateEdges,
    traversedEdges: result.traversedEdges,
    returnedEvidence: [...evidence].sort(),
    returnedIds: result.records.map((record) => record.id),
  };
}

const methods = [
  ["legacy-context-index", legacyContextIndex],
  ["legacy-graph-bm25", legacyGraphBm25],
  ["typed-graph-bm25", typedGraphBm25],
  ["typed-graph-bm25-lexical-rrf", typedGraphHybrid],
] as const;

const rows = tasks.flatMap((task) => {
  const request: TemporalContextRequest = {
    query: task.query,
    budgetTokens: task.budgetTokens,
    ...now,
  };
  return methods.map(([name, method]) => evaluate(name, task, method(request)));
});

const summary = Object.fromEntries(methods.map(([name]) => {
  const methodRows = rows.filter((row) => row.method === name);
  return [name, {
    taskSuccessRate: Number((methodRows.reduce((sum, row) => sum + row.taskSuccess, 0) / methodRows.length).toFixed(3)),
    meanEvidenceRecall: Number((methodRows.reduce((sum, row) => sum + row.evidenceRecall, 0) / methodRows.length).toFixed(3)),
    meanTokens: Number((methodRows.reduce((sum, row) => sum + row.estimatedTokens, 0) / methodRows.length).toFixed(1)),
  }];
}));

console.log(JSON.stringify({
  benchmark: "context-v2-typed-identity-graph",
  note: "The hybrid baseline is reproducible lexical+BM25 reciprocal-rank fusion over the exact same typed semantic frontier. It is not a vector-hybrid claim; the prior one-time MiniLM vector+BM25 checkpoint remains documented separately.",
  summary,
  rows,
}, null, 2));
