# Connector Ingestion v1

`@ssrl/ingestion` is the protocol-neutral reliability layer between provider-native sync streams and the append-only semantic state store.

It does **not** claim exactly-once source delivery. Providers may replay pages, duplicate changes, invalidate cursors, or force a full resync. SSRL instead makes semantic effects deterministic and replay-safe.

```text
provider delta/full stream
        ↓
SourceChange envelope
        ↓
durable change receipt
        ↓
durable mapped plan
        ↓
projection diff
        ↓
assertions + retractions
        ↓
SemanticStateStore.append()
        ↓
durable resource projection
        ↓
source checkpoint LAST
        ↓
existing semantic change feed -> capsule worker
```

## Source identity

A source is identified by an opaque `IngestionSourceKey`.

The key must identify the authoritative synchronization scope, not only the vendor/account.

For example, these must be different source keys:

```text
google-calendar/account-A/all-events
google-calendar/account-A/work-calendar-only
```

Otherwise a full-resync sweep from one filtered scope could incorrectly delete projections owned by another scope.

## Checkpoint vs continuation

The source API separates two opaque values:

- `SourceContinuation`: page cursor inside one sync round.
- `SourceCheckpoint`: durable completed-round state used to begin the next round.

v1 intentionally does not persist continuation.

If the process dies mid-round, it restarts from the previous completed checkpoint and safely replays pages.

A checkpoint is persisted only after all semantic effects and projection state for the round are durable.

## Provider draft vs resolved SourceChange

Providers do not all supply a reliable modification timestamp on every change. Sparse deletion records are a common example. The source contract therefore separates the provider-owned draft from the fully resolved change used by semantic ingestion:

```ts
interface SourceChangeDraft<TPayload = unknown> {
  changeId: string;
  externalType: string;
  externalId: string;
  kind: "upsert" | "delete";
  effectiveAt?: string;
  recordedAt?: string;
  revision?: string;
  payload?: TPayload;
}

interface SourceChange<TPayload = unknown> extends SourceChangeDraft<TPayload> {
  effectiveAt: string;
  recordedAt: string;
}
```

`changeId` remains provider/adapter replay-stable. The engine resolves omitted times only on the first durable receipt:

```text
recordedAt = provider recordedAt ?? firstObservedAt
effectiveAt = provider effectiveAt ?? provider recordedAt ?? firstObservedAt
```

The ingestion state store persists **both** canonical forms:

```text
provider draft identity
resolved SourceChange
```

On replay, the same provider draft returns the stored resolved change and does not call the clock again. This keeps a sparse delete stable even if the process restarts hours later.

Provider-supplied timestamps are never replaced by fallback time. The resolved receipt must preserve the provider-owned resource identity, kind, revision, payload, and any timestamps the provider did supply. A mismatched resolved receipt fails closed.

Replaying the same `sourceKey + changeId` with different provider content still fails with `SourceChangeCollisionError`.

The engine never uses wall-clock time as source-change **identity**. Fallback observation time is durable receipt data only.

## Durable mapped plan

Input determinism alone is insufficient.

A mapper implementation can change across deploys or accidentally be nondeterministic. Consider this crash:

```text
mapper emits semantic id A
semantic append commits A
process crashes before resource projection write
new deploy mapper emits semantic id B for the same source change
```

Without an additional boundary, replay could create a ghost assertion.

Therefore an upsert's normalized `DesiredProjection` is persisted **before** semantic append:

```text
source receipt
  -> map once
  -> persist canonical mapped plan
  -> semantic append
  -> resource projection
```

On replay, the engine loads the stored mapped plan and does not call the mapper again.

A different plan for the same source change fails closed with `MappedProjectionCollisionError`.

This makes half-applied changes recoverable even if mapper code changes between retries.

## Desired projection

The mapper describes desired semantic state for one external resource rather than issuing imperative writes:

```ts
interface DesiredProjection {
  additiveEntities?: SemanticEntity[];
  additiveAliases?: EntityAliasRecord[];
  slots: ProjectedSlot[];
}
```

A lifecycle-managed slot is either:

```text
slot key -> observation semantic record
slot key -> relation semantic record
```

Entities and aliases remain additive in v1.

Observation/relation slots have lifecycle semantics.

## Projection diff

For each external resource the ingestion state store remembers the currently open targets:

```text
sourceKey
externalType
externalId
  -> slot key -> kind + semanticRecordId
```

For an upsert:

- same slot target: semantic append becomes an idempotent replay;
- new slot: append assertion;
- changed slot: append new assertion + retract previous target;
- removed slot: retract previous target.

For a delete:

- retract every open observation/relation slot;
- persist the resource projection as deleted/empty.

Retraction IDs are deterministic from:

```text
sourceKey
external resource identity
slot key
previous semantic target
source changeId
```

Retraction `effectiveFrom` and `recordedAt` come directly from the normalized source change.

## Crash ordering

For one source change:

```text
1. load or persist durable provider-draft + resolved source-change receipt
2. load or persist durable mapped plan
3. load previous resource projection
4. derive semantic batch
5. SemanticStateStore.append(batch)
6. persist next resource projection
```

For one completed incremental round:

```text
7. persist new provider checkpoint
```

### Crash after semantic append, before projection

Replay uses the same durable mapped plan.

Semantic IDs and retraction IDs are identical, so `SemanticStateStore.append()` is an idempotent no-op and projection state can advance.

### Crash after projection, before checkpoint

The provider round replays from the previous checkpoint.

The resource projection already matches the desired target; semantic writes are no-ops; then the checkpoint advances.

This is at-least-once ingestion with idempotent semantic effects.

## Full-resync generations

A provider may declare its incremental checkpoint unusable via `reset-required`.

SSRL does not erase semantic history. Instead it starts a durable authoritative full-sync generation for the same source key.

```text
reset-required
  -> begin/reuse active full-sync generation
  -> restart full read from beginning
  -> process every returned resource as normal upsert/delete
  -> mark each resource seen
  -> ONLY after source reports complete:
       compare source projections vs generation seen-set
       synthesize deterministic delete changes for unseen active resources
       persist retractions/projections
       atomically commit provider checkpoint + completed generation
```

A crash before full snapshot completion cannot trigger an unseen-resource sweep.

Because continuation is not durable, an active generation resumes from the start of the full source read. Already-seen markers and semantic effects are idempotent.

## Full-sync completion

`completeFullSyncGeneration()` atomically:

1. writes the new source checkpoint;
2. marks the generation completed;
3. clears its temporary seen set.

Completed generation records remain as lightweight tombstones so finalize replay is idempotent.

Re-finalizing with the same checkpoint is a no-op. Re-finalizing with a different checkpoint fails closed with `FullSyncCompletionCollisionError`.

## Ingestion state backend

The backend-neutral `IngestionStateStore` persists:

- source checkpoints;
- resource projections;
- provider-draft + resolved source-change receipts;
- mapped plans;
- active/completed full-sync generations;
- generation seen sets.

`SQLiteIngestionStateStore` is the first backend.

v1 requires a dedicated SQLite database. It refuses to silently share the runtime-journal or semantic-state SQLite files, keeping schema ownership explicit.

## End-to-end integration

No ingestion-specific materializer path exists.

```text
IngestionEngine
  -> SQLiteSemanticStateStore.append()
  -> existing semantic_changes feed
  -> IncrementalContextCapsuleWorker
  -> Context Capsule
```

The integration test proves an ingested GraphQL assertion materializes into a capsule, then a later gRPC source update appends a new assertion plus retraction and the existing capsule worker refreshes from the normal semantic feed.

## Verified behaviors

Tests cover:

- multi-page initial sync;
- continuation never persisted as checkpoint;
- duplicate delivery is idempotent;
- missing provider timestamps are stamped once and reused across replay;
- provider-supplied timestamps remain authoritative;
- resolved receipts cannot mutate provider-owned source fields;
- changed observation slot;
- removed observation slot;
- changed relation slot;
- removed relation slot;
- resource delete;
- crash after semantic append / before projection;
- replay from durable mapped plan without rerunning mapper;
- crash after projection / before checkpoint;
- duplicate changeId with different source content fails closed;
- mapped plan close/reopen persistence;
- mapped plan collision fails closed;
- reset-required full generation;
- incomplete full sync does not sweep unseen resources;
- completed full sync retracts unseen active projections;
- sourceKey scope isolation;
- full-sync finalize replay idempotency;
- checkpoint/projection close/reopen persistence;
- ingestion-generated semantic changes drive the existing capsule worker.

## Non-goals in v1

- live Gmail/Calendar/Notion credentials or vendor adapters;
- persisted in-round continuation;
- distributed queue semantics;
- Kafka exactly-once claims;
- raw attachment/blob retention;
- LLM extraction as a required path;
- alias deletion lifecycle;
- entity tombstones / physical privacy erasure;
- outbound semantic sync/action reconciliation;
- CRDT replication.

## Next step

The next product-risk step is one real high-signal adapter using this contract, followed by measurement of:

- source-to-semantic latency;
- replay volume after interrupted rounds;
- semantic inserts/retractions per provider change;
- full-resync sweep cost;
- capsule refresh latency/cost;
- provider-specific checkpoint expiry behavior.
