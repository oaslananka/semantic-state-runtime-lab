# Artifact Plane v1

The Artifact Plane is the immutable raw-content evidence layer for SSRL.

It exists because large source payloads and semantic state have different jobs:

```text
source systems
  -> raw artifact bytes + artifact history     (source evidence)
  -> extracted text / chunks / OCR             (derived, rebuildable)
  -> semantic observations / relations         (normalized semantic evidence)
  -> context capsules / ranking                (derived runtime materialization)
```

Markdown, email bodies, PDFs, images, audio, and future robot/device captures must not be stuffed into `SemanticStateStore` merely because an agent may need them later.

## Package boundary

`@ssrl/artifact-store` defines the backend-neutral contract.

`@ssrl/storage-local-artifacts` is the first local implementation:

```text
filesystem content-addressed storage
+ dedicated SQLite metadata/event index
```

The contract has no dependency on SQLite, MCP, or any connector.

## Blob descriptor

```ts
interface ArtifactBlobDescriptor {
  digest: ArtifactDigest;
  size: number;
  mediaType: string;
}
```

v1 local writes use SHA-256 over the **exact input bytes**:

```text
sha256:<64 lowercase hex>
```

No text normalization, newline conversion, character transcoding, decompression, OCR, or semantic transformation participates in blob identity.

This follows the OCI descriptor model: content type, content digest, and raw byte size are separate descriptor fields. SHA-256 is the required baseline verification algorithm in OCI-compatible digest semantics.

### Media type is contextual metadata

CAS identity is only digest + size. `mediaType` lives on an artifact upsert descriptor, not the deduplicated blob row.

That is intentional. The same bytes can legitimately be referenced by two sources with different media-type context without duplicating content.

v1 accepts a canonical RFC 6838-style type/subtype restricted-name form such as:

```text
text/plain
application/pdf
application/vnd.example+json
```

Parameters such as `text/plain; charset=utf-8` are not stored in the base descriptor mediaType.

## Resource identity

```ts
interface ArtifactResourceIdentity {
  sourceKey: string;
  externalType: string;
  externalId: string;
}
```

`sourceKey` is a stable **non-secret** source scope identifier. OAuth tokens, API keys, session cookies, passwords, or other credentials must never be embedded in it.

Resource identity and semantic entity identity remain separate concepts.

## Immutable mutations

Artifact history is append-only:

```ts
ArtifactMutation = ArtifactUpsert | ArtifactDelete
```

Every mutation carries:

```text
stable id
resource identity
effectiveAt   // provider/world time
recordedAt    // SSRL knowledge/receipt time
optional revision/title/sourceUri
```

An upsert additionally references a blob descriptor.

A delete is a logical tombstone only. It does not physically erase historical blob bytes.

A restore is another later upsert.

### Idempotency and collision

```text
same mutation id + same canonical mutation
  -> no-op

same mutation id + different canonical mutation
  -> ArtifactMutationCollisionError
  -> whole metadata batch rolls back
```

Mutation JSON is canonicalized before comparison and storage.

## Bitemporal artifact resolution

`resolveArtifact()` answers what resource version was valid at one world time under one knowledge cutoff.

A candidate mutation participates only when:

```text
mutation.recordedAt <= knownAt
mutation.effectiveAt <= validAt
```

Selection order is deterministic:

```text
latest effectiveAt
then latest recordedAt
then lexicographically greatest stable mutation id
```

The result is:

```text
none
present(upsert)
deleted(delete)
```

This supports late-observed historical corrections without rewriting prior history.

Example:

```text
upsert recorded Jan 2, effective Jan 1
late delete recorded May 10, effective Apr 1
```

Then:

```text
validAt Apr 15 / knownAt May 1  -> present
validAt Apr 15 / knownAt May 10 -> deleted
```

## Local CAS layout

The local backend uses:

```text
<root>/
  artifacts.sqlite
  blobs/
    sha256/
      <64 lowercase hex>
  tmp/
```

Potentially large content is not stored as primary SQLite BLOB rows.

## Crash-safe blob install

The local write path is deliberately ordered:

```text
1. compute SHA-256 + size from exact bytes
2. write a private staging file with exclusive create
3. fsync staging file
4. atomically hard-link staging file to final digest path
5. verify final path type + size + SHA-256
6. fsync the CAS parent directory where supported
7. insert/deduplicate blob metadata
8. only later allow artifact mutation metadata to reference it
```

The hard-link step is no-overwrite. If another writer wins the race, the existing target is verified rather than replaced.

On platforms where directory fsync is not exposed portably, the backend degrades to the platform's available durability semantics; it never weakens digest verification or silently overwrites content.

### Crash asymmetry is intentional

A crash can leave an unreferenced or unindexed content blob. That is safe and recoverable.

The opposite state is not acceptable through the public API:

```text
committed artifact mutation
-> missing/unverified referenced blob
```

Upsert append verifies the referenced blob before entering the SQLite metadata transaction.

## Integrity boundary

`headBlob()` is a cheap metadata/file-shape operation. It validates:

```text
metadata JSON
digest/size metadata agreement
file exists
file is a regular file
file size matches descriptor
```

It intentionally does **not** hash the full file.

`readBlobRange()` returns trusted content and therefore performs full SHA-256 verification before returning bytes.

This split makes it possible to inspect descriptors without loading a large artifact while keeping content reads fail-closed.

Read-time validation also checks that an upsert mutation's descriptor size agrees with the indexed CAS blob metadata.

## Bounded range reads

```ts
readBlobRange(digest, {
  offset?,
  length?,
  maxBytes,
})
```

The request is bounded by both:

```text
request.maxBytes
store-configured maxReadBytes
```

The smaller limit wins.

The backend never silently truncates an oversized request. It throws `ArtifactBlobReadLimitError`.

Binary payloads are returned as exact `Uint8Array` bytes without text decoding or encoding coercion.

## Portable snapshot

`ArtifactStoreSnapshot` contains only:

```text
schema
blob digest + size descriptors
artifact mutation metadata
```

It does not inline or base64-duplicate raw content bytes.

Blob export/transfer can therefore remain content-addressed and independent from portable metadata export.

## Orphan detection

v1 exposes two diagnostics:

```text
unreferencedBlobs()
  CAS blobs indexed in metadata but referenced by no artifact mutation

unindexedCasFiles()
  SHA-256 content files present on disk but absent from blob metadata
```

v1 detects but does not garbage-collect them.

GC requires explicit retention/reachability policy and remains a later concern.

## Artifact URIs

Artifact URIs are transport-neutral helpers; the Artifact Plane does not depend on MCP.

### Blob URI

```text
ssrl://artifact/blob/sha256/<digest>
```

The blob URI is naturally content-addressed and contains no source identity.

### Resource URI

```text
ssrl://artifact/resource/sha256/<fingerprint>
```

The fingerprint is SHA-256 over canonical normalized resource identity using Web Crypto.

Raw `sourceKey`, `externalType`, and `externalId` do not appear in the URI.

### Version URI

```text
ssrl://artifact/version/sha256/<fingerprint>
```

The fingerprint is SHA-256 over the canonical immutable mutation.

Raw mutation IDs, source identity, title, and source URI do not appear in the URI.

These fingerprints avoid accidental identifier/credential exposure in MCP resource URIs and logs. They are identifiers, not an encryption or secret-storage mechanism; source identities themselves must still be non-secret.

## URI catalog and access projection

LocalArtifactStore schema v2 adds rebuildable indexes from opaque resource/version URIs back to trusted internal identities/mutations. The immutable mutation log remains source of truth; catalog rows are acceleration indexes.

The catalog is deliberately separate from authorization. URI opacity reduces accidental source-identifier leakage but does not grant access. Blob digests and blob URIs are content identity, never permission identity.

`@ssrl/artifact-access` now provides the policy/bounds/audit gateway above the Artifact Plane, and `@ssrl/mcp-server` projects policy-approved resources as text or exact base64 content. MCP cache TTL/scope remains a serving-layer concern. See `docs/artifact-access-gateway-v1.md`.

## HTTP integrity compatibility

RFC 9530 distinguishes digesting exact HTTP message content (`Content-Digest`) from digesting a selected representation (`Repr-Digest`).

Artifact CAS identity is deliberately closer to exact-content identity: the digest is over stored bytes. A future HTTP adapter may expose RFC 9530 fields, but it must not silently reinterpret the CAS digest as a transformed representation digest.

## Derived representations are not source of truth

Future extraction should be keyed by immutable source evidence and algorithm/version identity, for example:

```text
extracted text
  key = source blob digest + extractor/version

chunks
  key = extracted representation digest + chunker/version

embeddings
  key = chunk/representation digest + embedding model/version
```

OCR, summaries, embeddings, chunks, and indexes must remain rebuildable.

Semantic claims can cite artifact mutation/blob evidence but should not duplicate large raw payloads into semantic state.

## Verified v1 behavior

Tests cover:

- byte-identical CAS dedup across unrelated resources with different MIME descriptors;
- exact mutation replay no-op and collision rollback;
- update/delete/restore bitemporal resolution;
- late-observed historical deletion;
- deterministic same-clock tie breaking;
- close/reopen deterministic metadata snapshot;
- arbitrary binary byte round-trip;
- exact bounded range reads and max-byte enforcement;
- same-size byte corruption detected by digest verification;
- missing blob fail-closed;
- existing corrupt CAS path never overwritten;
- mutation cannot reference an absent blob;
- failed mutation batch leaves safe/detectable unreferenced blobs;
- unindexed CAS file detection;
- newer schema fail-closed;
- corrupted mutation JSON fail-closed;
- mutation descriptor size vs CAS metadata corruption fail-closed;
- snapshot metadata contains no inline raw bytes;
- opaque deterministic blob/resource/version URI helpers.

## Deliberate non-goals

v1 does not implement:

- Gmail/Drive/Notion adapters;
- streaming blob writes;
- OCR/PDF/image/audio extraction;
- HTML sanitization;
- FTS/vector indexes;
- embeddings or LLM summaries;
- distributed blob replication;
- S3/cloud object storage;
- encryption/key management;
- legal/physical erasure and retention policy;
- automatic orphan garbage collection;
- artifact-level ACL/policy projection;
- MCP resource serving itself.

Streaming writes are a likely follow-up before very large video/audio/device payloads become a primary workload. The v1 write API accepts one artifact as `Uint8Array`; the architecture intentionally avoids pretending that is sufficient forever.

## Standards alignment

The design is informed by:

- MCP `2026-07-28`: resources remain a first-class data surface and resource/list/read results can carry cache guidance;
- OCI Content Descriptors: media type, digest, and raw byte size are distinct; SHA-256 verification is the required baseline;
- RFC 9530: exact content integrity and representation integrity are separate concepts.

The Artifact Plane adopts those useful invariants without making any of those protocols the internal product API.
