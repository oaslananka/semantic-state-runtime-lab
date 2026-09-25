# E2E Vault Envelope v1

This document defines the first protocol-neutral end-to-end encryption primitive for SSRL personal-state and artifact payloads.

It does **not** yet change replication or HTTP transport. The purpose of v1 is to freeze the cryptographic envelope/key-grant semantics before an untrusted relay becomes part of the architecture.

## Threat model

Today, SSRL replication can authenticate devices and authorize projections, but canonical semantic payload JSON and artifact bytes are still plaintext at the replication transport endpoint. TLS protects transport hops; it does not prevent a cloud relay that terminates TLS or stores replication bodies from becoming a plaintext trust root.

v1 targets **payload confidentiality from an untrusted relay/storage service**.

It does not claim metadata privacy. A future relay may still learn, depending on the transport design:

- encrypted object kind and opaque/non-opaque object identifier;
- encryption epoch identifier;
- ciphertext length;
- recipient encryption-key identifiers and grant count;
- request/access timing and traffic volume.

Stronger metadata privacy would require a separate design: opaque identifiers, padding/bucketing, access-pattern mitigation, or related techniques.

## Why HPKE, not MLS

SSRL v1 is storage-shaped: immutable semantic records and artifact blobs must remain recoverable by newly enrolled or recovered devices.

MLS (RFC 9420) is designed for asynchronous group messaging with strong forward-secrecy and post-compromise-security properties. A newly added MLS member does not naturally obtain messages sent before it joined. That is desirable for messaging, but conflicts with SSRL's immediate requirement that a replacement/recovered personal device can regain historical vault access.

v1 therefore uses:

```text
payload bytes
  -> symmetric vault epoch secret
  -> object-specific AEAD key
  -> immutable encrypted envelope

vault epoch secret
  -> HPKE grant per recipient encryption key
```

MLS remains a future candidate if SSRL later adds real-time collaborative messaging/session semantics where its ratchet/epoch properties are a better match.

## Key-purpose separation

Existing SSRL device-trust keys are Ed25519 signing/authentication keys.

E2E encryption keys are separate X25519 keys.

```text
Ed25519  -> authentication / signatures
X25519   -> HPKE recipient encryption
AES-256  -> payload encryption
```

v1 never converts Ed25519 keys to X25519 or reuses one key for both purposes.

Public X25519 JWKs use the exact shape:

```json
{
  "kty": "OKP",
  "crv": "X25519",
  "x": "..."
}
```

Protocol parsers reject:

- private `d` material;
- Ed25519 keys;
- P-256/other curves;
- extra object fields;
- malformed/non-canonical base64url;
- X25519 keys whose raw public component is not exactly 32 bytes.

Key IDs are JWK Thumbprint URIs derived from canonical `{crv,kty,x}` public material.

Private X25519 JWKs are local secret material only. The public JSON encoders do not accept or serialize them.

## Vault epochs

A vault encryption epoch contains:

```ts
interface VaultEpoch {
  epochId: VaultEpochId;
  secret: VaultEpochSecret; // exactly 32 random bytes
}
```

The epoch ID is random public metadata and is not derived from the secret.

The epoch secret is generated from the platform CSPRNG and is never included in a public envelope or key-grant JSON object.

### Revocation semantics

Epoch rotation can provide **forward revocation**: after removing a device, new payloads can use a new epoch secret that is not granted to the revoked device.

It cannot make a compromised/revoked device forget epoch secrets or plaintext it already obtained. SSRL must not claim retroactive cryptographic revocation.

Historical recovery requires authorized replacement/recovery devices to receive grants for historical epochs that remain part of the user's retained vault history.

## Payload encryption

`EncryptedPayloadEnvelope` contains:

```ts
schema
suite
epochId
objectKind
objectId
plaintextBytes
nonce
ciphertext
```

Supported object kinds in v1:

```text
replication-record
artifact-blob
```

Payload size is bounded to 64 MiB per envelope in the primitive package. A later transport may impose a tighter limit.

### Object-specific key derivation

The 32-byte epoch secret is not imported directly as a single reusable AES key for every object.

For each object, SSRL derives an AES-256-GCM key via HKDF-SHA256 using canonical authenticated metadata as derivation context. The metadata includes:

```text
schema
suite
epochId
objectKind
objectId
plaintextBytes
purpose = payload-aead-key
```

A fresh random 96-bit AES-GCM nonce is still generated for every immutable envelope.

Object-specific derivation reduces the impact of a cross-object random nonce collision because distinct object identities use distinct AEAD keys.

### AAD binding

The same canonical metadata, excluding nonce/ciphertext, is authenticated as AES-GCM additional data.

Changing any of the following causes decryption to fail:

- epoch ID;
- object kind;
- object ID;
- plaintext length;
- nonce;
- ciphertext/tag.

### Randomized immutable output

Encrypting identical plaintext twice intentionally produces different nonce/ciphertext.

Therefore encrypted envelopes are **immutable persisted protocol objects**, not values that each device should independently recompute and expect to compare equal.

Future encrypted replication must reconcile the stored encrypted object/envelope identity, not re-encrypt plaintext on every peer and compare ciphertext.

## No plaintext digest in the public envelope

The envelope deliberately does not contain a SHA-256 digest of plaintext.

Many personal-state records have low entropy. Publishing a plaintext digest to an untrusted relay can permit offline dictionary guessing even when the payload itself is encrypted.

The existing plaintext `ReplicationRecord.payloadDigest` is therefore **not** a suitable public descriptor for the future untrusted-relay format.

A later encrypted replication format must define reconciliation identity over ciphertext/encrypted-object material or another construction that does not expose a plaintext verification oracle.

## HPKE epoch-key grants

`HpkeEpochKeyGrant` contains:

```ts
schema
suite
epochId
recipientKeyId
encapsulatedKey
ciphertext
```

The grant wraps exactly one 32-byte vault epoch secret for one X25519 recipient.

v1 HPKE suite:

```text
Mode: Base
KEM:  DHKEM(X25519, HKDF-SHA256)
KDF:  HKDF-SHA256
AEAD: AES-256-GCM
```

Grant metadata is bound both through HPKE `info` and AEAD AAD. The recipient key ID is the recipient X25519 public-JWK thumbprint.

Tampering with epoch ID, recipient key ID, encapsulated key, or ciphertext fails closed.

### One-shot HPKE API

SSRL uses `CipherSuite.seal()` / `CipherSuite.open()` as one-shot operations and constructs a fresh suite operation for each grant.

The dependency is pinned to `@hpke/core@1.9.0`.

Versions `<=1.7.4` were affected by CVE-2025-64767 / GHSA-73g8-5h73-26h4, where concurrent use of a mutable sender context could reuse an AEAD nonce. The upstream patch starts at 1.7.5. SSRL both pins a patched version and avoids sharing a mutable sender context.

## Critical authenticity boundary

HPKE **Base mode authenticates ciphertext to the recipient key but does not authenticate the sender**.

This package therefore proves:

```text
only the intended X25519 private key can unwrap this grant
```

It does **not** prove:

```text
this epoch/grant was authorized by the user's trusted-device/recovery state machine
```

That distinction is security-critical. An untrusted relay must not be allowed to create an attacker-chosen epoch secret, encrypt attacker-controlled payloads under it, create a syntactically valid HPKE grant to a real device, and thereby manufacture trusted personal state.

Epoch creation and grant issuance are now bound to authenticated SSRL trust state by `@ssrl/vault-keyring`; see `docs/vault-keyring-v1.md`.

`@ssrl/e2e` remains a **cryptographic primitive** rather than a complete encrypted sync authorization protocol. The keyring consumes these primitives and adds trusted recipient selection, signed epoch/grant lifecycle, durability and historical re-wrap semantics.

## Recovery

The same epoch secret may be independently HPKE-wrapped to:

- active device X25519 encryption keys;
- a dedicated recovery X25519 encryption key.

This is separate from the existing Ed25519 recovery credential used to authorize destructive trust recovery.

Future recovery flow must coordinate both concerns:

```text
Ed25519 recovery credential
  -> authorizes who may recover trust

recovery X25519 key / authorized re-wrap path
  -> restores access to historical vault epoch secrets
```

Rotating a recovery encryption key should re-wrap epoch secrets, not re-encrypt every semantic record/blob.

## Parser and memory boundaries

Public envelope/grant parsers:

- require exact object keys;
- require supported schema/suite values;
- require canonical unpadded base64url;
- enforce exact key/nonce/HPKE encapsulation lengths;
- enforce bounded payload/grant sizes;
- reject private JWK fields;
- fail closed on malformed ciphertext or authenticated metadata.

JavaScript/WebCrypto does not provide a reliable guarantee that every temporary secret copy can be immediately zeroized. SSRL therefore minimizes explicit secret serialization/copies but does not claim deterministic memory erasure in v1.

## What the tests prove

The v1 test suite covers:

- X25519 key generation/public identity and strict key-purpose parsing;
- 32-byte CSPRNG vault epochs;
- semantic JSON byte round-trip;
- arbitrary binary blob round-trip;
- ciphertext/nonce/AAD metadata tamper failure;
- wrong epoch-secret failure;
- randomized encryption of identical plaintext;
- absence of plaintext content/digest from public envelopes;
- strict envelope schemas and lengths;
- independent device and recovery HPKE grants for one epoch;
- wrong-recipient failure;
- grant metadata/encapsulation/ciphertext tamper failure;
- no private JWK or plaintext epoch secret in grant serialization.

The suite does not reimplement RFC 9180 test vectors. `@hpke/core` remains responsible for HPKE primitive conformance; SSRL tests its own context binding, parsing and envelope semantics.

## Non-goals

v1 does not provide:

- encrypted replication HTTP integration;
- encrypted Merkle/descriptor format;
- encrypted replication integration that consumes the durable keyring;
- automatic epoch rotation;
- metadata privacy;
- padding/traffic-analysis resistance;
- encrypted search;
- MLS;
- post-quantum/hybrid KEMs;
- retroactive revocation of already disclosed plaintext/epoch secrets.

## Follow-up order

The safe integration order is:

1. **Completed:** bind X25519 encryption recipients to device/recovery trust.
2. **Completed:** persist an authenticated epoch/grant keyring with historical re-wrapping.
3. Define encrypted replication records/blobs whose public reconciliation identity does not expose plaintext digests.
4. Integrate an untrusted relay/cloud transport and explicitly benchmark metadata leakage, payload overhead and recovery behavior.

Skipping directly to encrypted HTTP bodies would create ciphertext without a trustworthy key-lifecycle protocol and would not solve the actual relay trust problem.


## Recipient trust boundary

The E2E package treats X25519 keys as cryptographic recipients, not trusted principals. Device/recovery authorization belongs to `@ssrl/device-trust`; durable trust binds exact X25519 public JWKs to active signing/recovery generations and exposes `activeEncryptionRecipients(principal)`. The authenticated vault keyring now sources recipients from that trust query rather than accepting arbitrary caller-supplied thumbprints. See `docs/trusted-encryption-key-bindings-v1.md` and `docs/vault-keyring-v1.md`.
