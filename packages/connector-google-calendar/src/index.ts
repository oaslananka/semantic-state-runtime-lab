import { createHash } from "node:crypto";
import { canonicalJson, type EntityId, type StateValue } from "@ssrl/core";
import {
  ingestionSourceKey,
  sourceCheckpoint,
  sourceContinuation,
  type DesiredProjection,
  type IncrementalSource,
  type IngestionSourceKey,
  type ProjectionMapper,
  type SourceChange,
  type SourceChangeDraft,
  type SourceCheckpoint,
  type SourceContinuation,
  type SourceReadRequest,
  type SourceReadResult,
} from "@ssrl/ingestion";

export const GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE =
  "https://www.googleapis.com/auth/calendar.events.readonly" as const;

const API_BASE = "https://www.googleapis.com/calendar/v3";
const CHECKPOINT_PREFIX = "ssrl-gcal-checkpoint-v1:";
const CONTINUATION_PREFIX = "ssrl-gcal-page-v1:";
const ADAPTER_SCHEMA = "google-calendar-adapter-v1";

export interface GoogleCalendarEventDateTime {
  readonly date?: string;
  readonly dateTime?: string;
  readonly timeZone?: string;
}

export interface GoogleCalendarEventPerson {
  readonly email?: string;
  readonly displayName?: string;
  readonly self?: boolean;
}

export interface GoogleCalendarEventAttendee extends GoogleCalendarEventPerson {
  readonly responseStatus?: string;
  readonly optional?: boolean;
  readonly organizer?: boolean;
  readonly resource?: boolean;
}

export interface GoogleCalendarEventPayload {
  readonly id: string;
  readonly status?: string;
  readonly etag?: string;
  readonly updated?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  readonly start?: GoogleCalendarEventDateTime;
  readonly end?: GoogleCalendarEventDateTime;
  readonly transparency?: string;
  readonly visibility?: string;
  readonly eventType?: string;
  readonly recurrence?: readonly string[];
  readonly recurringEventId?: string;
  readonly originalStartTime?: GoogleCalendarEventDateTime;
  readonly organizer?: GoogleCalendarEventPerson;
  readonly attendees?: readonly GoogleCalendarEventAttendee[];
  readonly iCalUID?: string;
  readonly sequence?: number;
}

export interface GoogleCalendarEventsPage {
  readonly items?: readonly unknown[];
  readonly nextPageToken?: string;
  readonly nextSyncToken?: string;
}

export interface GoogleCalendarListRequest {
  readonly calendarId: string;
  readonly pageToken?: string;
  readonly syncToken?: string;
  readonly maxResults?: number;
  readonly singleEvents: false;
  readonly showDeleted: true;
}

export interface GoogleCalendarTransportResponse {
  readonly status: number;
  readonly body?: unknown;
}

export interface GoogleCalendarTransport {
  listEvents(request: GoogleCalendarListRequest): Promise<GoogleCalendarTransportResponse>;
}

export interface FetchGoogleCalendarTransportOptions {
  readonly accessToken: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
}

export class GoogleCalendarHttpError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: unknown,
  ) {
    super(`Google Calendar events.list failed with HTTP ${status}`);
    this.name = "GoogleCalendarHttpError";
  }
}

export class InvalidGoogleCalendarPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGoogleCalendarPayloadError";
  }
}

export class GoogleCalendarCheckpointMismatchError extends Error {
  constructor() {
    super("Google Calendar checkpoint belongs to a different adapter configuration");
    this.name = "GoogleCalendarCheckpointMismatchError";
  }
}

export class FetchGoogleCalendarTransport implements GoogleCalendarTransport {
  readonly #accessToken: () => Promise<string>;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: FetchGoogleCalendarTransportOptions) {
    this.#accessToken = options.accessToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async listEvents(request: GoogleCalendarListRequest): Promise<GoogleCalendarTransportResponse> {
    const query = new URLSearchParams();
    query.set("singleEvents", "false");
    query.set("showDeleted", "true");
    if (request.maxResults !== undefined) query.set("maxResults", String(request.maxResults));
    if (request.pageToken !== undefined) query.set("pageToken", request.pageToken);
    if (request.syncToken !== undefined) query.set("syncToken", request.syncToken);
    const url = `${API_BASE}/calendars/${encodeURIComponent(request.calendarId)}/events?${query}`;
    const response = await this.#fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${await this.#accessToken()}` },
    });
    let body: unknown;
    const text = await response.text();
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    return { status: response.status, ...(body === undefined ? {} : { body }) };
  }
}

export interface GoogleCalendarProjectionOptions {
  readonly includeDescription?: boolean;
  readonly includeLocation?: boolean;
  readonly includeOrganizer?: boolean;
  readonly includeAttendees?: boolean;
}

export interface GoogleCalendarAdapterOptions {
  readonly accountScope: string;
  readonly calendarId: string;
  readonly transport: GoogleCalendarTransport;
  readonly maxResults?: number;
  readonly projection?: GoogleCalendarProjectionOptions;
}

export interface GoogleCalendarAdapter {
  readonly sourceKey: IngestionSourceKey;
  readonly configFingerprint: string;
  readonly source: IncrementalSource<GoogleCalendarEventPayload>;
  readonly mapper: ProjectionMapper<GoogleCalendarEventPayload>;
}

interface CheckpointEnvelope {
  readonly fingerprint: string;
  readonly syncToken: string;
}

interface ContinuationEnvelope {
  readonly fingerprint: string;
  readonly pageToken: string;
  readonly mode: "incremental" | "full";
  readonly syncToken?: string;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidGoogleCalendarPayloadError(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return nonEmpty(value, label);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new InvalidGoogleCalendarPayloadError(`${label} must be boolean`);
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidGoogleCalendarPayloadError(`${label} must be a finite number`);
  }
  return value;
}

function object(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidGoogleCalendarPayloadError(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function validDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new InvalidGoogleCalendarPayloadError(`${label} must be YYYY-MM-DD`);
  }
  const millis = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) !== value) {
    throw new InvalidGoogleCalendarPayloadError(`${label} is invalid`);
  }
  return value;
}

function validDateTime(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new InvalidGoogleCalendarPayloadError(`${label} must be RFC3339-compatible`);
  }
  return value;
}

function eventDateTime(value: unknown, label: string): GoogleCalendarEventDateTime | undefined {
  if (value === undefined) return undefined;
  const record = object(value, label);
  const date = optionalString(record.date, `${label}.date`);
  const dateTime = optionalString(record.dateTime, `${label}.dateTime`);
  const timeZone = optionalString(record.timeZone, `${label}.timeZone`);
  if ((date === undefined) === (dateTime === undefined)) {
    throw new InvalidGoogleCalendarPayloadError(`${label} must contain exactly one of date or dateTime`);
  }
  return {
    ...(date === undefined ? {} : { date: validDate(date, `${label}.date`) }),
    ...(dateTime === undefined ? {} : { dateTime: validDateTime(dateTime, `${label}.dateTime`) }),
    ...(timeZone === undefined ? {} : { timeZone }),
  };
}

function person(value: unknown, label: string): GoogleCalendarEventPerson | undefined {
  if (value === undefined) return undefined;
  const record = object(value, label);
  const email = optionalString(record.email, `${label}.email`)?.toLowerCase();
  const displayName = optionalString(record.displayName, `${label}.displayName`);
  const self = optionalBoolean(record.self, `${label}.self`);
  return {
    ...(email === undefined ? {} : { email }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(self === undefined ? {} : { self }),
  };
}

function attendees(value: unknown, label: string): GoogleCalendarEventAttendee[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new InvalidGoogleCalendarPayloadError(`${label} must be an array`);
  return value.map((item, index) => {
    const record = object(item, `${label}[${index}]`);
    const base = person(record, `${label}[${index}]`) ?? {};
    const responseStatus = optionalString(record.responseStatus, `${label}[${index}].responseStatus`);
    const optional = optionalBoolean(record.optional, `${label}[${index}].optional`);
    const organizer = optionalBoolean(record.organizer, `${label}[${index}].organizer`);
    const resource = optionalBoolean(record.resource, `${label}[${index}].resource`);
    return {
      ...base,
      ...(responseStatus === undefined ? {} : { responseStatus }),
      ...(optional === undefined ? {} : { optional }),
      ...(organizer === undefined ? {} : { organizer }),
      ...(resource === undefined ? {} : { resource }),
    };
  }).toSorted((left, right) => (
    (left.email ?? "").localeCompare(right.email ?? "")
    || (left.displayName ?? "").localeCompare(right.displayName ?? "")
    || (left.responseStatus ?? "").localeCompare(right.responseStatus ?? "")
  ));
}

function normalizedProjectionOptions(
  options: GoogleCalendarProjectionOptions | undefined,
): Required<GoogleCalendarProjectionOptions> {
  return {
    includeDescription: options?.includeDescription ?? false,
    includeLocation: options?.includeLocation ?? false,
    includeOrganizer: options?.includeOrganizer ?? false,
    includeAttendees: options?.includeAttendees ?? false,
  };
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function encodeEnvelope(prefix: string, value: unknown): string {
  return `${prefix}${Buffer.from(canonicalJson(value), "utf8").toString("base64url")}`;
}

function decodeEnvelope(value: string, prefix: string): Readonly<Record<string, unknown>> {
  if (!value.startsWith(prefix)) throw new GoogleCalendarCheckpointMismatchError();
  try {
    return object(JSON.parse(Buffer.from(value.slice(prefix.length), "base64url").toString("utf8")), "envelope");
  } catch (cause) {
    if (cause instanceof GoogleCalendarCheckpointMismatchError) throw cause;
    throw new GoogleCalendarCheckpointMismatchError();
  }
}

function checkpointEnvelope(checkpoint: SourceCheckpoint, fingerprint: string): CheckpointEnvelope {
  const record = decodeEnvelope(checkpoint, CHECKPOINT_PREFIX);
  const storedFingerprint = nonEmpty(record.fingerprint, "checkpoint.fingerprint");
  const syncToken = nonEmpty(record.syncToken, "checkpoint.syncToken");
  if (storedFingerprint !== fingerprint) throw new GoogleCalendarCheckpointMismatchError();
  return { fingerprint: storedFingerprint, syncToken };
}

function continuationEnvelope(
  continuation: SourceContinuation,
  fingerprint: string,
): ContinuationEnvelope {
  const record = decodeEnvelope(continuation, CONTINUATION_PREFIX);
  const storedFingerprint = nonEmpty(record.fingerprint, "continuation.fingerprint");
  const pageToken = nonEmpty(record.pageToken, "continuation.pageToken");
  const mode = nonEmpty(record.mode, "continuation.mode");
  const syncToken = optionalString(record.syncToken, "continuation.syncToken");
  if (storedFingerprint !== fingerprint || (mode !== "incremental" && mode !== "full")) {
    throw new GoogleCalendarCheckpointMismatchError();
  }
  if (mode === "full" && syncToken !== undefined) throw new GoogleCalendarCheckpointMismatchError();
  return {
    fingerprint: storedFingerprint,
    pageToken,
    mode,
    ...(syncToken === undefined ? {} : { syncToken }),
  };
}

function normalizedEvent(
  value: unknown,
  projection: Required<GoogleCalendarProjectionOptions>,
): GoogleCalendarEventPayload {
  const record = object(value, "event");
  const id = nonEmpty(record.id, "event.id");
  const status = optionalString(record.status, "event.status");
  const recurringEventId = optionalString(record.recurringEventId, "event.recurringEventId");
  const originalStartTime = eventDateTime(record.originalStartTime, "event.originalStartTime");

  if (status === "cancelled") {
    const etag = optionalString(record.etag, "event.etag");
    const updated = optionalString(record.updated, "event.updated");
    return {
      id,
      status,
      ...(etag === undefined ? {} : { etag }),
      ...(updated === undefined ? {} : { updated: validDateTime(updated, "event.updated") }),
      ...(recurringEventId === undefined ? {} : { recurringEventId }),
      ...(originalStartTime === undefined ? {} : { originalStartTime }),
    };
  }

  const recurrence = record.recurrence === undefined
    ? undefined
    : (() => {
        if (!Array.isArray(record.recurrence)) {
          throw new InvalidGoogleCalendarPayloadError("event.recurrence must be an array");
        }
        return record.recurrence.map((item, index) => nonEmpty(item, `event.recurrence[${index}]`));
      })();
  const organizer = projection.includeOrganizer ? person(record.organizer, "event.organizer") : undefined;
  const attendeeList = projection.includeAttendees ? attendees(record.attendees, "event.attendees") : undefined;
  return {
    id,
    ...(status === undefined ? {} : { status }),
    ...(optionalString(record.etag, "event.etag") === undefined ? {} : { etag: record.etag as string }),
    ...(optionalString(record.updated, "event.updated") === undefined
      ? {}
      : { updated: validDateTime(record.updated as string, "event.updated") }),
    ...(optionalString(record.summary, "event.summary") === undefined ? {} : { summary: record.summary as string }),
    ...(projection.includeDescription && optionalString(record.description, "event.description") !== undefined
      ? { description: record.description as string }
      : {}),
    ...(projection.includeLocation && optionalString(record.location, "event.location") !== undefined
      ? { location: record.location as string }
      : {}),
    ...(eventDateTime(record.start, "event.start") === undefined ? {} : { start: eventDateTime(record.start, "event.start")! }),
    ...(eventDateTime(record.end, "event.end") === undefined ? {} : { end: eventDateTime(record.end, "event.end")! }),
    ...(optionalString(record.transparency, "event.transparency") === undefined ? {} : { transparency: record.transparency as string }),
    ...(optionalString(record.visibility, "event.visibility") === undefined ? {} : { visibility: record.visibility as string }),
    ...(optionalString(record.eventType, "event.eventType") === undefined ? {} : { eventType: record.eventType as string }),
    ...(recurrence === undefined ? {} : { recurrence }),
    ...(recurringEventId === undefined ? {} : { recurringEventId }),
    ...(originalStartTime === undefined ? {} : { originalStartTime }),
    ...(organizer === undefined ? {} : { organizer }),
    ...(attendeeList === undefined ? {} : { attendees: attendeeList }),
    ...(optionalString(record.iCalUID, "event.iCalUID") === undefined ? {} : { iCalUID: record.iCalUID as string }),
    ...(optionalNumber(record.sequence, "event.sequence") === undefined ? {} : { sequence: record.sequence as number }),
  };
}

function pageBody(value: unknown): GoogleCalendarEventsPage {
  const record = object(value, "events.list response");
  const items = record.items === undefined
    ? []
    : (() => {
        if (!Array.isArray(record.items)) {
          throw new InvalidGoogleCalendarPayloadError("events.list response items must be an array");
        }
        return record.items;
      })();
  const nextPageToken = optionalString(record.nextPageToken, "nextPageToken");
  const nextSyncToken = optionalString(record.nextSyncToken, "nextSyncToken");
  if ((nextPageToken === undefined) === (nextSyncToken === undefined)) {
    throw new InvalidGoogleCalendarPayloadError(
      "events.list response must contain exactly one of nextPageToken or nextSyncToken",
    );
  }
  return {
    items,
    ...(nextPageToken === undefined ? {} : { nextPageToken }),
    ...(nextSyncToken === undefined ? {} : { nextSyncToken }),
  };
}

function entityIdFor(accountScope: string, calendarId: string, eventId: string): EntityId {
  return `entity://calendar-event/${sha256([accountScope, calendarId, eventId])}` as EntityId;
}

function eventValue(value: GoogleCalendarEventDateTime): StateValue {
  return {
    ...(value.date === undefined ? {} : { date: value.date }),
    ...(value.dateTime === undefined ? {} : { dateTime: value.dateTime }),
    ...(value.timeZone === undefined ? {} : { timeZone: value.timeZone }),
  };
}

function personValue(value: GoogleCalendarEventPerson): StateValue {
  return {
    ...(value.email === undefined ? {} : { email: value.email }),
    ...(value.displayName === undefined ? {} : { displayName: value.displayName }),
    ...(value.self === undefined ? {} : { self: value.self }),
  };
}

function attendeeValue(value: GoogleCalendarEventAttendee): StateValue {
  return {
    ...(personValue(value) as Readonly<Record<string, StateValue>>),
    ...(value.responseStatus === undefined ? {} : { responseStatus: value.responseStatus }),
    ...(value.optional === undefined ? {} : { optional: value.optional }),
    ...(value.organizer === undefined ? {} : { organizer: value.organizer }),
    ...(value.resource === undefined ? {} : { resource: value.resource }),
  };
}

function propertyValue(payload: GoogleCalendarEventPayload, slot: string): StateValue | undefined {
  switch (slot) {
    case "status": return payload.status;
    case "summary": return payload.summary;
    case "description": return payload.description;
    case "location": return payload.location;
    case "start": return payload.start === undefined ? undefined : eventValue(payload.start);
    case "end": return payload.end === undefined ? undefined : eventValue(payload.end);
    case "allDay": return payload.start === undefined ? undefined : payload.start.date !== undefined;
    case "timeZones": {
      const start = payload.start?.timeZone;
      const end = payload.end?.timeZone;
      if (start === undefined && end === undefined) return undefined;
      return { ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }) };
    }
    case "transparency": return payload.transparency;
    case "visibility": return payload.visibility;
    case "eventType": return payload.eventType;
    case "recurrence": return payload.recurrence === undefined ? undefined : [...payload.recurrence];
    case "recurringEventId": return payload.recurringEventId;
    case "originalStartTime": return payload.originalStartTime === undefined
      ? undefined
      : eventValue(payload.originalStartTime);
    case "organizer": return payload.organizer === undefined ? undefined : personValue(payload.organizer);
    case "attendees": return payload.attendees === undefined
      ? undefined
      : payload.attendees.map(attendeeValue);
    case "iCalUID": return payload.iCalUID;
    case "sequence": return payload.sequence;
    default: return undefined;
  }
}

const SLOT_PROPERTIES = [
  ["status", "CalendarEvent.status"],
  ["summary", "CalendarEvent.summary"],
  ["description", "CalendarEvent.description"],
  ["location", "CalendarEvent.location"],
  ["start", "CalendarEvent.start"],
  ["end", "CalendarEvent.end"],
  ["allDay", "CalendarEvent.allDay"],
  ["timeZones", "CalendarEvent.timeZones"],
  ["transparency", "CalendarEvent.transparency"],
  ["visibility", "CalendarEvent.visibility"],
  ["eventType", "CalendarEvent.eventType"],
  ["recurrence", "CalendarEvent.recurrence"],
  ["recurringEventId", "CalendarEvent.recurringEventId"],
  ["originalStartTime", "CalendarEvent.originalStartTime"],
  ["organizer", "CalendarEvent.organizer"],
  ["attendees", "CalendarEvent.attendees"],
  ["iCalUID", "CalendarEvent.iCalUID"],
  ["sequence", "CalendarEvent.sequence"],
] as const;

class GoogleCalendarEventMapper implements ProjectionMapper<GoogleCalendarEventPayload> {
  readonly #accountScope: string;
  readonly #calendarId: string;
  readonly #fingerprint: string;

  constructor(
    accountScope: string,
    calendarId: string,
    fingerprint: string,
  ) {
    this.#accountScope = accountScope;
    this.#calendarId = calendarId;
    this.#fingerprint = fingerprint;
  }

  project(change: SourceChange<GoogleCalendarEventPayload>): DesiredProjection {
    const payload = change.payload;
    if (payload === undefined) throw new InvalidGoogleCalendarPayloadError("event upsert requires payload");
    const entityId = entityIdFor(this.#accountScope, this.#calendarId, payload.id);
    const revision = change.revision ?? change.changeId;
    const slots: DesiredProjection["slots"][number][] = [];
    for (const [slot, property] of SLOT_PROPERTIES) {
      const value = propertyValue(payload, slot);
      if (value === undefined) continue;
      slots.push({
        key: slot,
        kind: "observation",
        record: {
          id: `gcal-observation:${sha256([this.#fingerprint, payload.id, slot, revision])}`,
          entityId,
          property,
          value,
          source: {
            provider: "google-calendar",
            externalId: `${this.#calendarId}/${payload.id}`,
            revision,
          },
          validFrom: change.effectiveAt,
          recordedAt: change.recordedAt,
        },
      });
    }
    const additiveAliases = payload.summary === undefined
      ? undefined
      : [{
          id: `gcal-alias:${sha256([this.#fingerprint, payload.id, payload.summary])}`,
          entityId,
          value: payload.summary,
          recordedAt: change.recordedAt,
          evidenceRefs: [change.changeId],
        }];
    return {
      additiveEntities: [{ entityId, entityType: "CalendarEvent" }],
      ...(additiveAliases === undefined ? {} : { additiveAliases }),
      slots,
    };
  }
}

class GoogleCalendarEventSource implements IncrementalSource<GoogleCalendarEventPayload> {
  readonly #calendarId: string;
  readonly #transport: GoogleCalendarTransport;
  readonly #maxResults: number | undefined;
  readonly #fingerprint: string;
  readonly #projection: Required<GoogleCalendarProjectionOptions>;

  constructor(
    calendarId: string,
    transport: GoogleCalendarTransport,
    maxResults: number | undefined,
    fingerprint: string,
    projection: Required<GoogleCalendarProjectionOptions>,
  ) {
    this.#calendarId = calendarId;
    this.#transport = transport;
    this.#maxResults = maxResults;
    this.#fingerprint = fingerprint;
    this.#projection = projection;
  }

  #change(
    event: GoogleCalendarEventPayload,
    syncToken: string | undefined,
  ): SourceChangeDraft<GoogleCalendarEventPayload> {
    const isDelete = event.status === "cancelled";
    if (isDelete && syncToken === undefined) {
      throw new InvalidGoogleCalendarPayloadError(
        "Google Calendar cancelled event requires an incremental sync token",
      );
    }
    const roundIdentity = syncToken ?? "baseline";
    const revisionMaterial = isDelete
      ? ["delete", roundIdentity, event.id, event.recurringEventId ?? "", event.originalStartTime ?? null]
      : ["upsert", event.id, event.etag ?? event.updated ?? event.sequence ?? sha256(event)];
    const changeId = `gcal-change:${sha256([this.#fingerprint, revisionMaterial])}`;
    return {
      changeId,
      externalType: "google-calendar-event",
      externalId: event.id,
      kind: isDelete ? "delete" : "upsert",
      ...(event.updated === undefined ? {} : { effectiveAt: event.updated, recordedAt: event.updated }),
      ...(event.etag === undefined ? {} : { revision: event.etag }),
      payload: event,
    };
  }

  async read(request: SourceReadRequest): Promise<SourceReadResult<GoogleCalendarEventPayload>> {
    let syncToken: string | undefined;
    let pageToken: string | undefined;
    try {
      if (request.mode === "incremental" && request.checkpoint !== undefined) {
        syncToken = checkpointEnvelope(request.checkpoint, this.#fingerprint).syncToken;
      }
      if (request.continuation !== undefined) {
        const continuation = continuationEnvelope(request.continuation, this.#fingerprint);
        if (continuation.mode !== request.mode) throw new GoogleCalendarCheckpointMismatchError();
        if (
          syncToken !== undefined
          && continuation.syncToken !== undefined
          && continuation.syncToken !== syncToken
        ) {
          throw new GoogleCalendarCheckpointMismatchError();
        }
        if (request.mode === "full" && continuation.syncToken !== undefined) {
          throw new GoogleCalendarCheckpointMismatchError();
        }
        pageToken = continuation.pageToken;
        syncToken ??= continuation.syncToken;
      }
    } catch (cause) {
      if (cause instanceof GoogleCalendarCheckpointMismatchError) {
        return { kind: "reset-required", reason: "google-calendar-config-changed" };
      }
      throw cause;
    }
    const response = await this.#transport.listEvents({
      calendarId: this.#calendarId,
      singleEvents: false,
      showDeleted: true,
      ...(this.#maxResults === undefined ? {} : { maxResults: this.#maxResults }),
      ...(pageToken === undefined ? {} : { pageToken }),
      ...(syncToken === undefined ? {} : { syncToken }),
    });
    if (response.status === 410) {
      return { kind: "reset-required", reason: "google-calendar-sync-token-invalid" };
    }
    if (response.status < 200 || response.status >= 300) {
      throw new GoogleCalendarHttpError(response.status, response.body);
    }
    const page = pageBody(response.body);
    const events = (page.items ?? []).map((item) => normalizedEvent(item, this.#projection));
    const canApplyDeletes = request.mode === "incremental" && syncToken !== undefined;
    const changes = events
      .filter((event) => event.status !== "cancelled" || canApplyDeletes)
      .map((event) => this.#change(event, syncToken));
    if (page.nextPageToken !== undefined) {
      return {
        kind: "page",
        changes,
        next: {
          kind: "continue",
          cursor: sourceContinuation(encodeEnvelope(CONTINUATION_PREFIX, {
            fingerprint: this.#fingerprint,
            pageToken: page.nextPageToken,
            mode: request.mode,
            ...(syncToken === undefined ? {} : { syncToken }),
          })),
        },
      };
    }
    if (page.nextSyncToken === undefined) {
      throw new InvalidGoogleCalendarPayloadError("Google Calendar response lacks next sync token");
    }
    return {
      kind: "page",
      changes,
      next: {
        kind: "complete",
        checkpoint: sourceCheckpoint(encodeEnvelope(CHECKPOINT_PREFIX, {
          fingerprint: this.#fingerprint,
          syncToken: page.nextSyncToken,
        })),
      },
    };
  }
}

export function createGoogleCalendarAdapter(options: GoogleCalendarAdapterOptions): GoogleCalendarAdapter {
  if (options.accountScope.trim().length === 0) throw new TypeError("accountScope must not be empty");
  if (options.calendarId.trim().length === 0) throw new TypeError("calendarId must not be empty");
  if (
    options.maxResults !== undefined
    && (!Number.isInteger(options.maxResults) || options.maxResults < 1 || options.maxResults > 2_500)
  ) {
    throw new RangeError("maxResults must be an integer between 1 and 2500");
  }
  const projection = normalizedProjectionOptions(options.projection);
  const configFingerprint = sha256({
    schema: ADAPTER_SCHEMA,
    accountScope: options.accountScope,
    calendarId: options.calendarId,
    projection,
    singleEvents: false,
    showDeleted: true,
  });
  const sourceKey = ingestionSourceKey(
    `google-calendar/${sha256([options.accountScope, options.calendarId])}/events`,
  );
  return {
    sourceKey,
    configFingerprint,
    source: new GoogleCalendarEventSource(
      options.calendarId,
      options.transport,
      options.maxResults,
      configFingerprint,
      projection,
    ),
    mapper: new GoogleCalendarEventMapper(
      options.accountScope,
      options.calendarId,
      configFingerprint,
    ),
  };
}
