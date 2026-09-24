# Incremental Context Capsules v1

The durable semantic store solves persistence, but a persistent database alone does not make personal context cheap to use.

If every agent request rebuilds canonical state from the full semantic snapshot, latency grows with the user's lifetime data even when only one entity changed.

v1 introduces two derived/runtime layers:

```text
append-only semantic state
        ↓ same transaction
 durable semantic change feed
        ↓ cursor
 incremental materializer
        ↓
 entity-local Context Capsules
        ↓ compose related capsules
 existing retrieval/ranking
```

The semantic store remains the source of truth. Capsules are rebuildable caches.

## Durable change feed

`SemanticStateStore.changesAfter(cursor, limit)` returns an ordered page of inserted semantic records.

A change contains:

```ts
interface SemanticChange {
  cursor: SemanticChangeCursor;
  kind: "entity" | "alias" | "observation" | "relation" | "retraction";
  recordId: string;
  primaryEntityId: EntityId;
  affectedEntityIds: readonly EntityId[];
}
```

### Primary vs affected entity

For entity, alias, and observation records:

```text
primaryEntityId = owning entity
affectedEntityIds = [owning entity]
```

For a relation:

```text
primaryEntityId = relation.from
affectedEntityIds = sorted unique [relation.from, relation.to]
```

The current capsule contains **outgoing** relations, so a relation insertion rematerializes the source capsule. The target remains visible in affected metadata for future reverse-index/invalidation use.

A retraction inherits invalidation scope from its target: observation retractions invalidate the observation owner; relation retractions use the relation source as primary and both endpoints as affected.

## Transactional feed invariant

A change row is inserted in the same SQLite transaction as the semantic record.

Therefore:

```text
semantic insert committed -> change committed
semantic insert rolled back -> change rolled back
idempotent replay/no insert -> no new change
```

There is no orphan change and no inserted semantic record without a corresponding change in schema v2+. Retractions use the same transaction invariant.

## Store-bound opaque cursors

The public cursor type is opaque. Consumers must only persist and replay it.

SQLite encodes a persistent random feed identity plus sequence internally. The feed identity lives in the database and survives reopen/copy.

This prevents two dangerous cases from silently looking like "no new changes":

- a cursor from another semantic-state database
- a syntactically valid sequence that this feed never emitted

Both fail with `InvalidSemanticChangeCursorError`.

No pruning exists in v1, so every emitted cursor remains verifiable.

## Schema v1 -> v2 migration

Semantic State Store schema v2 adds:

```text
semantic_change_feed_meta
semantic_changes
```

Opening a v1 database performs one atomic migration:

1. create a persistent feed ID
2. create the change table
3. bootstrap deterministic changes for existing entities, aliases, observations, and relations
4. update the component-scoped schema marker to v2

The bootstrap means an incremental consumer can start from no cursor after upgrade and discover all pre-existing semantic state without a special full-snapshot mode.

Schema v3 adds `semantic_retractions` and extends the existing change feed with `retraction`. Its migration preserves the persistent feed ID and existing sequence values, so a cursor issued on v2 remains valid on v3.

## Entity-scoped reads

The store now supports:

```text
entity(entityId)
aliasesForEntity(entityId)
observationsForEntity(entityId)
relationsFromEntity(entityId)
retractionsForEntity(entityId)
```

The materializer does not call `snapshot()` for ordinary entity refreshes.

## Context Capsule

A capsule is model-neutral derived state for one entity:

```ts
interface ContextCapsule {
  schema: "ssrl-context-capsule-v1";
  entityId: EntityId;
  materializedAt: string;
  configurationVersion: string;
  changeCursor?: SemanticChangeCursor;
  material: {
    entity: TypedEntity;
    state: {
      canonical;
      conflicts;
      evidence;
      conflictEvidence;
    };
    activeRelations: readonly TemporalRelationEdge[];
    appliedRetractions: readonly SemanticRetraction[];
    nextTemporalBoundary?: string;
  };
}
```

The capsule does **not** copy related entity state.

Example:

```text
Project Atlas capsule
  - Project.apiStyle = GraphQL
  - relation Project.owner -> Alice

Alice capsule
  - Person.timezone = Europe/Istanbul
```

A query that needs the owner's timezone composes Project Atlas + Alice capsules. If Alice's timezone changes, Project Atlas does not need rematerialization.

## Why semantic material excludes clock metadata

`materializedAt` is capsule metadata.

The semantic material contains canonical state/provenance/relations but not `validAt` and `knownAt` query timestamps. Otherwise replaying the same state one second later would look like a semantic update merely because the clock changed.

`contextCapsuleMaterialJson()` provides deterministic canonical material for equality/no-op cache decisions.

## Time can invalidate a cache without a write

Change-feed invalidation alone is incorrect for bitemporal state.

Suppose SSRL already knows:

```text
REST     valid until 2026-08-01
GraphQL  valid from 2026-08-01
```

At March, a REST capsule is correct. On August 1 it becomes stale even if no connector writes anything that day.

The materializer therefore computes `nextTemporalBoundary` from:

- observation activation/deactivation boundaries
- relation activation/deactivation boundaries
- future alias `recordedAt`
- scheduled retraction transitions

For current-state capsules where `validAt == knownAt == now`, a temporal record becomes active at:

```text
max(validFrom, recordedAt)
```

provided that instant is before `validTo`.

An active record can deactivate at `validTo`. A known scheduled retraction can also invalidate its target at `max(effectiveFrom, recordedAt)` for current-state materialization, provided it shortens the target's original interval.

`ContextCapsuleStore.staleEntityIds(at, configurationVersion)` marks a capsule stale when:

- `at >= nextTemporalBoundary`, or
- deterministic materializer configuration changed

This lets time-driven state transitions refresh with an empty change feed.

## Configuration version

Authority rules are still supplied as deterministic runtime configuration rather than persisted policy.

Each materializer declares a `configurationVersion`. A capsule produced under another version is stale even when semantic evidence did not change.

This prevents authority-policy changes from silently leaving old canonical caches in place.

## Incremental worker

`IncrementalContextCapsuleWorker.runOnce()` performs:

```text
load cache checkpoint
  -> changesAfter(checkpoint)
  -> dedupe primaryEntityId values
  -> union time/config-stale capsule IDs
  -> materialize entity-local capsules
  -> write all capsules
  -> only then advance checkpoint
```

If a capsule write fails:

- checkpoint is not advanced
- some earlier capsule writes may already exist
- retry replays the same changes
- canonical material equality makes already-written capsules safe no-ops

This is at-least-once materialization with idempotent derived writes.

## Cache contract

The backend-neutral `ContextCapsuleStore` exposes:

```text
get
put
 delete
checkpoint
setCheckpoint
staleEntityIds
```

v1 includes `InMemoryContextCapsuleStore` to establish semantics.

This is intentionally derived/rebuildable. Losing the cache cannot lose semantic truth. A durable SQLite/cloud capsule cache can implement the same interface later.

## Query projection

`contextCorpusFromCapsules()` in `@ssrl/context` accepts a minimal structural capsule view rather than depending on the concrete materializer package.

It projects:

- canonical state records
- conflict records
- active relation records
- provenance refs

into the existing `ContextCorpus`.

The existing BM25 baseline/ranker then runs unchanged.

The integration test proves:

```text
Project Atlas capsule
+ Alice capsule
-> ContextCorpus
-> existing BM25
-> owner + Europe/Istanbul evidence
```

This keeps optimization below retrieval semantics: cache/materialization should not get credit for a new ranker.

## Verified v1 behaviors

Tests cover:

- durable ordered changes in the same transaction as inserts
- no changes for exact replay
- no orphan changes after rollback
- cursor close/reopen resume without duplicates
- foreign and unknown cursors fail closed
- v1 DB migration bootstraps a v2 feed
- entity-scoped reads without full snapshot
- March REST capsule with August next boundary
- zero-write September refresh to GraphQL
- Alice timezone change rematerializes Alice only
- relation change rematerializes source Project only
- observation/relation retraction changes rematerialize their primary entity only
- scheduled retraction refreshes at its temporal boundary even with an empty feed
- cached BM25 projection excludes retracted state and relations
- worker failure before checkpoint safely replays
- configuration-version invalidation
- capsule material deterministic under append array reordering
- direct + related capsule projection into unchanged BM25 retrieval

## Non-goals in v1

- distributed change replication
- change-log pruning/compaction
- durable capsule cache backend
- multi-hop mega-capsules
- embeddings or LLM summaries
- raw artifact invalidation
- automatic authority-policy persistence
- background cloud scheduler
- entity tombstone propagation / physical privacy erasure

## Ingestion integration

`@ssrl/ingestion` now produces ordinary semantic assertions/retractions through `SemanticStateStore.append()`. The capsule worker needs no ingestion-specific code: its existing durable semantic change cursor observes those effects and rematerializes only affected entities.

See `docs/connector-ingestion-v1.md`.
