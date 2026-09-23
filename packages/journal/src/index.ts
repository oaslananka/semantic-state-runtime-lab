import {
  canonicalJson,
  type EntityId,
  type ExternalSnapshot,
  type Mutation,
  type ReconciliationPlan,
} from "@ssrl/core";

export const JOURNAL_EVENT_SCHEMA_VERSION = 1 as const;

export type ReconciliationOutcome =
  | "dry-run"
  | "blocked"
  | "noop"
  | "converged"
  | "not-converged"
  | "drifted";

export interface JournalErrorSummary {
  readonly name: string;
}

interface EventEnvelope<Type extends string, Payload> {
  readonly schemaVersion: typeof JOURNAL_EVENT_SCHEMA_VERSION;
  readonly eventId: string;
  readonly runId: string;
  readonly entityId: EntityId;
  readonly type: Type;
  readonly occurredAt: string;
  readonly payload: Payload;
}

export type ReconciliationStartedEvent = EventEnvelope<
  "reconciliation.started",
  { readonly dryRun: boolean }
>;

export type ObservationRecordedEvent = EventEnvelope<
  "observation.recorded",
  {
    readonly phase: "before" | "after";
    readonly snapshot: ExternalSnapshot;
  }
>;

export type ReconciliationPlannedEvent = EventEnvelope<
  "reconciliation.planned",
  { readonly plan: ReconciliationPlan }
>;

export type MutationRequestedEvent = EventEnvelope<
  "mutation.requested",
  {
    readonly mutationId: string;
    readonly mutation: Mutation;
  }
>;

export type MutationAppliedEvent = EventEnvelope<
  "mutation.applied",
  {
    readonly mutationId: string;
    readonly mutation: Mutation;
  }
>;

export type MutationFailedEvent = EventEnvelope<
  "mutation.failed",
  {
    readonly mutationId: string;
    readonly mutation: Mutation;
    readonly error: JournalErrorSummary;
  }
>;

export type ReconciliationFailedEvent = EventEnvelope<
  "reconciliation.failed",
  {
    readonly failed: Mutation;
    readonly applied: readonly Mutation[];
    readonly error: JournalErrorSummary;
  }
>;

export type ReconciliationCompletedEvent = EventEnvelope<
  "reconciliation.completed",
  {
    readonly outcome: ReconciliationOutcome;
    readonly finalPlan: ReconciliationPlan;
  }
>;

export type RuntimeJournalEvent =
  | ReconciliationStartedEvent
  | ObservationRecordedEvent
  | ReconciliationPlannedEvent
  | MutationRequestedEvent
  | MutationAppliedEvent
  | MutationFailedEvent
  | ReconciliationFailedEvent
  | ReconciliationCompletedEvent;

export type RuntimeJournalEventType = RuntimeJournalEvent["type"];

export const RUNTIME_JOURNAL_EVENT_TYPES = [
  "reconciliation.started",
  "observation.recorded",
  "reconciliation.planned",
  "mutation.requested",
  "mutation.applied",
  "mutation.failed",
  "reconciliation.failed",
  "reconciliation.completed",
] as const satisfies readonly RuntimeJournalEventType[];

export function isRuntimeJournalEventType(value: unknown): value is RuntimeJournalEventType {
  return typeof value === "string"
    && (RUNTIME_JOURNAL_EVENT_TYPES as readonly string[]).includes(value);
}

export interface RuntimeEventSink {
  createId(): string;
  append(events: readonly RuntimeJournalEvent[]): Promise<void>;
}

export interface RuntimeEventJournal extends RuntimeEventSink {
  eventsForRun(runId: string): Promise<readonly RuntimeJournalEvent[]>;
  eventsForEntity(entityId: EntityId): Promise<readonly RuntimeJournalEvent[]>;
}

export function canonicalEventJson(event: RuntimeJournalEvent): string {
  return canonicalJson(event);
}

export class JournalEventCollisionError extends Error {
  constructor(readonly eventId: string) {
    super(`Journal event id ${eventId} already exists with different content`);
    this.name = "JournalEventCollisionError";
  }
}

export class InMemoryEventJournal implements RuntimeEventJournal {
  readonly #events: RuntimeJournalEvent[] = [];
  readonly #byId = new Map<string, RuntimeJournalEvent>();
  #nextId = 1;

  createId(): string {
    const id = `memory:${this.#nextId}`;
    this.#nextId += 1;
    return id;
  }

  async append(events: readonly RuntimeJournalEvent[]): Promise<void> {
    const staged = new Map(this.#byId);

    for (const event of events) {
      const existing = staged.get(event.eventId);
      if (existing !== undefined) {
        if (canonicalEventJson(existing) !== canonicalEventJson(event)) {
          throw new JournalEventCollisionError(event.eventId);
        }
        continue;
      }
      staged.set(event.eventId, event);
    }

    for (const event of events) {
      if (this.#byId.has(event.eventId)) continue;
      this.#events.push(event);
      this.#byId.set(event.eventId, event);
    }
  }

  async eventsForRun(runId: string): Promise<readonly RuntimeJournalEvent[]> {
    return this.#events.filter((event) => event.runId === runId);
  }

  async eventsForEntity(entityId: EntityId): Promise<readonly RuntimeJournalEvent[]> {
    return this.#events.filter((event) => event.entityId === entityId);
  }
}

export function indeterminateMutations(
  events: readonly RuntimeJournalEvent[],
): readonly MutationRequestedEvent[] {
  const requested = new Map<string, MutationRequestedEvent>();

  for (const event of events) {
    if (event.type === "mutation.requested") {
      requested.set(event.payload.mutationId, event);
      continue;
    }
    if (event.type === "mutation.applied" || event.type === "mutation.failed") {
      requested.delete(event.payload.mutationId);
    }
  }

  return [...requested.values()];
}
