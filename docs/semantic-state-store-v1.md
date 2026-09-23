# Semantic State Store v1

The Semantic State Store is the durable source of truth for normalized personal state evidence.

It is intentionally **not** the raw artifact store. Markdown files, email bodies, attachments, binary blobs, and other source-system payloads remain upstream evidence/artifacts. The state store persists the normalized semantic records that the temporal resolver and context compiler can consume without rescanning every source system on each request.

## Package boundary

The public contract lives in `@ssrl/state-store`.

The first backend is `SQLiteSemanticStateStore` in `@ssrl/storage-sqlite`.

This split is deliberate:

```text
connectors / ingestion
        ↓
@ssrl/state-store contract
        ↓
SQLite today
Postgres / cloud replica / other embedded backends later
```

Backend changes must not redefine append, collision, temporal, identity, or snapshot semantics.

## Records

v1 persists four record classes.

### Semantic entity

```ts
interface SemanticEntity {
  entityId: EntityId;
  entityType: string;
}
```

An entity ID has one immutable type in v1. Reusing an entity ID with a different type is a collision.

### Alias evidence

```ts
interface EntityAliasRecord {
  id: string;
  entityId: EntityId;
  value: string;
  recordedAt: string;
  evidenceRefs?: readonly string[];
}
```

Aliases are append-only evidence, not globally unique names.

Lookup uses the exact same Unicode normalization contract as `TypedEntityResolver` through `normalizeEntityAlias()`.

The portable record stores the raw alias. SQLite stores `normalized_value` only as a rebuildable derived index.

### Temporal observation

The store persists the existing `TemporalObservation` core type unchanged in meaning:

```text
entity + property + value + source
validFrom / validTo
recordedAt
```

### Temporal relation

The store persists the existing `TemporalRelationEdge` core type:

```text
from -> relationType -> to
validFrom / validTo
recordedAt
provenance
```

Relations remain bitemporal. Persisting a graph does not make edges static.

## Append-only transaction contract

`append(batch)` is atomic across entities, aliases, observations, and relations.

The insertion order inside the transaction is:

```text
entities
  -> aliases
  -> observations
  -> relations
```

This lets one batch introduce an entity and evidence that references it.

Every record has a stable ID. Append semantics are:

```text
same ID + same canonical semantic payload
  -> idempotent no-op

same ID + different payload
  -> SemanticRecordCollisionError
  -> entire transaction rolls back
```

Unknown entity references also fail the transaction with `UnknownSemanticEntityError`.

There is no UPDATE or DELETE evidence API in v1. New knowledge is represented by new temporal evidence. Historical evidence is not silently rewritten.

## Canonical semantic identity

Before persistence, records are normalized:

- timestamps become UTC ISO-8601 strings
- evidence refs are deduplicated and sorted
- nested `StateValue` objects are validated recursively
- object keys are canonicalized by `canonicalJson`
- non-finite numbers, non-plain objects, empty required strings, malformed intervals, and invalid entity IDs are rejected

This means semantically equivalent retries such as:

```text
2026-09-24T03:00:00+03:00
2026-09-24T00:00:00Z
```

produce the same record identity.

Array order inside `StateValue` remains meaningful and is not reordered.

## Portable snapshot

`SemanticStateSnapshot` contains:

```text
schema
entities
aliases
observations
relations
```

SQLite returns each collection in deterministic stable-ID order.

The snapshot contains portable JSON-compatible records only. It does not expose SQLite row IDs, pages, WAL state, JSONB blobs, or backend-specific metadata.

`typedEntitiesFromStateSnapshot()` reconstructs `TypedEntity` inputs from entity + alias evidence for `TypedEntityResolver` and `GraphContextCompiler`.

## SQLite v1 schema

The local backend uses `STRICT` tables with typed query columns plus canonical JSON text.

```text
semantic_entities
semantic_aliases
semantic_observations
semantic_relations
semantic_state_meta
```

Important choices:

- `record_json` is canonical RFC-8259 JSON TEXT with `json_valid()` checks.
- JSONB is **not** the portable source-of-truth representation.
- typed columns support indexed entity/property/time/relation access without parsing every JSON document.
- foreign keys are enabled.
- aliases have an exact normalized-value index.
- observations are indexed by entity/property/time.
- relations are indexed by source entity/relation type/time.

A future backend may use a different physical representation as long as public semantics and portable snapshots are preserved.

## Schema version ownership

The state store does not use `PRAGMA user_version` for its schema.

It uses a component-scoped row:

```text
semantic_state_meta
  component = semantic-state-store
  schema_version = 1
```

A database with a newer state-store schema fails closed with `UnsupportedSemanticStateSchemaError`.

### Dedicated DB in v1

The runtime journal currently owns a different migration model based on SQLite `user_version`.

Until a coordinated shared-database migration framework exists, v1 refuses to open a database containing `runtime_events`. This prevents the state store from silently mixing two schema-ownership systems in one file.

## WAL

`SQLiteSemanticStateStore({ wal: true })` may enable SQLite WAL for same-host concurrency.

WAL is only a local database runtime optimization. WAL/SHM files are not a semantic sync format, portable backup protocol, or network-filesystem replication design.

## Read integrity

Reads do not blindly cast stored JSON.

Each `record_json` is parsed and validated. The parsed semantic fields are then compared against the typed SQLite columns used for indexing/querying.

Examples of detected corruption:

- malformed or incomplete record JSON
- typed `entity_id` disagreeing with JSON
- alias normalized index disagreeing with the alias record
- temporal interval columns disagreeing with JSON
- relation endpoints disagreeing with JSON

Corrupted records fail closed with `CorruptSemanticStateError`.

## Context hydration

The store is deliberately compatible with the existing semantic runtime:

```text
SQLiteSemanticStateStore.snapshot()
  -> typedEntitiesFromStateSnapshot()
  -> GraphContextCompiler

SQLiteSemanticStateStore.observationsForEntity()
  -> resolveTemporalState()
```

The integration test proves that after closing and reopening the SQLite database:

- March Project Atlas API state resolves to REST
- September state resolves to GraphQL
- March owner relation traverses to Deniz / America/New_York
- September owner relation traverses to Alice / Europe/Istanbul

No source Markdown/API rescan is required for those normalized semantic queries.

## Non-goals in v1

The state store does not yet provide:

- raw file/email/blob storage
- FTS5 or vector search
- cloud replication
- CRDT merging
- tombstones/deletion/retention policy
- encryption key management
- automatic connector ingestion
- semantic sync reconciliation across applications
- persisted authority policy
- persisted entity/relation/property ontology descriptors

Those can be added around the stable append-only semantic evidence contract instead of changing it.

## Next architectural step

The next high-value layer is an **incremental semantic materializer / context capsule cache** driven from durable store changes:

```text
connector event
  -> append immutable semantic evidence
  -> identify affected entity/project capsules
  -> recompute only impacted canonical/context materialization
  -> agent receives a compact fresh ContextPackage
```

That is the path toward low-latency, low-token personal context without asking an agent to search every connected system at request time.
