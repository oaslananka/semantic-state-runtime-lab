# Authenticated Vault Keyring v1

The vault keyring is the authorization and durability layer between SSRL's trusted-device lifecycle and its protocol-neutral E2E envelope primitives.

It answers a question that HPKE Base mode alone cannot answer:

```text
Who authorized this exact vault epoch and this exact set of randomized recipient grants?
```

The design keeps three concerns separate:

```text
@ssrl/device-trust
  -> who is currently authorized and which X25519 recipients are trusted?

@ssrl/e2e
  -> how is one epoch secret wrapped to one X25519 recipient?

@ssrl/vault-keyring
  -> which signed epoch/grant transitions are authoritative and durable?
```

The SQLite implementation is a separate adapter:

```text
@ssrl/storage-sqlite-vault-keyring
```

so the protocol-neutral keyring package does not depend on Node SQLite.

## Why signed transitions are required

RFC 9180 HPKE Base mode provides recipient confidentiality but does not provide sender authentication. An untrusted relay could otherwise manufacture an attacker-chosen epoch secret and syntactically valid HPKE grant to a legitimate recipient.

SSRL therefore signs the **exact canonical keyring transition**, including the exact randomized HPKE grant bytes, using the active trusted Ed25519 signing generation.

The signature covers:

- operation;
- event ID;
- principal;
- epoch metadata and predecessor;
- exact active recipient snapshot;
- exact newly added HPKE grants;
- resulting grant inventory;
- issuer device/signing-key identity and public JWK;
- audience/domain separation;
- creation time.

A grant ciphertext substitution therefore invalidates the transition signature.

## Public and secret state

Durable keyring state is public/relay-safe cryptographic metadata:

- epoch IDs and lifecycle metadata;
- recipient X25519 public identities;
- HPKE encapsulated keys/ciphertexts;
- signed transition events;
- issuer public Ed25519 material.

It never persists:

- `VaultEpochSecret` plaintext;
- X25519 private JWK `d`;
- Ed25519 private key material.

Bootstrap/rotation epoch secrets exist transiently in process memory and are returned to the local caller for payload encryption. Historical re-wrap decrypts an already persisted grant locally, uses the recovered secret only to create missing grants, then performs a best-effort `fill(0)` on that explicit `Uint8Array` copy.

JavaScript/WebCrypto cannot guarantee deterministic erasure of every temporary or engine-internal copy, so v1 does not claim secure-memory zeroization.

## Recipient authority

The manager has no free-form recipient-JWK API.

For bootstrap, rotation, and historical grant extension, recipients come only from:

```text
DeviceTrustRepository.activeEncryptionRecipients(principal)
```

The manager:

1. reads the normalized trusted recipient snapshot;
2. creates grants;
3. re-reads the active recipient snapshot before signing;
4. signs the exact canonical transition;
5. re-reads the active recipient snapshot again immediately before repository commit;
6. aborts if either re-read differs from the original snapshot.

The post-sign check matters because WebCrypto signing itself is asynchronous. This narrows the ordinary trust-state TOCTOU window through the last application-level step before commit. It is still not a distributed transaction across two independent databases; a future cross-process trust/keyring service needs appropriate operation serialization or a stronger shared transaction/authorization boundary.

Each recipient snapshot entry includes the exact trusted X25519 public JWK and its device/recovery provenance.

## Epoch lifecycle

### Bootstrap

The first epoch:

- has `reason=bootstrap`;
- has no predecessor;
- receives one HPKE grant for every current active encryption recipient;
- becomes the only active epoch head for the principal.

### Rotation

A rotation:

- references the current active epoch as predecessor;
- creates a fresh random epoch ID and 32-byte secret;
- grants only to the current active recipient set;
- leaves predecessor epoch/grants immutable and queryable.

This gives **forward revocation** semantics: a removed device/recovery recipient does not receive a grant for the new epoch.

It does not provide retroactive cryptographic revocation. If a removed recipient already learned an old epoch secret or plaintext, SSRL cannot make that knowledge disappear.

### Historical grant extension

Historical recovery/device migration can add grants to an existing retained epoch without changing payload envelopes.

The caller supplies one local X25519 private key only to the manager operation. The manager:

1. derives its public key/key ID;
2. requires an existing persisted grant for that epoch and source key;
3. opens that grant locally;
4. reads the current active trusted recipient set;
5. creates grants only for currently active recipients that are missing;
6. signs the exact new grants plus resulting canonical grant inventory;
7. commits without changing existing grant bytes or epoch metadata.

A retired historical key can therefore be used locally as a migration source while not being eligible as a **new** recipient unless trust state makes it active again.

## Event replay and immutable IDs

`eventId` is an idempotency key.

Exact replay:

```text
same eventId + same signed transition
  -> replay existing persisted event
  -> return exactly that event's signed resulting grant inventory
  -> do not regenerate randomized HPKE ciphertext
```

If later historical-extension events add more grants to the same epoch, replaying an earlier bootstrap/extension event does **not** silently expand its result to the epoch's newer grant inventory. Event replay is therefore stable over future keyring growth.

Collision:

```text
same eventId + different signed content
  -> VaultKeyringConflictError
```

Other immutable constraints:

- same epoch ID cannot be replaced by another epoch transition;
- one `(epochId, recipientKeyId)` has exactly one immutable grant;
- a second signed event cannot replace that grant with different ciphertext;
- rotation predecessor must be the current active epoch;
- a principal may not fork into multiple active epoch heads.

The protocol-neutral `validateVaultKeyringCommit()` function is shared by in-memory and SQLite repositories so storage backends do not invent separate lifecycle semantics.

## Transition authenticity

An authorized transition contains the issuer's public Ed25519 JWK and its thumbprint-derived signing key ID.

Normalization verifies that:

- issuer public JWK is structurally valid;
- `issuerSigningKeyId` equals the public-JWK thumbprint;
- new epoch creator identity matches issuer identity for bootstrap/rotation;
- exact transition signature verifies;
- grants belong to the transition epoch;
- new-epoch grant recipient IDs exactly equal the signed active recipient inventory;
- historical extension grants are a subset of the active recipient snapshot;
- every recipient in the signed active-recipient snapshot is present in the signed resulting grant inventory;
- the resulting inventory matches persisted existing grants plus the exact newly added grants at commit time.

The manager additionally resolves the authorizing key through the active device-trust state before creating a new transition.

## Trust-admission boundary

`verifyAuthorizedVaultKeyringEvent()` verifies the event-carried Ed25519 key, signature and exact transition bytes. It does **not** by itself prove that the issuer key is or was trusted for the principal.

New local transitions become authorized because `VaultKeyringManager` first resolves `DeviceTrustManager.activeAuthorization(authorizingKeyId)` and sources recipients only from the trusted encryption-recipient query. The repository then enforces immutable lifecycle/storage invariants.

Therefore `VaultKeyringRepository.commit()` is deliberately **not** a public relay-ingestion authorization API. A future replicated keyring protocol must validate the signed issuer against the appropriate device-trust history/state before admitting a remote event; an untrusted relay must never be allowed to take an arbitrary self-signed transition and call repository commit as if signature validity alone established trust.

## SQLite v1

`SQLiteVaultKeyringRepository` uses a dedicated SQLite database with `STRICT` tables:

```text
vault_keyring_meta
vault_epochs
vault_epoch_grants
vault_keyring_events
```

Key constraints include:

- unique `event_id`;
- unique `epoch_id`;
- unique `(epoch_id, recipient_key_id)`;
- unique predecessor, preventing two children from the same epoch;
- one root epoch per canonical principal;
- foreign keys from grants/events/predecessors to epochs.

The repository uses `BEGIN IMMEDIATE` for commits and serializes commit operations within one repository instance.

All async cryptographic validation/canonicalization inside a commit completes **before the first SQLite write**. From the first write through `COMMIT`, the code does not `await`, preventing same-connection readers from observing a partially written epoch/grant/event transition during an event-loop yield.

## Fail-closed read integrity

The keyring is intentionally small, so v1 favors strong corruption detection over indexed-read micro-optimization.

Read paths validate stored rows against canonical signed/normalized JSON and cross-check indexed columns.

For example:

```text
vault_epochs.created_by_device_id
  must equal record_json.createdByDeviceId

vault_epoch_grants.(epoch_id, recipient_key_id)
  must equal normalized grant_json identity

vault_keyring_events indexed issuer/epoch/audience/time fields
  must equal the cryptographically verified event_json transition
```

The repository scans and validates the small keyring tables before filtering requested items. This avoids a class of corruption where changing an indexed lookup column could silently hide a record from its original identity query.

Corruption fails closed with `CorruptVaultKeyringDatabaseError` or the protocol-level `CorruptVaultKeyringError` for invalid epoch-head topology.

## Secret-at-rest proof

The SQLite integration test closes the database and scans its raw bytes after bootstrap plus historical re-wrap.

It verifies absence of:

- raw 32-byte epoch secret;
- base64url epoch-secret representation;
- source X25519 private `d`;
- destination X25519 private `d`;
- issuer Ed25519 private `d`.

This is evidence about SSRL's explicit SQLite serialization paths, not a claim about process memory, filesystem snapshots outside the DB file, swap, crash dumps, or host compromise.

## What v1 tests prove

The focused suites cover:

- bootstrap grants exactly to the active trusted recipient set;
- exact grant substitution invalidates the Ed25519 transition signature;
- exact event replay reuses persisted HPKE ciphertext and preserves the event-time grant inventory even after later extensions;
- an extension whose resulting inventory omits a signed active recipient is rejected;
- trust recipient-set change before signing or after signing/immediately before commit fails closed;
- wrong authorizing private key fails;
- forward rotation excludes retired recipients from new epochs while preserving old grants;
- historical re-wrap opens an existing source grant and adds only missing current recipients;
- encrypted historical payload envelope remains byte-identical through re-wrap and decrypts through the new grant;
- source key without an existing historical grant fails;
- event-request collision fails;
- SQLite restart/reopen preserves canonical events/epochs/grants;
- stale forked rotation is rejected atomically;
- same event ID with different valid signed content is rejected atomically;
- later valid signed event cannot replace an immutable existing recipient grant;
- indexed-column and signed-event corruption fail closed;
- dedicated DB and newer-schema guards fail closed;
- SQLite bytes contain none of the tested private/epoch-secret material.

## Standards boundary

This design intentionally differs from MLS group messaging.

RFC 9420 MLS provides forward secrecy/post-compromise security and states that newly added members do not receive access to messages from before they joined. A personal vault recovery flow often requires the opposite property: a newly recovered/authorized device may need access to retained historical user state.

SSRL therefore uses independent immutable historical epoch grants instead of claiming MLS semantics.

## Non-goals

v1 does not implement:

- encrypted replication record/blob identity;
- an untrusted relay/cloud service;
- metadata privacy, padding, or traffic-analysis resistance;
- OS keychain / Secure Enclave / TPM private-key persistence;
- automatic background rotation on every trust event;
- retroactive erasure of plaintext or epoch secrets already learned;
- MLS/group messaging;
- independent multi-user collaboration key policy;
- post-quantum or hybrid KEM migration.

## Next step

With authenticated durable epoch/grant authority in place, the next cryptographic product-risk question is the **encrypted replication object format**:

```text
semantic record / artifact blob
  -> payload envelope under vault epoch
  -> public relay-safe object identity / descriptor
  -> Merkle/reconciliation without exposing plaintext digest or semantic metadata unnecessarily
```

That layer should consume the active keyring epoch rather than inventing its own key lifecycle.
