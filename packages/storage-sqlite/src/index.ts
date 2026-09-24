import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  JOURNAL_EVENT_SCHEMA_VERSION,
  JournalEventCollisionError,
  canonicalEventJson,
  isRuntimeJournalEventType,
  type RuntimeEventJournal,
  type RuntimeJournalEvent,
} from "@ssrl/journal";

const SQLITE_SCHEMA_VERSION = 1;

interface SQLiteEventJournalOptions {
  readonly path: string;
  readonly timeoutMs?: number;
  readonly idFactory?: () => string;
}

interface EventJsonRow {
  readonly event_json: string;
}

export class UnsupportedJournalSchemaError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(`Journal schema version ${found} is newer than supported version ${supported}`);
    this.name = "UnsupportedJournalSchemaError";
  }
}

export class CorruptJournalEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptJournalEventError";
  }
}

function parseEvent(value: string): RuntimeJournalEvent {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object") {
    throw new CorruptJournalEventError("Journal event JSON is not an object");
  }

  const event = parsed as Partial<RuntimeJournalEvent>;
  const actor = (parsed as { readonly actor?: unknown }).actor;
  const actorIsInvalid = actor !== undefined && (
    actor === null
    || typeof actor !== "object"
    || Array.isArray(actor)
    || typeof (actor as { readonly subject?: unknown }).subject !== "string"
    || Object.keys(actor).some((key) => key !== "subject")
  );
  if (
    event.schemaVersion !== JOURNAL_EVENT_SCHEMA_VERSION
    || typeof event.eventId !== "string"
    || typeof event.runId !== "string"
    || typeof event.entityId !== "string"
    || !isRuntimeJournalEventType(event.type)
    || typeof event.occurredAt !== "string"
    || actorIsInvalid
    || event.payload === undefined
  ) {
    throw new CorruptJournalEventError("Journal event envelope is invalid");
  }

  return event as RuntimeJournalEvent;
}

export class SQLiteEventJournal implements RuntimeEventJournal {
  readonly #db: DatabaseSync;
  readonly #idFactory: () => string;

  constructor(options: SQLiteEventJournalOptions) {
    this.#db = new DatabaseSync(options.path, {
      timeout: options.timeoutMs ?? 5_000,
      defensive: true,
    });
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#initialize();
  }

  #initialize(): void {
    this.#db.exec("PRAGMA foreign_keys = ON");
    const row = this.#db.prepare("PRAGMA user_version").get();
    const rawVersion = row?.user_version;
    if (typeof rawVersion !== "number" && typeof rawVersion !== "bigint") {
      this.#db.close();
      throw new CorruptJournalEventError("SQLite did not return a numeric schema version");
    }
    const version = Number(rawVersion);
    if (version > SQLITE_SCHEMA_VERSION) {
      this.#db.close();
      throw new UnsupportedJournalSchemaError(
        version,
        SQLITE_SCHEMA_VERSION,
      );
    }
    if (version === SQLITE_SCHEMA_VERSION) return;

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.exec(`
        CREATE TABLE runtime_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          run_id TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          event_schema_version INTEGER NOT NULL,
          event_json TEXT NOT NULL
        );

        CREATE INDEX runtime_events_run_sequence
          ON runtime_events(run_id, sequence);

        CREATE INDEX runtime_events_entity_sequence
          ON runtime_events(entity_id, sequence);

        PRAGMA user_version = ${SQLITE_SCHEMA_VERSION};
      `);
      this.#db.exec("COMMIT");
    } catch (cause) {
      this.#db.exec("ROLLBACK");
      throw cause;
    }
  }

  createId(): string {
    return this.#idFactory();
  }

  async append(events: readonly RuntimeJournalEvent[]): Promise<void> {
    if (events.length === 0) return;

    const find = this.#db.prepare(
      "SELECT event_json FROM runtime_events WHERE event_id = ?",
    );
    const insert = this.#db.prepare(`
      INSERT INTO runtime_events (
        event_id,
        run_id,
        entity_id,
        event_type,
        occurred_at,
        event_schema_version,
        event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const event of events) {
        const eventJson = canonicalEventJson(event);
        const existing = find.get(event.eventId) as EventJsonRow | undefined;
        if (existing !== undefined) {
          if (existing.event_json !== eventJson) {
            throw new JournalEventCollisionError(event.eventId);
          }
          continue;
        }

        insert.run(
          event.eventId,
          event.runId,
          event.entityId,
          event.type,
          event.occurredAt,
          event.schemaVersion,
          eventJson,
        );
      }
      this.#db.exec("COMMIT");
    } catch (cause) {
      this.#db.exec("ROLLBACK");
      throw cause;
    }
  }

  async eventsForRun(runId: string): Promise<readonly RuntimeJournalEvent[]> {
    const rows = this.#db.prepare(`
      SELECT event_json
      FROM runtime_events
      WHERE run_id = ?
      ORDER BY sequence
    `).all(runId) as unknown as EventJsonRow[];

    return rows.map((row) => parseEvent(row.event_json));
  }

  async eventsForEntity(entityId: RuntimeJournalEvent["entityId"]): Promise<readonly RuntimeJournalEvent[]> {
    const rows = this.#db.prepare(`
      SELECT event_json
      FROM runtime_events
      WHERE entity_id = ?
      ORDER BY sequence
    `).all(entityId) as unknown as EventJsonRow[];

    return rows.map((row) => parseEvent(row.event_json));
  }

  close(): void {
    this.#db.close();
  }
}
export * from "./semantic-state-store.js";

export * from "./ingestion-state-store.js";
