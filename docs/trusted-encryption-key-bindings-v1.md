# Trusted Encryption Key Bindings v1

`@ssrl/e2e` can encrypt vault payloads and wrap epoch secrets to X25519 recipients. That cryptographic capability is not, by itself, authorization.

A syntactically valid X25519 JWK or RFC 9278 JWK Thumbprint URI does **not** prove that the key belongs to a trusted user/device/recovery generation. v1 closes that gap by binding an exact X25519 public key to the existing durable device-trust lifecycle.

## Security boundary

The key rule is:

```text
X25519 key validity != recipient authorization
```

A key becomes an eligible recipient only through a `TrustedEncryptionKeyBinding` attached to an already-trusted Ed25519 subject generation.

The binding has no independent active/revoked status. Eligibility is inherited from its subject:

```text
device recipient eligible
  iff trusted device is active
  AND device signing-key generation is active
  AND exact X25519 binding exists

recovery recipient eligible
  iff recovery credential generation is active
  AND exact X25519 binding exists
```

Revocation/retirement does not delete historical bindings. It only removes them from `activeEncryptionRecipients()`.

## Record model

```ts
type EncryptionBindingSubjectKind =
  | "device-signing-key"
  | "recovery-credential";

type TrustedEncryptionKeyBinding =
  | {
      subjectKind: "device-signing-key";
      subjectKeyId: string;
      deviceId: string;
      principal: AccessPrincipal;
      encryptionKeyId: string;
      publicKeyJwk: X25519PublicJwk;
      boundAt: string;
    }
  | {
      subjectKind: "recovery-credential";
      subjectKeyId: string;
      recoveryGeneration: number;
      principal: AccessPrincipal;
      encryptionKeyId: string;
      publicKeyJwk: X25519PublicJwk;
      boundAt: string;
    };
```

`encryptionKeyId` is the RFC 9278 SHA-256 JWK Thumbprint URI of the exact normalized X25519 public JWK.

The full public JWK is persisted and validated. The thumbprint is an identifier, not an authorization primitive.

Private X25519 `d` material is rejected by public/trust APIs and strict HTTP parsers and is never persisted in the device-trust SQLite database.

## Uniqueness invariants

v1 enforces both directions:

```text
one trusted signing/recovery generation -> at most one X25519 binding
one X25519 encryptionKeyId             -> at most one trusted subject
```

Therefore:

- rotating a signing key creates a new binding for the new signing generation;
- the predecessor binding remains auditable but becomes ineligible when the predecessor key is revoked;
- one X25519 key cannot be reused across a device signing generation and a recovery credential;
- a second different X25519 key cannot silently replace the binding of an existing subject generation.

## Canonical proof binding

New trust ceremonies include the exact normalized X25519 JWK and its thumbprint inside the same canonical signed proof that authorizes the trust transition.

### Local bootstrap

`LocalBootstrapInput` requires:

```text
Ed25519 device public JWK
X25519 device public JWK
```

The bootstrap transition atomically inserts:

```text
trusted device
trusted Ed25519 signing key
X25519 binding for that signing generation
device-trust event
```

There is no server-generated recipient key.

### Enrollment

The enrollment offer contains:

```text
Ed25519 public JWK + keyId
X25519 public JWK + encryptionKeyId
```

The challenge copies both identities. The candidate device signature covers the canonical challenge, so substituting either X25519 JWK or encryptionKeyId after the offer/challenge was created invalidates the proof.

### Signing-key rotation

The rotation challenge carries the new signing generation's Ed25519 and X25519 public keys. Completing rotation atomically:

```text
revokes predecessor signing generation
activates new signing generation
creates new X25519 binding
records the rotation event
consumes the challenge
```

The old binding remains historical and immediately disappears from `activeEncryptionRecipients()` because its signing subject is no longer active.

### Recovery provisioning

`RecoveryProvisioningProof` binds all of:

```text
new recovery Ed25519 public key
new recovery X25519 public key
recovery generation
principal
authorizing trusted device/key
audience
```

The new recovery Ed25519 private key signs that canonical proof. A network intermediary cannot replace the X25519 recipient key without invalidating proof-of-possession.

### Destructive recovery

`DeviceRecoveryChallenge` includes two new encryption bindings:

```text
replacement device X25519 binding
next recovery generation X25519 binding
```

The challenge is signed by:

```text
current recovery key
replacement device signing key
next recovery signing key
```

The repository transaction installs the replacement device/signing generation, next recovery generation, and both encryption bindings atomically while revoking/retiring old trust subjects.

## Legacy binding ceremony

Schema migration deliberately creates **zero synthetic encryption bindings**. Existing signing/recovery keys remain valid trust credentials, but they are not eligible E2E grant recipients until explicitly bound.

For a migrated active subject, `DeviceTrustManager.prepareEncryptionBinding()` creates a canonical `EncryptionBindingProof` containing:

```text
event ID
subject kind / subject key ID
principal
trusted authorizing device/key
exact X25519 public JWK + encryptionKeyId
audience
subject provenance: deviceId or recoveryGeneration
```

The subject's Ed25519 key signs this proof. `bindEncryptionKey()` then additionally requires an active trusted-device management authorizer for the same principal before committing the binding.

This provides:

- subject-key proof over the exact recipient key;
- management authorization through the existing trusted-device policy;
- stable event replay semantics;
- no signing-key rotation merely to add a recipient key.

Exact replay is idempotent. Same event ID with different content conflicts. A different key for an already-bound subject conflicts.

## Durable SQLite schema v3

Device-trust schema v3 adds:

```text
trusted_encryption_key_bindings
```

Indexed typed columns include:

```text
encryption_key_id
subject_kind
subject_key_id
principal_json
device_id
recovery_generation
public_jwk_json
bound_at
record_json
```

Reads parse and canonicalize `record_json` and cross-check indexed columns. Corruption fails closed rather than trusting typed columns or JSON independently.

The v2 -> v3 migration:

```text
preserves trusted devices
preserves device signing generations
preserves challenges/replay state
preserves recovery credentials/recovery challenges
adds zero synthetic X25519 bindings
```

A legacy trust subject becomes a recipient only after the explicit binding ceremony.

## Query contract

The repository exposes:

```ts
encryptionBinding(encryptionKeyId)
encryptionBindingForSubject(subjectKind, subjectKeyId)
activeEncryptionRecipients(principal)
```

`activeEncryptionRecipients()` returns deterministic ordering and exact subject provenance. It re-checks current subject eligibility instead of trusting a cached binding status.

This method is the intended trust source for a future epoch/grant keyring. A future grant layer should not accept arbitrary caller-supplied X25519 recipients as trusted merely because their key IDs are well formed.

## HTTP management

Enrollment, rotation, recovery provisioning and destructive recovery wire contracts carry public X25519 JWKs explicitly.

Strict parsing rejects:

- private `d` fields;
- wrong OKP curves;
- missing required binding fields in new operations;
- extra/unexpected object fields;
- mismatched JWK thumbprints.

Authenticated principal and authorizing key identity continue to come from the signed HTTP request context, never from caller-controlled body identity.

Recovery anti-enumeration behavior is unchanged.

## Dependency direction

The dependency is intentionally:

```text
@ssrl/device-trust -> @ssrl/e2e
```

`@ssrl/e2e` does not import device trust. This keeps primitive cryptography/protocol code independent from trust-policy state and avoids a package cycle.

## Deliberate non-goals

This layer does not:

- create or persist vault epochs;
- automatically issue HPKE grants;
- store private X25519 keys;
- prove X25519 private-key usability with a separate challenge-response;
- retroactively revoke epoch secrets a removed device already learned;
- implement a relay/keyring/cloud distribution service;
- implement MLS/group messaging.

The corresponding Ed25519 trusted subject signs the exact X25519 public JWK, preventing relay/authorizer key substitution. Supplying an unusable X25519 key is therefore a self-denial-of-service by that trusted subject in v1, not authorization of an attacker-controlled recipient key.

## Next step

The next trust/encryption layer should be a durable authenticated vault-epoch/grant keyring that uses only:

```text
DeviceTrustRepository.activeEncryptionRecipients(principal)
```

as its recipient source, with explicit rotation/re-wrapping behavior when device or recovery eligibility changes.
