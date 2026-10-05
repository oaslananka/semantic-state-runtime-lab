# Package Boundary Agent Instructions

These instructions apply to every workspace under `packages/**` and supplement the repository root instructions.

## Package-family ownership

Keep these responsibilities distinct:

- `core`, `state-store`, `materializer` — canonical semantic records, state transitions, materialization and deterministic state behavior.
- `artifact-store`, `artifact-access`, `storage-local-artifacts` — immutable artifact bytes, digest verification and access policy.
- `access`, `context-access`, `replication-access` — principal-aware authorization and disclosure boundaries.
- `context`, `storage-sqlite-capsules` — context-capsule construction/cache state; derived context never defines canonical truth.
- `ingestion`, `connector-sdk`, `connector-*` — source evidence capture, restart-safe ingestion and provider/source mappings.
- `runtime`, `runtime-host`, `journal` — plan/apply side effects, preconditions and durable mutation evidence.
- `replication`, `replication-http`, `opaque-*`, `storage-*-opaque-*` — immutable replication, bounded reconciliation, verified Merkle/inventory state and opaque relay representations.
- `device-trust`, `device-trust-http`, `storage-sqlite-device-trust`, `vault-keyring`, `storage-sqlite-vault-keyring` — device identities, signatures, key lifecycle/recovery and protected key persistence.
- `http-wire`, `mcp-server`, `mcp-http`, `node-app` — transport/application adapters around canonical runtime semantics.
- `e2e` — executable integration evidence; it must consume public contracts rather than becoming a production dependency.

## Canonical semantics versus adapters

- Provider IDs, HTTP/MCP framing, SQLite row IDs, local filenames and relay object names are adapter/storage details unless a versioned semantic contract explicitly promotes them.
- Do not make caches, search indexes, transport cursors or database internals part of portable canonical identity.
- Keep deterministic functions pure where practical; filesystem, database, clock, network and crypto side effects belong at explicit boundaries.
- Do not duplicate canonical normalization/conflict rules inside each connector or transport.

## Access packages

Authorization happens before operations that could disclose protected state.

- A valid principal/session/device signature proves identity, not authorization to all namespaces.
- Prefix, namespace, artifact, capsule and mutation scopes remain explicit.
- Hidden aliases/IDs must not leak through resolution, ranking or distinguishable errors before authorization.
- Read-only bindings never receive mutation authority.

## Storage packages

- Persistence implements the semantic contract; it does not redefine it.
- Preserve ordered/durable change feeds and transaction boundaries required by the owning design.
- Migrations/schema changes must retain existing durable state unless an explicit migration contract says otherwise.
- SQLite WAL/page/cursor details are backend-local and never replication identity.
- Do not silently discard conflicts, retractions, provenance or journal history to simplify storage.

## Replication packages

- Immutable record identity uses stable typed keys and canonical payload verification.
- Identical payload for the same immutable key is idempotent; divergent payload for the same key fails closed.
- Verify externally supplied roots, fingerprints, descriptors and blob digests before using them for reconciliation decisions.
- Inventories contain descriptors only where the design promises that boundary.
- Keep reconciliation/apply bounded and resumable rather than one unbounded transaction.
- Opaque relay views must preserve the documented non-disclosure properties across epochs.

## Device trust and keyring packages

- Preserve algorithm, key identity, sender constraint, timestamp, nonce and replay semantics exactly.
- Key material is never logged or serialized through generic debug/evidence paths.
- Recovery and rotation must be explicit state transitions with regression tests.
- Do not add plaintext fallback key persistence where encrypted/keyring-backed storage is required.

## Runtime host and journal

- Plan before apply.
- Carry observed provider/source revision preconditions into mutations where supported.
- Retries must preserve idempotency semantics and must not duplicate paid/external side effects.
- Journal attempted and applied mutations according to the versioned contract.
- Unknown provider outcomes remain unknown; do not synthesize success after timeout/transport ambiguity.

## Connectors

- Connectors capture source evidence and map it into canonical semantics through explicit contracts.
- Source receipts/cursors are source-local operational state, not portable semantic identity.
- Restart/resume must not duplicate canonical observations or hide source gaps.
- Until replica-stable receipt semantics exist, do not pretend independent active-active ingestion of one source key is safe.

## MCP and HTTP adapters

- Protocol adapters do not define canonical semantics.
- Authentication and domain authorization stay separate.
- Validate/bound request sizes, sessions and reconciliation work.
- Preserve exact versioned wire contracts and fail closed on malformed security-sensitive messages.
- Stdio protocol output must not be polluted by diagnostic logging.
- Remote HTTP behavior must preserve the documented authenticated/stateless or device-bound signature model.

## Tests

For a package change, run its focused tests/typecheck first, then root `pnpm typecheck`, `pnpm test` and `pnpm build`. Run the matching benchmark/smoke command for replication, ingestion, context, MCP or connector changes.
