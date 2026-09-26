# Relay-safe opaque encrypted replication objects v1

This layer is the cryptographic object-identity boundary between SSRL's plaintext immutable replication model and a future untrusted relay/cloud.

It answers a narrow question:

> How can an untrusted relay store, compare and transfer encrypted immutable objects without learning the underlying SSRL record key, semantic kind, record ID, plaintext digest, artifact digest, or payload?

It does **not** make the relay metadata-blind.

## Layering

```text
canonical SSRL ReplicationRecord / artifact bytes
        ↓
authorized VaultEpochSecret
        ↓
epoch-derived opaque reconciliation identity
        +
randomized AES-256-GCM payload envelope
        ↓
relay-safe public object

vault-keyring
  -> decides which epoch/grants are authorized

@ssrl/e2e
  -> provides VaultEpochSecret + randomized AEAD envelope primitives

@ssrl/replication/encrypted
  -> binds SSRL immutable-record semantics to opaque relay identity
```

The encrypted replication codec takes an already-authorized `epochId + VaultEpochSecret`. It does not decide which vault epoch is authoritative and does not accept arbitrary recipient grants.

## Why current plaintext descriptors cannot go to an untrusted relay

The existing local/trusted replication descriptor intentionally contains:

- canonical `ReplicationRecord.key`;
- record kind;
- record ID;
- plaintext payload SHA-256;
- plaintext payload byte count.

Those fields are appropriate inside authorized SSRL nodes, but they reveal too much to a managed relay.

A public plaintext SHA-256 is especially problematic for low-entropy semantic records. A relay can guess candidate values offline and compare hashes without possessing any user secret.

The encrypted relay descriptor therefore contains no unkeyed plaintext digest.

## Epoch-derived index key

The raw vault epoch secret is not used directly as an HMAC key.

v1 derives a 256-bit HMAC-SHA256 key using HKDF-SHA256:

```text
IKM  = VaultEpochSecret
salt = "ssrl-opaque-replication-index-salt-v1"
info = "ssrl-opaque-replication-index-key-v1"
```

The derived key is used only for opaque reconciliation tags.

Payload encryption remains in `@ssrl/e2e` and derives its own AES key with a separate salt/info domain.

## Opaque record identity

For a verified canonical immutable `ReplicationRecord`:

```text
opaqueKey =
  HMAC(indexKey,
       canonical(["ssrl-opaque-replication-tag-v1",
                  "record-key",
                  ReplicationRecord.key]))

opaqueContentTag =
  HMAC(indexKey,
       canonical(["ssrl-opaque-replication-tag-v1",
                  "record-content",
                  plaintext payloadDigest]))
```

Both are encoded as:

```text
hmac-sha256:<unpadded-base64url-32-bytes>
```

Domain separation prevents a record key tag, record content tag, blob key tag and blob content tag from being interchangeable.

## Collision law

Within one vault epoch:

```text
same immutable logical key + same canonical plaintext
  -> same opaqueKey
  -> same opaqueContentTag

same immutable logical key + different canonical plaintext
  -> same opaqueKey
  -> different opaqueContentTag
  -> immutable-record collision

different logical key
  -> different opaqueKey, except negligible cryptographic collision
```

This preserves SSRL's existing rule:

> Same immutable key with different content is a collision; never silently last-write-wins.

The relay can detect that two public descriptors disagree for one opaque key without learning what the underlying semantic key or content was.

## Randomized ciphertext is deliberately separate from reconciliation identity

Payload encryption remains randomized AES-256-GCM through `encryptPayload()`.

Every encryption uses a fresh random nonce.

Therefore encrypting the exact same logical record twice under the same epoch gives:

```text
same opaque descriptor
different nonce
different ciphertext
```

This is intentional.

SSRL does **not** derive an AES-GCM nonce from record identity or content. Deterministic nonce shortcuts would create avoidable nonce-reuse/cross-domain cryptographic risk.

The stable reconciliation identity comes from keyed HMAC tags, not deterministic ciphertext.

### Relay representative semantics

Two valid ciphertext envelopes may therefore share one opaque descriptor.

A future relay store may deduplicate/select one ciphertext representative for an opaque descriptor, but the relay cannot prove that ciphertext decrypts to the intended SSRL record because it does not possess the epoch secret.

Authorized clients remain the integrity boundary:

- decrypt the selected ciphertext;
- verify the canonical ReplicationRecord or artifact digest;
- recompute the opaque descriptor;
- reject any mismatch.

A corrupted or malicious relay ciphertext is an availability/integrity failure for that fetch. It is never accepted as a different semantic value and never invokes last-write-wins.

## Public descriptor

`OpaqueReplicationDescriptor` contains:

```text
schema
epochId
objectKind                 # replication-record | artifact-blob
opaqueKey
opaqueContentTag
ciphertextBytes
fingerprint
```

The fingerprint is an ordinary SHA-256 over the already-opaque canonical public descriptor material. It provides structural integrity/accounting convenience; it is not a secret authenticator.

The descriptor intentionally has no:

- plaintext replication key;
- semantic kind;
- record ID;
- plaintext payload digest;
- artifact SHA-256;
- source-system identifier;
- plaintext payload.

## Encrypted object

`EncryptedReplicationObject` contains:

```text
schema
opaque descriptor
EncryptedPayloadEnvelope
```

The existing E2E envelope binds through AEAD additional data:

- E2E schema and suite;
- epoch ID;
- coarse object class;
- `objectId = opaqueKey`;
- plaintext byte count.

The descriptor cross-checks the envelope's epoch, object class, opaque object ID and ciphertext byte count before decryption.

## Authorized record verification

After an authorized device obtains the epoch secret from the authenticated vault keyring, `decryptReplicationRecord()` performs:

1. strict public descriptor validation;
2. strict E2E envelope validation;
3. descriptor/envelope identity cross-check;
4. AES-GCM authenticated decryption;
5. UTF-8 + exact-field JSON parsing;
6. canonical `ReplicationRecord` verification using the existing replication integrity rules;
7. rejection of noncanonical replication-record JSON;
8. recomputation of `opaqueKey` and `opaqueContentTag`;
9. exact descriptor comparison.

A relay-provided ciphertext is never sufficient authority to apply semantic state.

## Artifact blob identity

Artifact blobs use separate HMAC domains:

```text
blob-key
blob-content
```

The local plaintext SHA-256 digest is used as secret input to the HMAC computation, but that SHA-256 is never exposed in the relay descriptor.

On decrypt, the authorized SSRL node:

1. decrypts bytes;
2. verifies them against the expected plaintext artifact SHA-256 learned through trusted/decrypted metadata;
3. recomputes the opaque blob descriptor.

The same artifact digest under the same epoch has a stable opaque identity. Rotating the vault epoch produces a different public opaque identity.

## Epoch rotation

Opaque identifiers are intentionally epoch-scoped.

A new vault epoch changes the HMAC key, so newly encrypted objects do not retain cross-epoch public equality.

Historical encrypted objects remain under their historical epoch and can be recovered through historical key grants.

v1 does not require whole-vault re-encryption during rotation.

This trades public cross-epoch deduplication for less relay-visible linkage.

## What the relay still learns

v1 explicitly leaks:

- vault epoch identifier;
- coarse object class: record vs blob;
- encrypted/plaintext-equivalent length through envelope accounting;
- object count;
- equality of the same opaque identity within one epoch;
- access timing/frequency;
- network-level metadata outside this codec.

Future work may add:

- padding/size buckets;
- opaque epoch aliases;
- access-pattern mitigation;
- private-set-intersection style discovery;
- stronger metadata-private storage protocols.

Until then, SSRL must not describe this layer as complete metadata privacy, anonymous storage, ORAM, private search, or a universal "zero-knowledge" relay.

## Parser and bound posture

Public JSON parsers:

- reject unknown/missing fields;
- validate supported schemas;
- validate epoch IDs;
- require canonical fixed-size HMAC tags;
- validate descriptor fingerprint;
- enforce E2E envelope size limits;
- cross-check descriptor and envelope byte accounting.

The underlying E2E plaintext ceiling remains 64 MiB in v1.

## Tests

The focused suite proves:

- canonical record encrypt/decrypt round-trip;
- repeat encryption changes nonce/ciphertext but not opaque descriptor;
- same logical key + divergent payload produces an opaque collision;
- public serialization contains none of fixture record ID/key/plaintext digest/entity/value/epoch secret;
- descriptor, envelope identity and ciphertext tampering fail closed;
- wrong epoch secret fails;
- ciphertext for another valid replication identity is rejected before plaintext is returned;
- unknown public fields are rejected;
- artifact digest stays private;
- artifact bytes are SHA-256 verified after decrypt;
- epoch rotation changes opaque identities.

## Benchmark

`pnpm benchmark:replication:encrypted:v1` reports only encoded byte overhead:

- current trusted/plaintext replication descriptor bytes;
- opaque descriptor bytes;
- complete encrypted-record JSON bytes;
- representative encrypted blob JSON expansion.

It does not claim:

- network latency;
- relay throughput;
- storage-engine overhead;
- TLS cost;
- privacy strength from byte counts.

## Non-goals

v1 does not implement:

- Merkle/reconciliation migration to opaque descriptors;
- relay HTTP/storage integration;
- a durable ciphertext object store;
- deterministic encryption;
- metadata padding;
- encrypted search;
- access-pattern hiding;
- active-active source witnessing;
- MLS;
- post-quantum/hybrid KEM.

## Next step

The next layer should make the existing prefix-Merkle/reconciliation engine descriptor-generic or add a clean opaque descriptor adapter so an untrusted relay sees only:

```text
epoch-scoped opaque keys/tags
Merkle hashes over those opaque descriptors
ciphertext objects
```

It must not overload existing fields such as `payloadDigest` with secret-keyed tags merely because they have a similar textual shape.

After that, the authenticated HTTP replication transport can be integrated with relay ciphertext storage using the vault keyring as epoch/grant authority.
