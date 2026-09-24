# Local Node runtime v1

`@ssrl/node-app` is the first runnable local composition of the SSRL packages.

It combines:

- one or more explicit Markdown filesystem providers
- canonical entity bindings and provider authority rules
- principal-scoped field policy
- the state-bound Runtime Host
- file-backed SQLite journal evidence
- the state MCP tools, plus optional `context.compile` and artifact resources
- stdio transport

It does not open a network listener.

## Build and run

```bash
pnpm build
node packages/node-app/dist/cli.js ./ssrl.config.json
```

The process writes MCP protocol traffic only to stdout. Startup warnings and transport diagnostics go to stderr.

Exactly one config path is required. There is no implicit vault discovery.

## Config v1

Paths are resolved relative to the config file unless they are absolute.

```json
{
  "schemaVersion": "1",
  "journalPath": "./state/runtime.sqlite",
  "context": {
    "semanticStatePath": "./state/semantic.sqlite",
    "ingestionStatePath": "./state/ingestion.sqlite",
    "artifactStoreRoot": "./state/artifacts",
    "sources": [
      { "provider": "source", "externalType": "markdown" },
      { "provider": "replica", "externalType": "markdown" }
    ],
    "maxBudgetTokens": 512
  },
  "principal": {
    "subject": "user:local",
    "scopes": ["state:read", "state:write", "context:read"]
  },
  "providers": [
    {
      "id": "source",
      "root": "./source-vault",
      "manifest": {
        "schemaVersion": "0.1",
        "id": "source",
        "displayName": "Source vault",
        "capabilities": {
          "read": true,
          "write": false,
          "observe": true,
          "subscribe": false,
          "revisions": "opaque",
          "idempotency": "none"
        },
        "entities": [
          {
            "canonicalType": "Project",
            "externalType": "markdown",
            "fields": [
              {
                "canonical": "Project.deadline",
                "external": "deadline",
                "access": ["read"]
              }
            ]
          }
        ]
      }
    },
    {
      "id": "replica",
      "root": "./replica-vault",
      "manifest": {
        "schemaVersion": "0.1",
        "id": "replica",
        "displayName": "Replica vault",
        "capabilities": {
          "read": true,
          "write": true,
          "observe": true,
          "subscribe": false,
          "revisions": "opaque",
          "idempotency": "none"
        },
        "entities": [
          {
            "canonicalType": "Project",
            "externalType": "markdown",
            "fields": [
              {
                "canonical": "Project.deadline",
                "external": "deadline",
                "access": ["read", "write"]
              }
            ]
          }
        ]
      }
    }
  ],
  "entities": [
    {
      "entityId": "entity://project/atlas",
      "aliases": ["Project Atlas", "Atlas"],
      "bindings": [
        {
          "provider": "source",
          "externalId": "projects/atlas.md",
          "canonicalType": "Project"
        },
        {
          "provider": "replica",
          "externalId": "projects/atlas.md",
          "canonicalType": "Project"
        }
      ],
      "authority": [
        {
          "property": "Project.deadline",
          "provider": "source"
        }
      ]
    }
  ],
  "policy": {
    "operations": {
      "plan": true,
      "apply": true
    },
    "fields": [
      {
        "entityId": "entity://project/atlas",
        "property": "Project.deadline",
        "read": true,
        "write": true
      }
    ]
  }
}
```

A binding does not repeat field capability metadata. Its readable/writable fields are derived from the referenced connector manifest and can only be narrowed by policy.

The `context` block is optional. Without it, the local app remains state-only and does not expose `context.compile`. With it, `sources` is an explicit allowlist of authoritative context source mappings. A source is identified by `(provider, externalType)` and must match exactly one manifest entity mapping. Only bindings that participate in those configured sources enter the Context Plane.

## Startup validation

Before the stdio protocol loop begins, the app validates:

- config schema version and JSON shape
- connector manifests
- unique provider and entity IDs
- provider references and canonical type mappings
- authority rules
- field policy references
- principal scope consistency
- Markdown external IDs
- provider roots as existing directories
- unique context sources and exact `(provider, externalType)` manifest mapping
- at least one binding for each configured context source
- explicit aliases for context-participating entities
- normalized alias uniqueness
- duplicate `(provider, externalId)` context bindings
- dedicated journal / semantic-state / ingestion-state / artifact metadata paths
- `context:read` when context is enabled

The SQLite journal is opened only after config and provider-root validation complete.

On POSIX systems a group/world-writable config file emits a warning to stderr.

## Path safety

Markdown `externalId` values must be relative `.md` paths using forward slashes. Absolute paths, parent traversal, dot segments, empty segments, backslashes, and NUL bytes are rejected.

The Markdown connector also resolves the target through `realpath()` and rejects symbolic-link escapes outside the configured root.

## Local Context Plane

When `context` is configured, the local process composes one knowledge path:

```text
configured Markdown sources
  -> authoritative ingestion
  -> SQLite ingestion state
  -> SQLite Semantic State Store
  -> Local Artifact Store
  -> semantic change feed
  -> incremental Context Capsules
  -> ContextAccessGateway
  -> MCP context.compile
```

There is no direct `RuntimeHost -> context` shortcut. Semantic context and raw artifacts come from the same mapped ingestion round, so artifact projection cannot lag behind an already-persisted semantic-only mapped plan.

Configured aliases are seeded as deterministic append-only semantic alias evidence. Adding an alias is supported. Removing or renaming a previously persisted config-owned alias fails closed in v1 because alias validity/retraction is not yet modeled.

The in-memory capsule cache is derived and rebuildable. Restarting with the same durable stores replays the semantic change feed and reconstructs current capsules.

### Freshness and authoritative inventory

Before `context.compile` or artifact list/read is delegated, the local runtime passes every configured source through the same coalesced source-verification gate. The default `context.sourceVerificationMaxAgeMs = 0` preserves the original correctness-first behavior: every access performs the authoritative recursive Markdown scan.

With an explicit positive `sourceVerificationMaxAgeMs`, one recursive `fs.watch` handle per configured root is used only as a **dirty hint**. Clean sources may skip rescanning until the verification-age bound expires. A dirty hint, age expiry, startup, watcher setup failure, watcher runtime error, or unexpected watcher close causes an authoritative scan. Watcher failure degrades to scan-on-every-access rather than stale-cache fallback.

The event filename/type is never interpreted as source truth. Any scan still executes the existing strict configured external-ID inventory, full-generation deletion sweep, revision checks, and ingestion/retraction logic. Concurrent accesses coalesce one in-flight verification round. Separate clean roots are not rescanned merely because another root is dirty.

A restart never trusts prior watcher state: the first access verifies all configured sources even when the durable Context Capsule cache is warm. Changing only `sourceVerificationMaxAgeMs` is runtime tuning and does not change persistent source-topology identity.

See `docs/source-verification-v1.md` for failure semantics, bounded-staleness tradeoffs, and benchmark measurements.

## Policy

Policy is default-deny.

The configured principal is explicit and is not inferred from MCP client metadata.

For field access:

```text
effective read  = connector read capability  AND policy read grant
effective write = connector write capability AND policy write grant
```

A policy grant can optionally restrict a canonical property to named providers. Canonical context still requires `context:read`; entity/property visibility is filtered by the configured field read grants. Markdown-only local context exposes no inferred relations. Provenance IDs are hidden unless the principal also has `artifact:read`. Raw artifacts are never granted merely because `context:read` is present.

The proposal digest is never an authorization credential. `state.apply` re-evaluates current policy and live provider state before any external write.

## Persistence

Reconciliation evidence is stored in the configured SQLite file.

Restarting the local process with the same journal path preserves prior event history. Journal actor evidence contains only the principal subject; scopes and credentials are not persisted.

When context is enabled, semantic state, ingestion receipts/projections, and raw artifact versions use separate durable stores. Reusing persistent context storage with a changed source/storage topology fails closed unless an explicit migration or fresh context store is used.

## Verification

The repository test suite covers real Markdown and SQLite behavior with the MCP adapter.

The separate build-after-test stdio smoke gate spawns `dist/cli.js` as a real child process through the official MCP `StdioClientTransport`. It verifies tool discovery, planning, apply, stale-digest rejection, denied-field redaction, real `context.compile`, semantic/artifact persistence, restart, and that invalid startup writes nothing to stdout. The in-process composition tests additionally cover edits, field/file deletion retractions, strict unknown-file failure, stale-context suppression, alias drift, artifact scope, source-sync coalescing, and same-revision semantic/artifact projection.
