# Owner-Controlled Trust Recovery v1

SSRL device trust now has a cryptographic recovery path for the failure mode where the owner has lost access to every active trusted device.

The goal is **not** to add a weaker password/email/SMS reset path. Recovery is a pre-provisioned break-glass capability with its own high-entropy signing credential and destructive trust-set replacement semantics.

```text
normal operation
  trusted device key(s)
        │
        └── provision recovery public key (private key stays owner-side)

all devices lost
        │
        ├── current recovery key proves recovery authority
        ├── replacement device key proves possession
        └── next recovery key proves future break-glass possession
                 ↓
       one atomic recovery transaction
                 ↓
       every old active device/key revoked
       replacement device/key active
       old recovery credential retired
       next recovery generation active
```

## Threat model

Recovery must not undermine the device-bound trust model it protects.

v1 therefore deliberately excludes:

- password reset
- email or SMS OTP
- short recovery codes
- caller-supplied authoritative principal
- server-held private recovery keys
- reactivating an old device or key
- reusing the current recovery key after successful recovery

The server stores only recovery **public** keys and immutable lifecycle events.

## Recovery credential

A recovery credential is separate from every device/replication key:

```ts
interface TrustedRecoveryCredential {
  keyId: string;
  principal: AccessPrincipal;
  publicKeyJwk: Ed25519PublicJwk;
  generation: number;
  activatedAt: string;
  status: "active" | "retired";
  retiredAt?: string;
  predecessorKeyId?: string;
}
```

`keyId` is the same RFC 7638 SHA-256 JWK thumbprint represented as an RFC 9278 JWK Thumbprint URI used elsewhere in device trust.

Role separation is mandatory. A recovery public key cannot reuse device-key material, and the recovery ceremony requires three distinct keys:

```text
current recovery key
replacement device key
next recovery key
```

## Provisioning and rotation

Recovery is useful only if it was provisioned before total device loss.

Provisioning is authorized by an already-active trusted device. The proposed recovery private key proves possession over a canonical provisioning payload containing:

- event ID
- principal derived from the trusted authorizer
- authorizing device ID and key ID
- proposed recovery public JWK and thumbprint key ID
- next recovery generation
- management audience

The trusted-device authorization channel and recovery-key proof serve different purposes:

```text
trusted-device authorization
  -> who is allowed to install/rotate recovery authority

new recovery-key PoP
  -> proof the owner actually controls the private key being installed
```

The first recovery credential is generation 1. Rotation retires the previous active generation and activates `generation + 1` atomically.

Exact committed provisioning event replay remains idempotent even if the original authorizing device is later revoked. Replay does not mutate trust state.

## Recovery challenge

Recovery is a separate ceremony from normal enrollment/rotation and has a separate canonical challenge schema.

A `DeviceRecoveryChallenge` binds:

- derived principal
- current recovery key ID, public JWK, and generation
- fresh replacement device ID and display name
- fresh replacement device public JWK and key ID
- fresh next recovery public JWK, key ID, and generation
- verifier/audience
- cryptographically random challenge value
- created/expiry timestamps

The principal is resolved from the active recovery credential. A client-injected principal field is ignored because it is not part of the API contract.

## Three proofs of possession

Completion requires three Ed25519 signatures over the **same domain-separated canonical recovery proof**:

1. current recovery credential signature — authorizes destructive recovery
2. replacement device signature — proves possession of the new device key
3. next recovery credential signature — proves possession of future recovery authority

Changing any bound field changes the signed bytes. Tests specifically cover changes to:

- replacement device ID
- display name
- replacement device key
- next recovery key
- audience
- recovery generation

A failed signature does not consume the durable challenge.

## Destructive trust-set replacement

Successful recovery is intentionally destructive.

For the recovered principal, one SQLite transaction performs:

```text
revalidate durable challenge + recovery generation
  -> revalidate active device/key set has not changed concurrently
  -> revoke every currently-active old device key
  -> revoke every currently-active old device
  -> retire current recovery credential
  -> insert fresh replacement device
  -> insert fresh replacement device key
  -> insert next recovery generation
  -> append recover-trust-set event
  -> consume recovery challenge
  -> COMMIT
```

Any failed invariant rolls back the whole operation. There is no state in which only part of the old trust set is revoked.

A concurrent enrollment/rotation that changes the active trust-set between preparation and commit is detected as a conflict rather than silently surviving recovery.

## Why recovery rotates itself

A recovery secret should not remain a reusable permanent master key after it has been exercised.

Therefore successful recovery requires a fresh next recovery key and retires the authorizing recovery generation in the same transaction.

```text
recovery generation 1  --used--> retired
recovery generation 2  --------> active
```

The old recovery key cannot start a second recovery.

There is no `unretire` primitive in v1.

## Idempotency and lost responses

`recover-trust-set` is recorded as an immutable trust event.

If the client loses the success response, the exact same event/challenge/signatures can be retried. The committed event is recognized before consumed/expired challenge rejection and returns `replayed` with the current materialized replacement state.

Using the same event ID for different recovery content fails closed and does not consume the second challenge or revoke the current trust set.

Consumed recovery challenges are retained so committed-event replay remains possible. Expired **unused** recovery challenges may be pruned.

## SQLite schema v2

Device trust schema v2 adds:

```text
trusted_recovery_credentials
device_recovery_challenges
```

and expands `device_trust_events` with:

```text
set-recovery-credential
recover-trust-set
```

The v1 -> v2 migration is atomic. Existing:

- devices
- device keys
- trust events
- enrollment/rotation challenges
- replication replay nonces

remain intact.

A migrated v1 registry has **no** active recovery credential until the owner explicitly provisions one.

## Private-key handling

Recovery private JWK material is never accepted by the persistence API.

Public-key normalization rejects JWKs containing private `d` material. Integration tests also inspect the SQLite file bytes and verify both current and next recovery private `d` values are absent.

## Verified behavior

Tests prove:

- canonical recovery provisioning PoP
- generation-bound recovery provisioning and exact replay
- invalid provisioning PoP leaves state unchanged
- recovery-key rotation retires the predecessor atomically
- caller cannot override recovery principal
- current/device/next-recovery key role separation
- three signatures bind device/name/device-key/next-key/audience
- failed one-of-three proof leaves challenge unconsumed
- multi-device recovery revokes every old active device/key
- old device keys stop resolving immediately
- next recovery generation activates atomically
- old recovery credential cannot be reused
- exact recovery replay succeeds after challenge expiry
- conflicting recovery event ID causes no partial revocation
- restart-safe recovery challenge completion
- unused challenge expiry/pruning
- v1 -> v2 migration preserves normal challenge and replay state
- typed-column / canonical-JSON corruption fails closed
- private recovery key material is absent from durable storage

## Deliberate non-goals

v1 does not implement:

- HTTP recovery endpoints
- password/email/SMS reset
- low-entropy printable recovery codes
- social/quorum recovery
- remote human identity proofing
- WebAuthn relying-party/server stack
- passkey synchronization policy
- hardware attestation
- Secure Enclave / TPM / Android Keystore adapters
- distributed/cloud trust-registry consensus
- end-to-end relay payload encryption
- recovery UI

## Next step

The next trust-layer work should expose provisioning/start/complete through a **separately profiled bounded management HTTP surface** with generic anti-enumeration failure shapes. That surface must not weaken the cryptographic state machine documented here.

After recovery transport is stable, E2E relay encryption can be evaluated on top of a trust lifecycle that now covers bootstrap, enrollment, rotation, revocation, and total-device-loss recovery.
