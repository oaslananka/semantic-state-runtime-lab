# Semantic State Runtime Lab

Private engineering lab for a user-owned, protocol-neutral Personal AI Runtime.

The repository is testing the hard infrastructure needed for one person's durable context to remain usable across AI models and agent transports without making any model vendor or source application the canonical owner of that context.

## Current architecture

```text
source systems / local files
        ↓
connectors + restart-safe ingestion
        ↓
immutable Artifact Plane + Semantic State Store
        ↓
bitemporal state / retractions / typed identity / relations
        ↓
incremental Context Capsules
        ↓
Context Access Gateway
        ↓
retrieval / future agent adapters

AI side effects:
agent -> RuntimeHost plan/apply -> provider preconditions -> journal
```

Implemented checkpoints include:

- canonical entity identity and typed alias resolution;
- bitemporal semantic observations and immutable retractions;
- explicit field authority and conflict detection;
- deterministic reconciliation planning and proposal digests;
- durable SQLite semantic state + ordered change feed;
- incremental, time-aware context capsules;
- Markdown filesystem and Google Calendar ingestion adapters;
- immutable content-addressed Artifact Plane;
- policy-enforced artifact access;
- local stdio MCP composition;
- authenticated stateless MCP 2026-07-28 HTTP composition;
- principal-aware, capsule-backed derived context access;
- MCP `context.compile` projection with authenticated `context:read` preflight;
- policy-scoped prefix-Merkle replication with bounded resumable sessions;
- principal-scoped immutable record + artifact blob transfer;
- authenticated bounded replication HTTP with real two-node semantic/artifact convergence;
- optional Ed25519 device-bound HTTP Message Signature authentication with replay defense;
- epoch-scoped opaque encrypted replication object identities that hide plaintext record/blob identifiers and digests from an untrusted relay.

## Design posture

Core constraints are intentionally stricter than a conventional "RAG over personal files" system:

- source evidence remains auditable;
- derived caches/indexes are rebuildable and never define truth;
- authorization happens before identity resolution/ranking when disclosure could leak hidden state;
- agents receive bounded semantic context rather than unrestricted source-system search;
- transport authentication and domain authorization are separate layers;
- protocol adapters such as MCP do not define canonical semantics.

See `docs/invariants.md` and the versioned design documents under `docs/`.

## Near-term gaps

The lab is not yet a consumer product. Important remaining work includes:

- more source connectors and semantic mappings;
- historical context-access semantics;
- opaque provenance/evidence expansion handles;
- device enrollment, sender-constrained authentication and key rotation;
- opaque-descriptor Merkle/reconciliation and ciphertext HTTP/storage integration for untrusted relay/cloud deployments;
- active-active source receipt/witness semantics;
- deployment composition, real IdP verifier integration and observability;
- product UX, onboarding, sync operations and commercial packaging.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm benchmark:context:v2
pnpm benchmark:google-calendar:v1
pnpm benchmark:markdown:v1
pnpm test:stdio
```
