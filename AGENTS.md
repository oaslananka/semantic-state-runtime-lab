# Semantic State Runtime Lab Agent Instructions

These instructions apply repository-wide. Read `docs/invariants.md` before changing semantics, authority, replication, access, identity, journaling, or transport behavior.

## Scope and precedence

- `AGENTS.md` is the repository-wide contract.
- `packages/AGENTS.md` adds package-family rules for every workspace under `packages/**`.
- The closest applicable file adds detail but may not weaken the core invariants, provenance, authorization, replication, or fail-closed rules.
- Versioned design documents under `docs/**` are architecture contracts, not disposable notes. When implementation intentionally changes a versioned contract, update the design document and tests together.

## Repository posture

This repository is a private engineering lab for a protocol-neutral personal AI runtime. It is not yet a consumer product.

Do not turn experimental capability into product claims. Benchmarks and local demonstrations prove only the exact scenario executed.

Core architecture:

```text
source systems / local files
  -> restart-safe ingestion
  -> immutable Artifact Plane + Semantic State Store
  -> bitemporal state / retractions / typed identity / relations
  -> incremental Context Capsules
  -> Context Access Gateway
  -> protocol adapters / future agents

agent side effects
  -> RuntimeHost plan/apply
  -> provider preconditions
  -> journal
```

## Non-negotiable semantic invariants

Preserve the invariants in `docs/invariants.md`, especially:

- canonical identity is independent of provider identifiers;
- every canonical property remains source-traceable;
- authority may outrank recency;
- equal-precedence ambiguity becomes an explicit conflict rather than a guess;
- read-only bindings never receive mutations;
- deterministic reconciliation produces identical plans for equivalent state;
- derived indexes, caches and transports never define canonical semantics;
- backend-local WAL/pages/cursors/indexes never become portable replication identity;
- immutable-record conflicts fail closed;
- raw artifacts remain content-digest-verified and separate from metadata inventories;
- reconciliation inventories contain descriptors, not canonical payload bodies;
- externally supplied roots/fingerprints are verified before reconciliation decisions;
- apply/reconciliation work remains bounded.

## Authorization and disclosure ordering

Authorization can be semantically observable. Where hidden identifiers, aliases, ranking candidates, artifacts or records could reveal protected state, authorize before identity resolution, ranking, expansion or retrieval.

Transport authentication and domain authorization are separate concerns. A valid HTTP/MCP/device signature does not imply semantic access to every namespace, record, artifact, capsule or mutation.

## Mutation and journaling

- Prefer plan/apply APIs with explicit preconditions over direct provider mutation.
- Mutations preserve the external revision/precondition observed during planning where available.
- Journal entries are durable evidence of attempted/applied side effects; do not silently omit or rewrite them to make a flow look converged.
- A converged system produces an empty mutation plan.
- Provider-specific states stay behind bindings/adapters unless the canonical semantic model intentionally promotes them.

## Cryptography, device trust and replication

- Keep signatures, nonces, timestamps, key identities, epochs and replay-defense semantics explicit.
- Opaque replication must not leak plaintext record/blob identifiers or canonical digests to an untrusted relay when the documented design promises opacity.
- Never weaken digest verification, sender constraints, key rotation/recovery, bounded sessions, Merkle verification or replay protection for convenience.
- Do not invent cryptographic guarantees beyond the exact implemented protocol and tests.

## Toolchain and verification

Use the checked-in package manager and lockfile:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm test:stdio
```

Run the focused benchmark or smoke test for the changed subsystem. Benchmark outputs are regression/evidence tools, not universal performance claims.

The GitHub CI workflow is authoritative for the exact PR head. Do not weaken or skip typecheck, tests, build, stdio smoke or benchmark smoke gates to land unrelated work.

## Dependency and package discipline

- Keep package boundaries explicit; avoid circular or convenience imports that collapse canonical semantics into storage/transport adapters.
- Shared interfaces should live in the package that owns the semantic contract rather than being duplicated in each adapter.
- Storage packages implement persistence contracts; they do not redefine semantic identity.
- Protocol packages adapt the canonical runtime; they do not become the source of truth.
- Connector packages own source-specific ingestion behavior; source-provider quirks do not leak into canonical semantics unless promoted intentionally.

## Evidence and privacy

- Do not commit personal source data, real calendar content, credentials, device keys, tokens, private artifacts, or production-like secrets.
- Fixtures and benchmark data must be synthetic or explicitly safe.
- Avoid logging canonical/private payload bodies when identifiers, counts, digests, bounded metadata or correlation IDs are sufficient.
- Do not expose hidden state through error differences, enumeration, ranking, replication metadata or debug output.

## Change discipline

- Keep changes narrowly scoped to one semantic or infrastructure objective.
- Add regression tests for semantic, authorization, replication, cryptographic, storage and mutation fixes.
- Do not replace fail-closed behavior with best-effort guessing.
- Do not rewrite versioned design documents merely to match an accidental implementation regression.
- Do not introduce a hosted control plane, vendor-specific canonical model, broad source-system search, or consumer-product claim without an explicit architecture decision.

## Definition of done

A change is ready when the implementation, relevant versioned design contract, focused tests, package boundaries, benchmark/smoke evidence and exact-head CI agree. State clearly what was not exercised.
