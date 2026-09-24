# MCP runtime adapter v1

`@ssrl/mcp-server` is a protocol adapter over the policy-enforced Runtime Host. MCP is not the authority, state model, connector API, or persistence layer.

## Dependency posture

The adapter is pinned to `@modelcontextprotocol/server@2.1.0` and uses `@modelcontextprotocol/client@2.1.0` in integration tests. The upgrade was made before building remote HTTP because 2.1.0 adds request-time OAuth scope challenges and modern HTTP hardening needed by the authenticated transport boundary.

The repository supply-chain lockfile policy remains enabled; it was not bypassed.

## Construction

```ts
createRuntimeMcpServer({
  host,
  principal,
})
```

`principal` must already be a trusted, normalized `RuntimePrincipal`. This package does not parse bearer tokens, JWTs, OAuth metadata, authorization headers, MCP client metadata, or self-reported client identity.

`@ssrl/mcp-http` now implements the authenticated remote composition: bearer verification happens first, verified auth is mapped to `AccessPrincipal`, and then a fresh request-scoped MCP server is constructed. The raw bearer token is stripped before principal mapping.

## Tool surface

The v1 adapter intentionally exposes only two semantic tools.

### `state.plan`

Input:

```json
{"entityId":"entity://project/atlas"}
```

Properties:

- read-only MCP annotation
- calls `RuntimeHost.plan(entityId, principal)`
- returns policy-filtered canonical state
- returns unresolved conflicts and exact planned mutations
- returns a state-bound SHA-256 proposal digest
- does not apply external mutations

### `state.apply`

Input:

```json
{
  "entityId":"entity://project/atlas",
  "proposalDigest":"sha256:..."
}
```

Properties:

- destructive, non-idempotent MCP annotation
- digest is mandatory
- calls `RuntimeHost.apply(entityId, digest, principal)`
- Runtime Host re-authorizes, re-observes, re-plans, and compares the live proposal digest before any write
- proposal drift returns an error instructing the caller to call `state.plan` again
- the adapter never silently substitutes a new proposal digest
- no generic connector passthrough is exposed

## Results

Successful tool calls return both text `content` and versioned `structuredContent`.

The plan result includes:

- schema version
- entity ID
- proposal status
- digest algorithm and proposal digest
- policy-filtered canonical properties
- exact mutations
- conflicts
- optional journal run ID

The apply result includes:

- schema version
- entity ID
- applied mutation count
- convergence flag
- remaining mutation count
- conflict count
- optional journal run ID

## Errors

Runtime exceptions are mapped to stable tool-level codes with fixed safe messages:

- `access_denied`
- `entity_not_configured`
- `invalid_proposal_digest`
- `proposal_drifted`
- `proposal_blocked`
- `apply_failed`
- `internal_error`

Unexpected exception messages, stacks, causes, principal scopes, and credentials are not serialized.

Malformed MCP inputs are rejected by the registered Zod schemas before Runtime Host policy evaluation.

## Tests

Integration tests use the official MCP v2 `InMemoryTransport.createLinkedPair()` with a real `Client` and `McpServer`; tool handlers are not tested only as direct function calls.

The suite verifies:

- exactly two exposed tools and their annotations
- policy-filtered plan output
- digest-bound successful apply
- stale digest rejection with zero provider writes
- cross-principal digest reuse rejection
- denied fields absent from text and structured output
- input validation before Runtime Host evaluation
- unexpected error redaction

## Transport split

`@ssrl/mcp-server` remains transport-neutral protocol registration. It now also accepts optional coarse `scopeChallenge` configuration for state tools and artifact resources. Without that option, existing stdio/in-process behavior is unchanged.

Authenticated modern Streamable HTTP composition lives in `@ssrl/mcp-http`; see `docs/authenticated-mcp-http-v1.md`.

## Non-goals

This package does not own OAuth token verification, HTTP deployment, connector passthrough, async MCP tasks, or chat UI. Those remain separate layers so transport/auth concerns do not leak into runtime semantics.
