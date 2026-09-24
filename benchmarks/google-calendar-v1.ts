import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IngestionEngine } from "../packages/ingestion/dist/index.js";
import {
  ContextCapsuleMaterializer,
  IncrementalContextCapsuleWorker,
  InMemoryContextCapsuleStore,
} from "../packages/materializer/dist/index.js";
import {
  SQLiteIngestionStateStore,
  SQLiteSemanticStateStore,
} from "../packages/storage-sqlite/dist/index.js";
import {
  createGoogleCalendarAdapter,
  type GoogleCalendarListRequest,
  type GoogleCalendarTransport,
  type GoogleCalendarTransportResponse,
} from "../packages/connector-google-calendar/dist/index.js";
import type { SemanticAppendCounts } from "../packages/state-store/dist/index.js";

class ScriptedTransport implements GoogleCalendarTransport {
  readonly requests: GoogleCalendarListRequest[] = [];
  readonly #responses: GoogleCalendarTransportResponse[];

  constructor(responses: readonly GoogleCalendarTransportResponse[]) {
    this.#responses = [...responses];
  }

  async listEvents(request: GoogleCalendarListRequest): Promise<GoogleCalendarTransportResponse> {
    this.requests.push(request);
    const response = this.#responses.shift();
    if (response === undefined) throw new Error("fixture transport exhausted");
    return response;
  }
}

function event(id: string, revision: number, summary: string) {
  const day = String(23 + revision).padStart(2, "0");
  return {
    id,
    status: "confirmed",
    etag: `\"${id}-r${revision}\"`,
    updated: `2026-09-${day}T08:00:00Z`,
    summary,
    start: { dateTime: `2026-10-0${revision}T10:00:00+03:00`, timeZone: "Europe/Istanbul" },
    end: { dateTime: `2026-10-0${revision}T11:00:00+03:00`, timeZone: "Europe/Istanbul" },
  };
}

function adapter(transport: GoogleCalendarTransport) {
  return createGoogleCalendarAdapter({
    accountScope: "benchmark-account",
    calendarId: "primary",
    transport,
    maxResults: 2,
  });
}

function countTotal(counts: SemanticAppendCounts): number {
  return counts.entities
    + counts.aliases
    + counts.observations
    + counts.relations
    + counts.retractions;
}

const root = mkdtempSync(join(tmpdir(), "ssrl-gcal-bench-"));
const semantic = new SQLiteSemanticStateStore({ path: join(root, "semantic.sqlite") });
const ingestion = new SQLiteIngestionStateStore({ path: join(root, "ingestion.sqlite") });
const cache = new InMemoryContextCapsuleStore();
let now = "2026-09-24T12:00:00Z";
const engine = new IngestionEngine({
  semanticState: semantic,
  ingestionState: ingestion,
  now: () => now,
});
const worker = new IncrementalContextCapsuleWorker({
  stateStore: semantic,
  capsuleStore: cache,
  materializer: new ContextCapsuleMaterializer({ stateStore: semantic }),
});

try {
  const initial = adapter(new ScriptedTransport([
    {
      status: 200,
      body: {
        items: [
          event("evt-1", 1, "Architecture review"),
          event("evt-3", 1, "Release planning"),
        ],
        nextPageToken: "initial-page-2",
      },
    },
    {
      status: 200,
      body: {
        items: [event("evt-2", 1, "Customer call")],
        nextSyncToken: "sync-1",
      },
    },
  ]));
  const initialSync = await engine.sync({
    sourceKey: initial.sourceKey,
    source: initial.source,
    mapper: initial.mapper,
  });
  const initialCapsules = await worker.runOnce({ at: "2026-09-24T12:01:00Z" });

  now = "2026-09-25T12:00:00Z";
  const incremental = adapter(new ScriptedTransport([
    {
      status: 200,
      body: {
        items: [
          event("evt-1", 2, "Architecture review v2"),
          { id: "evt-2", status: "cancelled" },
        ],
        nextSyncToken: "sync-2",
      },
    },
  ]));
  const incrementalSync = await engine.sync({
    sourceKey: incremental.sourceKey,
    source: incremental.source,
    mapper: incremental.mapper,
  });
  const incrementalCapsules = await worker.runOnce({ at: "2026-09-25T12:01:00Z" });

  now = "2026-09-26T12:00:00Z";
  const reset = adapter(new ScriptedTransport([
    { status: 410, body: { error: { code: 410, reason: "fullSyncRequired" } } },
    {
      status: 200,
      body: {
        items: [event("evt-1", 2, "Architecture review v2")],
        nextSyncToken: "sync-3",
      },
    },
  ]));
  const resetSync = await engine.sync({
    sourceKey: reset.sourceKey,
    source: reset.source,
    mapper: reset.mapper,
  });
  const resetCapsules = await worker.runOnce({ at: "2026-09-26T12:01:00Z" });

  assert.equal(initialSync.pagesRead, 2);
  assert.equal(initialSync.changesProcessed, 3);
  assert.equal(initialCapsules.materializedEntityIds.length, 3);
  assert.equal(incrementalSync.pagesRead, 1);
  assert.equal(incrementalSync.changesProcessed, 2);
  assert.equal(incrementalCapsules.materializedEntityIds.length, 2);
  assert.equal(resetSync.resetPerformed, true);
  assert.equal(resetSync.mode, "full");
  assert.equal(resetSync.sweptResources, 1);
  assert.equal(resetCapsules.materializedEntityIds.length, 1);

  const rounds = [
    {
      name: "initial-multipage",
      pages: initialSync.pagesRead,
      changes: initialSync.changesProcessed,
      sweptResources: initialSync.sweptResources,
      semanticAppends: initialSync.semanticAppends,
      semanticWrites: countTotal(initialSync.semanticAppends),
      capsuleRefreshes: initialCapsules.materializedEntityIds.length,
    },
    {
      name: "incremental-update-delete",
      pages: incrementalSync.pagesRead,
      changes: incrementalSync.changesProcessed,
      sweptResources: incrementalSync.sweptResources,
      semanticAppends: incrementalSync.semanticAppends,
      semanticWrites: countTotal(incrementalSync.semanticAppends),
      capsuleRefreshes: incrementalCapsules.materializedEntityIds.length,
    },
    {
      name: "410-full-resync-sweep",
      pages: resetSync.pagesRead,
      changes: resetSync.changesProcessed,
      sweptResources: resetSync.sweptResources,
      semanticAppends: resetSync.semanticAppends,
      semanticWrites: countTotal(resetSync.semanticAppends),
      capsuleRefreshes: resetCapsules.materializedEntityIds.length,
    },
  ];

  console.log(JSON.stringify({
    benchmark: "google-calendar-adapter-v1-fixture",
    note: "Deterministic fixture accounting only. No live Google credentials and no latency/throughput claim.",
    rounds,
    totals: {
      pages: rounds.reduce((sum, round) => sum + round.pages, 0),
      changes: rounds.reduce((sum, round) => sum + round.changes, 0),
      sweptResources: rounds.reduce((sum, round) => sum + round.sweptResources, 0),
      semanticWrites: rounds.reduce((sum, round) => sum + round.semanticWrites, 0),
      capsuleRefreshes: rounds.reduce((sum, round) => sum + round.capsuleRefreshes, 0),
    },
  }, null, 2));
} finally {
  semantic.close();
  ingestion.close();
  rmSync(root, { recursive: true, force: true });
}
