# Owner Trust Recovery HTTP v1

SSRL exposes owner-controlled trust recovery over the existing bounded device-trust HTTP package without turning the recovery endpoint into a weaker account-reset mechanism.

The transport has two deliberately different authorization profiles:

```text
normal operation
  trusted device HTTP Message Signature
  -> recovery credential provisioning / rotation

all normal devices lost
  no trusted-device HTTP signature available
  -> recovery ceremony itself is authorization
  -> current recovery proof + replacement-device PoP + next-recovery PoP
```

The recovery HTTP API never accepts password, email, SMS, low-entropy recovery codes, caller-supplied principal, or caller-supplied audience as authority.

## Routes

All routes are `POST` + `application/json`:

```text
/v1/device-trust/recovery-credentials/prepare
/v1/device-trust/recovery-credentials/commit
/v1/device-trust/recovery/start
/v1/device-trust/recovery/complete
```

The two provisioning routes require the existing `ssrl-device-trust-v1` HTTP Message Signature profile.

The two emergency recovery routes intentionally do **not** require a normal trusted-device HTTP signature. If they did, they would be unusable in the exact total-device-loss state they are designed to recover from.

## Provisioning profile

Provisioning remains a normal trusted management operation.

```text
active trusted device
  signed POST recovery-credentials/prepare
        ↓
server derives active authorizer + principal
server injects configured audience
server returns canonical RecoveryProvisioningProof
        ↓
proposed recovery private key signs proof
        ↓
signed POST recovery-credentials/commit
        ↓
server verifies recovery-key PoP
atomic generation install/rotation
```

The request body contains only:

```text
eventId
public recovery JWK
[commit only] recovery-key signature
```

`principal`, `authorizingKeyId`, and `audience` are not request fields. Extra keys are rejected rather than ignored.

The provisioning response binds:

- event ID
- derived principal
- durable authorizing device/key
- recovery public JWK + thumbprint key ID
- next recovery generation
- configured registry audience

The client also checks that the returned proof still corresponds to the requested event ID and recovery public key before signing it.

## Public emergency-recovery profile

The start body contains only candidate/public material:

```text
recoveryKeyId
replacement deviceId
displayName
replacement device public JWK
next recovery public JWK
```

The server:

1. bounds and parses the entire JSON request;
2. rejects unexpected identity/audience fields;
3. looks up the recovery credential;
4. derives principal from that credential;
5. injects the configured audience;
6. delegates to the core `DeviceTrustManager.startRecovery()` state machine.

The response is a fully validated `DeviceRecoveryChallenge` under the dedicated HTTP schema.

The client validates all JWK thumbprint IDs and also verifies the challenge matches the exact requested:

- current recovery key ID
- replacement device ID
- display name
- replacement public key
- next recovery public key

A server response that is internally valid but belongs to another recovery request is rejected client-side.

## Completion

Completion sends:

```text
eventId
challengeId
current recovery signature
replacement device signature
next recovery signature
```

All three signatures are unpadded base64url Ed25519 signatures over the same domain-separated recovery proof defined by the core recovery protocol.

On success the response contains the materialized:

- immutable recovery event
- replacement trusted device
- replacement device key
- rotated recovery credential

The client validates the response records and checks that event/challenge IDs match the request that produced them.

## Anti-enumeration error profile

Emergency recovery endpoints expose one public state-dependent failure:

```json
{
  "schema": "ssrl-device-trust-http-error-v1",
  "code": "recovery-failed",
  "message": "Device trust recovery failed"
}
```

with HTTP `401`.

The same shape is returned for domain-state failures including:

- unknown recovery key
- retired recovery key
- recovery generation mismatch
- already-used replacement device ID
- replacement key reuse
- next recovery key reuse
- stale recovery credential
- invalid one-of-three proof
- expired recovery challenge
- consumed recovery challenge when no committed exact replay exists
- conflicting recovery event ID

The handler does not expose whether an account/principal/recovery key exists through different domain error bodies.

Protocol-shape errors remain distinguishable because they do not reveal durable trust state:

- malformed JSON / unexpected fields: `400`
- invalid Host/Origin policy
- wrong method/media type
- oversized request: `413`
- unknown route: `404`

This separation keeps programmer/protocol errors diagnosable without making durable recovery state enumerable.

## Timing caveat

v1 normalizes public failure **status/body**, not total network execution time.

Database lookup, cryptographic verification, cache state, storage latency, and network scheduling can still produce timing variation. The protocol therefore does not claim constant-time remote recovery behavior.

Deployments exposing recovery to untrusted networks should add rate limiting and abuse controls outside this core package. Those controls must preserve the same generic public failure semantics.

## Replay semantics

A completed `recover-trust-set` event is recognized by the core state machine before consumed/expired challenge rejection.

Therefore a client that lost the success response may retry the exact same completion and receive `replayed`, even after challenge expiry.

A different recovery attempt that reuses the same event ID is not a replay. It fails under the same public `recovery-failed` envelope and does not partially revoke the current trust set or consume the new challenge.

## Bounded transport

Recovery routes inherit the existing management handler invariants:

- Host allowlist
- optional Origin allowlist
- POST only
- `application/json`
- 256 KiB default request bound
- 1 MiB hard request bound
- fatal UTF-8 JSON parsing
- strict object keys
- `cache-control: no-store`

The client bounds responses at 1 MiB and rejects:

- wrong media type
- oversized response
- invalid JSON
- wrong schema
- malformed challenge/event/device/key/recovery records
- internally inconsistent records
- valid records belonging to another request

## Private-key boundary

Only public Ed25519 JWKs are accepted in recovery HTTP JSON.

A JWK containing private `d` material is rejected by both client-side normalization and strict server request parsing. The HTTP surface does not persist or return private recovery/device keys.

The actual private keys remain on the owner-controlled device/storage chosen by the product layer.

## Real loopback proof

The HTTP integration suite proves the full ceremony over a real loopback server and the real SQLite trust registry:

1. local laptop is bootstrap-trusted;
2. recovery generation 1 is prepared/PoP-signed/committed over signed management HTTP;
3. generation rotation retires the predecessor;
4. public recovery start works without a trusted-device HTTP signature;
5. principal and audience are server-derived;
6. a bad one-of-three signature returns generic recovery failure and leaves challenge unused;
7. successful recovery revokes laptop and an enrolled phone;
8. replacement device/key becomes active;
9. replacement key immediately authenticates the existing replication HTTP signature profile;
10. current recovery authority rotates to the next generation;
11. exact completion replay succeeds after expiry;
12. a conflicting event ID returns generic recovery failure without partial mutation.

The suite also compares unknown, retired, and conflicting start failures and requires the same public body/status.

## Standards rationale

Generic public recovery errors follow the anti-enumeration direction used by current OWASP authentication/recovery guidance: existent/non-existent/disabled states should not be exposed through distinct public messages, and timing discrepancies should be minimized where practical.

WebAuthn remains an adapter opportunity rather than a core protocol dependency. WebAuthn Level 3 is a W3C Recommendation, while broader credential recovery/backup work continues to evolve. A future WebAuthn, Secure Enclave, TPM, Android Keystore, or hardware-token adapter can provide key custody/proof without changing the SSRL recovery state machine or HTTP trust semantics.

## Deliberate non-goals

v1 does not implement:

- password/email/SMS recovery
- WebAuthn RP/server stack
- low-entropy recovery codes
- CAPTCHA
- rate limiter implementation
- social/quorum recovery
- remote human identity proofing
- hardware attestation
- UI
- exact constant-time guarantees across network/storage stacks
- end-to-end replication payload encryption

## Next risk

With bootstrap, enrollment, rotation, revocation, total-device-loss recovery, and recovery transport defined, the next high-value trust problem is no longer adding more reset paths.

The next candidate is **end-to-end replication relay encryption and key distribution** so a relay/cloud synchronization service can transport ciphertext without becoming a plaintext trust root.
