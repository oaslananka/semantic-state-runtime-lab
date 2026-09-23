import { performance } from "node:perf_hooks";
import {
  planReconciliation,
  type AuthorityRule,
  type EntityId,
  type ExternalSnapshot,
  type StateValue,
} from "../packages/core/dist/index.js";
import {
  ContextIndex,
  bm25Baseline,
  type ContextCorpus,
  type ContextKind,
  type ContextPackage,
  type ContextRecord,
} from "../packages/context/dist/index.js";

interface Observation {
  readonly id: string;
  readonly entityId: EntityId;
  readonly provider: string;
  readonly externalId: string;
  readonly property: string;
  readonly externalPath: string;
  readonly value: StateValue;
  readonly observedAt: string;
  readonly text: string;
  readonly kind: ContextKind;
  readonly relatedEntityIds?: readonly EntityId[];
}

interface EvidenceMeta {
  readonly facts: readonly { readonly key: string; readonly value: StateValue }[];
  readonly conflicts: readonly string[];
  readonly observedAt?: string;
}

interface EvidenceCorpus {
  readonly corpus: ContextCorpus;
  readonly evidence: ReadonlyMap<string, EvidenceMeta>;
}

interface ExpectedFact {
  readonly entityId: EntityId;
  readonly property: string;
  readonly value: StateValue;
}

interface BenchmarkTask {
  readonly name: string;
  readonly query: string;
  readonly budgetTokens: number;
  readonly expectedFacts?: readonly ExpectedFact[];
  readonly expectConflicts?: readonly { readonly entityId: EntityId; readonly property: string }[];
  readonly answerNeedles?: readonly string[];
  readonly forbiddenNeedles?: readonly string[];
}

interface MethodResult {
  readonly context: ContextPackage;
  readonly retrievalCalls: number;
  readonly medianLatencyMs: number;
}

const atlas = "entity://project/atlas" as const;
const alice = "entity://person/alice" as const;
const atlasPerson = "entity://person/atlas" as const;

function factKey(entityId: EntityId, property: string): string {
  return `${entityId}::${property}`;
}

function valueText(value: StateValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

type ObservationArgs = readonly [
  id: string,
  entityId: EntityId,
  provider: string,
  externalId: string,
  property: string,
  externalPath: string,
  value: StateValue,
  observedAt: string,
  text: string,
  kind?: ContextKind,
  relatedEntityIds?: readonly EntityId[],
];

function observation(args: ObservationArgs): Observation {
  const [
    id,
    entityId,
    provider,
    externalId,
    property,
    externalPath,
    value,
    observedAt,
    text,
    kind = "state",
    relatedEntityIds,
  ] = args;
  return {
    id,
    entityId,
    provider,
    externalId,
    property,
    externalPath,
    value,
    observedAt,
    text,
    kind,
    ...(relatedEntityIds === undefined ? {} : { relatedEntityIds }),
  };
}

function observations(): Observation[] {
  return [
    observation([
      "atlas-deadline-pm", atlas, "pm", "atlas",
      "Project.deadline", "deadline", "2026-11-20", "2026-09-10T09:00:00Z",
      "Project Atlas delivery deadline is 2026-11-20 in the authoritative project system. Atlas projesi teslim tarihi 2026-11-20.",
    ]),
    observation([
      "atlas-deadline-chat-proposal", atlas, "chat", "thread-77",
      "Project.deadline", "deadline", "2026-11-25", "2026-09-15T13:00:00Z",
      "A chat proposal suggests moving Project Atlas delivery to 2026-11-25, pending project-system approval.",
      "event",
    ]),
    observation([
      "atlas-api-rest-old", atlas, "adr", "adr-api",
      "Project.apiStyle", "apiStyle", "REST", "2026-02-10T10:00:00Z",
      "ADR: Project Atlas API style is REST. This decision was recorded on 2026-02-10.",
      "decision",
    ]),
    observation([
      "atlas-api-graphql-new", atlas, "adr", "adr-api",
      "Project.apiStyle", "apiStyle", "GraphQL", "2026-08-20T10:00:00Z",
      "ADR supersedes the previous API decision: Project Atlas API style is GraphQL as of 2026-08-20.",
      "decision",
    ]),
    observation([
      "atlas-owner-directory", atlas, "directory", "atlas",
      "Project.ownerEntityId", "owner", alice, "2026-09-01T08:00:00Z",
      "Project Atlas owner is Alice. Atlas projesinin sahibi Alice.",
      "relationship", [alice],
    ]),
    observation([
      "alice-timezone-profile", alice, "profile", "alice",
      "Person.timezone", "timezone", "Europe/Istanbul", "2026-09-05T08:00:00Z",
      "Alice works in timezone Europe/Istanbul. Alice saat dilimi Europe/Istanbul.",
    ]),
    observation([
      "atlas-person-employer", atlasPerson, "profile", "atlas-person",
      "Person.employer", "employer", "Acme Robotics", "2026-09-12T08:00:00Z",
      "The person Atlas works at Acme Robotics. Atlas kişisinin işvereni Acme Robotics.",
    ]),
    observation([
      "atlas-stage-ops", atlas, "ops", "atlas-release",
      "Project.releaseStage", "stage", "beta", "2026-09-20T10:00:00Z",
      "Operations reports Project Atlas release stage as beta.",
    ]),
    observation([
      "atlas-stage-pm", atlas, "pm", "atlas-release",
      "Project.releaseStage", "stage", "production", "2026-09-20T10:00:00Z",
      "Project system reports Project Atlas release stage as production at the same observation time.",
    ]),
  ];
}

function authority(): ReadonlyMap<EntityId, readonly AuthorityRule[]> {
  return new Map([
    [atlas, [
      { property: "Project.deadline", strategy: { kind: "provider", provider: "pm" } },
      { property: "Project.apiStyle", strategy: { kind: "provider", provider: "adr" } },
      { property: "Project.ownerEntityId", strategy: { kind: "provider", provider: "directory" } },
    ]],
    [alice, [
      { property: "Person.timezone", strategy: { kind: "provider", provider: "profile" } },
    ]],
    [atlasPerson, [
      { property: "Person.employer", strategy: { kind: "provider", provider: "profile" } },
    ]],
  ]);
}

function entities() {
  const result = [
    { id: atlas, aliases: ["Project Atlas", "Atlas Project", "Atlas projesi", "Atlas"] },
    { id: alice, aliases: ["Alice", "Alice Yilmaz"] },
    { id: atlasPerson, aliases: ["Atlas kişisi", "Atlas person", "Atlas"] },
  ];
  for (let i = 0; i < 80; i += 1) {
    const n = i.toString().padStart(3, "0");
    result.push({ id: `entity://project/noise-${n}`, aliases: [`Project Noise ${n}`] });
  }
  return result;
}

function noiseProperty(item: number): "Project.deadline" | "Project.apiStyle" {
  return item % 2 === 0 ? "Project.deadline" : "Project.apiStyle";
}

function noiseValue(property: string, item: number): StateValue {
  if (property.endsWith("deadline")) return `2027-0${(item % 9) + 1}-15`;
  return item % 3 === 0 ? "GraphQL" : "REST";
}

function noiseObservation(n: string, entityId: EntityId, item: number): Observation {
  const property = noiseProperty(item);
  const provider = item % 3 === 0 ? "chat" : "pm";
  const externalPath = property.endsWith("deadline") ? "deadline" : "apiStyle";
  const kind: ContextKind = item % 2 === 0 ? "state" : "event";
  const day = ((item % 27) + 1).toString().padStart(2, "0");
  return observation([
    `noise-${n}-${item}`,
    entityId,
    provider,
    `noise-${n}-${item}`,
    property,
    externalPath,
    noiseValue(property, item),
    `2026-08-${day}T12:00:00Z`,
    `Unrelated project ${n} planning record ${item}: deadline API REST GraphQL owner release stage authentication delivery.`,
    kind,
  ]);
}

function noiseObservations(): Observation[] {
  const result: Observation[] = [];
  for (let project = 0; project < 80; project += 1) {
    const n = project.toString().padStart(3, "0");
    const entityId = `entity://project/noise-${n}` as EntityId;
    for (let item = 0; item < 25; item += 1) {
      result.push(noiseObservation(n, entityId, item));
    }
  }
  return result;
}

function rawEvidence(all: readonly Observation[]): EvidenceCorpus {
  const evidence = new Map<string, EvidenceMeta>();
  const records = all.map((observation): ContextRecord => {
    evidence.set(observation.id, {
      facts: [{ key: factKey(observation.entityId, observation.property), value: observation.value }],
      conflicts: [],
      observedAt: observation.observedAt,
    });
    return {
      id: observation.id,
      entityId: observation.entityId,
      kind: observation.kind,
      text: `[observed=${observation.observedAt} source=${observation.provider}] ${observation.text}`,
      importance: 0.7,
      ...(observation.relatedEntityIds === undefined ? {} : { relatedEntityIds: observation.relatedEntityIds }),
    };
  });
  return { corpus: { entities: entities(), records }, evidence };
}

function latestBySourceProperty(all: readonly Observation[]): Observation[] {
  const latest = new Map<string, Observation>();
  for (const observation of all) {
    const key = JSON.stringify([
      observation.entityId,
      observation.provider,
      observation.externalId,
      observation.property,
    ]);
    const existing = latest.get(key);
    if (
      existing === undefined
      || Date.parse(observation.observedAt) > Date.parse(existing.observedAt)
      || (observation.observedAt === existing.observedAt && observation.id.localeCompare(existing.id) > 0)
    ) {
      latest.set(key, observation);
    }
  }
  return [...latest.values()];
}

function observationSnapshot(observation: Observation): ExternalSnapshot {
  return {
    binding: {
      entityId: observation.entityId,
      provider: observation.provider,
      externalId: observation.externalId,
      fields: [{
        canonical: observation.property,
        external: observation.externalPath,
        readable: true,
        writable: false,
      }],
    },
    revision: `obs:${observation.id}`,
    observedAt: observation.observedAt,
    values: { [observation.externalPath]: observation.value },
  };
}

const propertyLabels: Readonly<Record<string, string>> = {
  "Project.deadline": "delivery deadline / teslim tarihi",
  "Project.apiStyle": "API architecture style / API mimarisi",
  "Project.ownerEntityId": "project owner / proje sahibi",
  "Project.releaseStage": "release stage / yayın aşaması",
  "Person.timezone": "timezone / saat dilimi",
  "Person.employer": "employer / işveren",
};

function propertyLabel(property: string): string {
  return propertyLabels[property] ?? property;
}

function stateText(
  entityId: EntityId,
  property: string,
  value: StateValue,
  provider: string,
  observedAt: string,
): string {
  return `${entityId} ${propertyLabel(property)}: ${valueText(value)}. Canonical source=${provider}, observed=${observedAt}.`;
}

function canonicalKind(property: string): ContextKind {
  if (property.includes("owner")) return "relationship";
  if (property.includes("apiStyle")) return "decision";
  return "state";
}

function relatedEntityIdsForState(
  observations: readonly Observation[],
  property: string,
  provider: string,
  externalId: string,
  value: StateValue,
): readonly EntityId[] | undefined {
  return observations.find((candidate) => (
    candidate.provider === provider
    && candidate.externalId === externalId
    && candidate.property === property
    && candidate.value === value
  ))?.relatedEntityIds;
}

function addCanonicalStateRecords(
  entityId: EntityId,
  entityObservations: readonly Observation[],
  properties: ReturnType<typeof planReconciliation>["canonical"]["properties"],
  evidence: Map<string, EvidenceMeta>,
  records: ContextRecord[],
): void {
  for (const [property, state] of Object.entries(properties)) {
    const id = `state:${entityId}:${property}`;
    const relatedEntityIds = relatedEntityIdsForState(
      entityObservations,
      property,
      state.source.provider,
      state.source.externalId,
      state.value,
    );
    evidence.set(id, {
      facts: [{ key: factKey(entityId, property), value: state.value }],
      conflicts: [],
      observedAt: state.observedAt,
    });
    records.push({
      id,
      entityId,
      kind: canonicalKind(property),
      text: stateText(entityId, property, state.value, state.source.provider, state.observedAt),
      current: true,
      importance: 1,
      ...(relatedEntityIds === undefined ? {} : { relatedEntityIds }),
    });
  }
}

function conflictCandidateText(provider: string, value: StateValue): string {
  return `${provider}=${valueText(value)}`;
}

function conflictText(
  property: string,
  candidates: readonly { readonly provider: string; readonly value: StateValue }[],
): string {
  const candidateText = candidates
    .map((candidate) => conflictCandidateText(candidate.provider, candidate.value))
    .join("; ");
  return `Unresolved conflict for ${propertyLabel(property)} (${property}): ${candidateText}. Do not assert a single value.`;
}

function addConflictRecords(
  entityId: EntityId,
  conflicts: ReturnType<typeof planReconciliation>["conflicts"],
  evidence: Map<string, EvidenceMeta>,
  records: ContextRecord[],
): void {
  for (const conflict of conflicts) {
    const id = `conflict:${entityId}:${conflict.property}`;
    evidence.set(id, {
      facts: [],
      conflicts: [factKey(entityId, conflict.property)],
    });
    records.push({
      id,
      entityId,
      kind: "state",
      text: conflictText(conflict.property, conflict.candidates),
      current: true,
      importance: 1,
    });
  }
}

function groupByEntity(all: readonly Observation[]): Map<EntityId, Observation[]> {
  const grouped = new Map<EntityId, Observation[]>();
  for (const item of latestBySourceProperty(all)) {
    const list = grouped.get(item.entityId) ?? [];
    list.push(item);
    grouped.set(item.entityId, list);
  }
  return grouped;
}

function compileState(
  all: readonly Observation[],
  rulesByEntity: ReadonlyMap<EntityId, readonly AuthorityRule[]> | undefined,
): EvidenceCorpus {
  const evidence = new Map<string, EvidenceMeta>();
  const records: ContextRecord[] = [];
  for (const [entityId, entityObservations] of groupByEntity(all)) {
    const authorityRules = rulesByEntity?.get(entityId) ?? [];
    const plan = planReconciliation({
      entityId,
      snapshots: entityObservations.map(observationSnapshot),
      ...(rulesByEntity === undefined ? {} : { authority: authorityRules }),
    });
    addCanonicalStateRecords(
      entityId,
      entityObservations,
      plan.canonical.properties,
      evidence,
      records,
    );
    addConflictRecords(entityId, plan.conflicts, evidence, records);
  }
  return { corpus: { entities: entities(), records }, evidence };
}

function resolvedEntityBm25(
  evidenceCorpus: EvidenceCorpus,
  request: { readonly query: string; readonly budgetTokens: number },
): ContextPackage {
  const index = new ContextIndex(evidenceCorpus.corpus);
  const resolved = index.resolveEntities(request.query);
  return bm25Baseline(evidenceCorpus.corpus, request, resolved);
}

function graphBm25(
  evidenceCorpus: EvidenceCorpus,
  request: { readonly query: string; readonly budgetTokens: number },
): ContextPackage {
  const index = new ContextIndex(evidenceCorpus.corpus);
  const direct = index.resolveEntities(request.query);
  const candidates = new Set(direct);
  for (const record of evidenceCorpus.corpus.records) {
    if (!candidates.has(record.entityId)) continue;
    for (const related of record.relatedEntityIds ?? []) candidates.add(related);
  }
  return bm25Baseline(evidenceCorpus.corpus, request, [...candidates]);
}

function asOfRawBm25(
  raw: EvidenceCorpus,
  task: BenchmarkTask,
): ContextPackage {
  const date = /\b20\d{2}-\d{2}-\d{2}\b/.exec(task.query)?.[0];
  if (date === undefined) return resolvedEntityBm25(raw, task);
  const cutoff = Date.parse(`${date}T23:59:59Z`);
  const records = raw.corpus.records.filter((record) => {
    const observedAt = raw.evidence.get(record.id)?.observedAt;
    return observedAt !== undefined && Date.parse(observedAt) <= cutoff;
  });
  return resolvedEntityBm25(
    { corpus: { entities: raw.corpus.entities, records }, evidence: raw.evidence },
    task,
  );
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function timed(
  fn: () => ContextPackage,
  retrievalCalls: number,
  repeats = 25,
): MethodResult {
  const times: number[] = [];
  let context = fn();
  for (let i = 0; i < repeats; i += 1) {
    const started = performance.now();
    context = fn();
    times.push(performance.now() - started);
  }
  return {
    context,
    retrievalCalls,
    medianLatencyMs: Number(median(times).toFixed(3)),
  };
}

function sameValue(left: StateValue, right: StateValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function evaluate(
  method: string,
  result: MethodResult,
  task: BenchmarkTask,
  evidence: ReadonlyMap<string, EvidenceMeta>,
) {
  const returnedEvidence = result.context.records
    .map((record) => evidence.get(record.id))
    .filter((item): item is EvidenceMeta => item !== undefined);
  const facts = returnedEvidence.flatMap((item) => item.facts);
  const conflicts = new Set(returnedEvidence.flatMap((item) => item.conflicts));
  const expectedFacts = task.expectedFacts ?? [];
  const expectedConflicts = (task.expectConflicts ?? [])
    .map((item) => factKey(item.entityId, item.property));

  const requiredHits = expectedFacts.filter((expected) => facts.some(
    (fact) => fact.key === factKey(expected.entityId, expected.property)
      && sameValue(fact.value, expected.value),
  )).length;
  const contradictions = expectedFacts.flatMap((expected) => facts.filter(
    (fact) => fact.key === factKey(expected.entityId, expected.property)
      && !sameValue(fact.value, expected.value),
  )).length;
  const conflictHits = expectedConflicts.filter((key) => conflicts.has(key)).length;
  const assertedConflictFacts = expectedConflicts.flatMap(
    (key) => facts.filter((fact) => fact.key === key),
  ).length;

  const requiredTotal = expectedFacts.length + expectedConflicts.length;
  const evidenceRecall = requiredTotal === 0
    ? 1
    : (requiredHits + conflictHits) / requiredTotal;
  const success = requiredHits === expectedFacts.length
    && contradictions === 0
    && conflictHits === expectedConflicts.length
    && assertedConflictFacts === 0;

  const relevantIds = new Set(result.context.records.filter((record) => {
    const meta = evidence.get(record.id);
    if (meta === undefined) return false;
    const exactFact = expectedFacts.some((expected) => meta.facts.some(
      (fact) => fact.key === factKey(expected.entityId, expected.property)
        && sameValue(fact.value, expected.value),
    ));
    const conflict = expectedConflicts.some((key) => meta.conflicts.includes(key));
    return exactFact || conflict;
  }).map((record) => record.id));
  const irrelevantRatio = result.context.records.length === 0
    ? 0
    : 1 - relevantIds.size / result.context.records.length;

  return {
    task: task.name,
    method,
    taskSuccess: success ? 1 : 0,
    evidenceRecall: Number(evidenceRecall.toFixed(3)),
    contradictionErrors: contradictions,
    irrelevantRatio: Number(irrelevantRatio.toFixed(3)),
    estimatedTokens: result.context.estimatedTokens,
    returnedRecords: result.context.records.length,
    consideredRecords: result.context.consideredRecords,
    retrievalCalls: result.retrievalCalls,
    medianLatencyMs: result.medianLatencyMs,
    resolvedEntityIds: result.context.resolvedEntityIds,
    returnedIds: result.context.records.map((record) => record.id),
  };
}

const primary = observations();
const all = [...primary, ...noiseObservations()];
const raw = rawEvidence(all);

const stateBuildStarted = performance.now();
const freshestState = compileState(all, undefined);
const authorityState = compileState(all, authority());
const stateBuildMs = Number((performance.now() - stateBuildStarted).toFixed(3));
const authorityIndex = new ContextIndex(authorityState.corpus);

function factTask(
  name: string,
  query: string,
  budgetTokens: number,
  expectedFacts: readonly ExpectedFact[],
  answerNeedles: readonly string[],
  forbiddenNeedles: readonly string[] = [],
): BenchmarkTask {
  return { name, query, budgetTokens, expectedFacts, answerNeedles, forbiddenNeedles };
}

function conflictTask(
  name: string,
  query: string,
  budgetTokens: number,
  property: string,
  answerNeedles: readonly string[],
): BenchmarkTask {
  return {
    name,
    query,
    budgetTokens,
    expectConflicts: [{ entityId: atlas, property }],
    answerNeedles,
  };
}

const tasks: BenchmarkTask[] = [
  factTask(
    "authority-deadline-tr",
    "Atlas projesinin teslim tarihi nedir?",
    85,
    [{ entityId: atlas, property: "Project.deadline", value: "2026-11-20" }],
    ["2026-11-20"],
    ["2026-11-25"],
  ),
  factTask(
    "current-api-decision-en",
    "Which API architecture decision is in force for Project Atlas?",
    85,
    [{ entityId: atlas, property: "Project.apiStyle", value: "GraphQL" }],
    ["GraphQL"],
    ["REST"],
  ),
  factTask(
    "relation-owner-timezone-tr",
    "Atlas projesinin sahibi kim ve sahibi hangi saat diliminde?",
    145,
    [
      { entityId: atlas, property: "Project.ownerEntityId", value: alice },
      { entityId: alice, property: "Person.timezone", value: "Europe/Istanbul" },
    ],
    ["Alice", "Europe/Istanbul"],
  ),
  factTask(
    "alias-collision-person-tr",
    "Atlas kişisinin işvereni nedir?",
    80,
    [{ entityId: atlasPerson, property: "Person.employer", value: "Acme Robotics" }],
    ["Acme Robotics"],
  ),
  conflictTask(
    "unresolved-release-conflict-tr",
    "Atlas projesinin yayın aşaması nedir?",
    90,
    "Project.releaseStage",
    ["beta", "production"],
  ),
  factTask(
    "historical-api-as-of",
    "On 2026-03-01, what API style did Project Atlas use?",
    80,
    [{ entityId: atlas, property: "Project.apiStyle", value: "REST" }],
    ["REST"],
    ["GraphQL"],
  ),
];

const rows = [];
const modelCases: {
  readonly task: string;
  readonly method: string;
  readonly query: string;
  readonly context: string;
  readonly answerNeedles: readonly string[];
  readonly forbiddenNeedles: readonly string[];
}[] = [];
for (const task of tasks) {
  const request = { query: task.query, budgetTokens: task.budgetTokens };
  const methods: readonly [string, MethodResult, ReadonlyMap<string, EvidenceMeta>][] = [
    ["raw-bm25-global", timed(() => bm25Baseline(raw.corpus, request), 1), raw.evidence],
    ["raw-agent-entity-bm25", timed(() => resolvedEntityBm25(raw, request), 2), raw.evidence],
    ["raw-temporal-asof-bm25", timed(() => asOfRawBm25(raw, task), 2), raw.evidence],
    ["freshest-state-bm25", timed(() => resolvedEntityBm25(freshestState, request), 1), freshestState.evidence],
    ["authority-state-bm25", timed(() => resolvedEntityBm25(authorityState, request), 1), authorityState.evidence],
    ["authority-state-graph-bm25", timed(() => graphBm25(authorityState, request), 1), authorityState.evidence],
    ["authority-compiled-v1", timed(() => authorityIndex.compile(request), 1), authorityState.evidence],
  ];
  for (const [name, result, evidence] of methods) {
    rows.push(evaluate(name, result, task, evidence));
    modelCases.push({
      task: task.name,
      method: name,
      query: task.query,
      context: result.context.records.map((record) => record.text).join("\n"),
      answerNeedles: task.answerNeedles ?? [],
      forbiddenNeedles: task.forbiddenNeedles ?? [],
    });
  }
}

const summary = Object.fromEntries(
  [...new Set(rows.map((row) => row.method))].map((method) => {
    const methodRows = rows.filter((row) => row.method === method);
    return [method, {
      taskSuccessRate: Number((methodRows.reduce((sum, row) => sum + row.taskSuccess, 0) / methodRows.length).toFixed(3)),
      meanEvidenceRecall: Number((methodRows.reduce((sum, row) => sum + row.evidenceRecall, 0) / methodRows.length).toFixed(3)),
      totalContradictionErrors: methodRows.reduce((sum, row) => sum + row.contradictionErrors, 0),
      meanIrrelevantRatio: Number((methodRows.reduce((sum, row) => sum + row.irrelevantRatio, 0) / methodRows.length).toFixed(3)),
      meanTokens: Number((methodRows.reduce((sum, row) => sum + row.estimatedTokens, 0) / methodRows.length).toFixed(1)),
      meanRetrievalCalls: Number((methodRows.reduce((sum, row) => sum + row.retrievalCalls, 0) / methodRows.length).toFixed(2)),
    }];
  }),
);

console.log(JSON.stringify({
  benchmark: "context-v1-state-resolution",
  corpus: {
    entities: raw.corpus.entities.length,
    rawObservations: raw.corpus.records.length,
    freshestStateRecords: freshestState.corpus.records.length,
    authorityStateRecords: authorityState.corpus.records.length,
  },
  stateBuildMs,
  warning: "This benchmark measures deterministic evidence-level task success. Set SSRL_BENCH_MODEL_CASES=1 to emit downstream model cases.",
  summary,
  rows,
  ...(process.env.SSRL_BENCH_MODEL_CASES === "1" ? { modelCases } : {}),
}, null, 2));
