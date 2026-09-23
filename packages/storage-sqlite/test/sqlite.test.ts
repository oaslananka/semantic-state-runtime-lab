import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  JournalEventCollisionError,
  type RuntimeJournalEvent,
} from "@ssrl/journal";
import {
  CorruptJournalEventError,
  SQLiteEventJournal,
  UnsupportedJournalSchemaError,
} from "../src/index.js";

const roots: string[] = [];
const entityId = "entity://project/atlas" as const;

async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ssrl-journal-"));
  roots.push(root);
  return join(root, "journal.sqlite");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function event(
  eventId: string,
  runId = "run-1",
  occurredAt = "2026-09-23T21:30:00Z",
): RuntimeJournalEvent {
  return {
    schemaVersion: 1,
    eventId,
    runId,
    entityId,
    type: "reconciliation.started",
    occurredAt,
    payload: { dryRun: false },
  };
}

describe("SQLiteEventJournal", () => {
  it("persists ordered events across close and reopen", async () => {
    const path = await databasePath();
    const first = new SQLiteEventJournal({ path });
    await first.append([event("event-1"), event("event-2")]);
    first.close();

    const reopened = new SQLiteEventJournal({ path });
    expect((await reopened.eventsForRun("run-1")).map((item) => item.eventId))
      .toEqual(["event-1", "event-2"]);
    expect((await reopened.eventsForEntity(entityId)).map((item) => item.eventId))
      .toEqual(["event-1", "event-2"]);
    reopened.close();
  });

  it("accepts an identical retry without duplicating the event", async () => {
    const path = await databasePath();
    const journal = new SQLiteEventJournal({ path });
    const item = event("event-1");

    await journal.append([item]);
    await journal.append([item]);

    expect(await journal.eventsForRun("run-1")).toHaveLength(1);
    journal.close();
  });

  it("rolls back an entire batch when an event id collides", async () => {
    const path = await databasePath();
    const journal = new SQLiteEventJournal({ path });
    await journal.append([event("existing")]);

    await expect(journal.append([
      event("new"),
      event("existing", "run-1", "2026-09-23T21:31:00Z"),
    ])).rejects.toBeInstanceOf(JournalEventCollisionError);

    expect((await journal.eventsForRun("run-1")).map((item) => item.eventId))
      .toEqual(["existing"]);
    journal.close();
  });

  it("rejects journal actor metadata beyond the subject reference", async () => {
    const path = await databasePath();
    const journal = new SQLiteEventJournal({ path });
    const item = event("event-actor");
    await journal.append([item]);
    journal.close();

    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE runtime_events SET event_json = ? WHERE event_id = ?").run(
      JSON.stringify({
        ...item,
        actor: {
          subject: "user:alice",
          accessToken: "must-not-persist",
        },
      }),
      item.eventId,
    );
    raw.close();

    const reopened = new SQLiteEventJournal({ path });
    await expect(reopened.eventsForRun("run-1"))
      .rejects.toBeInstanceOf(CorruptJournalEventError);
    reopened.close();
  });

  it("rejects an unknown event type instead of casting corrupted data", async () => {
    const path = await databasePath();
    const journal = new SQLiteEventJournal({ path });
    const item = event("event-1");
    await journal.append([item]);
    journal.close();

    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE runtime_events SET event_json = ? WHERE event_id = ?").run(
      JSON.stringify({ ...item, type: "future.unknown" }),
      item.eventId,
    );
    raw.close();

    const reopened = new SQLiteEventJournal({ path });
    await expect(reopened.eventsForRun("run-1"))
      .rejects.toBeInstanceOf(CorruptJournalEventError);
    reopened.close();
  });

  it("rejects a database created by a newer unknown schema version", async () => {
    const path = await databasePath();
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA user_version = 99");
    raw.close();

    expect(() => new SQLiteEventJournal({ path }))
      .toThrow(UnsupportedJournalSchemaError);
  });
});
