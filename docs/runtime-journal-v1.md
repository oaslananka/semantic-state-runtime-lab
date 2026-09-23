# Durable runtime journal v1

The journal is an append-only evidence layer for reconciliation. It is not a replacement for external providers and it does not pretend that a local database transaction can make remote side effects exactly-once.

## Event ordering

A journal-enabled reconciliation records:

1. `reconciliation.started`
2. one or more `observation.recorded` events for the initial read
3. `reconciliation.planned`
4. for every planned external mutation:
   - `mutation.requested` **before** the provider side effect
   - then either `mutation.applied` or `mutation.failed`
5. observations after successful mutation application
6. `reconciliation.completed`

A provider failure also records `reconciliation.failed` with the mutations known to have completed before the failure.

## Crash semantics

The hard boundary is between `mutation.requested` and its terminal event.

If a process dies after the provider accepted a mutation but before `mutation.applied` reaches durable storage, the journal contains an indeterminate request. Recovery must observe the provider again before deciding whether to retry, compensate, or mark the operation complete.

This is deliberate. There is no distributed transaction between SQLite and an arbitrary external provider.

## Event identity

Event IDs are idempotency keys. Re-appending byte-equivalent semantic event content with the same ID is accepted without duplication. Reusing an ID for different content is a collision error.

## SQLite adapter

`@ssrl/storage-sqlite` is the first persistence adapter. The journal contract itself does not expose SQLite or Node APIs.

The adapter uses a versioned append-only table and transactional batch append. It rejects database files with a newer unknown schema version rather than attempting a destructive downgrade.

The current Node 24 `node:sqlite` binding is isolated behind this adapter because its Node API is still release-candidate status. The durable event contract and SQL schema remain independent of that binding.
