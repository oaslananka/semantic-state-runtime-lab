# Bounded Reconciliation Session v1

Prefix-Merkle reconciliation removed the need to exchange an O(N) descriptor manifest for small deltas, but the first implementation compared two complete indexes inside one process.

That is not a network protocol. A remote peer needs a stable logical view, bounded request/response sizes, resumable client state, explicit stale-view behavior, and protection against one hot fixed-prefix leaf producing an unbounded message.

v1 adds those protocol semantics without coupling the core to HTTP, WebSocket, MCP, fetch, sockets, peer identity, or encryption.

```text
live immutable replication records
        ↓
PrefixMerkleIndex (derived)
        ↓ open
FrozenPrefixMerkleView
        ↓
transport-neutral endpoint
        ↓
BoundedReconciliationSession
        ↓
localOnly / remoteOnly / collisions
        ↓
existing recordsByKeys + apply APIs
```

The immutable record merge law is unchanged.

## Stable pinned views

`FrozenPrefixMerkleView.open(index)` snapshots and revalidates the current prefix-Merkle index.

A view publishes:

```ts
interface ReconciliationViewInfo {
  schema: "ssrl-reconciliation-v1";
  viewId: string;
  prefixBits: 8 | 12 | 16;
  rootDigest: string;
  recordCount: number;
}
```

Every node and leaf response repeats the `viewId` and `rootDigest` it belongs to.

Mutation of the live source index after opening a view cannot leak newer descriptors into that view. The in-memory registry can also explicitly expire a view. Access after expiry fails with `StaleReconciliationViewError`; it never silently rebinds the old `viewId` to current data.

The current implementation freezes a derived index in memory. A future durable backend may pin a storage snapshot instead, provided it preserves the same immutable-view contract.

## Transport-neutral endpoint

The protocol core depends only on:

```text
viewInfo(viewId)
nodeHashes(viewId, refs, limits)
leafPage(viewId, leafId, cursor, limits)
```

`InMemoryReconciliationEndpoint` is the reference adapter used by tests.

A future HTTPS, WebSocket, local IPC, or peer-to-peer adapter can implement the same interface. The state machine does not import a network stack.

## Root-first reconciliation

Session startup fetches remote view metadata and compares roots.

If roots are equal, reconciliation is complete immediately:

```text
node queries = 0
leaf pages = 0
leaf descriptors = 0
```

If roots differ, the client traverses the complete prefix-Merkle tree using bounded node-reference batches and descends only through mismatched branches.

When traversal reaches a mismatched leaf, it exchanges only canonical payload-free descriptors for that leaf and applies the existing `diffReplicationDescriptors()` law:

- key only local -> `localOnly`
- key only remote -> `remoteOnly`
- same key / different payload digest -> collision
- same key / same digest / inconsistent immutable metadata -> fail closed

There is no last-write-wins rule in the protocol.

## Bounded node work

Server node requests are capped:

```text
default max refs/request: 128
server hard max:          512
```

The session additionally caps queued client work:

```text
default pending nodes:  4,096
hard max:             131,072

default pending leaves: 1,024
hard max:             65,536
```

Crossing a configured pending-work limit fails with `ReconciliationLimitError` instead of allowing an unbounded local queue.

Node references are validated against the negotiated fixed tree shape. Invalid levels or indexes fail closed.

## Bounded leaf pages

One fixed-prefix leaf may contain many descriptors, especially when an authorized or malicious writer can choose record IDs.

Leaf responses are therefore paginated by deterministic `ReplicationRecordKey` order.

Defaults and hard maxima:

```text
default descriptors/page: 128
hard max:               1,024

default estimated bytes/page: 64 KiB
hard max:                  256 KiB
```

Both limits apply simultaneously. If even one descriptor cannot fit inside the requested byte limit, the server fails instead of returning an oversized response.

The byte count covers the canonical JSON descriptor array, not transport framing.

Payload bodies are forbidden from leaf messages.

### Opaque page cursor

A page cursor is bound to:

```text
protocol schema
viewId
rootDigest
leafId
afterKey
```

The in-memory view authenticates that cursor material with an ephemeral HMAC secret. Tampered cursors, cross-view cursors, cross-leaf cursors, and cursors whose `afterKey` is not in the pinned leaf fail closed.

The cursor is protocol state, not an authorization credential.

## Resumable client session

`BoundedReconciliationSession.encode()` serializes canonical client state, including:

```text
local + remote view identities
resolved limits
phase
pending node refs
pending leaves
current leaf page cursors/buffers
accumulated delta/collisions
protocol-work counters
```

`restore()` validates the structure before use:

- protocol/view metadata
- supported prefix width
- root digest shape
- record counts
- canonical options
- node/leaf bounds
- pending-work limits
- non-negative counters
- canonical descriptor buffers
- maximum encoded checkpoint size (8 MiB)

A restored session still has to use the same pinned views. If one has expired, the next protocol operation fails explicitly with `StaleReconciliationViewError` and the caller restarts from fresh roots.

Tests cover resume both mid-tree and mid-leaf, including active page cursors.

## At-least-once protocol execution

Session state is client-side derived protocol state. Repeating a node request or leaf-page request for the same pinned view/cursor is deterministic.

This allows callers to persist the encoded session only after a successful step. If a process crashes before checkpointing the next state, replaying the previous step is safe because reconciliation has no semantic write side effect.

Actual record transfer/application remains a separate phase using the existing immutable record APIs.

## Step budget

`maxSteps` is a caller-controlled total-work budget, capped by a hard maximum.

When the session reaches that budget before completion it throws `ReconciliationBudgetExceededError`.

This is a resource bound, not a convergence prediction.

## Correctness parity

The v1 tests compare bounded-session output directly with the flat v0 descriptor diff.

Current coverage includes:

- equal roots
- 100,000 records + one remote-only record
- 100,000 records with 10 local-only + 10 remote-only records
- same-key/different-payload collision
- same-key/same-digest/inconsistent immutable metadata
- different node batch sizes
- different leaf page sizes
- mixed semantic + artifact descriptor kinds
- mid-tree resume
- mid-leaf resume
- remote-view expiry
- tampered root metadata
- step budget
- pending-work budget

The 100k correctness fixture lives in tests. The routine protocol-work benchmark uses a smaller normal fixture to keep CI useful rather than turning it into a load test.

## Protocol-work benchmark

Run:

```text
pnpm benchmark:replication:sync:v1
```

The benchmark is observational local work. It does not claim network latency.

Recorded local run on 2026-09-25:

### Normal 10,000-record fixture, 12-bit tree

| Scenario | Remote messages* | Node hashes | Leaf pages | Remote leaf descriptors | Descriptor bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| equal roots | 1 | 0 | 0 | 0 | 0 B |
| +1 remote record | 15 | 25 | 1 | 6 | 1,975 B |
| 10+10 delta, resumed | 34 | 297 | 20 | 60 | 19,761 B |

`*` `remoteMessages` counts one root/view-info exchange plus remote node-query responses and leaf-page responses.

The resumed 10+10 run encoded a **996-byte** canonical checkpoint. Local encode was ~0.11 ms and restore ~0.37 ms in that run. These are implementation observations, not SLAs.

### Deliberately hot fixed-prefix leaf

The benchmark brute-forces 10,000 valid record IDs into leaf 0 of an 8-bit public prefix tree, then reconciles an empty local set against that remote leaf.

Observed:

```text
10,000 descriptors
79 bounded leaf pages
10,000 descriptors transferred
~3.19 MB canonical descriptor bytes
89 total remote messages including root/view + node traversal
```

This is intentionally the bad fixed-prefix clustering case.

Pagination bounds **per-message** resource usage; it does not make total hot-leaf work sublinear. The total descriptor transfer remains O(hotLeafSize).

## What the benchmark excludes

The metrics exclude:

- TLS/HTTP/WebSocket framing
- authentication/signatures
- authorization/capability checks
- compression
- RTT and packet loss
- peer discovery
- payload/blob transfer
- storage I/O for a durable pinned-view backend

The benchmark also spends time constructing/searching its synthetic hot-leaf fixture. That fixture-generation time is not protocol cost.

## Security boundary

This v1 module is deliberately not safe to expose directly to an unauthenticated network.

`viewId` and page cursors identify protocol state; they do not grant access.

A production transport still needs:

- peer/device authentication
- capability/ACL enforcement
- rate limits
- request-size limits at the transport edge
- replay/session policy where appropriate
- encrypted transport, and possibly end-to-end encryption depending on architecture

Predictable fixed prefixes also remain a clustering/DoS surface. Bounded pages limit individual responses, while writer authorization/rate limits or a future adaptive/keyed tree are still required to control adversarial total work.

## Non-goals

v1 does not implement:

- HTTP or WebSocket server
- peer enrollment or device keys
- signatures/capability tokens
- E2E encryption
- peer discovery
- NAT traversal
- background sync scheduler
- mutable-document CRDTs
- record payload transfer inside reconciliation messages
- physical deletion propagation

## Result

The reconciliation layer can now discover immutable set deltas against a stable logical snapshot using bounded, transport-neutral messages and can stop/resume mid-protocol without changing the merge law.

This completes **descriptor reconciliation**, not the complete multi-device product. The next independent problem is authenticated peer/device trust and authorized record transfer over an actual transport.
