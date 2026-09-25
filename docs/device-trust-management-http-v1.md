# Signed Device-Trust Management HTTP v1

SSRL can now enroll, rotate, and revoke real device keys over a bounded HTTP **management plane** without turning request JSON into an identity authority.

The data plane and control plane are deliberately separate:

```text
replication data plane
  RFC 9421 tag: ssrl-replication-v1

trust management plane
  RFC 9421 tag: ssrl-device-trust-v1
```

Both profiles retain fixed POST request signing, target-URI binding, `Content-Digest`, Ed25519, bounded signature lifetime, nonce replay protection, and exact body verification. A proof from one profile is not accepted by the other.

## Security model

The management server never accepts `principal` or `authorizingKeyId` from request JSON.

For trusted management operations:

```text
HTTP Message Signature
  -> verified keyId + principal (+ deviceId when known)
  -> bounded body read
  -> signed Content-Digest verification + replay claim
  -> durable registry active-authorizer check
  -> strict JSON parsing
  -> DeviceTrustManager operation
```

The ordering is intentional. A tampered body is rejected before `DeviceTrustManager.activeAuthorization()` or mutation/domain work. Because replay consumption happens only after body digest verification, a captured valid signature with a modified body cannot burn the legitimate request nonce.

The durable registry remains authoritative after cryptographic verification. The verified principal and optional device ID must agree with the active key's persisted device/principal binding.

Unknown and revoked management signing keys share one public `401 authentication-failed` response shape.

## Key-bound enrollment offer

A candidate device creates its keypair locally and exports only a portable public offer:

```ts
interface DeviceEnrollmentOffer {
  schema: "ssrl-device-enrollment-offer-v1";
  deviceId: string;
  displayName: string;
  publicKeyJwk: Ed25519PublicJwk;
  keyId: string;
  audience: string;
}
```

`keyId` is the RFC 7638 SHA-256 JWK thumbprint represented as the RFC 9278 thumbprint URI. It is recomputed from the public JWK; caller-supplied mismatch fails.

The offer is canonical JSON and may be transported by QR, clipboard, local discovery, or another UX layer. The protocol does not make the transport itself a trust root.

## Display fingerprint

`deviceEnrollmentOfferFingerprint()` derives a short display value from SHA-256 of the **entire canonical offer**.

The v1 shape is four groups of four uppercase hex characters:

```text
ABCD-EF12-3456-7890
```

This fingerprint is **not a secret and is never accepted as authorization**. It exists only so a human can confirm that two screens refer to the same candidate device/key/audience.

Changing the device ID, display name, public key, key ID, or audience changes the canonical offer/fingerprint.

This avoids creating a low-entropy server lookup code that would need to carry security authority.

## Enrollment flow

```text
candidate device
  generate Ed25519 keypair locally
  create offer + display fingerprint
          │
          │ QR / copy / local UX
          ▼
existing trusted device
  user confirms candidate/fingerprint
  signed POST /enrollments/start
          │
          ▼
server
  derives authorizer from HTTP signature
  validates active durable authorizer
  DeviceTrustManager.startEnrollment()
  returns durable challenge
          │
          │ challenge transfer
          ▼
candidate device
  verify challenge matches local offer
  sign canonical challenge with candidate private key
  POST /enrollments/complete
          │
          ▼
server
  verifies candidate proof of possession
  atomic enroll + challenge consumption
```

The candidate private key never leaves the candidate device.

`signEnrollmentChallengeForOffer()` refuses to sign when the returned challenge's operation, device ID, display name, public key/key ID, or audience differs from the local offer.

## Completion endpoints

Enrollment and rotation completion do **not** require an already-trusted HTTP signing key.

Their authorization proof is intentionally different:

```text
high-entropy durable challenge ID/value
+ challenge binding to candidate key/device/audience
+ Ed25519 proof of possession by proposed private key
```

Completion bodies are exactly:

```json
{
  "eventId": "...",
  "challengeId": "...",
  "signature": "<unpadded base64url Ed25519 signature>"
}
```

Unknown/wrong challenges and invalid candidate signatures share the public `401 proof-failed` shape. Invalid proof does not consume the challenge. Exact committed completion remains idempotently replayable by event ID.

## HTTP routes

All v1 routes are POST and `application/json`:

```text
/v1/device-trust/enrollments/start
/v1/device-trust/enrollments/complete
/v1/device-trust/rotations/start
/v1/device-trust/rotations/complete
/v1/device-trust/keys/revoke
/v1/device-trust/devices/revoke
/v1/device-trust/recovery-credentials/prepare
/v1/device-trust/recovery-credentials/commit
/v1/device-trust/recovery/start
/v1/device-trust/recovery/complete
```

Trusted-device HTTP signatures are required for:

- enrollment start
- rotation start
- key revocation
- device revocation
- recovery credential prepare
- recovery credential commit

Candidate/key-bound proof is required for:

- enrollment complete
- rotation complete
- public recovery start/complete use the separate owner-recovery ceremony rather than a surviving trusted-device signature

There is no remote first-device bootstrap route.

## Bounded transport invariants

The management handler enforces:

- explicit Host allowlist
- optional Origin allowlist
- known routes only
- POST only
- exact JSON media type
- default request bound of 256 KiB
- hard request bound of 1 MiB
- strict object keys
- fatal UTF-8 JSON decoding
- generic authentication/proof failures
- no-store JSON responses

The client bounds JSON responses at 1 MiB and validates response schemas and normalized trust records. Malformed successful server responses fail closed with `InvalidDeviceTrustHttpResponseError` rather than leaking raw normalization exceptions into callers.

## Shared HTTP wire layer

Security-sensitive HTTP primitives moved into `@ssrl/http-wire`:

```text
bounded body collection
UTF-8 JSON parsing
strict object helpers
Host / Origin validation
generic Node Fetch-handler adapter
```

`@ssrl/replication-http` and `@ssrl/device-trust-http` are sibling protocols over that shared layer. The management package has no production dependency on the replication HTTP package; it uses it only in tests for the existing RFC 9421 signer/authenticator implementation.

This prevents body-limit and Host/Origin parsing behavior from drifting between control and data planes.

## Rotation and revocation

Rotation uses the same management transport:

```text
active device key signs /rotations/start
new private key signs returned rotation challenge
/rotations/complete atomically activates successor + revokes predecessor
```

The predecessor immediately stops authenticating management or replication requests.

Key/device revocation routes are signed by an active same-principal trusted device. The authorizing key comes only from verified HTTP metadata.

## Real loopback proof

The integration suite uses the real SQLite device-trust backend and a real loopback Node HTTP server:

1. bootstrap laptop locally;
2. phone creates key-bound offer;
3. laptop signs enrollment start using `ssrl-device-trust-v1`;
4. phone verifies/signs challenge;
5. phone completes enrollment;
6. durable SQLite resolver exposes the phone as an active credential;
7. phone signs a request under `ssrl-replication-v1` and passes replication authentication.

The suite also confirms the candidate private JWK `d` value is not present in the SQLite trust database.

## Standards rationale

The management signature tag is an SSRL application profile boundary over RFC 9421, not a new signature scheme.

RFC 8628's device-flow security guidance is useful for UX design: short user codes need rate limiting and remote-phishing mitigation, and users should be clear which device they are authorizing. SSRL v1 takes the safer route of keeping authorization cryptographically key-bound; the short fingerprint is display-only and has no server authority.

WebAuthn/passkeys remain separate. They are suitable for a future owner-approval or recovery ceremony, but a WebAuthn credential is not reused as the generic SSRL replication signing key.

## Verified v1 behavior

Tests prove:

- canonical offer key identity and deterministic display fingerprint;
- changed offer identity/audience changes fingerprint;
- candidate refuses mismatched challenge before signing;
- default replication signature profile is byte-compatible;
- management and replication signature tags are mutually rejected;
- verified authentication exposes key/device metadata;
- body-supplied authorizer/principal fields are rejected;
- body digest is verified before durable manager authorization/domain work;
- tampered body does not consume the legitimate nonce;
- offer audience mismatch is rejected before device creation;
- real loopback enrollment succeeds;
- invalid candidate PoP does not consume challenge;
- committed completion replays idempotently;
- rotation revokes predecessor immediately;
- signed key/device revocation succeeds;
- unknown/revoked signing keys have the same public failure shape;
- durable principal/device mismatch fails closed;
- Host/Origin/method/media/body/route bounds fail closed;
- malformed successful HTTP responses fail closed client-side;
- enrolled second device can authenticate the replication data plane;
- candidate private key material is not persisted by the server.

## Deliberate non-goals

v1 does not implement:

- unauthenticated remote first-device bootstrap;
- password/email/SMS or social recovery;
- WebAuthn/passkey RP/server stack;
- low-entropy device-code polling authorization;
- Bluetooth/NFC transport;
- hardware attestation;
- Secure Enclave/TPM/Android Keystore adapters;
- E2E replication payload encryption;
- distributed/cloud trust-registry consensus;
- a graphical pairing UI.

## Recovery transport

Owner-controlled destructive recovery now has a separately profiled HTTP surface. Normal recovery-credential provisioning remains trusted-device signed, while emergency start/complete are authorized by the recovery ceremony itself and collapse durable state failures to one generic public response.

See `docs/device-trust-recovery-http-v1.md`.

## Next risk

With lifecycle recovery transport in place, the next trust-layer candidate is end-to-end replication relay encryption/key distribution rather than adding weaker reset factors.
