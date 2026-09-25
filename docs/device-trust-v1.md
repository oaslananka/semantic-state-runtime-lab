# Durable Device Trust v1

SSRL replication now has a durable trust lifecycle for real devices without treating a user, a logical device, and a cryptographic key as the same identity.

```text
principal
  user/account authorization identity
       │
       ├── device:laptop      stable logical device
       │      ├── key A      immutable crypto key version, revoked
       │      └── key B      immutable crypto key version, active
       │
       └── device:phone
              └── key C
```

This distinction is necessary for phones, laptops, robots, servers, vehicles, and future personal hardware. A device can keep its logical identity while rotating cryptographic keys, and a principal can own multiple devices without sharing private signing keys between them.

## Package boundary

The protocol-neutral lifecycle lives in `@ssrl/device-trust`.

The first durable backend is `@ssrl/storage-sqlite-device-trust`.

`@ssrl/replication-http` imports only the resolver/replay contracts it needs:

```text
ReplicationDeviceKeyResolver
ReplicationSignatureReplayStore
```

The HTTP signature profile does not own enrollment, rotation, revocation, challenge persistence, or device registry storage.

Static key resolution and the in-memory replay implementation remain available for tests/development.

## Principal, device, and key identities

### Principal

`AccessPrincipal` is the authenticated user/account identity used by SSRL authorization policy.

A device key authenticates a principal only because a trusted registry binds the active key to an active device and that device to the principal.

Client enrollment payloads cannot choose a principal. `startEnrollment()` has no `principal` field. The principal is derived from the already-active authorizing device.

### Device

A `TrustedDevice` is a stable logical endpoint:

```ts
interface TrustedDevice {
  deviceId: string;
  principal: AccessPrincipal;
  displayName: string;
  enrolledAt: string;
  status: "active" | "revoked";
  revokedAt?: string;
}
```

A device is not a key. Rotation preserves `deviceId`.

### Key

A `TrustedDeviceKey` is an immutable public-key identity/version:

```ts
interface TrustedDeviceKey {
  keyId: string;
  deviceId: string;
  publicKeyJwk: Ed25519PublicJwk;
  activatedAt: string;
  status: "active" | "revoked";
  revokedAt?: string;
  predecessorKeyId?: string;
}
```

The registry never persists the device private key.

## RFC-defined key identity

v1 accepts public Ed25519 OKP JWKs only:

```json
{
  "crv": "Ed25519",
  "kty": "OKP",
  "x": "..."
}
```

`keyId` is not caller-chosen metadata. SSRL recomputes it as the RFC 7638 SHA-256 JWK Thumbprint and represents it using the RFC 9278 JWK Thumbprint URI form:

```text
urn:ietf:params:oauth:jwk-thumbprint:sha-256:<base64url-thumbprint>
```

For Ed25519, the RFC 8037 thumbprint input contains exactly `crv`, `kty`, and `x` in canonical member ordering. Optional JWK metadata such as `kid` or `alg` is not part of key identity.

The test suite includes the RFC 8037 known-answer key and thumbprint:

```text
x = 11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo
thumbprint = kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k
```

A supplied `keyId` that does not equal the recomputed thumbprint URI fails before registry mutation.

## Why WebAuthn/passkeys are separate

WebAuthn credentials are RP-scoped credentials for authenticating a user to a relying party. SSRL does not reuse a passkey credential as a replication signing key.

A future management UX may use WebAuthn/passkeys to authorize an enrollment or recovery ceremony. The replication key itself remains a protocol-specific device key whose lifecycle is owned by the device-trust registry.

This separation avoids turning an account-login credential into a generic cross-device replication credential.

## First-device bootstrap

The first device has a bootstrapping problem: there is no trusted device yet to authorize it.

v1 exposes an explicit `bootstrapLocal()` management operation. It succeeds only when the registry is empty.

```text
empty registry
  + explicit local bootstrap call
  + principal supplied by trusted local setup context
  + public device key
        ↓
first active device/key/event
```

There is no unauthenticated remote bootstrap endpoint in v1.

The same bootstrap `eventId` can be retried idempotently after a successful commit. Changed device/key/principal/display-name input under that event ID is a collision.

## Enrollment proof of possession

After bootstrap, a new device requires an already-active trusted device for the same principal.

Enrollment is two-stage:

```text
active trusted device
  -> issue durable challenge for proposed new public key
  -> new device signs canonical challenge proof with proposed private key
  -> verify proof
  -> atomic device + key + event commit
  -> consume challenge in the same transaction
```

The canonical proof binds:

- challenge ID and random challenge value
- operation (`enroll-device` or `rotate-key`)
- derived principal
- target device ID and display name
- proposed public JWK and derived `keyId`
- verifier/audience string

Changing the principal, audience, device, operation, or proposed key invalidates the signature.

Challenges are cryptographically random, bounded-lifetime, durable, and single-use.

A failed proof does **not** consume the challenge. Consumption occurs only after cryptographic verification and inside the same transaction as the lifecycle mutation.

## Idempotency and event ledger

Trust-management operations append immutable `DeviceTrustEvent` records:

```text
bootstrap-device
enroll-device
rotate-key
revoke-key
revoke-device
set-recovery-credential
recover-trust-set
```

The current device/key tables are materialized state derived by the same atomic transaction as each event.

An operation retry with the same committed event ID and the same semantic operation returns `replayed`. Reusing an event ID for different content fails closed.

This is important when the caller loses the response after commit. A successful enrollment can be retried even after its challenge expires, because the event ledger proves that the mutation already committed. A new mutation cannot reuse the consumed/expired challenge.

## Rotation

Normal rotation preserves logical device identity:

```text
device:laptop
  key A active
       ↓ new-key PoP challenge
  key A revoked
  key B active, predecessorKeyId = key A
```

The new key proves possession before commit.

Activation of the new key, revocation of the predecessor, event append, and challenge consumption are one SQLite transaction.

The predecessor stops resolving immediately. It remains revoked after restart and cannot be reactivated/rebound in v1.

## Revocation

### Key revocation

An active same-principal trusted device may revoke a target key. Resolver lookup stops returning that key immediately.

### Device revocation

Device revocation atomically revokes the device and every currently active key belonging to it.

A revoked device or key cannot authorize new enrollment/rotation operations.

There is no `unrevoke` primitive. Recovery creates a new trusted device/key through a separate trusted ceremony.

## Trust management is not replication authorization

A valid device signature proves which registered principal/device key signed the request. It does not grant access to semantic records by itself.

The request still flows through `ReplicationAccessGateway` policy:

```text
signed HTTP request
  -> durable device/key authentication
  -> derived AccessPrincipal
  -> ReplicationAccessGateway policy
  -> authorized projection only
```

The integration test authenticates a durable Bob device successfully while an Alice-only replication policy still returns an empty projection.

## Durable replay protection

The SQLite backend implements `ReplicationSignatureReplayStore` directly.

Accepted replay identity is:

```text
(keyId, nonce)
```

The nonce is written only after:

1. HTTP message signature verification succeeds, and
2. exact request-body digest verification succeeds.

A tampered body therefore does not burn an otherwise-valid nonce.

Replay rows survive process restart. The authenticator passes `signature expires + accepted clock skew` as the replay expiry, so pruning cannot re-enable the same request while the signature could still be accepted.

An expired signature cannot create a fresh replay row.

## SQLite schema

The durable backend is now device-trust schema v2. v2 preserves the original lifecycle tables and adds owner-controlled recovery. It uses a dedicated SQLite database with `STRICT` tables:

```text
device_trust_meta
trusted_devices
trusted_device_keys
device_trust_events
device_trust_challenges
trusted_recovery_credentials
device_recovery_challenges
replication_signature_replays
```

Key properties:

- foreign keys enabled
- optional WAL for same-host concurrency only
- canonical validated JSON plus typed indexed columns
- public Ed25519 JWK only
- public JWK unique across the registry
- immutable event IDs
- durable challenge `consumed_at`
- durable replay `(key_id, nonce)` primary key
- newer schema versions fail closed
- unrelated existing tables cause dedicated-DB refusal

SQLite establishes local/single-host durability semantics. It is not the future shared-cloud consensus implementation.

## Verified v1 behavior

Tests currently prove:

- RFC 8037/7638/9278 known-answer key identity
- arbitrary caller `keyId` mismatch rejection
- exactly-one local bootstrap plus exact bootstrap replay
- principal cannot be changed by client enrollment payload
- random durable challenge survives restart
- new key proof of possession
- invalid PoP does not consume challenge
- single-use and expiry semantics
- exact committed enrollment replay after challenge expiry
- event-ID collision rollback
- atomic key rotation and predecessor revocation
- individual key revocation and no key-material rebinding
- device revocation invalidates all active device keys
- revoke event idempotent replay
- restart-safe resolver state
- durable request replay nonce across restart
- safe replay/challenge pruning
- private key material is not persisted
- SQLite resolver/replay integration with HTTP Message Signatures
- tampered body does not consume durable replay nonce
- old key stops HTTP-authenticating after rotation
- replication access policy remains authoritative after durable device authentication
- static/in-memory and bearer paths remain supported

## Deliberate non-goals

v1 does not implement:

- unauthenticated remote first-device bootstrap
- WebAuthn RP/server stack
- passkey credential storage
- password/email/SMS account-reset UX
- social/quorum recovery
- hardware attestation verification
- TPM/Secure Enclave key management adapters
- distributed/cloud trust-registry consensus
- end-to-end replication payload encryption
- generic certificate authority / PKI

## Next architectural steps

The next trust work should be chosen from product risk rather than feature count:

1. **E2E relay encryption/key distribution**: prevent sync relays from becoming plaintext trust roots now that the device lifecycle and recovery transport are complete.
2. **Management UX** over the implemented key-bound protocols: QR/copy/native-device flows that preserve explicit possession confirmation.
3. **Hardware-backed key adapters**: Secure Enclave/TPM/Android Keystore without changing logical device/key/recovery semantics.
4. **Shared trust/replay backend** for cloud or multi-process deployments.
5. **E2E relay encryption** (for example an HPKE-based design) now that bootstrap, lifecycle, and total-device-loss recovery semantics exist.

The signed management transport and key-bound enrollment offer are documented in `docs/device-trust-management-http-v1.md`.

Owner-controlled destructive recovery is documented in `docs/owner-trust-recovery-v1.md`.

Its anti-enumeration HTTP transport is documented in `docs/device-trust-recovery-http-v1.md`.
