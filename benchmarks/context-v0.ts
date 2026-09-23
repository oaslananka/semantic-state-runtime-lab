import {
  ContextIndex,
  lexicalBaseline,
  rawContext,
  type ContextCorpus,
  type ContextPackage,
  type ContextRecord,
} from "../packages/context/src/index.ts";

interface BenchmarkTask {
  readonly name: string;
  readonly query: string;
  readonly budgetTokens: number;
  readonly requiredEvidence: readonly string[];
  readonly relevantEvidence: readonly string[];
}

function buildCorpus(): ContextCorpus {
  const entities = [{ id: "project:atlas", aliases: ["Project Atlas", "Atlas"] }];
  const records: ContextRecord[] = [
    {
      id: "atlas-state-auth",
      entityId: "project:atlas",
      kind: "state",
      text: "Authentication uses OAuth2 with PKCE. Sessions remain server-side.",
      current: true,
      importance: 1,
    },
    {
      id: "atlas-decision-jwt-current",
      entityId: "project:atlas",
      kind: "decision",
      text: "ADR-42: JWT migration is deferred until revocation semantics are resolved.",
      current: true,
      importance: 1,
    },
    {
      id: "atlas-decision-jwt-old",
      entityId: "project:atlas",
      kind: "decision",
      text: "Historical proposal: migrate every authentication session to JWT immediately.",
      current: false,
      importance: 0.2,
    },
    {
      id: "atlas-issue-callback",
      entityId: "project:atlas",
      kind: "commitment",
      text: "Open blocker: auth callback races with token refresh during account relink.",
      current: true,
      importance: 0.9,
    },
    {
      id: "atlas-owner",
      entityId: "project:atlas",
      kind: "relationship",
      text: "Alice owns the authentication migration workstream.",
      current: true,
      importance: 0.6,
    },
  ];

  for (let project = 0; project < 100; project += 1) {
    const entityId = `project:p${project.toString().padStart(3, "0")}`;
    entities.push({
      id: entityId,
      aliases: [`Project P${project.toString().padStart(3, "0")}`],
    });
    for (let item = 0; item < 50; item += 1) {
      const authNoise = item % 3 === 0
        ? "authentication JWT session callback OAuth refresh decision"
        : "project planning delivery customer metrics deployment";
      records.push({
        id: `${entityId}:record:${item}`,
        entityId,
        kind: item % 7 === 0 ? "decision" : "event",
        text: `${authNoise} synthetic record ${item} for unrelated project ${project}.`,
        current: item % 5 !== 0,
        importance: (item % 10) / 10,
      });
    }
  }

  return { entities, records };
}

function evaluate(
  method: string,
  context: ContextPackage,
  task: BenchmarkTask,
) {
  const returned = new Set(context.records.map((record) => record.id));
  const requiredHits = task.requiredEvidence.filter((id) => returned.has(id)).length;
  const relevantHits = task.relevantEvidence.filter((id) => returned.has(id)).length;
  const recall = task.requiredEvidence.length === 0
    ? 1
    : requiredHits / task.requiredEvidence.length;
  const irrelevant = context.records.length === 0
    ? 0
    : 1 - relevantHits / context.records.length;

  return {
    task: task.name,
    method,
    evidenceRecall: Number(recall.toFixed(3)),
    irrelevantRatio: Number(irrelevant.toFixed(3)),
    estimatedTokens: context.estimatedTokens,
    returnedRecords: context.records.length,
    consideredRecords: context.consideredRecords,
  };
}

const corpus = buildCorpus();
const index = new ContextIndex(corpus);
const tasks: BenchmarkTask[] = [
  {
    name: "current-session-decision",
    query: "For Project Atlas, what is the current authentication session and JWT decision?",
    budgetTokens: 220,
    requiredEvidence: ["atlas-state-auth", "atlas-decision-jwt-current"],
    relevantEvidence: [
      "atlas-state-auth",
      "atlas-decision-jwt-current",
      "atlas-issue-callback",
      "atlas-owner",
    ],
  },
  {
    name: "auth-blocker",
    query: "What auth callback blocker is currently important for Atlas?",
    budgetTokens: 160,
    requiredEvidence: ["atlas-issue-callback"],
    relevantEvidence: ["atlas-issue-callback", "atlas-state-auth", "atlas-owner"],
  },
];

const rows = [];
for (const task of tasks) {
  const request = { query: task.query, budgetTokens: task.budgetTokens };
  rows.push(evaluate("raw", rawContext(corpus), task));
  rows.push(evaluate("lexical", lexicalBaseline(corpus, request), task));
  rows.push(evaluate("compiled-v0", index.compile(request), task));
}

console.log(JSON.stringify({
  corpus: {
    entities: corpus.entities.length,
    records: corpus.records.length,
  },
  warning: "estimatedTokens uses a model-neutral character heuristic; this is retrieval-only, not LLM task success.",
  rows,
}, null, 2));
