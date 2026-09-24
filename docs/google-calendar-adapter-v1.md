# Google Calendar Adapter v1

`@ssrl/connector-google-calendar` is the first real provider adapter built on the restart-safe connector ingestion contract.

It is deliberately read-only and narrow: one configured Google Calendar collection becomes one authoritative ingestion source.

```text
Google Calendar events.list
        ↓
GoogleCalendarEventSource
        ↓ SourceChangeDraft
IngestionEngine
        ↓
SQLiteIngestionStateStore receipts/checkpoint/projection
        ↓
SQLiteSemanticStateStore assertions + retractions
        ↓
semantic change feed
        ↓
Context Capsule worker
```

## Authorization boundary

The adapter exports the recommended least-privilege scope constant:

```text
https://www.googleapis.com/auth/calendar.events.readonly
```

OAuth UI, refresh-token storage, client secrets, and credential persistence are outside the adapter package.

`FetchGoogleCalendarTransport` receives an injected async `accessToken()` function. Tests can inject a transport directly and never require live credentials.

## Source scope

v1 configures exactly one:

```text
accountScope + calendarId
```

Both contribute to the source key, config fingerprint, and semantic event entity identity. Therefore the same Google event ID in two accounts or calendars cannot collide.

The source key has the form conceptually equivalent to:

```text
google-calendar/<hash(accountScope, calendarId)>/events
```

`accountScope` is caller-defined opaque account identity. It should be stable for the connected Google account but need not expose the user's email address.

## Query shape

Every `events.list` round uses the same synchronization shape:

```text
singleEvents=false
showDeleted=true
optional maxResults
optional pageToken
optional syncToken
```

No `timeMin`, `timeMax`, `updatedMin`, free-text query, ordering, or extended-property filter is introduced when a sync token is in use.

`singleEvents=false` preserves recurring masters and explicit exceptions instead of expanding an unbounded occurrence stream.

`showDeleted=true` ensures deleted/cancelled resources needed for incremental correctness are visible. During an authoritative full read, cancelled tombstones are not emitted as source deletes; unseen-resource generation sweep owns full-snapshot deletion semantics.

`maxResults` is restricted to 1..2500.

## Checkpoint and continuation

Google's `nextSyncToken` becomes SSRL `SourceCheckpoint` only on the final page.

Google's `nextPageToken` becomes SSRL `SourceContinuation`.

The checkpoint envelope contains:

```text
adapter config fingerprint
Google syncToken
```

The continuation envelope contains:

```text
adapter config fingerprint
pageToken
sync mode
syncToken when the round is incremental from a prior checkpoint
```

This lets a continuation reproduce the exact incremental query even when called without separately passing the checkpoint. Combining a continuation with a different sync round fails closed and triggers reset.

Changing privacy/projection configuration changes the fingerprint, so old checkpoints cannot silently continue under a different data contract.

## 410 reset

Google may invalidate a sync token and return HTTP 410.

The source converts this to:

```text
reset-required: google-calendar-sync-token-invalid
```

`IngestionEngine` then starts/reuses a durable full-sync generation, reads the calendar without the invalid sync token, marks resources seen, and only after the full read completes retracts previously active projections that were not seen.

No semantic history is erased.

## Deleted events and fallback time

Google sparse deletions may contain only the event ID. Cancelled recurring exceptions may contain only:

```text
id
recurringEventId
originalStartTime
```

Therefore the adapter does not invent `updated` with `Date.now()`.

For a sparse incremental delete it emits a timestamp-free `SourceChangeDraft`. The ingestion receipt resolves missing time once using `firstObservedAt` and persists that resolved change. Crash/replay then reuses the stored timestamp.

If Google does supply `updated`, it is retained as both `effectiveAt` and `recordedAt`.

### Delete identity

A delete change ID includes the prior sync-round identity plus stable sparse event identity:

```text
adapter fingerprint
delete
prior sync token
event id
recurringEventId when present
originalStartTime when present
```

This keeps replay within one round idempotent while allowing delete -> restore/update -> delete in a later completed sync round to produce a distinct change.

A cancelled recurring exception deletes **its own external resource ID**. The recurring master is a separate resource and remains intact unless independently changed/deleted.

## Upsert identity

Upserts prefer provider version evidence in this order:

```text
etag
updated
sequence
canonical payload hash fallback
```

Google etags are version evidence, while the adapter fingerprint scopes that evidence to the configured account/calendar/projection contract.

## Event projection

Each Google event maps to one deterministic `CalendarEvent` entity.

Lifecycle-managed observation slots include:

```text
status
summary
description (opt-in)
location (opt-in)
start
end
allDay
timeZones
transparency
visibility
eventType
recurrence
recurringEventId
originalStartTime
organizer (opt-in)
attendees (opt-in)
iCalUID
sequence
```

Observation IDs are deterministic from adapter fingerprint, Google event ID, slot key, and provider revision/change identity.

Changed/removed fields flow through the normal projection diff and immutable `SemanticRetraction` path.

## Summary alias

A non-empty event summary also produces additive alias evidence for the `CalendarEvent` entity.

Alias IDs are deterministic from event identity + summary, so the same title is idempotent across revisions. Because alias invalidation is intentionally not part of semantic retractions v1, a renamed event can retain an older summary as historical identity evidence. This is a known tradeoff rather than a hidden current-title claim.

## Time representation

Timed events preserve Google's RFC3339 `dateTime` string exactly and preserve `timeZone` when present.

All-day events preserve `YYYY-MM-DD` dates without fabricating a timezone. Impossible calendar dates are rejected rather than normalized to another day.

## Attendees and organizer privacy

Defaults minimize personal data:

```text
includeDescription=false
includeLocation=false
includeOrganizer=false
includeAttendees=false
```

When attendees are explicitly enabled, email addresses are lowercased and the attendee list is deterministically sorted before semantic projection.

Attendee/organizer email addresses are stored only as event property values. v1 does **not** create or link canonical `Person` entities from email addresses.

Raw Google payloads are not written to semantic state by default.

## Recurrence

v1 stores recurrence rules on recurring masters and keeps explicit exception resources separate.

It does not expand recurring masters into all future occurrences. Occurrence expansion/query is a later concern and should not inflate durable personal state unnecessarily.

## Deterministic fixture benchmark

`pnpm benchmark:google-calendar:v1` runs against scripted responses and real SQLite ingestion/semantic stores. It requires no Google credentials.

Current fixture sequence:

1. two-page initial sync with three active events;
2. one incremental round with one update and one sparse delete;
3. invalid sync token (410), then full resync with one previously active event absent and swept.

Expected accounting:

```text
4 API pages
7 processed changes (includes synthesized full-sync sweep deletion)
1 swept resource
49 semantic inserts/retractions/aliases/entities total
6 capsule refreshes
```

These are deterministic fixture counts, **not** a live latency/throughput or scalability claim.

## Verified behaviors

Tests cover:

- authenticated minimal read-only transport request;
- `showDeleted=true`, `singleEvents=false`, and absence of forbidden sync filters;
- multi-page continuation and final sync checkpoint;
- incremental continuation bound to original sync token;
- mismatched continuation/checkpoint fails closed;
- config/privacy fingerprint mismatch forces reset;
- HTTP 410 reset;
- timestamp-free sparse delete stability;
- provider `updated` preservation on cancelled events;
- delete identities distinct across completed sync rounds;
- sparse recurring-exception delete identity;
- default sensitive-field omission;
- summary alias evidence;
- timed event timezone preservation;
- all-day date preservation and validation;
- deterministic attendee normalization;
- account/calendar-scoped semantic entity IDs;
- authoritative full-resync sweep;
- end-to-end ingestion -> semantic change feed -> Context Capsule flow.

## Non-goals

- OAuth UX or token/secret persistence;
- calendar-list discovery;
- Google Calendar writes/actions;
- push notification/watch channels;
- attendee/organizer -> Person identity linking;
- recurrence occurrence expansion;
- free/busy;
- Gmail, Meet, or Drive enrichment;
- live credentials in CI.

A manual live credential smoke can be added outside CI once credential handling/authorization UX exists.
