# Artifact-aware Connector Ingestion v1

The Artifact Plane stores immutable raw bytes and version history. The connector ingestion engine stores provider checkpoints, replay receipts, and semantic projections. Integrating them must not collapse those boundaries.

The design is a deterministic, restart-safe **saga**, not a cross-database ACID transaction.

```text
provider change
    ↓
durable source receipt
    ↓
semantic mapper ───────────────┐
artifact mapper -> raw bytes   │ transient only
    ↓                          │
ArtifactStore.putBlob()        │
    ↓                          │
persist MappedIngestionPlan ◄──┘
    ↓
ArtifactStore.append(mutation)
    ↓
SemanticStateStore.append(batch)
    ↓
persist ResourceProjection
    ↓
checkpoint LAST
```

## Raw bytes do not enter ingestion-state JSON

`SourceChange.payload` is durable provider metadata. It must remain reasonably small and JSON-like.

Raw email bodies, PDFs, images, audio, archives, or arbitrary binary payloads must not be copied into it merely to reach the artifact layer. `normalizeSourceChangeDraft()` rejects `ArrayBuffer` and typed-array/buffer views recursively.

Raw content instead crosses a transient mapper boundary:

```ts
interface ArtifactProjectionDraft {
  bytes: Uint8Array;
  mediaType: string;
  title?: string;
  sourceUri?: string;
}

interface ArtifactProjectionMapper<TPayload> {
  projectArtifact(change: SourceChange<TPayload>):
    Promise<ArtifactProjectionDraft | undefined>
    | ArtifactProjectionDraft
    | undefined;
}
```

The bytes are handed to `ArtifactStore.putBlob()` and disappear from the ingestion plan. The durable plan contains only the normalized immutable artifact mutation descriptor: digest, size, media type, source identity, clocks, and optional metadata.

## Durable mapped plan envelope

The old semantic-only durable projection boundary is generalized to:

```ts
interface MappedIngestionPlan {
  semantic?: DesiredProjection;
  artifactAction:
    | { kind: "preserve" }
    | { kind: "apply"; mutation: ArtifactMutation };
}
```

`artifactAction: preserve` means ingestion must not modify the resource's currently managed artifact state.

`artifactAction: apply` contains one deterministic immutable upsert/delete mutation.

The plan is canonicalized and persisted before either artifact mutation append or semantic append. Replay therefore does not call the semantic mapper or artifact mapper again once a plan exists.

A different plan for the same `sourceKey + changeId` fails closed with `MappedProjectionCollisionError`.

## Resource projection

A live source resource can additionally remember:

```ts
artifact?: {
  latestMutationId: string;
}
```

This is lifecycle state only. It does not duplicate the blob descriptor or bytes.

A deleted resource cannot retain a live artifact target.

## Artifact action rules

### Upsert with an artifact mapper

If the mapper returns bytes:

1. normalize media type/metadata;
2. install/deduplicate the blob in the Artifact Plane;
3. construct a deterministic artifact upsert mutation;
4. persist that mutation inside the mapped plan;
5. append it after plan persistence.

If the configured mapper returns no raw artifact and the resource previously had a live artifact, ingestion constructs a deterministic artifact delete.

If there was no prior artifact, no artifact mutation is needed.

### Upsert without an artifact mapper

Existing artifact state is **preserved**. A structured-only connector update must not silently delete a raw artifact that another ingestion configuration already manages.

### Provider delete

If a resource has a live artifact, provider deletion creates an artifact delete even though no artifact mapper is required.

### Full-sync sweep delete

An unseen active resource removed by authoritative full sync follows the exact same delete path, including artifact deletion.

## Deterministic artifact identity

Artifact resource identity is exactly:

```text
sourceKey
externalType
externalId
```

The source key is already required to be a stable, non-secret synchronization-scope identifier. Credentials/tokens must not be embedded into it.

Mutation IDs are deterministic from source/resource/change identity plus mutation kind and content/previous-version discriminator. Source clocks and revision are copied from the durable resolved `SourceChange`.

## Crash semantics

There is intentionally no 2PC across ingestion SQLite, Artifact Plane storage, and Semantic State Store.

Safety comes from immutable stable IDs, canonical mapped plans, idempotent appends, and checkpoint-last ordering.

### Crash after blob install, before plan persistence

The installed blob can be temporarily unreferenced.

Replay is allowed to rerun both mappers because no mapped plan exists yet. `putBlob()` content-addressed deduplication reuses the same blob.

### Crash after plan persistence, before artifact append

Replay loads the persisted plan. Neither mapper reruns. The planned artifact mutation is appended.

### Crash after artifact append, before semantic append

Artifact append is an idempotent no-op on replay, then semantic append proceeds.

### Crash after semantic append, before resource projection

Both effect layers replay idempotently, then the resource projection advances.

### Crash after resource projection, before checkpoint

The provider replays from the previous checkpoint. The stored plan and deterministic effects are reused; then the checkpoint advances.

### Persisted plan references a missing/corrupt blob

Replay fails closed in the Artifact Plane. The engine does **not** rerun the artifact mapper and silently substitute new bytes for an already persisted plan.

This preserves the durable plan as the replay contract.

## SQLite ingestion-state schema v3

Schema v3 renames the receipt's semantic-only `projection_json` into `mapped_plan_json`.

A v2 receipt with a semantic projection migrates to:

```json
{
  "semantic": "<the previous normalized projection>",
  "artifactAction": { "kind": "preserve" }
}
```

The migration changes only the receipt table. Existing provider/resolved receipts, source checkpoints, resource projections, active full-sync generations, and seen sets remain intact.

Tests cover v2 → v3 migration with all of those restart-state components present, followed by mapped-plan idempotent replay.

## Observability

`IngestionSyncResult` adds:

```text
artifactMutationsAppended
```

This counts newly appended artifact mutations.

It deliberately does not claim a count of newly written blobs because the current `ArtifactStore.putBlob()` contract intentionally hides whether a content-addressed blob was newly installed or already deduplicated.

## Verified behavior

Tests prove:

- binary buffers cannot enter durable provider payloads;
- arbitrary binary bytes round-trip through the raw Artifact Plane without UTF-8 coercion;
- normal ordering is blob → plan → artifact mutation → semantic → projection → checkpoint;
- mapped-plan JSON contains artifact descriptors, never inline `bytes`;
- source clocks/revision and resource identity survive into artifact mutation metadata;
- crash after blob install / before plan persistence safely reruns and deduplicates the blob;
- persisted-plan replay bypasses both mappers;
- artifact append failure blocks semantic/projection/checkpoint advancement;
- persisted plan + missing blob fails closed without rerunning mappers;
- semantic failure may leave durable raw artifact evidence but not projection/checkpoint advancement;
- configured artifact mapper returning no content deletes a previously live artifact;
- structured-only upsert preserves a live artifact;
- provider delete removes a live artifact;
- authoritative full-sync sweep removes an unseen live artifact;
- artifact-bearing mapped plans survive SQLite close/reopen and collision checks;
- v2 ingestion-state DB migrates semantic projections to preserve-artifact plans while retaining restart state.

## Non-goals

v1 does not add:

- Gmail/Drive/Notion raw-content connectors;
- artifact ACL or MCP exposure;
- OCR/extraction/chunking;
- semantic evidence-ref redesign;
- cross-store two-phase commit;
- a distributed transaction coordinator;
- streaming artifact writes;
- orphan blob garbage collection.

The next connector can rely on this common saga instead of inventing provider-specific crash ordering.
