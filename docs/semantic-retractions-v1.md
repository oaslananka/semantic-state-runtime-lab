# Semantic Retractions v1

Semantic state is append-only, but append-only must not mean "once asserted, true forever".

Real source systems delete fields, remove relationships, correct old records, and sometimes discover later that an earlier assertion stopped being true at an earlier date. Mutating the old semantic record would destroy the audit history that bitemporal state is meant to preserve.

v1 therefore models invalidation as a separate immutable semantic record.

## Record

```ts
type RetractableSemanticRecordKind = "observation" | "relation";

interface SemanticRetraction {
  id: string;
  targetKind: RetractableSemanticRecordKind;
  targetId: string;
  effectiveFrom: string;
  recordedAt: string;
  source?: SourceRef;
  evidenceRefs?: readonly string[];
}
```

The clocks have different meanings:

- `effectiveFrom`: world/valid time from which the target assertion no longer applies.
- `recordedAt`: knowledge/system time when SSRL learned the invalidation.

The target assertion is never edited.

## Bitemporal semantics

A retraction participates in a query only when:

```text
retraction.recordedAt <= knownAt
```

For one target, among all retractions known at that cutoff, the effective target end is:

```text
min(original validTo, earliest retraction.effectiveFrom)
```

Consequences:

- a future `effectiveFrom` schedules invalidation;
- `effectiveFrom <= target.validFrom` fully voids the assertion after the retraction is known;
- a retraction learned late can retroactively correct valid-time history;
- querying with an earlier `knownAt` still reconstructs what SSRL believed before learning the correction;
- a retraction later than the target's existing `validTo` does not extend or otherwise change it.

Example:

```text
assertion:
  REST validFrom 2026-02-01, open-ended

retraction:
  effectiveFrom 2026-08-01
  recordedAt    2026-08-10
```

Then:

```text
validAt=2026-08-05, knownAt=2026-08-05 -> REST is still what SSRL knew
validAt=2026-08-05, knownAt=2026-08-10 -> REST is no longer valid
```

This is not an overwrite. Both the original assertion and the later invalidation remain auditable.

## No unretract primitive

v1 is monotonic: retractions themselves are not deleted or toggled off.

If an invalidation was wrong, the correction is a new assertion record with its own provenance and time semantics. This avoids a second mutation channel that could erase history.

## Observation resolution

`resolveTemporalState()` accepts optional retractions.

Observation retractions are applied as a resolution-time overlay. The original `TemporalObservation` object and stored JSON remain unchanged.

`TemporalStateResolution.appliedRetractions` contains only retractions that actually shorten a target assertion under the requested knowledge cutoff.

Unknown targets and duplicate retraction IDs fail closed.

## Relation resolution

`resolveActiveRelationEdges()` applies the same two-clock semantics to relation edges and returns:

```text
active edges
applied retractions
```

`activeRelationEdges()` remains a backwards-compatible wrapper that returns only the active edge array.

A relation can therefore disappear from current context while remaining available in historical queries with an appropriate `validAt` / `knownAt` pair.

## Durable store

`SemanticStateBatch` and portable snapshots include retractions.

The append order is:

```text
entities
  -> aliases
  -> observations
  -> relations
  -> retractions
```

This permits a single atomic batch to create an assertion and then retract it, while still validating the target before commit.

Store rules:

- target must exist and match `targetKind`;
- exact canonical replay is a no-op;
- same retraction ID with different content is a collision;
- unknown or wrong-kind targets roll back the entire batch;
- malformed stored retraction JSON fails closed on read.

For change-feed invalidation:

```text
observation retraction:
  primaryEntityId = observation.entityId
  affectedEntityIds = [observation.entityId]

relation retraction:
  primaryEntityId = relation.from
  affectedEntityIds = sorted unique [relation.from, relation.to]
```

## SQLite schema v3

Schema v3 adds `semantic_retractions` and permits `retraction` in `semantic_changes.record_kind`.

The v2 -> v3 migration rebuilds the change table while preserving every existing explicit sequence and **does not replace the persistent feed ID**. A cursor issued before migration therefore remains valid after migration.

No synthetic retraction is generated for old data.

Portable snapshot schema is `ssrl-semantic-state-snapshot-v2` because retractions are now part of exported semantic truth.

## Incremental capsules

The materializer reads `retractionsForEntity(entityId)` and applies observation and relation invalidations before producing the capsule.

Capsule material includes `appliedRetractions` for audit/debug provenance, while retrieval projection emits only surviving canonical state/conflicts/active relations.

Retractions also participate in `nextTemporalBoundary`.

For current-state materialization (`validAt == knownAt == now`), a scheduled retraction can change visible semantics at:

```text
max(retraction.effectiveFrom, retraction.recordedAt)
```

when the retraction can shorten the target's original validity interval.

This means a capsule can refresh at a future deletion boundary even when the change feed is empty at that moment.

## Cached and non-cached consistency

Both direct context compilers and capsule materialization use the same core retraction semantics.

Tests prove that:

- direct temporal context does not emit retracted state;
- graph context does not traverse a retracted relation;
- capsule projection into the existing BM25 corpus does not reintroduce the removed state or relation.

Retraction handling is therefore below retrieval/ranking and cannot diverge merely because one request used a cache.

## Deliberate non-goals

v1 does not treat the following as semantic retractions:

- physical privacy erasure or legal deletion from storage;
- entity tombstones/deletion;
- alias invalidation;
- undo/unretract mutation;
- change-log compaction;
- distributed merge/CRDT conflict handling.

Alias evidence needs its own valid-time identity lifecycle rather than being forced into an observation/relation abstraction.

Physical erasure is also a different concern: semantic invalidation says "do not treat this assertion as true"; it does not promise that historical evidence bytes have been destroyed.

## Research lineage

The design follows established immutable/provenance ideas rather than inventing mutation semantics inside SSRL:

- Datomic transaction model: additions and retractions over immutable datoms.
- W3C PROV: invalidation is represented as a distinct provenance event.
- XTDB bitemporal model: valid-time corrections remain separable from system/knowledge-time history.

The SSRL-specific contribution is applying those principles consistently across personal semantic state, graph relations, durable cursors, and incremental context materialization.
