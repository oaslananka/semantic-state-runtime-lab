# Runtime access policy boundary v1

The access-policy layer narrows the trusted Runtime Host for authenticated or delegated callers. It is intentionally independent from MCP, HTTP, OAuth libraries, and token formats.

## Trust model

A transport adapter is responsible for authenticating a caller and constructing a normalized `RuntimePrincipal`:

```ts
{
  subject: "user:alice",
  scopes: ["state:read", "state:write"]
}
```

The runtime never accepts or persists raw bearer tokens, refresh tokens, JWTs, authorization headers, or arbitrary identity-provider claims.

When an `accessPolicy` is configured, a missing principal or missing policy decision is denied.

A Runtime Host without an `accessPolicy` remains an explicitly trusted in-process surface. It must not be exposed directly to untrusted remote callers.

## Decision points

The policy receives three request kinds:

- `operation`: permission to plan or apply for an entity
- `field`: permission to read or write one canonical property through one provider binding
- `proposal`: permission to apply the actual re-observed proposal immediately before digest validation and side effects

The proposal digest is not an authorization credential. A caller presenting a valid digest must independently pass current operation, field, and proposal policy.

## Field projection

Policy can only narrow connector capabilities.

If a source binding says `readable: false` or `writable: false`, policy cannot turn it on.

For policy-enforced planning/apply, each binding is projected before observation:

```text
effective readable = connector readable AND policy read allow
effective writable = connector writable AND policy write allow
```

Provider snapshots are then sanitized again inside the runtime. Values not declared readable by the effective binding are discarded before reconciliation and before journal persistence.

This second filter is deliberate: providers are not trusted to omit extra data.

## Permission drift

Apply re-evaluates current operation/field policy and re-plans from live provider state.

If write permission was available during planning but is revoked before apply, the effective mutation set changes. The state-bound proposal digest therefore changes and apply fails before `provider.apply()`.

Provider revision/precondition checks remain the final race guard after policy and proposal validation.

## Journal identity

When a principal is present, reconciliation events may persist only:

```json
{"actor":{"subject":"user:alice"}}
```

Scopes and other caller credentials are not copied into journal evidence. SQLite journal reads reject expanded actor metadata with fields other than `subject`.

## MCP mapping later

For a future MCP adapter, bearer/OAuth verification belongs at the HTTP boundary. The adapter should map verified auth context into `RuntimePrincipal`, then call this policy-enforced Runtime Host.

MCP client/server self-reported identity metadata must not be used as an authorization principal.
