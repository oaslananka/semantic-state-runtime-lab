# Device-bound replication HTTP signatures v1

SSRL replication can authenticate a peer with a device-held asymmetric key instead of relying only on a reusable bearer credential.

The implementation is an intentionally narrow application profile of established HTTP standards:

- RFC 9421 HTTP Message Signatures
- RFC 9530 `Content-Digest`
- RFC 9421 `ed25519` signature algorithm

It is **not** a new signature algorithm and it is not a generic implementation of every RFC 9421 feature.

## Why this layer exists

TLS protects a transport connection, but a reusable bearer token can still be replayed if it leaks. TLS may also terminate at a reverse proxy before the SSRL process.

The signature profile binds one replication request to possession of a device private key:

```text
registered device public key + principal
              ↓
        signed HTTP request
              ↓
request authentication
              ↓
existing ReplicationAccessGateway authorization
              ↓
Merkle/record/blob operation
```

A valid signature authenticates a principal. It does **not** authorize a projection, record, or blob. Authorization remains in `ReplicationAccessGateway`.

## Fixed v1 profile

One signature label is accepted:

```text
ssrl
```

Covered components are fixed and ordered:

```text
"@method"
"@target-uri"
"content-digest"
"content-type"
```

Signature parameters are fixed and ordered:

```text
created
expires
nonce
keyid
alg="ed25519"
tag="ssrl-replication-v1"
```

Example shape:

```text
Content-Digest: sha-256=:...:
Signature-Input: ssrl=("@method" "@target-uri" "content-digest" "content-type");created=...;expires=...;nonce="...";keyid="device:alice-laptop";alg="ed25519";tag="ssrl-replication-v1"
Signature: ssrl=:...:
```

The signature base follows RFC 9421's component-line format:

```text
"@method": POST
"@target-uri": https://sync.example/v1/replication/projection/open
"content-digest": sha-256=:...:
"content-type": application/json
"@signature-params": ("@method" "@target-uri" "content-digest" "content-type");...
```

The tests include a known-answer `Content-Digest` and exact `Signature-Input` fixture so signer/verifier round-trip cannot hide a shared serialization mistake.

## Content binding without unbounded pre-auth body reads

The authenticator does not consume the request body.

Authentication proceeds as:

```text
Host / Origin checks
  -> parse signature headers
  -> validate created/expires/keyid/nonce
  -> resolve device public key + principal
  -> verify Ed25519 signature over signed header/derived components
  -> return principal + signed expected content digest + pending nonce claim
```

The transport then performs:

```text
bounded body read
  -> SHA-256(actual bytes) == signed Content-Digest
  -> atomically consume one-time (keyid, nonce)
  -> JSON or binary-frame parsing
  -> domain/authorization work
```

This separation matters. A signature authenticator does not bypass the existing JSON/blob byte limits, and request content is verified before parsing or mutation.

## Device key resolution

`ReplicationDeviceKeyResolver` maps `keyid` to:

```ts
interface ReplicationDeviceCredential {
  keyId: string;
  publicKeyJwk: JsonWebKey;
  principal: AccessPrincipal;
  status?: "active" | "revoked";
}
```

v1 provides `StaticReplicationDeviceKeyResolver` for the protocol/authentication semantics.

The public key must be an Ed25519 public JWK (`kty=OKP`, `crv=Ed25519`) and must not contain private `d` material.

Unknown and revoked key IDs return the same public `authentication-failed` shape.

The private key is never passed to the server/authenticator. `createHttpMessageSigningFetch()` accepts a caller-owned private `CryptoKey`.

## Replay defense

Every proof has:

```text
created
expires
nonce
keyid
```

The verifier enforces:

- short bounded signature lifetime;
- configurable clock skew;
- no future-created request beyond skew;
- no expired request beyond skew;
- one-time `(keyid, nonce)` use.

`InMemoryReplicationSignatureReplayStore` establishes the replay-store contract. It is bounded, removes expired entries, and fails closed when full.

Nonce retention extends through `expires + allowedClockSkew`; otherwise a proof could be replayed during the verifier's own expiration-skew grace period.

The nonce is consumed only after the bounded body matches the signed `Content-Digest`. A request with valid captured signature headers but tampered content therefore cannot burn the legitimate request's one-time nonce. The nonce is still consumed before JSON/frame parsing or replication domain work, so concurrent authentic replays race on the replay store and only one can proceed.

A process-local replay store is not sufficient for a horizontally scaled production service. A durable/shared implementation is a follow-up requirement.

## Binding properties

The profile rejects reuse/tamper across:

- another target URI/path/host;
- another HTTP method;
- another `Content-Type`;
- another request body;
- another nonce/key ID/signature parameter set.

All current replication routes are POST, and the v1 signing fetch refuses to sign another method.

The exact full `Request.url` is covered as `@target-uri`. A TLS-terminating/rewrite proxy must therefore preserve the externally signed target URI at the SSRL verification boundary or terminate/re-sign in an explicitly trusted architecture.

## Binary artifact transfer

The same profile signs JSON requests and `application/vnd.ssrl.replication-blob-install-v1` binary frames.

The v1 signing fetch buffers the outgoing request content in order to compute `Content-Digest` before signing. Server-side request limits remain authoritative, but streaming/trailer-based client signing for very large payloads is not implemented in this profile.

For blob install:

```text
Content-Digest = SHA-256(entire framed request body)
```

After request authentication/content verification, existing artifact-record and blob digest verification still runs. HTTP signatures do not replace CAS/content-address integrity.

## OAuth / DPoP relationship

RFC 9700 recommends sender-constraining OAuth access tokens. DPoP (RFC 9449) is appropriate when SSRL is deployed behind an OAuth authorization server that issues DPoP-bound tokens.

This profile solves a different deployment requirement: device-to-device or self-hosted SSRL replication where no OAuth AS is assumed.

`ReplicationHttpAuthenticator` remains pluggable, so a deployment can choose:

```text
bearer/OAuth authenticator
DPoP-aware OAuth authenticator
SSRL RFC 9421 device-signature authenticator
another deployment-specific authenticator
```

No authenticator changes replication authorization semantics.

## Verified behavior

The transport tests prove:

- exact known-answer `Content-Digest` and `Signature-Input` profile;
- Ed25519-signed projection request succeeds;
- principal comes only from the registered device credential;
- exact proof replay fails before replication source/domain work;
- nonce remains blocked through accepted clock-skew expiry grace;
- target URI tamper fails;
- `Content-Type` tamper fails;
- request-body tamper fails after bounded read but before JSON/domain work;
- unknown and revoked key IDs share one failure shape;
- future-created, expired and overlong signatures fail;
- malformed signature/digest fields fail closed;
- authenticator does not consume request body;
- real SQLite peers converge over signed loopback HTTP;
- binary artifact blob install works through the same signature profile;
- existing bearer-authenticated transport remains supported.

## Non-goals

v1 deliberately does not provide:

- first-device bootstrap;
- durable trusted-device registry;
- device enrollment ceremony;
- device key rotation/recovery ceremony;
- durable/shared replay store;
- OAuth Authorization Server;
- DPoP token issuance/verification;
- mTLS client certificates;
- generic RFC 9421 parser/algorithm negotiation;
- streaming/trailer-based request signing;
- end-to-end payload encryption;
- untrusted cloud relay confidentiality.

## Next layer

The next security work should establish a durable device trust lifecycle:

```text
first-device/root bootstrap
  -> enrollment approval
  -> durable public credential registry
  -> revocation/rotation/recovery
  -> shared/durable nonce/replay state where needed
```

Only then should an untrusted-relay E2E encryption design bind HPKE recipient keys to trusted devices. Otherwise encryption simply moves the unresolved trust problem into key distribution.
