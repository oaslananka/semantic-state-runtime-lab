# Authenticated bounded replication HTTP transport v1

SSRL's replication core already defined immutable records, prefix-Merkle reconciliation, bounded/resumable sessions, policy-scoped projections, principal-aware record transfer/apply, and explicit artifact-blob authorization.

v1 adds the missing network boundary. It does **not** replace those semantics with an HTTP-specific sync algorithm.

```text
remote SSRL client
        ↓ HTTPS outside loopback
injected transport authenticator
        ↓ normalized AccessPrincipal
Replication HTTP handler
        ↓
ReplicationAccessGateway
        ↓
authorized Merkle / records / blobs / apply
```

The transport is deliberately independent from MCP. MCP is an agent-facing protocol adapter; replication is a node-to-node state-transfer protocol.

## Package boundary

`@ssrl/replication-http` contains:

- a Fetch-compatible server handler;
- a bounded HTTP client;
- an HTTP implementation of the existing `ReconciliationEndpoint` contract;
- raw artifact blob read/install transport;
- stable public transport errors.

`@ssrl/replication-http/node` contains the Node HTTP adapter. It converts Node request streams to Fetch `Request` streams and streams Fetch `Response` bodies back with backpressure. It does not pre-buffer the whole request before the transport handler can enforce bounds.

## Core reconciliation change

A real remote endpoint exposed one transport-neutral abstraction defect: `ReconciliationEndpoint.viewInfo()` and `nodeHashes()` were synchronous even though the interface represented a remote peer.

They now allow:

```ts
T | Promise<T>
```

`BoundedReconciliationSession` awaits the remote calls. Existing in-memory endpoints remain synchronous and the reconciliation algorithm/merge law is unchanged.

The existing 100,000-record reconciliation tests continue to pass through this refactor.

## Authentication is injected, authorization remains domain-owned

The HTTP package does not parse OAuth access tokens, JWTs, DPoP proofs, device certificates, or custom capability signatures.

The server receives:

```ts
interface ReplicationHttpAuthenticator {
  authenticate(request: Request):
    | AccessPrincipal
    | Response
    | Promise<AccessPrincipal | Response>;
}
```

This allows a deployment adapter to provide the authentication mechanism and its own `401` / `WWW-Authenticate` semantics.

On success, SSRL always passes the returned identity through `normalizeAccessPrincipal()` before policy evaluation. Extra runtime credential-like object fields are discarded.

Critically:

- the request JSON never supplies the authenticated principal;
- authentication occurs before JSON/binary body parsing and before replication source scans;
- domain authorization remains in `ReplicationAccessGateway`;
- one authenticated principal can see a different authorized Merkle root from another principal over the same underlying store.

Tests prove Alice and Bob receive different root/count projections when policy hides an Alice-only record from Bob.

## Transport security baseline

`ReplicationHttpClient` refuses cleartext HTTP for non-loopback hosts.

Allowed v1 client bases are therefore:

```text
https://remote.example
http://localhost
http://127.0.0.1
http://[::1]
```

This is a guardrail, not a TLS implementation. Certificate issuance, reverse-proxy configuration and public deployment remain outside this package.

The auth boundary is intentionally compatible with stronger standard layers later:

- OAuth 2.0 Security Best Current Practice: RFC 9700
- OAuth 2.0 Demonstrating Proof of Possession (DPoP): RFC 9449
- HTTP Message Signatures: RFC 9421

References:

- https://www.rfc-editor.org/rfc/rfc9700.html
- https://www.rfc-editor.org/rfc/rfc9449.html
- https://www.rfc-editor.org/rfc/rfc9421.html

v1 does not invent an SSRL-specific signature format.

## Versioned routes

All routes use `POST` under `/v1/replication`:

```text
/projection/open
/view/info
/view/nodes
/view/leaf
/records/read
/records/apply/semantic
/records/apply/artifacts
/blob/read
/blob/install
```

JSON routes require `Content-Type: application/json`.

The v1 request schemas are strict at the transport envelope: unknown top-level route fields, unknown Merkle-ref fields, and unknown replication-record envelope fields are rejected instead of being silently discarded. A client-supplied `principal` field is therefore invalid input rather than an alternate identity channel.

Unknown route/version/method/media type is rejected rather than being silently interpreted.

## Host and Origin boundary

The handler has server-configured hostname and optional Origin-hostname allowlists. Host and Origin parsing rejects userinfo/path/query/fragment smuggling such as `evil.example@localhost` rather than reducing it to the apparent final hostname.

This is defense in depth for deployments reachable from browser-capable environments and for obvious host-header misuse. It does not replace authentication, authorization or a hardened reverse proxy.

## Bounded request bodies

The handler does not trust `Content-Length` alone.

It:

1. rejects an invalid or already-over-limit declared length;
2. reads the actual request stream incrementally;
3. cancels and rejects if observed bytes exceed the configured maximum.

Default JSON request limit is 1 MiB with an 8 MiB hard configuration ceiling.

Artifact blob installation has a separate larger bounded request limit because raw bytes must not be forced through JSON/base64.

## Bounded remote responses

The client applies the symmetric rule to responses:

- validates `Content-Length` if present;
- counts actual streamed bytes;
- rejects responses exceeding configured JSON/blob limits;
- validates response media type before decoding JSON;
- uses fatal UTF-8 decoding;
- rejects malformed JSON;
- rejects unknown top-level response/envelope fields for the versioned v1 shapes.

Reconciliation responses are structurally and cryptographically sanity-checked before the existing session consumes them:

- supported reconciliation schema;
- SHA-256 root/hash format;
- requested view ID binding;
- requested node count/order/reference binding;
- requested leaf ID binding;
- canonical/sorted replication descriptors;
- exact record-read key-set match;
- every returned full record passes `verifyReplicationRecord()`.

The transport therefore does not blindly cast remote JSON into internal types.

## Stable public error envelope

JSON errors use:

```json
{
  "schema": "ssrl-replication-http-error-v1",
  "code": "...",
  "message": "..."
}
```

Internal stack traces and request bodies are not reflected.

Intentional mappings include:

```text
expired authorized view -> 409 view-expired
revoked authorized view -> 409 view-revoked
unknown/mismatched view -> non-specific view-unavailable
hidden/global-missing record -> 404 record-unavailable
hidden/global-missing/physical-missing blob -> 404 blob-unavailable
unauthorized apply -> 403 apply-denied
bounded-limit failure -> 413 limit-exceeded
invalid replication envelope/cursor/integrity -> 400 invalid-replication-data
unexpected exception -> generic 500 internal-error
```

Non-enumerating record/blob behavior from `ReplicationAccessGateway` survives the HTTP boundary.

## Merkle reconciliation over HTTP

`ReplicationHttpClient.endpoint(projectionId)` implements the existing `ReconciliationEndpoint` contract.

No HTTP-specific reconciliation algorithm exists.

A normal flow is:

```text
open local authorized view
open remote authorized view over HTTP
        ↓
BoundedReconciliationSession
        ↓ HTTP node/leaf queries
localOnly / remoteOnly / collisions
```

An immutable same-key/different-payload collision remains a collision. HTTP does not introduce last-writer-wins.

## Two-node convergence proof

The test suite starts actual Node TCP servers on loopback with independent SQLite semantic stores.

The peers begin with:

```text
shared immutable entity/alias
left-only semantic record
right-only semantic record
```

Then:

1. both open authorized projections;
2. the existing bounded session reconciles across HTTP;
3. each side reads/applies the other's missing records in bounded batches;
4. fresh authorized roots/counts become equal;
5. a second reconciliation returns no delta.

This is the first repository checkpoint that proves the replication stack converges across a real HTTP request/response boundary rather than only in-process interfaces.

## Artifact blob read

Artifact metadata remains an immutable JSON replication record.

Raw CAS bytes use `/blob/read`:

```text
JSON request
        ↓
projection + record:read + artifact-blob:read
        ↓
raw HTTP response body
```

Response metadata includes bounded headers for digest and size plus the authorized media type.

The client independently checks:

- requested digest matches response metadata;
- actual body size equals declared/authorized size;
- SHA-256(body) equals digest.

Blob bytes are never base64 encoded into JSON.

## Artifact blob install frame

`/blob/install` uses:

```text
Content-Type: application/vnd.ssrl.replication-blob-install-v1

[4-byte unsigned big-endian metadata length]
[canonical UTF-8 JSON metadata]
[raw blob bytes]
```

Metadata contains:

```text
projectionId
verified artifact replication record
optional maxBytes tightening
```

The server bounds total request bytes and metadata length before use. It rejects truncated/noncanonical/oversized frames before calling CAS mutation code.

The existing `ReplicationAccessGateway.installArtifactBlob()` then performs:

```text
verify immutable record
record:apply authorization
artifact-blob:apply authorization
verify byte size + SHA-256
allow-audit preflight
ArtifactStore.putBlob()
verify returned descriptor
```

### Blob install does not apply artifact metadata

CAS installation and artifact mutation append remain deliberately separate operations.

The end-to-end test proves:

```text
blob install
  -> target CAS contains blob
  -> target mutation list still empty

record apply
  -> mutation metadata appended
```

A crash between these operations may leave an unreferenced CAS blob. That is an accepted safe asymmetry; future GC/retention owns cleanup.

Same-content blob install and mutation apply remain idempotent.

## Node HTTP adapter

`startNodeReplicationHttpServer()` is a small runtime adapter, not a new domain layer.

It:

- accepts Node `IncomingMessage` as a stream;
- exposes it to the Fetch handler with `duplex: "half"`;
- streams `Response.body` to the Node response;
- honors output backpressure;
- defaults to loopback and ephemeral port.

Public deployment configuration remains a separate concern.

## Benchmark v1

Run:

```bash
pnpm build
pnpm benchmark:replication:http:v1
```

The deterministic local loopback fixture contains:

```text
source: 64 semantic observations + one artifact mutation
peer:   32 shared semantic observations
blob:   41 raw bytes
```

Expected semantic/artifact delta:

```text
32 semantic records
1 artifact mutation
0 collisions
final authorized record count: 67
```

Current local accounting on 2026-09-25:

```text
53 HTTP requests
32,837 request-body bytes
  32,024 JSON request bytes
     813 binary request bytes
63,133 response-body bytes
  63,092 JSON response bytes
      41 binary response bytes
```

Reconciliation accounting:

```text
44 steps
12 remote node queries
221 remote node hashes
32 remote leaf pages
35 remote leaf descriptors
10,459 remote leaf descriptor bytes
```

Elapsed time is recorded by the benchmark but is observational only. This loopback fixture does **not** model WAN RTT, TLS handshake, OAuth/DPoP verification, reverse proxies, relays, remote disk latency, congestion, mobile networks or production throughput.

## Verified v1 behavior

Tests cover:

- auth before malformed-body parsing and source scan;
- authenticated identity cannot be overridden by JSON;
- credential-like extra principal fields do not reach policy;
- principal-specific authorized Merkle roots over one store;
- existing bounded session over an async HTTP `ReconciliationEndpoint`;
- real loopback two-node semantic convergence and second-run no-op;
- immutable collision remains collision, never LWW;
- view expiry/revocation semantics survive transport;
- hidden and globally missing records share one public unavailable response;
- raw blob read + client-side tamper detection;
- binary blob install + separate metadata apply + idempotent replay;
- unauthenticated/truncated/oversized blob frames do not mutate CAS;
- host/origin/media-type/body-limit rejection;
- non-loopback cleartext client rejection;
- malformed/wrong-schema/invalid-envelope/oversized remote responses fail before consumers use them.
- unknown v1 request/response fields fail closed instead of being ignored.
- malformed Host/Origin authorities, non-POST methods and unknown route versions are rejected.

## Non-goals

v1 deliberately does not provide:

- TLS certificate issuance/termination;
- OAuth Authorization Server implementation;
- JWT/DPoP verification;
- generic HTTP Message Signature algorithm/profile negotiation;
- durable device enrollment, rotation, recovery or key exchange;
- end-to-end replication payload encryption;
- cloud relay service;
- WebSocket or QUIC protocol;
- resumable/chunked large-blob transfer;
- distributed CAS garbage collection;
- active-active source receipt/witness semantics.

## Next security layer

Now that a real bounded wire boundary exists, device trust and confidentiality can be designed against a concrete protocol rather than against hypothetical library calls.

A concrete sender-constrained option now exists as the RFC 9421/RFC 9530 Ed25519 profile documented in `device-bound-http-signatures-v1.md`. OAuth deployments can still supply a DPoP-aware authenticator instead.

The next security work should add durable device enrollment/revocation/recovery and then evaluate E2E record/blob encryption for untrusted relay/cloud storage. That work must preserve the current separation between authentication, projection authorization, immutable record integrity and replication reconciliation.
