# Opaque Merkle Reconciliation v1

SSRL's encrypted replication codec produces relay-safe object descriptors, but encryption alone is insufficient if the reconciliation protocol still exposes plaintext record metadata.

This checkpoint moves prefix-Merkle inventory and bounded reconciliation onto a descriptor-generic engine and adds an epoch-scoped opaque adapter.

```text
authorized client
  plaintext ReplicationRecord / artifact blob
        ↓ #86
  randomized encrypted object
  + OpaqueReplicationDescriptor
        ↓ #87
  opaque Prefix-Merkle inventory
        ↓
  bounded node walk + leaf paging
        ↓
  opaque local/remote delta or collision
        ↓
  future ciphertext object transfer
```

The Merkle/session layer never needs the vault epoch secret. It only consumes already-derived public opaque descriptors.

## Descriptor-generic core

The Merkle engine now depends on a small internal descriptor codec rather than on `ReplicationRecordDescriptor` fields:

```ts
interface MerkleDescriptorCodec<D, K extends string, C> {
  normalize(descriptor: D): Promise<D>;
  key(descriptor: D): K;
  scope(descriptor: D): string;
  canonicalValue(descriptor: D): unknown;
  compareSameKey(left: D, right: D): { collision?: C };
  collisionError(collision: C): Error;
  invalid(message: string): Error;
  scopeMismatch(left: string, right: string): Error;
  collisionKey(collision: C): K;
}
```

The same generic implementation owns:

- leaf assignment;
- leaf and parent hashing;
- deterministic snapshots;
- incremental add;
- tree comparison;
- frozen views;
- HMAC-protected leaf cursors;
- descriptor/byte-bounded paging;
- resumable bounded node/leaf reconciliation;
- session resource caps and counters.

There is not a second opaque-only reconciliation algorithm.

## Plaintext compatibility wrapper

The existing public plaintext APIs remain:

```text
PrefixMerkleIndex
FrozenPrefixMerkleView
BoundedReconciliationSession
ReconciliationEndpoint
```

The plaintext adapter uses a fixed internal scope:

```text
ssrl-plaintext-replication-v1
```

That scope is not added to the existing plaintext public view/wire shape.

The adapter preserves the existing descriptor canonical material and the existing Merkle hash domains:

```text
ssrl-prefix-merkle-leaf-v1
ssrl-prefix-merkle-node-v1
```

The pre-existing plaintext Merkle and bounded-sync suites continue to pass, including the 100k-small-delta reconciliation test. This is the compatibility check for root/snapshot/session behavior.

## Opaque Prefix-Merkle

`OpaquePrefixMerkleIndex` consumes only `OpaqueReplicationDescriptor`:

```text
epochId
objectKind
opaqueKey
opaqueContentTag
ciphertextBytes
fingerprint
```

The identity key is `opaqueKey`.

Leaf hashing commits to the entire canonical opaque descriptor, not only the key or content tag.

### Collision law

Inside one epoch:

```text
same opaqueKey + exact same descriptor
  -> idempotent / equal

same opaqueKey + different opaqueContentTag
  -> OpaqueReplicationCollision

same opaqueKey + same content tag + inconsistent metadata
  -> validation failure

different opaqueKey
  -> ordinary local/remote delta
```

There is no last-write-wins rule.

## Epoch scope is a correctness boundary

Opaque keys are intentionally epoch-scoped because #86 derives them from the epoch secret.

Therefore two different epoch views are **not comparable inventories**.

If epoch A and epoch B were compared as ordinary trees, the same logical records would have unrelated opaque keys and could appear as a complete delete/add set. v1 rejects this explicitly with `OpaqueReplicationEpochMismatchError` before reconciliation work begins.

Rules:

- a non-empty opaque index must contain descriptors from exactly one epoch;
- an empty opaque index requires an explicit `epochId`;
- adding a descriptor from another epoch fails before root mutation;
- comparing indexes from different epochs fails;
- starting a bounded session across different epochs fails before node walking;
- snapshot restore preserves the epoch scope.

Cross-epoch deduplication is deliberately not attempted.

## Relay-visible snapshot

An opaque Merkle snapshot may reveal only already-documented relay metadata plus Merkle structure:

```text
epochId
objectKind
opaqueKey
opaqueContentTag
opaque descriptor fingerprint
ciphertextBytes
leaf ids / record counts
Merkle hashes
```

It does not contain:

```text
ReplicationRecord.kind
recordId
plaintext ReplicationRecord.key
payloadDigest
plaintext artifact digest
payload body
ciphertext body
```

Ciphertext transfer/storage is a separate layer. The inventory tree should not duplicate encrypted payloads in every snapshot or leaf page.

## Frozen opaque views and leaf cursors

`FrozenOpaquePrefixMerkleView` pins a rebuilt snapshot of an opaque index before reconciliation.

Later mutation of the live index therefore cannot silently rebase the view.

Leaf paging keeps the existing resource bounds:

- descriptor count limit;
- serialized descriptor byte limit;
- HMAC-protected cursor;
- cursor bound to schema, scope, view ID, root and leaf ID;
- cursor must point to a key still present in that frozen leaf.

A cursor from another frozen view fails closed.

## Bounded opaque reconciliation

`OpaqueBoundedReconciliationSession` is a thin adapter over the same generic state machine used by plaintext reconciliation.

Its result contains only:

```ts
interface OpaqueReconciliationResult {
  localOnly: readonly OpaqueReplicationTag[];
  remoteOnly: readonly OpaqueReplicationTag[];
  collisions: readonly OpaqueReplicationCollision[];
  counters: ReconciliationCounters;
}
```

The state machine keeps the existing protections:

- bounded node refs per step;
- bounded leaf descriptors and bytes;
- bounded pending work;
- max-step budget;
- stale-view checks;
- deterministic leaf merge;
- pause / canonical encode / restore / resume.

Encoded opaque session state can contain opaque descriptors while a hot leaf is partially buffered, but it does not contain plaintext replication metadata or ciphertext bodies.

## 100k protocol-work benchmark

`pnpm benchmark:replication:opaque:v1` deliberately isolates Merkle/session work from cryptographic derivation cost.

The 100k fixture uses structurally valid deterministic opaque relay descriptors. HMAC/HKDF/AES behavior is separately tested and byte-accounted by the encrypted-replication checkpoint.

Observed local checkpoint result on 2026-09-26:

```text
records                         100,000
small delta                      10 + 10
prefix leaves                     4,096
remote node hashes examined         283
remote leaf descriptors examined     490
remote leaf bytes                195,040
leaf-descriptor fraction           0.5%
node-hash / leaf-count fraction     6.9%
```

Typical descriptor sample in that fixture:

```text
plaintext descriptor average      334 B
opaque descriptor average         397 B
opaque/plaintext ratio            1.189x
```

Interpretation:

- the opaque adapter preserves the intended touched-region behavior for a small delta;
- opaque public descriptors are moderately larger in this fixture;
- these numbers are serialized-byte and protocol-work accounting only;
- they are **not** a network latency, CPU throughput, bandwidth-compression, or cloud-cost claim.

The existing plaintext 100k bounded reconciliation test also passes after the generic-core refactor.

## Durable incremental view follow-up

`incremental-opaque-merkle-v1.md` adds a SQLite-backed versioned Merkle materializer behind this same `OpaqueReconciliationEndpoint` contract. It consumes a transactional opaque descriptor change feed, preserves frozen-view semantics without cloning the full index, and updates one Merkle path per new descriptor. The bounded reconciliation state machine described here remains unchanged.

The durable implementation also makes opaque-key ordering an explicit protocol primitive instead of relying on runtime locale collation. A persisted SQL sort key preserves the established v1 order while keeping leaf pagination bounded and deterministic.

## What this does not solve

v1 does not implement:

- authenticated public relay HTTP routes for opaque inventory/object transfer;
- vault-keyring lookup inside the relay;
- cross-epoch reconciliation;
- historical epoch re-encryption;
- metadata padding;
- access-pattern hiding;
- traffic-analysis resistance;
- record/blob application after transfer;
- replication authorization changes.

The relay still learns the leakage documented by `opaque-encrypted-replication-v1.md`, plus Merkle/page access patterns and tree counts.

## Next step

The durable opaque object store and incremental SQL-backed Merkle views now provide the persistence/reconciliation substrate. The next untrusted-cloud checkpoint should expose them only behind authenticated vault/epoch authorization:

```text
authorized client
  -> opaque view/session requests
  -> untrusted relay stores opaque descriptors + ciphertext objects
  -> opaque delta
  -> ciphertext fetch/push
  -> authorized client decrypts + recomputes descriptor
  -> existing semantic/artifact apply path
```

A relay API should never accept plaintext `ReplicationRecordDescriptor` for an E2E vault and then claim to be metadata-opaque.
