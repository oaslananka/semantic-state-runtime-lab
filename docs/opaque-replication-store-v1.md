# Durable Opaque Replication Store v1

The opaque replication store is the persistence boundary for an **untrusted ciphertext relay**.

The relay can reconcile and transfer encrypted objects without learning the plaintext replication record key, record ID, payload digest, artifact digest, source path, or payload contents.

```text
trusted device
  -> encrypt replication record / artifact blob
  -> EncryptedReplicationObject
        |
        v
OpaqueReplicationObjectStore       <- protocol-neutral contract
        |
        v
LocalOpaqueReplicationStore        <- SQLite metadata + canonical encrypted body files
        |
        +-> epoch descriptor catalog
                |
                v
       opaque Merkle / bounded reconciliation
```

The relay never receives a vault epoch secret and never calls a decrypt function.

## Identity

A durable opaque object is identified by the tuple:

```text
(epochId, opaqueKey)
```

`opaqueKey` is deliberately **not** treated as globally unique across epochs.

This matters even though honest HMAC-derived keys colliding across epochs is extraordinarily unlikely: the storage contract must encode its actual cryptographic scope rather than relying on probability.

## Protocol-neutral contract

`@ssrl/opaque-replication-store` defines:

```ts
interface OpaqueReplicationObjectStore {
  install(object): Promise<OpaqueObjectInstallResult>;
  descriptor(locator): Promise<OpaqueReplicationDescriptor | undefined>;
  readObject(locator, options?): Promise<EncryptedReplicationObject>;
  descriptorPage(request): Promise<OpaqueDescriptorCatalogPage>;
}
```

The contract is independent of SQLite/filesystem layout so a future cloud object-store backend can preserve the same collision, cursor, read-limit, and catalog semantics.

Standalone opaque tags are runtime-validated through the same `normalizeOpaqueReplicationTag()` implementation used by encrypted descriptor parsing. Branded TypeScript strings are not treated as runtime validation.

## First committed body wins

The descriptor is deterministic for one logical encrypted content identity, but AES-GCM encryption is randomized.

Two trusted devices can therefore independently produce:

```text
same epochId
same opaqueKey
same opaqueContentTag
same descriptor fingerprint
DIFFERENT nonce/ciphertext envelope
```

That is not a semantic collision.

The v1 store uses this rule:

```text
first structurally valid ciphertext body committed for a descriptor wins
```

Later installs with the exact same descriptor are descriptor-idempotent no-ops even if their randomized envelope differs. The store never replaces the first body.

This avoids false multi-device conflicts while also avoiding last-writer-wins ciphertext mutation.

### True collision

For the same `(epochId, opaqueKey)`:

- different `opaqueContentTag` -> `OpaqueReplicationCollisionError`
- same content tag but inconsistent descriptor metadata -> encrypted descriptor validation failure

The existing committed object remains unchanged.

## Relay validation boundary

Before persistence, the store uses existing encrypted replication validation:

- encrypted-object schema
- descriptor schema
- epoch ID
- object kind
- opaque key/content tag format
- descriptor fingerprint
- envelope identity agreement
- ciphertext/plaintext byte accounting
- canonical JSON on committed bodies

The relay **cannot** verify the AES-GCM authentication tag without the epoch secret. That is intentional. A relay-side structurally valid object is not a claim that the ciphertext decrypts successfully on a trusted device.

Trusted readers still perform authenticated decryption after transfer.

## Local backend

`@ssrl/storage-local-opaque-replication` stores:

```text
<root>/opaque-replication.sqlite
<root>/objects/sha256/<2 hex>/<62 hex>.json
<root>/tmp/<random>.json
```

The object filename is:

```text
SHA-256(canonical JSON [epochId, opaqueKey])
```

It therefore contains no plaintext replication identity.

The body file is the existing canonical `EncryptedReplicationObject` JSON. v1 deliberately does not invent another ciphertext encoding.

### SQLite metadata

The `STRICT` metadata table stores only public opaque descriptor/storage integrity fields:

- epoch ID
- opaque key
- opaque content tag
- object kind
- ciphertext byte count
- descriptor fingerprint
- locator-derived storage key
- canonical body JSON byte count
- SHA-256 of the ciphertext-envelope body file
- canonical opaque descriptor JSON

It does **not** store plaintext record or artifact metadata.

## Crash ordering

Install order is:

```text
normalize + validate object
  -> write random temp file (0600)
  -> fsync temp
  -> hard-link temp to final locator path (exclusive)
  -> fsync containing directory when supported
  -> parse/validate the actual final body
  -> insert SQLite metadata
```

The important invariant is:

```text
metadata never becomes visible before a body exists
```

If the process crashes after linking the body but before metadata commit, an orphan file can remain. It is invisible to the public store API.

A later equivalent install can recover that orphan by validating the final body and committing metadata for the **actual body that won the final path**, including its actual byte count and digest.

This last detail is important because an equivalent retry may contain a different randomized AES-GCM envelope.

## Corruption behavior

Reads fail closed when:

- metadata exists but the body is missing
- body path is not a regular file
- physical byte count differs from DB metadata
- ciphertext body SHA-256 differs
- body is invalid UTF-8/JSON
- body JSON is structurally valid but non-canonical
- encrypted object validation fails
- body descriptor disagrees with SQLite descriptor metadata
- SQLite canonical descriptor disagrees with its indexed columns

An orphan body without metadata returns not-found through the public object API; it is a future garbage-collection candidate.

## Descriptor catalog

The relay exposes descriptors separately from ciphertext bodies.

Catalog properties:

- required epoch scope
- ordered by `opaqueKey`
- bounded descriptor count
- bounded canonical descriptor bytes
- no ciphertext body in a page
- descriptor-byte accounting uses canonical opaque descriptor JSON

A descriptor that cannot fit into an otherwise-empty requested byte page fails with `OpaqueDescriptorCatalogEntryTooLargeError` rather than returning a non-advancing empty page.

## Cursor integrity

Catalog cursors are opaque branded strings.

The local store persists:

```text
catalog_id
random 256-bit cursor_secret
```

A cursor authenticates canonical:

```text
[catalog_id, epochId, lastOpaqueKey]
```

with HMAC-SHA-256.

Consequences:

- cursor from another store fails
- cursor used against another epoch fails
- client-edited/forged last key fails
- unknown/stale last key fails

The cursor is navigation state, not an authorization credential. HTTP authorization will be a separate trusted-device/vault/epoch layer.

## Merkle integration

The descriptor catalog is the persistence bridge to the opaque reconciliation engine:

```text
descriptorPage(epoch)
  -> descriptors
  -> buildOpaquePrefixMerkleIndex(descriptors, { epochId })
  -> FrozenOpaquePrefixMerkleView / bounded opaque session
```

Tests prove that closing/reopening the repository and re-reading descriptors produces the exact same opaque Merkle snapshot/root.

Object bodies are never included in the descriptor catalog or Merkle snapshot.

## Physical leakage test

The test suite scans persisted DB/body files and filenames for fixture plaintext values including:

- secret record ID
- secret semantic value
- plaintext `ReplicationRecord.key`
- plaintext `payloadDigest`
- plaintext entity ID
- artifact plaintext digest/content

Those values must not appear.

Allowed v1 relay leakage remains the already-documented opaque protocol surface:

- epoch ID
- object kind
- opaque key
- opaque content tag
- ciphertext byte count
- descriptor fingerprint
- ciphertext/envelope bytes when an object is transferred
- timing and size/access patterns

## Resource bounds

The contract/backend bound:

- stored encrypted-object JSON bytes
- read bytes
- catalog descriptors per page
- catalog canonical descriptor bytes per page

Reads inspect committed metadata size before loading the body into memory.

## 100k catalog benchmark

`pnpm benchmark:replication:opaque-store:v1` seeds **100,000 valid synthetic opaque descriptors** directly into the local metadata schema and consumes them exclusively through the public `descriptorPage()` API.

The benchmark intentionally does not generate 100,000 ciphertext bodies; it isolates descriptor-catalog pagination rather than crypto/upload throughput.

Initial local checkpoint (2026-09-26):

```text
records                 100,000
max descriptors/page        256
max bytes/page           262,144
pages                        391
max descriptors seen         256
max bytes seen            101,632
```

The observed local traversal time is emitted by the benchmark for regression tracking, but v1 makes no product latency/SLA claim from this synthetic run.

## Deliberate non-goals

v1 does not implement:

- HTTP relay endpoints
- device/vault/epoch authorization
- semantic `ReplicationAccessGateway` policy on the relay
- relay-side decryption
- cross-epoch deduplication
- delete mutation
- retention/garbage collection
- quotas/billing
- persisted incremental Merkle trees
- S3/R2/cloud object-store adapter
- metadata padding/access-pattern hiding

## Next step

The next layer should be an authenticated opaque relay service:

```text
existing device-bound request signatures / trust registry
        +
epoch capability/authorization
        +
LocalOpaqueReplicationStore
        +
opaque reconciliation views
        -> HTTP
```

It must not reuse the plaintext semantic `ReplicationAccessGateway` as though the relay could inspect semantic records.
