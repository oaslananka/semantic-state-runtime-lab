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

function observations(): Observation[] {
  return [
    {
      id: "atlas-deadline-pm",
      entityId: atlas,
      provider: "pm",
      externalId: "atlas",
      property: "Project.deadline",
      externalPath: "deadline",
      value: "2026-11-20",
      observedAt: "2026-09-10T09:00:00Z",
      text: "Project Atlas delivery deadline is 2026-11-20 in the authoritative project system. Atlas projesi teslim tarihi 2026-11-20.",
      kind: "state",
    },
    {
      id: "atlas-deadline-chat-proposal",
      entityId: atlas,
      provider: "chat",
      externalId: "thread-77",
      property: "Project.deadline",
      externalPath: "deadline",
      value: "2026-11-25",
      observedAt: "2026-09-15T13:00:00Z",
      text: "A chat proposal suggests moving Project Atlas delivery to 2026-11-25, pending project-system approval.",
      kind: "event",
    },
    {
      id: "atlas-api-rest-old",
      entityId: atlas,
      provider: "adr",
      externalId: "adr-api",
      property: "Project.apiStyle",
      externalPath: "apiStyle",
      value: "REST",
      observedAt: "2026-02-10T10:00:00Z",
      text: "ADR: Project Atlas API style is REST. This decision was recorded on 2026-02-10.",
      kind: "decision",
    },
    {
      id: "atlas-api-graphql-new",
      entityId: atlas,
      provider: "adr",
      externalId: "adr-api",
      property: "Project.apiStyle",
      externalPath: "apiStyle",
      value: "GraphQL",
      observedAt: "2026-08-20T10:00:00Z",
      text: "ADR supersedes the previous API decision: Project Atlas API style is GraphQL as of 2026-08-20.",
      kind: "decision",
    },
    {
      id: "atlas-owner-directory",
      entityId: atlas,
      provider: "directory",
      externalId: "atlas",
      property: "Project.ownerEntityId",
      externalPath: "owner",
      value: alice,
      observedAt: "2026-09-01T08:00:00Z",
      text: "Project Atlas owner is Alice. Atlas projesinin sahibi Alice.",
      kind: "relationship",
      relatedEntityIds: [alice],
    },
    {
      id: "alice-timezone-profile",
      entityId: alice,
      provider: "profile",
      externalId: "alice",
      property: "Person.timezone",
      externalPath: "timezone",
      value: "Europe/Istanbul",
      observedAt: "2026-09-05T08:00:00Z",
      text: "Alice works in timezone Europe/Istanbul. Alice saat dilimi Europe/Istanbul.",
      kind: "state",
    },
    {
      id: "atlas-person-employer",
      entityId: atlasPerson,
      provider: "profile",
      externalId: "atlas-person",
      property: "Person.employer",
      externalPath: "employer",
      value: "Acme Robotics",
      observedAt: "2026-09-12T08:00:00Z",
      text: "The person Atlas works at Acme Robotics. Atlas kişisinin işvereni Acme Robotics.",
      kind: "state",
    },
    {
      id: "atlas-stage-ops",
      entityId: atlas,
      provider: "ops",
      externalId: "atlas-release",
      property: "Project.releaseStage",
      externalPath: "stage",
      value: "beta",
      observedAt: "2026-09-20T10:00:00Z",
      text: "Operations reports Project Atlas release stage as beta.",
      kind: "state",
    },
    {
      id: "atlas-stage-pm",
      entityId: atlas,
      provider: "pm",
      externalId: "atlas-release",
      property: "Project.releaseStage",
      externalPath: "stage",
      value: "production",
      observedAt: "2026-09-20T10:00:00Z",
      text: "Project system reports Project Atlas release stage as production at the same observation time.",
      kind: "state",
    },
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

function noiseObservations(): Observation[] {
  const result: Observation[] = [];
  for (let project = 0; project < 80; project += 1) {
    const n = project.toString().padStart(3, "0");
    const entityId = `entity://project/noise-${n}` as EntityId;
    for (let item = 0; item < 25; item += 1) {
      const property = item % 2 === 0 ? "Project.deadline" : "Project.apiStyle";
      result.push({
        id: `noise-${n}-${item}`,
        entityId,
        provider: item % 3 === 0 ? "chat" : "pm",
        externalId: `noise-${n}-${item}`,
        property,
        externalPath: property.endsWith("deadline") ? "deadline" : "apiStyle",
        value: property.endsWith("deadline") ? `2027-0${(item % 9) + 1}-15` : (item % 3 === 0 ? "GraphQL" : "REST"),
        observedAt: `2026-08-${((item % 27) + 1).toString().padStart(2, "0")}T12:00:00Z`,
        text: `Unrelated project ${n} planning record ${item}: deadline API REST GraphQL owner release stage authentication delivery.`,
        kind: item % 2 === 0 ? "state" : "event",
      });
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

function compileState(
  all: readonly Observation[],
  rulesByEntity: ReadonlyMap<EntityId, readonly AuthorityRule[]> | undefined,
): EvidenceCorpus {
  const latest = latestBySourceProperty(all);
  const byEntity = new Map<EntityId, Observation[]>();
  for (const observation of latest) {
    const list = byEntity.get(observation.entityId) ?? [];
    list.push(observation);
    byEntity.set(observation.entityId, list);
  }

  const evidence = new Map<string, EvidenceMeta>();
  const records: ContextRecord[] = [];
  for (const [entityId, entityObservations] of byEntity) {
    const plan = planReconciliation({
      entityId,
      snapshots: entityObservations.map(observationSnapshot),
      ...(rulesByEntity === undefined ? {} : { authority: rulesByEntity.get(entityId) ?? [] }),
    });

    for (const [property, state] of Object.entries(plan.canonical.properties)) {
      const id = `state:${entityId}:${property}`;
      const sourceObservation = entityObservations.find(
        (candidate) => candidate.provider === state.source.provider
          && candidate.externalId === state.source.externalId
          && candidate.property === property
          && candidate.value === state.value,
      );
      const related = sourceObservation?.relatedEntityIds;
      evidence.set(id, {
        facts: [{ key: factKey(entityId, property), value: state.value }],
        conflicts: [],
        observedAt: state.observedAt,
      });
      records.push({
        id,
        entityId,
        kind: property.includes("owner") ? "relationship" : property.includes("apiStyle") ? "decision" : "state",
        text: stateText(entityId, property, state.value, state.source.provider, state.observedAt),
        current: true,
        importance: 1,
        ...(related === undefined ? {} : { relatedEntityIds: related }),
      });
    }

    for (const conflict of plan.conflicts) {
      const id = `conflict:${entityId}:${conflict.property}`;
      evidence.set(id, {
        facts: [],
        conflicts: [factKey(entityId, conflict.property)],
      });
      records.push({
        id,
        entityId,
        kind: "state",
        text: `Unresolved conflict for ${propertyLabel(conflict.property)} (${conflict.property}): ${conflict.candidates.map((candidate) => `${candidate.provider}=${valueText(candidate.value)}`).join("; ")}. Do not assert a single value.`,
        current: true,
        importance: 1,
      });
    }
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
  const date = task.query.match(/\b20\d{2}-\d{2}-\d{2}\b/)?.[0];
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

const tasks: BenchmarkTask[] = [
  {
    name: "authority-deadline-tr",
    query: "Atlas projesinin teslim tarihi nedir?",
    budgetTokens: 85,
    expectedFacts: [{ entityId: atlas, property: "Project.deadline", value: "2026-11-20" }],
    answerNeedles: ["2026-11-20"],
    forbiddenNeedles: ["2026-11-25"],
  },
  {
    name: "current-api-decision-en",
    query: "Which API architecture decision is in force for Project Atlas?",
    budgetTokens: 85,
    expectedFacts: [{ entityId: atlas, property: "Project.apiStyle", value: "GraphQL" }],
    answerNeedles: ["GraphQL"],
    forbiddenNeedles: ["REST"],
  },
  {
    name: "relation-owner-timezone-tr",
    query: "Atlas projesinin sahibi kim ve sahibi hangi saat diliminde?",
    budgetTokens: 145,
    expectedFacts: [
      { entityId: atlas, property: "Project.ownerEntityId", value: alice },
      { entityId: alice, property: "Person.timezone", value: "Europe/Istanbul" },
    ],
    answerNeedles: ["Alice", "Europe/Istanbul"],
  },
  {
    name: "alias-collision-person-tr",
    query: "Atlas kişisinin işvereni nedir?",
    budgetTokens: 80,
    expectedFacts: [{ entityId: atlasPerson, property: "Person.employer", value: "Acme Robotics" }],
    answerNeedles: ["Acme Robotics"],
  },
  {
    name: "unresolved-release-conflict-tr",
    query: "Atlas projesinin yayın aşaması nedir?",
    budgetTokens: 90,
    expectConflicts: [{ entityId: atlas, property: "Project.releaseStage" }],
    answerNeedles: ["beta", "production"],
  },
  {
    name: "historical-api-as-of",
    query: "On 2026-03-01, what API style did Project Atlas use?",
    budgetTokens: 80,
    expectedFacts: [{ entityId: atlas, property: "Project.apiStyle", value: "REST" }],
    answerNeedles: ["REST"],
    forbiddenNeedles: ["GraphQL"],
  },
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
