# Local Node runtime v1

`@ssrl/node-app` is the first runnable local composition of the SSRL packages.

It combines:

- one or more explicit Markdown filesystem providers
- canonical entity bindings and provider authority rules
- principal-scoped field policy
- the state-bound Runtime Host
- file-backed SQLite journal evidence
- the two-tool MCP adapter
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
  "principal": {
    "subject": "user:local",
    "scopes": ["state:read", "state:write"]
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

The SQLite journal is opened only after config and provider-root validation complete.

On POSIX systems a group/world-writable config file emits a warning to stderr.

## Path safety

Markdown `externalId` values must be relative `.md` paths using forward slashes. Absolute paths, parent traversal, dot segments, empty segments, backslashes, and NUL bytes are rejected.

The Markdown connector also resolves the target through `realpath()` and rejects symbolic-link escapes outside the configured root.

## Policy

Policy is default-deny.

The configured principal is explicit and is not inferred from MCP client metadata.

For field access:

```text
effective read  = connector read capability  AND policy read grant
effective write = connector write capability AND policy write grant
```

A policy grant can optionally restrict a canonical property to named providers.

The proposal digest is never an authorization credential. `state.apply` re-evaluates current policy and live provider state before any external write.

## Persistence

Reconciliation evidence is stored in the configured SQLite file.

Restarting the local process with the same journal path preserves prior event history. Journal actor evidence contains only the principal subject; scopes and credentials are not persisted.

## Verification

The repository test suite covers real Markdown and SQLite behavior with the MCP adapter.

The separate build-after-test stdio smoke gate spawns `dist/cli.js` as a real child process through the official MCP `StdioClientTransport`. It verifies tool discovery, planning, apply, stale-digest rejection, denied-field redaction, journal creation, restart, and that invalid startup writes nothing to stdout.
