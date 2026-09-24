# Prefix-Merkle Reconciliation v1

The immutable replication layer already has a deterministic merge law, but the original v0 protocol exchanges a flat O(N) descriptor inventory.

That is acceptable as a correctness baseline and poor as a long-lived WAN/mobile synchronization protocol. At 100,000 payload-free records, the flat descriptor array is roughly 34 MB before transport framing, authentication, or compression.

v1 keeps the exact immutable record identity/collision semantics and changes only **how replicas discover which descriptors differ**.

```text
immutable replication records
        ↓
fixed-prefix Merkle index (derived/rebuildable)
        ↓
compare root
   equal -> done
   unequal -> descend only mismatched branches
        ↓
mismatched leaves exchange descriptor lists
        ↓
existing immutable descriptor diff/collision law
        ↓
payload/blob transfer remains separate
```

## Stable partitioning

Each `ReplicationRecordKey` is hashed with SHA-256. The first N digest bits choose a leaf.

Supported v1 widths are intentionally small and explicit:

```text
8 bits   -> 256 leaves
12 bits  -> 4096 leaves (default)
16 bits  -> 65536 leaves
```

Array order, backend row order, insertion time, and device identity do not affect bucket assignment.

The same replication key therefore lands in the same leaf on every conforming replica using the same `prefixBits`.

Indexes with different prefix widths are not directly comparable and fail closed.

## Leaves

A leaf contains only normalized `ReplicationRecordDescriptor` values sorted by key:

```text
key
kind
recordId
payloadDigest
fingerprint
payloadBytes
```

It never contains the payload body.

The leaf digest is:

```text
SHA256(canonicalJson([
  "ssrl-prefix-merkle-leaf-v1",
  descriptorList
]))
```

Empty leaves also have one deterministic digest.

## Internal tree

The tree is complete over `2 ** prefixBits` leaves.

Each parent digest is domain-separated and level-bound:

```text
SHA256(canonicalJson([
  "ssrl-prefix-merkle-node-v1",
  level,
  leftHash,
  rightHash
]))
```

The root therefore commits to every normalized descriptor in every fixed bucket.

## Reconciliation

`comparePrefixMerkleIndexes(local, remote)` first compares the two roots.

If roots are equal:

```text
internalHashComparisons = 1
leafDescriptorsExamined = 0
estimatedLeafDescriptorBytesExchanged = 0
```

If roots differ, reconciliation recursively visits only child nodes whose hashes differ. Descriptor lists are inspected only when traversal reaches a mismatched leaf.

The final leaf comparison reuses the same `diffReplicationDescriptors()` law as flat v0:

- local-only key
- remote-only key
- same key / different payload digest -> collision
- same key / same payload digest but inconsistent immutable descriptor metadata -> invalid record, fail closed

There is no last-write-wins path.

## Incremental add

`PrefixMerkleIndex.add(descriptor)` validates and normalizes one descriptor.

For a new key:

```text
update one leaf
  -> update one parent per level
  -> O(log leafCount) parent updates
```

For an exact replay:

```text
unchanged
root unchanged
recordCount unchanged
```

For the same key with a different payload digest:

```text
ReplicationRecordCollisionError
root unchanged
recordCount unchanged
```

There is deliberately no mutable update/delete operation. Replicated semantic state remains immutable records plus semantic retractions at the data-model layer.

## Portable derived snapshot

`PrefixMerkleSnapshot` is a deterministic **derived cache snapshot**, not user truth and not the default wire manifest.

It stores:

```text
schema
prefixBits
recordCount
rootDigest
non-empty leaves:
  leafId
  leaf hash
  recordCount
  payload-free descriptors
```

The snapshot is O(N) because it is intended for local persistence/restart, not full exchange on every peer sync.

`restorePrefixMerkleIndex(snapshot)` rebuilds and revalidates:

- descriptor validity
- deterministic bucket assignment
- leaf counts
- leaf hashes
- total record count
- root digest
- canonical snapshot equality

Tampered root or leaf metadata fails closed.

Losing the snapshot loses no user data; the index can always be rebuilt from immutable replication records.

## Descriptor validation optimization

Merkle construction does **not** build the old flat inventory root first.

Both v0 and v1 now share `normalizeReplicationDescriptors()`, which performs descriptor fingerprint validation in bounded parallel batches and applies the same duplicate/collision law.

This removes unnecessary flat-root work from Merkle construction while keeping the v0 inventory API semantically unchanged.

## Benchmark v1

Command:

```text
pnpm benchmark:replication:merkle:v1
```

The benchmark uses valid, payload-free replication descriptors. It measures protocol work rather than source parsing, payload hashing, network latency, or compression.

Local observation on 2026-09-25, default 12-bit tree:

| Records | Flat descriptor bytes | Local index build | 1 remote-only descriptor exchange | 10+10 delta exchange | 1 collision exchange | Incremental add |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 341,001 B | 162 ms | 344 B | 9,605 B | 684 B | 1.21 ms |
| 10,000 | 3,410,001 B | 670 ms | 1,707 B | 34,826 B | 2,048 B | 2.48 ms |
| 100,000 | 34,100,001 B | 4.48 s | 13,301 B | 332,856 B | 13,642 B | 0.90 ms |

At 100,000 records, the observed descriptor-exchange reduction versus one full flat manifest was approximately:

```text
1-record delta:  2564x
10+10 delta:       102x
1 collision:      2500x
```

The 100k 10+10 case examined 976 leaf descriptors across 20 mismatched leaves rather than all 100,000 descriptors.

The 100k 10+10 comparison itself took about 4.2 ms locally once both indexes were built.

### What this benchmark does not prove

These are local protocol-work measurements, not WAN SLAs.

The exchange estimate counts both descriptor lists for mismatched leaves but excludes:

- Merkle node request/response framing
- authentication/signatures
- TLS/HTTP/WebSocket overhead
- compression
- RTT and packet loss
- peer discovery
- payload/blob transfer

Index build still costs seconds at 100k and must be treated as local derived work. A production system should persist/reuse or incrementally maintain the derived index rather than rebuild it before every sync.

## Security / adversarial caveat

Fixed public prefixes are predictable.

A malicious writer who can choose arbitrary record IDs can brute-force keys into the same prefix and create a hot leaf. A 12-bit fixed-prefix tree is therefore **not adversarially optimal** and must not be described as DoS-proof.

v1 assumes future authenticated writer/capability/rate limits at the replication boundary.

If real workloads or attack analysis justify it, follow-up options include:

- adaptive range subdivision
- authenticated sparse Merkle structures
- keyed partition functions negotiated inside a trust domain
- explicit per-writer quotas

The current fixed tree is chosen because it is deterministic, simple, portable, and already removes the O(N) small-delta manifest exchange problem.

## Non-goals

v1 does not implement:

- network transport
- peer discovery
- E2E encryption
- signatures or writer capabilities
- active-active ownership of one external source cursor
- mutable-document CRDTs
- physical deletion propagation
- automatic tree persistence backend
- blob transfer inside Merkle leaves

Artifact blobs continue to transfer separately by content digest after artifact-mutation descriptors reconcile.

## Result

The spike validates the narrow hypothesis that SSRL can keep its immutable collision semantics while making small-delta set discovery sublinear in exchanged descriptor volume.

It does **not** establish a complete multi-device sync product yet. The next layer still needs an authenticated transport/session protocol, peer trust/capability model, bounded node/leaf exchange messages, resumability, and abuse limits.
