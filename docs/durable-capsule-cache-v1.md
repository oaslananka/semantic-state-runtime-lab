# Durable SQLite Context Capsule Cache v1

Context Capsules are derived state. They are not semantic truth, but losing them on every process restart eventually makes startup depend on replaying a user's entire semantic change history.

v1 adds a dedicated durable SQLite cache while preserving the existing semantic-store and retrieval contracts.

```text
Semantic State Store (truth)
        ↓ bootstrap view / change feed
Incremental Materializer
        ↓
SQLite Context Capsule Cache (derived)
        ↓ alias index
Context Access Gateway
        ↓
existing ContextCorpus + ranking
```

## Package boundary

The backend lives in a separate package:

```text
@ssrl/storage-sqlite-capsules
```

It depends on `@ssrl/materializer`, but the existing `@ssrl/storage-sqlite` semantic/journal package does not. This avoids a storage-sqlite ↔ materializer runtime dependency cycle.

## Dedicated database

The capsule cache owns its own SQLite file. It must not share a database with:

- runtime journal
- semantic state
- ingestion state
- artifact metadata

The backend itself refuses to initialize over an unrelated existing schema, and local Node configuration also rejects equal persistent-storage paths.

If `context.capsuleCachePath` is omitted, local composition derives:

```text
<semanticStatePath>.capsules.sqlite
```

Changing only this derived-cache path is allowed and does not alter the semantic source-topology fingerprint.

## Schema

The cache uses SQLite `STRICT` tables:

```text
capsule_cache_meta
context_capsules
context_capsule_aliases
context_capsule_checkpoint
```

`context_capsules` stores indexed columns plus canonical JSON TEXT:

```text
entity_id
materialized_at
configuration_version
change_cursor
next_temporal_boundary
capsule_json
```

`capsule_json` remains the integrity representation. Typed columns are derived indexes and are checked against parsed canonical JSON on read.

Alias rows contain:

```text
entity_id
normalized_alias
alias_score
token_count
```

Alias normalization and scoring reuse `@ssrl/core` functions rather than duplicating ranking logic in SQL.

## Canonical capsule validation

`@ssrl/materializer` now exports:

```text
contextCapsuleJson()
parseContextCapsuleJson()
CorruptContextCapsuleError
```

Stored capsule JSON must be canonical JSON and must agree with the indexed entity ID, materialization time, configuration version, change cursor, next temporal boundary, and alias index.

Corruption fails closed.

The cache can always be deleted and rebuilt because it is not a source of truth.

## Alias search semantics

The previous in-memory search performs:

1. `normalizeEntityAlias(query)`
2. whole-phrase alias matching
3. strongest alias score per entity
4. score descending
5. entity ID ascending tie-break
6. limit

SQLite preserves those semantics instead of introducing FTS-specific ranking.

At query time:

1. normalize the query
2. read only alias token lengths that exist in the index
3. generate the corresponding contiguous query n-grams
4. pass the n-grams as one canonical JSON array parameter
5. expand with SQLite `json_each(?)`
6. join against indexed `normalized_alias`
7. `MAX(alias_score)` per entity
8. order by score DESC / entity ID ASC
9. deserialize only selected capsule rows

Tests compare SQLite results directly with `InMemoryContextCapsuleStore` for:

- case normalization
- punctuation normalization
- Unicode NFKC normalization
- multilingual aliases
- multi-token aliases
- ties
- limits

A deliberately corrupted non-matching capsule proves search candidate selection happens before capsule deserialization.

SQLite documents JSON functions, including `json_each`, as built-in by default in modern SQLite releases. `STRICT` tables provide rigid per-table type enforcement. These are physical backend choices, not part of the public cache contract.

## Atomic put

`put(capsule)` atomically:

1. validates/parses the previous row if present
2. determines `inserted` / `updated` / `unchanged` using canonical semantic material + configuration version
3. upserts the full canonical capsule row
4. removes old alias-index rows
5. inserts the current alias index

Even an `unchanged` semantic material result persists newer derived metadata such as `materializedAt` or `changeCursor`, matching the in-memory store contract.

## Persistent checkpoint

The materializer checkpoint is stored in the same dedicated cache DB.

Worker ordering remains:

```text
read semantic page
  -> write/delete every affected capsule
  -> only then persist checkpoint
```

A crash after a capsule write but before checkpoint persistence causes safe at-least-once replay. Canonical material comparison turns the already-written capsule into an `unchanged` write on retry.

## Cold bootstrap

A new/lost cache must not replay the entire historical semantic feed.

`SemanticStateStore.bootstrapView()` atomically returns:

```text
current sorted entity IDs
semantic feed tail cursor
```

`ContextCapsuleBootstrapper` then:

1. resets derived cache state
2. materializes the captured current entity set
3. writes all capsules
4. persists the captured tail cursor only after materialization succeeds
5. lets normal feed processing consume changes after that cursor

A test deliberately constrains synchronization to `pageSize=1/maxPages=1`; a populated cold cache still succeeds with `changesRead=0`, proving it did not drain historical pages.

## Change after bootstrap tail

A semantic write can commit after the bootstrap snapshot but before/during capsule materialization.

This is safe:

- materialization may already observe the newer semantic state
- checkpoint is still the older captured tail
- normal synchronization replays the post-tail change
- replay is idempotent

A test injects a new `Project.apiStyle = gRPC` observation immediately after `bootstrapView()` captures its tail. Bootstrap sees current state, then the one post-tail change is still consumed afterward; nothing is skipped.

## Invalid/foreign checkpoint recovery

A persisted cache may be copied beside a different semantic-state DB or otherwise contain a cursor that the semantic store rejects.

When `InvalidSemanticChangeCursorError` occurs and a bootstrapper is configured:

```text
reject stale cursor
  -> reset derived cache
  -> snapshot bootstrap
  -> resume post-tail feed
```

The sync result exposes `recoveredInvalidCheckpoint: true` so recovery is detectable rather than a silent stale fallback.

## Time/config invalidation after reopen

`staleEntityIds()` uses indexed columns only:

- `next_temporal_boundary <= now`
- `configuration_version != current configurationVersion`

The full capsule JSON does not need to be scanned to decide staleness.

This preserves the existing behavior where time itself can invalidate bitemporal materialization even if the semantic change feed is empty.

## Local runtime integration

Local Node composition now uses `SQLiteContextCapsuleStore` instead of `InMemoryContextCapsuleStore`.

On normal restart with unchanged Markdown:

- source synchronization emits no semantic change
- persisted capsule checkpoint reopens
- no historical semantic changes are reread
- existing capsule `materializedAt` remains unchanged
- `context.compile` output remains correct

The cache is closed idempotently with the other local stores.

## Benchmark checkpoint — 2026-09-24

`pnpm benchmark:capsule-cache:v1` compares the existing in-memory full alias scan with indexed SQLite candidate selection.

Synthetic fixture:

- two aliases per capsule
- exact one-entity query near the end of the generated set
- 5 warmup searches
- 40 measured searches
- SQLite fixture rows are bulk-seeded in one benchmark-only transaction so the measurement isolates search rather than per-item public `put()` durability cost

Observed on the current MSI development host:

| Capsules | Indexed SQLite mean search | In-memory mean search | SQLite DB size |
| ---: | ---: | ---: | ---: |
| 100 | 0.325 ms | 0.802 ms | 159,744 B |
| 1,000 | 0.392 ms | 8.653 ms | 1,171,456 B |
| 10,000 | 1.465 ms | 81.182 ms | 11,415,552 B |

Both implementations returned the same entity in every measured fixture.

These are **observational development-host numbers**, not production SLAs. They depend on hardware, filesystem, Node/SQLite versions, warmup, query shape, alias distribution, and fixture construction. The useful signal is scaling direction: indexed candidate selection avoids the linear full-capsule alias scan.

## Non-goals

v1 does not add:

- vector search
- FTS/BM25 replacement
- cloud/distributed cache replication
- cache as source of truth
- semantic change-log compaction
- source filesystem watcher correctness
- remote multi-process writer coordination
- cache encryption/key management
- historical capsule versions

## Next step

With warm restart and cold rebuild semantics in place, the next performance question should be measured at the **source synchronization boundary**: authoritative Markdown currently still checks source state before context compilation. A watcher/dirty-hint layer may reduce that cost, but only if authoritative correctness and missed-event recovery remain intact.
