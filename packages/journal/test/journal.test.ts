import { describe, expect, it } from "vitest";
import {
  InMemoryEventJournal,
  JournalEventCollisionError,
  canonicalEventJson,
  indeterminateMutations,
  type RuntimeJournalEvent,
} from "../src/index.js";

const entityId = "entity://project/atlas" as const;

function started(
  eventId: string,
  overrides: Partial<Extract<RuntimeJournalEvent, { type: "reconciliation.started" }>> = {},
): Extract<RuntimeJournalEvent, { type: "reconciliation.started" }> {
  return {
    schemaVersion: 1,
    eventId,
    runId: "run-1",
    entityId,
    type: "reconciliation.started",
    occurredAt: "2026-09-23T21:30:00Z",
    payload: { dryRun: false },
    ...overrides,
  };
}

describe("runtime journal contract", () => {
  it("treats identical event retries as idempotent", async () => {
    const journal = new InMemoryEventJournal();
    const event = started("event-1");

    await journal.append([event]);
    await journal.append([event]);

    expect(await journal.eventsForRun("run-1")).toEqual([event]);
  });

  it("rejects the same event id with different content atomically", async () => {
    const journal = new InMemoryEventJournal();
    await journal.append([started("existing")]);

    await expect(journal.append([
      started("new"),
      started("existing", { occurredAt: "2026-09-23T21:31:00Z" }),
    ])).rejects.toBeInstanceOf(JournalEventCollisionError);

    expect((await journal.eventsForRun("run-1")).map((event) => event.eventId))
      .toEqual(["existing"]);
  });

  it("canonicalizes object key order for event identity", () => {
    const left = started("event-1");
    const right = {
      payload: { dryRun: false },
      occurredAt: left.occurredAt,
      type: left.type,
      entityId: left.entityId,
      runId: left.runId,
      eventId: left.eventId,
      schemaVersion: left.schemaVersion,
    } as RuntimeJournalEvent;

    expect(canonicalEventJson(left)).toBe(canonicalEventJson(right));
  });

  it("rejects expanded actor metadata before persistence serialization", () => {
    const unsafe = {
      ...started("actor-event"),
      actor: {
        subject: "user:alice",
        accessToken: "must-not-persist",
      },
    } as unknown as RuntimeJournalEvent;

    expect(() => canonicalEventJson(unsafe)).toThrow(TypeError);
  });

  it("rejects non-finite values instead of silently serializing them as null", () => {
    const unsafe: RuntimeJournalEvent = {
      schemaVersion: 1,
      eventId: "unsafe",
      runId: "run-1",
      entityId,
      type: "mutation.requested",
      occurredAt: "2026-09-23T21:30:01Z",
      payload: {
        mutationId: "mutation-unsafe",
        mutation: {
          provider: "replica",
          externalId: "atlas",
          externalPath: "score",
          canonicalProperty: "Project.score",
          nextValue: Number.NaN,
        },
      },
    };

    expect(() => canonicalEventJson(unsafe)).toThrow(TypeError);
  });

  it("detects requested mutations without an applied or failed terminal event", () => {
    const requested: RuntimeJournalEvent = {
      schemaVersion: 1,
      eventId: "request-event",
      runId: "run-1",
      entityId,
      type: "mutation.requested",
      occurredAt: "2026-09-23T21:30:01Z",
      payload: {
        mutationId: "mutation-1",
        mutation: {
          provider: "replica",
          externalId: "atlas",
          externalPath: "deadline",
          canonicalProperty: "Project.deadline",
          nextValue: "2026-11-20",
        },
      },
    };

    expect(indeterminateMutations([started("start"), requested]))
      .toEqual([requested]);
  });
});
