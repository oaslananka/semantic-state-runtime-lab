import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IngestionEngine,
  resolveSourceChange,
  type SourceReadRequest,
} from "@ssrl/ingestion";
import {
  ContextCapsuleMaterializer,
  IncrementalContextCapsuleWorker,
  InMemoryContextCapsuleStore,
} from "@ssrl/materializer";
import {
  SQLiteIngestionStateStore,
  SQLiteSemanticStateStore,
} from "@ssrl/storage-sqlite";
import {
  FetchGoogleCalendarTransport,
  createGoogleCalendarAdapter,
  type GoogleCalendarListRequest,
  type GoogleCalendarProjectionOptions,
  type GoogleCalendarTransport,
  type GoogleCalendarTransportResponse,
} from "../src/index.js";

const roots: string[] = [];

async function dbPath(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ssrl-gcal-"));
  roots.push(root);
  return join(root, name);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class ScriptedTransport implements GoogleCalendarTransport {
  readonly requests: GoogleCalendarListRequest[] = [];
  readonly #responses: GoogleCalendarTransportResponse[];

  constructor(responses: readonly GoogleCalendarTransportResponse[]) {
    this.#responses = [...responses];
  }

  async listEvents(request: GoogleCalendarListRequest): Promise<GoogleCalendarTransportResponse> {
    this.requests.push(request);
    const response = this.#responses.shift();
    if (response === undefined) throw new Error("unexpected Google Calendar request");
    return response;
  }
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    status: "confirmed",
    etag: '"etag-1"',
    updated: "2026-09-24T08:00:00Z",
    summary: "Architecture review",
    start: { dateTime: "2026-09-25T10:00:00+03:00", timeZone: "Europe/Istanbul" },
    end: { dateTime: "2026-09-25T11:00:00+03:00", timeZone: "Europe/Istanbul" },
    ...overrides,
  };
}

function adapter(
  transport: GoogleCalendarTransport,
  projection: GoogleCalendarProjectionOptions = {},
) {
  return createGoogleCalendarAdapter({
    accountScope: "account-A",
    calendarId: "primary",
    transport,
    maxResults: 50,
    projection,
  });
}

function observationValue(
  desired: Awaited<ReturnType<ReturnType<typeof adapter>["mapper"]["project"]>>,
  key: string,
) {
  const slot = desired.slots.find((item) => item.key === key);
  if (slot?.kind !== "observation") return undefined;
  return slot.record.value;
}

async function completedCheckpoint(value: ReturnType<typeof adapter>) {
  const result = await value.source.read({ mode: "incremental" });
  if (result.kind !== "page" || result.next.kind !== "complete") {
    throw new Error("expected completed Google Calendar page");
  }
  return result.next.checkpoint;
}


async function checkpointFor(syncToken = "sync-A") {
  return completedCheckpoint(adapter(new ScriptedTransport([
    { status: 200, body: { items: [], nextSyncToken: syncToken } },
  ])));
}

async function projectedEvent(
  overrides: Record<string, unknown> = {},
  projection: GoogleCalendarProjectionOptions = {},
) {
  const value = adapter(new ScriptedTransport([
    { status: 200, body: { items: [event(overrides)], nextSyncToken: "sync-1" } },
  ]), projection);
  const result = await value.source.read({ mode: "incremental" });
  if (result.kind !== "page" || result.changes[0] === undefined) throw new Error("expected event page");
  return value.mapper.project(resolveSourceChange(result.changes[0], "2026-09-24T09:00:00Z"));
}

describe("Google Calendar incremental adapter", () => {
  it("builds a minimal authenticated events.list request without forbidden sync filters", async () => {
    let requestedUrl = "";
    let requestedAuth = "";
    const transport = new FetchGoogleCalendarTransport({
      accessToken: async () => "token-123",
      fetch: async (input, init) => {
        requestedUrl = String(input);
        requestedAuth = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(JSON.stringify({ items: [], nextSyncToken: "sync-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const response = await transport.listEvents({
      calendarId: "team@example.com",
      singleEvents: false,
      showDeleted: true,
      maxResults: 25,
      syncToken: "sync-old",
    });

    expect(response.status).toBe(200);
    expect(requestedAuth).toBe("Bearer token-123");
    const url = new URL(requestedUrl);
    expect(url.pathname).toContain("team%40example.com");
    expect(url.searchParams.get("singleEvents")).toBe("false");
    expect(url.searchParams.get("showDeleted")).toBe("true");
    expect(url.searchParams.get("maxResults")).toBe("25");
    expect(url.searchParams.get("syncToken")).toBe("sync-old");
    expect(url.searchParams.has("timeMin")).toBe(false);
    expect(url.searchParams.has("timeMax")).toBe(false);
    expect(url.searchParams.has("updatedMin")).toBe(false);
  });

  it("maps pageToken/nextSyncToken to SSRL continuation/checkpoint and reuses syncToken", async () => {
    const transport = new ScriptedTransport([
      { status: 200, body: { items: [event()], nextPageToken: "page-2" } },
      { status: 200, body: { items: [event({ id: "evt-2", etag: '"etag-2"' })], nextSyncToken: "sync-1" } },
    ]);
    const value = adapter(transport);
    const first = await value.source.read({ mode: "incremental" });
    if (first.kind !== "page" || first.next.kind !== "continue") throw new Error("expected continuation");
    expect(transport.requests[0]).toEqual({
      calendarId: "primary",
      singleEvents: false,
      showDeleted: true,
      maxResults: 50,
    });

    const second = await value.source.read({ mode: "incremental", continuation: first.next.cursor });
    if (second.kind !== "page" || second.next.kind !== "complete") throw new Error("expected checkpoint");
    expect(transport.requests[1]?.pageToken).toBe("page-2");

    const followupTransport = new ScriptedTransport([
      { status: 200, body: { items: [], nextSyncToken: "sync-2" } },
    ]);
    await adapter(followupTransport).source.read({
      mode: "incremental",
      checkpoint: second.next.checkpoint,
    });
    expect(followupTransport.requests[0]?.syncToken).toBe("sync-1");
  });

  it("binds an incremental continuation to the original sync token and reuses it on later pages", async () => {
    const checkpoint = await checkpointFor("sync-round-A");
    const transport = new ScriptedTransport([
      { status: 200, body: { items: [event()], nextPageToken: "page-2" } },
      { status: 200, body: { items: [], nextSyncToken: "sync-round-B" } },
    ]);
    const value = adapter(transport);
    const first = await value.source.read({ mode: "incremental", checkpoint });
    if (first.kind !== "page" || first.next.kind !== "continue") throw new Error("expected continuation");
    expect(transport.requests[0]?.syncToken).toBe("sync-round-A");

    const second = await value.source.read({ mode: "incremental", continuation: first.next.cursor });
    if (second.kind !== "page" || second.next.kind !== "complete") throw new Error("expected completion");
    expect(transport.requests[1]?.pageToken).toBe("page-2");
    expect(transport.requests[1]?.syncToken).toBe("sync-round-A");
  });

  it("fails closed when a continuation is replayed with a different sync round", async () => {
    const checkpointA = await checkpointFor("sync-A");
    const paged = adapter(new ScriptedTransport([
      { status: 200, body: { items: [], nextPageToken: "page-A2" } },
    ]));
    const first = await paged.source.read({ mode: "incremental", checkpoint: checkpointA });
    if (first.kind !== "page" || first.next.kind !== "continue") throw new Error("expected continuation");

    const checkpointB = await checkpointFor("sync-B");
    expect(await paged.source.read({
      mode: "incremental",
      checkpoint: checkpointB,
      continuation: first.next.cursor,
    })).toEqual({ kind: "reset-required", reason: "google-calendar-config-changed" });
  });

  it("forces reset when a durable checkpoint belongs to different projection/privacy config", async () => {
    const original = adapter(new ScriptedTransport([
      { status: 200, body: { items: [], nextSyncToken: "sync-old" } },
    ]));
    const checkpoint = await completedCheckpoint(original);
    const changed = adapter(new ScriptedTransport([]), { includeAttendees: true });

    expect(await changed.source.read({ mode: "incremental", checkpoint }))
      .toEqual({ kind: "reset-required", reason: "google-calendar-config-changed" });
  });

  it("maps HTTP 410 to reset-required", async () => {
    const initial = adapter(new ScriptedTransport([
      { status: 200, body: { items: [], nextSyncToken: "sync-old" } },
    ]));
    const checkpoint = await completedCheckpoint(initial);
    const transport = new ScriptedTransport([{ status: 410, body: { error: { code: 410 } } }]);
    expect(await adapter(transport).source.read({ mode: "incremental", checkpoint }))
      .toEqual({ kind: "reset-required", reason: "google-calendar-sync-token-invalid" });
  });

  it("keeps sparse delete drafts timestamp-free and stable inside one sync round", async () => {
    const checkpoint = await checkpointFor();
    const transport = new ScriptedTransport([
      { status: 200, body: { items: [{ id: "evt-1", status: "cancelled" }], nextSyncToken: "sync-B" } },
      { status: 200, body: { items: [{ id: "evt-1", status: "cancelled" }], nextSyncToken: "sync-B" } },
    ]);
    const value = adapter(transport);
    const request: SourceReadRequest = { mode: "incremental", checkpoint };
    const first = await value.source.read(request);
    const replay = await value.source.read(request);
    if (first.kind !== "page" || replay.kind !== "page") throw new Error("expected page");
    expect(first.changes[0]?.changeId).toBe(replay.changes[0]?.changeId);
    expect(first.changes[0]?.effectiveAt).toBeUndefined();
    expect(first.changes[0]?.recordedAt).toBeUndefined();
  });

  it("preserves provider updated time on cancelled events when Google supplies it", async () => {
    const checkpoint = await checkpointFor();
    const value = adapter(new ScriptedTransport([
      {
        status: 200,
        body: {
          items: [{
            id: "evt-1",
            status: "cancelled",
            etag: '"delete-etag"',
            updated: "2026-09-24T10:11:12Z",
          }],
          nextSyncToken: "sync-B",
        },
      },
    ]));
    const result = await value.source.read({ mode: "incremental", checkpoint });
    if (result.kind !== "page") throw new Error("expected page");
    expect(result.changes[0]).toEqual(expect.objectContaining({
      kind: "delete",
      effectiveAt: "2026-09-24T10:11:12Z",
      recordedAt: "2026-09-24T10:11:12Z",
      revision: '"delete-etag"',
    }));
  });

  it("deletes a sparse cancelled recurring exception by its own external resource id", async () => {
    const checkpoint = await checkpointFor();
    const value = adapter(new ScriptedTransport([
      {
        status: 200,
        body: {
          items: [{
            id: "instance-42",
            status: "cancelled",
            recurringEventId: "master-1",
            originalStartTime: { dateTime: "2026-10-01T10:00:00+03:00", timeZone: "Europe/Istanbul" },
          }],
          nextSyncToken: "sync-B",
        },
      },
    ]));
    const result = await value.source.read({ mode: "incremental", checkpoint });
    if (result.kind !== "page") throw new Error("expected page");
    expect(result.changes[0]).toEqual(expect.objectContaining({
      kind: "delete",
      externalId: "instance-42",
      payload: expect.objectContaining({
        id: "instance-42",
        recurringEventId: "master-1",
      }),
    }));
  });

  it("makes delete identities distinct across completed sync rounds", async () => {
    const cpA = await checkpointFor();
    const roundA = adapter(new ScriptedTransport([
      { status: 200, body: { items: [{ id: "evt-1", status: "cancelled" }], nextSyncToken: "sync-B" } },
    ]));
    const a = await roundA.source.read({ mode: "incremental", checkpoint: cpA });
    if (a.kind !== "page" || a.next.kind !== "complete") throw new Error("expected page");
    const roundB = adapter(new ScriptedTransport([
      { status: 200, body: { items: [{ id: "evt-1", status: "cancelled" }], nextSyncToken: "sync-C" } },
    ]));
    const b = await roundB.source.read({ mode: "incremental", checkpoint: a.next.checkpoint });
    if (b.kind !== "page") throw new Error("expected page");
    expect(a.changes[0]?.changeId).not.toBe(b.changes[0]?.changeId);
  });

  it("maps event state while omitting sensitive optional fields by default", async () => {
    const transport = new ScriptedTransport([
      { status: 200, body: { items: [event({
        description: "private notes",
        location: "Home",
        organizer: { email: "Owner@Example.com", displayName: "Owner" },
        attendees: [{ email: "B@Example.com" }, { email: "a@example.com" }],
        recurrence: ["RRULE:FREQ=WEEKLY"],
        iCalUID: "uid@example.com",
        sequence: 3,
      })], nextSyncToken: "sync-1" } },
    ]);
    const value = adapter(transport);
    const result = await value.source.read({ mode: "incremental" });
    if (result.kind !== "page") throw new Error("expected page");
    const draft = result.changes[0]!;
    expect(draft.payload).not.toHaveProperty("description");
    expect(draft.payload).not.toHaveProperty("location");
    expect(draft.payload).not.toHaveProperty("organizer");
    expect(draft.payload).not.toHaveProperty("attendees");
    const desired = await value.mapper.project(resolveSourceChange(draft, "2026-09-24T09:00:00Z"));
    expect(desired.additiveAliases).toEqual([expect.objectContaining({
      value: "Architecture review",
    })]);
    const keys = desired.slots.map((slot) => slot.key);
    expect(keys).toContain("recurrence");
    expect(keys).not.toContain("description");
    expect(keys).not.toContain("location");
    expect(keys).not.toContain("organizer");
    expect(keys).not.toContain("attendees");
  });

  it("preserves timed RFC3339 values and provider time zones", async () => {
    const desired = await projectedEvent();
    expect(observationValue(desired, "start")).toEqual({
      dateTime: "2026-09-25T10:00:00+03:00",
      timeZone: "Europe/Istanbul",
    });
    expect(observationValue(desired, "end")).toEqual({
      dateTime: "2026-09-25T11:00:00+03:00",
      timeZone: "Europe/Istanbul",
    });
    expect(observationValue(desired, "timeZones")).toEqual({
      start: "Europe/Istanbul",
      end: "Europe/Istanbul",
    });
  });

  it("preserves all-day dates without fabricating timezone", async () => {
    const desired = await projectedEvent({
      id: "all-day",
      etag: '"all-day"',
      start: { date: "2026-09-25" },
      end: { date: "2026-09-26" },
    });
    expect(observationValue(desired, "start"))
      .toEqual({ date: "2026-09-25" });
    expect(desired.slots.find((slot) => slot.key === "timeZones")).toBeUndefined();
    expect(observationValue(desired, "allDay")).toBe(true);
  });

  it("rejects impossible all-day dates instead of normalizing them to another day", async () => {
    const value = adapter(new ScriptedTransport([
      {
        status: 200,
        body: {
          items: [event({
            id: "invalid-all-day",
            start: { date: "2026-02-31" },
            end: { date: "2026-03-01" },
          })],
          nextSyncToken: "sync-1",
        },
      },
    ]));
    await expect(value.source.read({ mode: "incremental" }))
      .rejects.toThrow(/event.start.date is invalid/);
  });

  it("canonicalizes attendee email casing/order when explicitly enabled", async () => {
    const desired = await projectedEvent({ attendees: [
      { email: "ZED@Example.com", responseStatus: "accepted" },
      { email: "alice@example.com", responseStatus: "tentative" },
    ] }, { includeAttendees: true });
    expect(observationValue(desired, "attendees")).toEqual([
      { email: "alice@example.com", responseStatus: "tentative" },
      { email: "zed@example.com", responseStatus: "accepted" },
    ]);
  });

  it("scopes CalendarEvent entity ids by account and calendar", async () => {
    const project = async (accountScope: string, calendarId: string) => {
      const transport = new ScriptedTransport([
        { status: 200, body: { items: [event()], nextSyncToken: "sync" } },
      ]);
      const value = createGoogleCalendarAdapter({ accountScope, calendarId, transport });
      const result = await value.source.read({ mode: "incremental" });
      if (result.kind !== "page") throw new Error("expected page");
      return value.mapper.project(resolveSourceChange(result.changes[0]!, "2026-09-24T09:00:00Z"));
    };
    const first = await project("account-A", "primary");
    const second = await project("account-B", "primary");
    const third = await project("account-A", "team@example.com");
    expect(first.additiveEntities?.[0]?.entityId).not.toBe(second.additiveEntities?.[0]?.entityId);
    expect(first.additiveEntities?.[0]?.entityId).not.toBe(third.additiveEntities?.[0]?.entityId);
  });

  it("ignores cancelled tombstones during authoritative full pages so the generation sweep owns deletion", async () => {
    const value = adapter(new ScriptedTransport([
      {
        status: 200,
        body: {
          items: [
            { id: "deleted-event", status: "cancelled" },
            event({ id: "active-event", etag: '"active"' }),
          ],
          nextSyncToken: "sync-full",
        },
      },
    ]));
    const result = await value.source.read({ mode: "full" });
    if (result.kind !== "page") throw new Error("expected page");
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.externalId).toBe("active-event");
  });

  it("uses Google 410 to drive an authoritative full-resync sweep of a disappeared event", async () => {
    const semantic = new SQLiteSemanticStateStore({ path: await dbPath("semantic-reset.sqlite") });
    const ingestion = new SQLiteIngestionStateStore({ path: await dbPath("ingestion-reset.sqlite") });
    const initial = adapter(new ScriptedTransport([
      { status: 200, body: { items: [event()], nextSyncToken: "sync-old" } },
    ]));
    const initialEngine = new IngestionEngine({
      semanticState: semantic,
      ingestionState: ingestion,
      now: () => "2026-09-24T09:00:00Z",
    });
    await initialEngine.sync({ sourceKey: initial.sourceKey, source: initial.source, mapper: initial.mapper });
    expect((await semantic.snapshot()).retractions).toHaveLength(0);

    const resetting = adapter(new ScriptedTransport([
      { status: 410, body: { error: { code: 410 } } },
      { status: 200, body: { items: [], nextSyncToken: "sync-new" } },
    ]));
    const result = await initialEngine.sync({
      sourceKey: resetting.sourceKey,
      source: resetting.source,
      mapper: resetting.mapper,
    });
    const snapshot = await semantic.snapshot();

    expect(result.resetPerformed).toBe(true);
    expect(result.mode).toBe("full");
    expect(result.sweptResources).toBe(1);
    expect(snapshot.retractions.length).toBeGreaterThan(0);
    expect(snapshot.retractions.every((item) => item.targetKind === "observation")).toBe(true);
    semantic.close();
    ingestion.close();
  });

  it("flows through IngestionEngine -> semantic change feed -> existing capsule worker", async () => {
    const semantic = new SQLiteSemanticStateStore({ path: await dbPath("semantic.sqlite") });
    const ingestion = new SQLiteIngestionStateStore({ path: await dbPath("ingestion.sqlite") });
    const value = adapter(new ScriptedTransport([
      { status: 200, body: { items: [event()], nextSyncToken: "sync-1" } },
    ]));
    const engine = new IngestionEngine({
      semanticState: semantic,
      ingestionState: ingestion,
      now: () => "2026-09-24T09:00:00Z",
    });
    await engine.sync({ sourceKey: value.sourceKey, source: value.source, mapper: value.mapper });

    const cache = new InMemoryContextCapsuleStore();
    const worker = new IncrementalContextCapsuleWorker({
      stateStore: semantic,
      capsuleStore: cache,
      materializer: new ContextCapsuleMaterializer({ stateStore: semantic }),
    });
    const run = await worker.runOnce({ at: "2026-09-24T09:01:00Z" });
    expect(run.materializedEntityIds).toHaveLength(1);
    const capsule = await cache.get(run.materializedEntityIds[0]!);
    expect(capsule?.material.state.canonical.properties["CalendarEvent.summary"]?.value)
      .toBe("Architecture review");
    semantic.close();
    ingestion.close();
  });
});
