# Authenticated stateless MCP HTTP v1

`@ssrl/mcp-http` is the authenticated remote transport boundary for SSRL's existing MCP state and artifact surfaces.

```text
HTTP request
  -> Host / Origin validation
  -> Bearer resource-server gate
  -> verified AuthInfo
  -> token-stripped auth context
  -> AccessPrincipal mapper
  -> fresh request-scoped McpServer
  -> RuntimeHost / ArtifactAccessGateway policy
```

Authentication establishes **who the request is**. SSRL policy independently establishes **what that principal may do**.

A valid bearer token is never sufficient authorization by itself.

## SDK baseline

The repository is pinned to the MCP TypeScript SDK v2.1.0 line:

```text
@modelcontextprotocol/server 2.1.0
@modelcontextprotocol/client 2.1.0 (tests)
```

This is important because v2.1.0 adds request-time OAuth scope challenges and hardens modern HTTP request limits while continuing the 2026-07-28 stateless request model.

The repository's supply-chain lockfile policy is not bypassed.

Because MCP v2's published declarations reference Node types under TypeScript >=6, both test and production build configs for the HTTP package include `types: ["node"]`; the production build is tested separately from the broader source typecheck.

## Modern-only remote endpoint

`createAuthenticatedRuntimeMcpHttpHandler()` always configures:

```ts
createMcpHandler(factory, {
  legacy: "reject"
})
```

There is no legacy compatibility flag on this remote factory.

Stdio/in-process MCP remains a separate composition and retains its existing behavior.

For modern MCP 2026-07-28:

- each JSON-RPC request is an independent HTTP POST;
- the handler creates a fresh `McpServer` from the factory for each request;
- SSRL does not rely on protocol session identity;
- modern client tests confirm no `sessionId` is established.

## Bearer verification

The HTTP package does not implement an authorization server or hardcode JWT/JWK logic.

The application supplies the official SDK `OAuthTokenVerifier`:

```ts
createAuthenticatedRuntimeMcpHttpHandler({
  verifier,
  ...
})
```

`requireBearerAuth()` runs before MCP dispatch.

Default endpoint scope:

```text
mcp
```

Expected transport outcomes include:

```text
missing / invalid / expired bearer -> 401
missing base endpoint scope        -> 403 insufficient_scope
```

If configured, the protected-resource metadata URL is included in the standards-based challenge.

The verifier owns token-format validation. SSRL does not assume JWT vs opaque token vs introspection.

## Token-stripped principal mapping

The SDK `AuthInfo` contains the raw access token. SSRL deliberately does **not** expose that object to the domain principal mapper.

Instead the mapper receives:

```ts
interface VerifiedMcpAuthContext {
  clientId: string;
  scopes: readonly string[];
  expiresAt: number;
  resource?: URL;
  resourceMetadataUrl?: string;
  extra?: Readonly<Record<string, unknown>>;
}
```

The `token` field is absent.

This prevents ordinary principal-mapping code from accidentally copying the bearer credential into:

- `AccessPrincipal`;
- runtime policy requests;
- journal evidence;
- artifact audit events;
- application logs owned by SSRL domain packages.

An IdP-specific verifier may still put sensitive values inside `extra`; verifier/mapping configuration remains responsible for exposing only claims needed for principal mapping.

## Subject mapping is explicit

OAuth `clientId` is not universally the human/user subject.

Therefore SSRL has no implicit `clientId -> user` conversion.

Applications provide:

```ts
interface McpAuthPrincipalMapper {
  map(auth: VerifiedMcpAuthContext): AccessPrincipal | Promise<AccessPrincipal>;
}
```

A convenience mapper can read an explicit claim such as `extra.sub`:

```ts
subjectClaimPrincipalMapper({ prefix: "user:" })
```

Missing/malformed subjects fail closed.

Returned principals are normalized through `@ssrl/access`.

Mapper exceptions are replaced by the fixed safe error:

```text
Authenticated principal mapping failed.
```

Original mapper error text is not serialized.

## Self-reported MCP identity is not authorization

The bearer-verified principal is constructed before `createRuntimeMcpServer()`.

MCP `clientInfo`, server metadata, User-Agent, IP address, protocol session metadata, and client-provided names are not passed into principal mapping.

Tests intentionally connect clients named like:

```text
self-reported-admin-root
self-reported-bob
```

while policy still sees only bearer-derived principals such as:

```text
user:alice
user:bob
```

## Request-level scope challenges

Remote v1 defaults to these coarse operation scopes:

```ts
{
  plan: ["state:read"],
  apply: ["state:write"],
  artifacts: ["artifact:read"],
  context: ["context:read"]
}
```

The MCP server attaches SDK `requireScopes()` handlers to tools/resources.

This gives a modern client a proper request-time `403 insufficient_scope` before a callback runs when, for example, a read-only token calls `state.apply`. The wire-level test also verifies that the challenge advertises `state:write` plus the configured protected-resource metadata URL and that RuntimeHost apply policy is never reached.

For resources, the SDK scope challenge applies to the individual resource operation; challenged resources remain discoverable in MCP list operations by design. SSRL therefore does **not** treat `artifact:read` as a substitute for list authorization: `ArtifactAccessGateway.list()` still filters metadata by the mapped principal.

These scopes are **coarse preconditions only**.

They do not replace:

- RuntimeHost operation/field/proposal policy;
- ArtifactAccessGateway resource/version policy;
- ContextAccessGateway operation/entity/property/relation/provenance policy.

A bearer with `artifact:read` can still receive zero resources or not-found semantics because SSRL resource policy denies that specific artifact.

Likewise a bearer with `state:read` can still receive an `access_denied` tool result for an entity denied by RuntimeHost policy.

A bearer with `context:read` can likewise still receive a sanitized `access_denied` result because `ContextAccessGateway` remains authoritative after the coarse MCP scope preflight. A bearer without `context:read` receives a request-time `403 insufficient_scope` before the context gateway callback runs. The bearer identity is mapped to the server-side principal; the MCP tool input has no principal field and cannot override it.

## Host and Origin validation

`allowedHostnames` is mandatory configuration.

`allowedOriginHostnames` defaults to the host allowlist unless explicitly supplied.

Both checks execute **before bearer verification**.

This avoids spending verifier work or accepting credentials on a request whose host/origin is not intended for this endpoint.

The package uses the SDK's standard host/origin helpers rather than custom header parsing.

## Modern wire validation

SSRL does not hand-parse the 2026-07-28 per-request MCP envelope or standard MCP headers. After Host/Origin and bearer verification, the request is passed to `createMcpHandler()`, which owns protocol classification and validation.

The integration suite verifies SDK rejection for:

- missing `MCP-Protocol-Version`;
- `Mcp-Method` disagreement with the JSON-RPC body;
- protocol-version disagreement;
- malformed modern `_meta` missing required `io.modelcontextprotocol/clientCapabilities`.

The modern test helper uses the actual namespaced envelope keys:

```text
io.modelcontextprotocol/protocolVersion
io.modelcontextprotocol/clientInfo
io.modelcontextprotocol/clientCapabilities
```

This keeps SSRL out of protocol-parser business and makes SDK upgrades responsible for future wire-rule changes.

The endpoint also does not accept query-string credentials. Authentication is the standard `Authorization` bearer header path only. With `legacy: "reject"`, a GET request is not treated as an authenticated modern session operation.

## Request size

`maxRequestBodySize` is passed to `createMcpHandler()`.

A body above the configured limit is rejected with HTTP `413` before a request-scoped MCP server or principal mapper is created.

Authentication still occurs first because bearer verification is the outer resource-server gate.

Tests prove:

```text
oversized body
-> token verification may run
-> principal mapper = 0 calls
-> MCP server factory = not reached
```

## State semantics over HTTP

The HTTP adapter does not reimplement reconciliation.

Modern HTTP tests run the same existing path:

```text
state.plan
  -> RuntimeHost.plan
  -> policy-filtered live proposal
  -> SHA-256 proposal digest

state.apply(digest)
  -> RuntimeHost.apply
  -> re-auth + re-observe + re-plan
  -> digest/drift checks
  -> provider side effect
```

A writer token successfully plans and applies the exact digest across separate stateless HTTP requests.

A reader token receives `insufficient_scope` before `state.apply` callback execution.

## Artifact semantics over HTTP

The HTTP composition passes the same request principal into the existing MCP Artifact Resource adapter.

The ArtifactAccessGateway still performs resource/version-bound authorization on every list/read.

Tests prove a token with valid endpoint + `artifact:read` scopes still cannot read an artifact denied to its mapped subject.

No HTTP authentication shortcut bypasses the gateway.

## Modern cache hints on the wire

The previous in-memory legacy harness could only test the registered cache-hint constant.

The new modern Streamable HTTP client pins protocol revision `2026-07-28` and verifies actual response fields:

```json
{
  "ttlMs": 0,
  "cacheScope": "private"
}
```

for both `resources/list` and `resources/read`.

This closes the wire-level cache-hint gap from Artifact Access Gateway v1.

## No protocol session principal

Two clients can issue concurrent requests with different bearer tokens through the same HTTP handler.

Each request:

1. verifies its own Authorization header;
2. constructs its own token-stripped auth context;
3. maps its own principal;
4. creates its own request-scoped MCP server.

There is no mutable module-level `currentUser` or session principal.

Concurrent Alice/Bob tests verify both identities reach policy independently with no clientInfo influence. A separate repeated-request test deliberately returns an unnormalized principal from the mapper and proves every request independently reaches policy as the same canonical `{ subject, scopes }` value; principal mapping is not cached in a protocol session.

## Security layering

The remote security model is intentionally layered:

```text
Host/Origin allowlist
        ↓
Bearer verification + expiry
        ↓
base endpoint scope
        ↓
AuthInfo -> AccessPrincipal mapping
        ↓
request-time coarse MCP scope challenge
        ↓
RuntimeHost / ArtifactAccessGateway policy
        ↓
proposal digest / provider preconditions / artifact byte bounds
```

Removing any inner layer is not justified by the presence of an outer one.

## Verified cases

The modern HTTP integration suite verifies:

- pinned 2026-07-28 client connects;
- modern protocol era with no session ID;
- fresh per-request server/principal factory path;
- repeated same-token requests yield the same normalized principal;
- concurrent Alice/Bob token isolation;
- spoofed clientInfo cannot affect principal;
- exact plan/apply digest flow over separate HTTP requests;
- request-time `state:write` scope challenge, including wire `WWW-Authenticate` metadata and pre-handler enforcement;
- artifact list/read over modern HTTP;
- real private/ttl0 cache hints on modern wire;
- valid artifact scope still subject to ArtifactAccessGateway policy;
- missing bearer -> 401;
- invalid bearer -> 401 `invalid_token`;
- expired bearer -> 401;
- missing endpoint scope -> 403 `insufficient_scope`;
- protected-resource metadata challenge parameter;
- missing subject claim fails closed;
- query-string credential is ignored/rejected;
- GET is rejected on the modern-only endpoint;
- missing/mismatched modern standard headers are rejected by the SDK;
- malformed modern per-request envelope is rejected by the SDK;
- invalid Host / Origin rejected before verifier;
- oversized body -> 413 before principal mapping;
- principal mapper failures sanitized;
- raw access token absent from mapper input and bearer error responses;
- remote legacy traffic rejected;
- existing stdio/in-memory MCP state + artifact tests remain unchanged.

## Non-goals

v1 does not implement:

- OAuth authorization server;
- login/consent UI;
- token issuance or refresh;
- IdP-specific JWT/JWK verifier;
- dynamic client registration;
- cloud tenancy/account database;
- DPoP server enforcement;
- protocol sessions;
- request-state multi-round-trip workflows;
- public internet deployment automation;
- TLS termination;
- reverse-proxy trust configuration.

## Next step

The next meaningful layer is **deployment composition**, not another auth abstraction:

```text
node/http or platform fetch endpoint
+ real verifier implementation supplied by deployment
+ TLS/reverse-proxy config
+ health/readiness
+ durable security/audit sink
+ load/concurrency limits
```

Before that, the runtime now has a tested standards-aligned request security boundary independent from any one identity provider.
