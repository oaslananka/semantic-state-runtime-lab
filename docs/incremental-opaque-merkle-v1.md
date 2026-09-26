# Durable Incremental Opaque Merkle Views v1

The durable opaque object store is the source of truth for relay-visible encrypted object descriptors. Rebuilding an in-memory Merkle tree from the full descriptor catalog every time a remote reconciliation view opens is correct, but it makes steady-state work proportional to the vault's lifetime object count.

v1 adds a rebuildable derived Merkle layer:

```text
OpaqueReplicationObjectStore
  -> transactional descriptor change feed
  -> SQLiteOpaqueMerkleViewStore
       - durable descriptor projection
       - versioned Merkle node hashes
       - per-epoch head/version/root
       - source checkpoint
  -> frozen SQL-backed reconciliation view
  -> existing OpaqueBoundedReconciliationSession
```

The derived database contains no ciphertext bodies and no plaintext semantic metadata. It can be discarded and rebuilt from the opaque object store.

## Descriptor change feed

`OpaqueReplicationObjectStore` now exposes:

```ts
descriptorChangesAfter(request?): Promise<OpaqueDescriptorChangePage>
```

The feed is global across epochs and ordered by an internal monotonic sequence. A change is emitted only when a new `(epochId, opaqueKey)` object is actually inserted.

Semantics:

- exact descriptor replay -> no new change;
- colliding/failed install -> no orphan change;
- object metadata and its change row commit in the same SQLite transaction;
- pages are bounded by descriptor count and canonical descriptor bytes;
- a descriptor too large for an empty requested page fails instead of returning a non-advancing page.

### Store-bound head cursor

Even an empty feed returns an opaque HMAC-authenticated **sequence-0 head cursor**.

This is not a synthetic change. It binds a consumer to the identity of the source store before the first object exists.

Consequences:

- reopen against the same empty source succeeds;
- a cursor from another store fails;
- tampered cursors fail;
- a never-emitted positive sequence fails;
- a derived Merkle DB cannot silently attach to a different source merely because the original source was empty.

Existing positive-sequence cursors remain compatible.

## Local opaque store schema v2

The local opaque store adds `opaque_replication_changes` to the existing metadata database.

The v1 -> v2 migration:

1. creates the change table;
2. copies existing canonical descriptor rows in deterministic SQLite BINARY order by `epoch_id, opaque_key`;
3. preserves the existing `catalog_id` and cursor secret;
4. updates the component-scoped schema marker atomically.

This means a consumer can start from the change feed after migration without separately scanning the old descriptor catalog.

## Derived Merkle database

`@ssrl/storage-sqlite-opaque-merkle` is a derived/rebuildable backend implementing the protocol-neutral `OpaqueMerkleViewProvider` contract.

It persists:

```text
opaque_merkle_meta
opaque_merkle_source_state
opaque_merkle_epoch_heads
opaque_merkle_descriptors
opaque_merkle_node_versions
```

Per epoch, the head stores:

```text
prefixBits
currentVersion
recordCount
rootDigest
```

Descriptors store their leaf ID, the epoch-local version at which they were inserted, and a derived deterministic `sort_key` for bounded SQL leaf pagination.

### Deterministic opaque descriptor ordering

The v1 in-memory Merkle implementation originally inherited JavaScript `localeCompare()` ordering for opaque keys. SQLite BINARY ordering is different for base64url text, and a full-suite reconciliation run exposed that mismatch as a non-canonical leaf page.

The protocol now makes the established v1 opaque-tag order explicit via `compareOpaqueReplicationTags()` and `opaqueReplicationTagOrderKey()`. The order key is derived only from the fixed 43-character base64url HMAC tag suffix, preserves the existing v1 ordering, and is sortable with SQLite BINARY collation.

The compatibility test enumerates 4,096 valid tags covering every first-12-bit combination and requires all three orders to match exactly:

```text
legacy v1 localeCompare order
== explicit opaque comparator
== persisted SQLite sort_key order
```

The generic plaintext Merkle codec is unchanged.

Node hashes are append-versioned by:

```text
epochId + level + nodeIndex + version
```

A frozen view can therefore ask for the newest node hash with `version <= capturedVersion` without cloning the whole tree.

## Bootstrap path

When the derived store has not been initialized:

1. consume the source change feed in bounded pages;
2. group descriptors by epoch;
3. build one normal `OpaquePrefixMerkleIndex` per epoch;
4. derive canonical descriptors, leaf IDs, and only the node hashes reachable from non-empty leaves;
5. persist epoch heads, descriptors, and node hashes in one bulk SQLite transaction;
6. advance the source checkpoint only with the committed materialization.

Historical bootstrap intentionally does **not** perform one SQLite transaction and one O(log N) path update per descriptor.

If the source is empty, the sequence-0 head cursor is still persisted, binding the derived DB to that source.

## Incremental catch-up

After bootstrap, catch-up consumes only changes after the persisted source cursor.

For one new descriptor:

```text
normalize descriptor
  -> compute leaf id
  -> read current descriptors in that leaf
  -> compute new canonical leaf hash
  -> walk one ancestor path
       each sibling hash = latest version <= current epoch version
       missing sibling = deterministic empty-subtree hash
  -> append descriptor at next epoch version
  -> append changed leaf + ancestor node versions
  -> update epoch head
```

With `prefixBits = B`, one insert writes exactly `B + 1` node versions.

The incremental root is required to be byte-identical to a full `buildOpaquePrefixMerkleIndex()` rebuild.

### Crash/replay semantics

Descriptor materialization commits before the source checkpoint advances.

If the process crashes after derived data commits but before the checkpoint update, replay sees the same descriptor already present, validates exact descriptor identity, performs no second Merkle mutation, and then advances the checkpoint.

Normal reopen resumes from the persisted checkpoint and reads zero historical descriptors when no source changes exist.

A persisted source cursor that belongs to another source is translated into `OpaqueMerkleSourceCheckpointError`; the derived DB must be rebuilt rather than silently rebound.

## Frozen SQL-backed views

`openView(epochId)` first performs bounded catch-up and then captures only:

```text
epochId
currentVersion
rootDigest
recordCount
prefixBits
viewId
expiry
cursor secret
```

It does not rebuild or clone the descriptor catalog.

For a frozen view:

- `nodeHashes()` reads the newest node version not newer than the captured epoch version;
- missing nodes use deterministic empty-subtree hashes;
- `leafPage()` returns only descriptors whose `insertedVersion <= capturedVersion`;
- later source inserts and derived catch-up do not change that view.

The view registry is in-memory, TTL-bounded, and count-bounded. The Merkle state itself remains durable in SQLite.

## Leaf cursor integrity

SQL-backed leaf cursors are HMAC-bound to canonical:

```text
viewId
epochId
rootDigest
leafId
afterKey
```

Validation rejects:

- another view;
- another leaf;
- edited/tampered cursors;
- a cursor key absent from the captured frozen leaf/version.

The cursor is navigation state, not authorization. Authenticated relay HTTP is a separate layer.

## Existing reconciliation engine remains unchanged

The SQL-backed provider satisfies the existing `OpaqueReconciliationEndpoint` contract.

`OpaqueBoundedReconciliationSession` can reconcile against it without a new reconciliation algorithm.

The Merkle hashing primitives used by the materializer are exported narrowly from the existing generic Merkle implementation:

- opaque leaf ID;
- canonical leaf hash;
- parent hash;
- deterministic empty-subtree hash chain.

Tests require persisted/bootstrap/incremental hashes to match the normal in-memory opaque Merkle index exactly.

## Corruption and privacy boundary

Derived reads revalidate canonical descriptors against indexed columns, including the persisted opaque `sort_key`, and validate persisted Merkle hash formats. Epoch-head `rootDigest` is also compared in O(1) against the versioned persisted root node before a view is opened, so a well-formed but incorrect head hash fails closed without a full-tree rebuild.

The derived database must not contain fixture plaintext such as:

- semantic record IDs;
- entity IDs;
- property names;
- provider names;
- plaintext values;
- plaintext artifact digests;
- replication payload bodies;
- vault epoch secrets.

It contains only relay-visible opaque descriptor material, Merkle structure, source cursor/checkpoint state, and random local view/cursor secrets.

## 100k incremental benchmark

`pnpm benchmark:replication:opaque-incremental-merkle:v1` uses **100,000** synthetic canonical opaque descriptors with `prefixBits = 12`.

The source fixture is populated separately from the measured materializer phases so crypto/upload/body persistence is not conflated with Merkle work.

Local checkpoint on 2026-09-26:

```text
records                                  100,000
prefix bits                                   12
bootstrap pages                               25
bootstrap descriptors                    100,000
source population                       17.785 s
one-time derived bootstrap              26.614 s

no-change catch-up                       0.173 ms
no-change openView                       0.232 ms
steady-state full catalog calls                  0
steady-state descriptors read                    0

single new descriptor catch-up          30.752 ms
single change descriptors read                   1
single change node versions                     13
expected path nodes                             13

reference full in-memory rebuild          5.424 s
incremental root == full rebuild               true
```

Interpretation:

- one-time bootstrap is still O(N) and intentionally reported separately;
- steady-state view-open no longer scans the lifetime catalog;
- one new descriptor updates one leaf/ancestor path rather than rebuilding 100k descriptors;
- the benchmark proves the shape of work, not a production latency SLA;
- timings are local synthetic measurements and should be treated as regression checkpoints only.

## Deliberate non-goals

v1 does not implement:

- authenticated public relay HTTP;
- vault/epoch authorization in the Merkle provider;
- distributed/multi-process materializer leadership;
- descriptor deletion/tombstones;
- node-version compaction;
- remote/public exposure of the source change feed;
- a cloud database backend;
- a performance SLA.

## Next step

The next relay checkpoint can place existing trusted-device request authentication and vault/epoch authorization in front of these bounded opaque operations:

```text
signed trusted-device request
  -> active trusted-device key binding
  -> vault/epoch grant authorization
  -> openView / nodeHashes / leafPage / opaque object read-write
```

The relay can remain unable to decrypt semantic or artifact payloads while avoiding O(N) Merkle rebuilds for ordinary reconciliation requests.
