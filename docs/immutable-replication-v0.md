# Immutable replication records v0

SSRL's first replication primitive is deliberately smaller than a general-purpose CRDT.

The current source-of-truth layers are already mostly immutable:

```text
Semantic Plane
  entity identity
  alias evidence
  temporal observation
  temporal relation
  semantic retraction

Artifact Plane
  immutable artifact mutation
  content-addressed raw blob
```

These records are append-only. A correction is another assertion/retraction or artifact mutation; it is not an in-place JSON/document edit.

That makes the core replication problem closer to **set reconciliation over immutable records** than to concurrent editing of one mutable object graph.

## Why v0 is not Automerge

Automerge solves concurrent mutation of shared documents with actor IDs, change graphs, causal heads, and a peer sync protocol.

That is the right class of machinery for collaborative mutable text/objects. SSRL's current semantic truth does not need that machinery merely to exchange immutable observations/retractions.

Reference:

- https://automerge.org/automerge/automerge/
- https://automerge.org/automerge/automerge/sync/struct.State.html

This does **not** mean SSRL will never use a CRDT. A future collaborative user-authored document layer may need one. It means the semantic/artifact replication core should not inherit CRDT complexity before its data model requires it.

## Willow as a closer reference

Willow separates:

- a data model;
- content-addressed payloads;
- writer/subspace authorization;
- set reconciliation;
- transport/confidential-sync concerns.

Its range-based reconciliation explicitly frames synchronization as discovering data one peer has and another lacks.

References:

- https://willowprotocol.org/specs/data-model/
- https://willowprotocol.org/specs/rbsr/
- https://willowprotocol.org/specs/meadowcap/

SSRL v0 adopts the **separation of concerns**, not Willow's wire format or data model.

## Portable replication record

`@ssrl/replication` defines a backend-neutral record:

```ts
interface ReplicationRecord {
  key: ReplicationRecordKey;
  kind: ReplicationRecordKind;
  recordId: string;
  payloadDigest: string;
  fingerprint: string; // SHA-256 of canonical (key, payloadDigest)
  payloadBytes: number;
  payload: string; // canonical JSON, record transfer only
}
```

Supported kinds are:

```text
semantic-entity
semantic-alias
semantic-observation
semantic-relation
semantic-retraction
artifact-mutation
```

The record key is a canonical tuple of kind + stable record ID.

The payload is parsed through the existing domain normalizer and re-encoded as canonical JSON **before hashing**. Whitespace, object-key order, equivalent timestamp offsets, or equivalent evidence-ref ordering therefore do not create false replication differences.

`payloadDigest` is SHA-256 over the exact canonical UTF-8 payload.

`fingerprint` is SHA-256 over canonical `{ key, payloadDigest }`. It gives future Merkle/range reconciliation a compact deterministic record-level identity without redefining the payload merge law.

## Merge law

For one record key:

```text
absent locally
  -> import

same key + same canonical payload
  -> idempotent no-op

same key + different canonical payload
  -> ReplicationRecordCollisionError
```

There is no last-writer-wins fallback for immutable evidence.

`mergeReplicationRecordSets()` is expected to satisfy, for non-conflicting sets:

```text
identity / idempotence: merge(A, A) = A
commutativity:          merge(A, B) = merge(B, A)
associativity:          merge(merge(A, B), C) = merge(A, merge(B, C))
```

Tests lock these properties down.

## Inventory v0

`ReplicationInventory` is a deterministic sorted list of descriptors plus one SHA-256 root digest.

```text
records sorted by record key
        ↓
canonical descriptor list
        ↓ SHA-256
inventory root
```

Inventory descriptors are explicitly projected and contain **no canonical payload body**. This matters at runtime: passing full `ReplicationRecord` objects into an inventory builder must not leak their extra `payload` property into the manifest. A regression test locks that invariant down.

Before comparison, `verifyReplicationInventory()` recomputes descriptor fingerprints and the inventory root. `diffReplicationInventories()` therefore does not trust a remote-supplied root string blindly. Only after both manifests verify can equal roots take the equal-set fast path.

Because v0 has no authenticated Merkle/range root, this verification is still O(N). A future signed/authenticated hierarchical root can make equal-set checks much cheaper without changing record identity.

If verified roots differ, v0 compares the two descriptor sets and returns:

```text
localOnly
remoteOnly
collisions
```

This is intentionally an O(N) correctness baseline.

### It is not the final network reconciliation algorithm

The interface is designed so the flat inventory can later be replaced by Merkle/range reconciliation without changing record identity or merge semantics.

The current flat inventory should not be exposed as a claim of scalable internet sync.

## Semantic export/import

`exportSemanticReplicationRecords()` converts a portable semantic snapshot to replication records.

`applySemanticReplicationRecords()` validates:

- record key ↔ kind/id agreement;
- canonical payload form;
- SHA-256 payload integrity;
- deterministic record fingerprint;
- domain schema/normalization;
- payload record ID ↔ envelope record ID agreement.

Apply operations are explicitly bounded. The default maximum is 1,000 records per call, with a hard configurable ceiling of 10,000. Larger reconciliation sets must be transferred/applied in bounded batches rather than one unbounded in-memory transaction.

It then appends one normal `SemanticStateBatch` through the existing store contract.

The replication package does not bypass semantic collision, reference, or retraction checks.

Derived state is rebuilt normally from imported semantic truth:

```text
replicated semantic records
  -> SemanticStateStore
  -> semantic change feed
  -> Context Capsule materializer
  -> Context Compiler
```

Context Capsules themselves are not replicated.

## Artifact metadata and blobs

Artifact mutation metadata is replicated as another immutable record family.

Raw bytes are **not** base64-inlined into the replication inventory.

For imported upsert mutations:

```text
artifact mutation metadata
  -> derive required blob digests/sizes/media-type hints
  -> HEAD local CAS
  -> fetch only missing digests
  -> verify source bytes against expected digest before install
  -> install/verify target digest
  -> append artifact mutation metadata
```

A mutation referring to a missing blob still fails closed through the existing Artifact Store API.

Two unrelated resources referencing the same exact bytes transfer one blob because CAS identity is the digest.

A crash after blob transfer but before mutation import can leave an unreferenced blob. That is the same safe asymmetry already accepted by the Artifact Plane.

## What is explicitly not replicated

v0 does not replicate:

```text
SQLite pages/WAL
SemanticChangeCursor
Context Capsule cache/checkpoint
Ingestion provider checkpoints
Ingestion continuations/full-sync generations
Runtime journal
retrieval/vector indexes
credentials/tokens
runtime access sessions
```

Those are local execution/materialization state, not portable user truth.

In particular, `SemanticChangeCursor` is store-bound and must never become a peer-replication cursor.

## Critical source-ingestion limitation

A naive multi-device topology exposed a real collision in the current ingestion model.

Markdown source changes have deterministic IDs based on path/content revision, but the source draft does not carry a provider-owned timestamp. `resolveSourceChange()` therefore uses the local runtime's `firstObservedAt` for both `effectiveAt` and `recordedAt`.

Two independent runtimes can therefore process the same source event as:

```text
same source change ID
same semantic observation ID
same entity/property/value/source revision
BUT
runtime A recordedAt = 10:00
runtime B recordedAt = 10:05
```

Result:

```text
same replication record key
+ different canonical semantic payload
= explicit replication collision
```

The test suite reproduces this exact case.

### Why not just put recordedAt into the record ID?

That would turn one logical provider event into two different assertions. It also makes later retractions/projections diverge by replica. The collision disappears syntactically but semantic duplication becomes worse.

### Why not last-writer-wins?

The two values are not competing user edits. They are two local receipt timestamps for the **same provider event**. Choosing one by LWW would invent a distributed knowledge-time policy and hide topology bugs.

## v0 source authority rule

Until source receipt clocks have replica-stable semantics:

> **One sourceKey has one logical ingestion authority inside one replication namespace.**

Other replicas receive that authority's immutable semantic/artifact output. They do not independently ingest the same sourceKey into the same namespace.

A failover can move the connector, but it must continue from the same durable source-ingestion history/authority rather than creating an unrelated first receipt of old provider events.

Provider events carrying deterministic provider-owned `effectiveAt` and `recordedAt` do not have this particular collision: independent local `firstObservedAt` values normalize to the same resolved source event and the same replication record payload. The tests prove that contrast as well.

This v0 rule is a deliberate limitation, not a permanent product assumption.

A future active-active source design needs a portable **source event receipt/witness model** that distinguishes provider event identity/time from replica-local receipt observations. Changing IDs alone is insufficient.

## Trust and authorization boundary

v0 is a reconciliation library, not a network trust protocol.

`writerId`, signatures, peer authentication, capabilities, namespace membership, and end-to-end encryption are intentionally absent.

A future transport/control plane must authenticate who is allowed to contribute which records before passing them to this reconciliation core.

Willow's writer-owned subspaces / capability model is a useful architectural reference, but SSRL has not adopted it as a protocol.

Opaque IDs and content digests are not authorization.

The first concrete network binding is now documented in `replication-http-transport-v1.md`: authenticated principals are injected into a bounded HTTP transport, while projection/record/blob authorization remains in `ReplicationAccessGateway`. Device-bound authentication and E2E encryption are still intentionally separate follow-up layers.

## v0 benchmark

Run:

```bash
pnpm build
pnpm benchmark:replication:v0
```

A local MSI run on 2026-09-24 measured:

| Records | Record build | Inventory build | Verified equal diff | Verified 10+10 delta diff | Descriptor JSON |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 200 ms | 74 ms | 107 ms | 92 ms | 0.34 MB |
| 10,000 | 940 ms | 547 ms | 719 ms | 817 ms | 3.43 MB |
| 100,000 | 6.26 s | 4.17 s | 6.32 s | 6.56 s | 34.30 MB |

The same benchmark verifies deterministic roots under reversed input order and detects a one-record collision. Diff timing includes manifest fingerprint/root verification rather than trusting an unverified remote root.

An earlier prototype accidentally retained full record `payload` properties inside runtime descriptor objects despite the TypeScript descriptor type, inflating the 100k JSON measurement to roughly 65 MB. Explicit descriptor projection fixed that bug; v0 now measures about 34.3 MB.

The result is still intentionally negative:

**34 MB of flat descriptors plus ~6.5 s of verified 100k comparison on this local run is not an acceptable final WAN-sync protocol.**

v0 establishes the merge law and portable records. A scalable implementation should compare hierarchical/range fingerprints and exchange only divergent ranges/records.

Timing and heap numbers are observational and hardware/runtime dependent; no production SLA is implied.

## Verified behavior

Tests prove:

- canonical-equivalent JSON creates the same replication record/digest/fingerprint;
- inventory descriptors never carry canonical payload bodies;
- inventory root is independent of input order;
- inventory roots/fingerprints are recomputed before comparison; malformed wire kinds fail closed;
- identical duplicate descriptors collapse as set membership;
- merge idempotence, commutativity, and associativity for non-conflicting sets;
- small-delta inventory comparison;
- same-key/different-payload collision in inventory comparison, record selection, and set merge;
- semantic apply batches reject configured-bound overflow before mutating the destination;
- bidirectional disjoint semantic additions converge to byte/canonical-equivalent snapshots;
- semantic retractions replicate and preserve temporal resolver behavior;
- missing artifact blobs are identified before metadata import;
- missing artifact bytes are verified against the source digest before target installation;
- missing artifact bytes transfer by verified digest before mutation metadata;
- repeated blob transfer sends zero bytes when target already has the digest;
- two artifact resources sharing exact bytes transfer one CAS blob;
- artifact update/delete history converges;
- same deterministic Markdown event with different local receipt clocks produces an explicit collision;
- explicit/provider-owned event clocks remain replica-stable despite different local receipt times.

## Next step

There are two independent follow-ups; they should not be conflated:

1. **Scalable reconciliation + trust**
   - Merkle/range fingerprints;
   - authenticated writer/replica identities;
   - capability-scoped record exchange;
   - E2E encrypted relay/drop transport.

2. **Active-active source ingestion, if required**
   - portable provider-event identity;
   - provider clock provenance;
   - replica-local receipt witnesses;
   - deterministic join semantics for receipt knowledge time;
   - reprojection/correction semantics when an earlier receipt witness arrives.

The product can support useful multi-device replication before solving active-active ingestion of the same external source.

## Scalable reconciliation follow-up

The flat v0 inventory remains the correctness baseline. `docs/prefix-merkle-reconciliation-v1.md` adds a derived fixed-prefix Merkle index that preserves the same immutable descriptor/collision law while avoiding full-manifest exchange for small deltas.
