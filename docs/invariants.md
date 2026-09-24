# Core invariants

These are design constraints, not implementation details.

1. Canonical identity is independent of every external provider identifier.
2. Every canonical property value has traceable source provenance.
3. Explicit authority may outrank recency.
4. Ambiguous equal-precedence disagreement becomes a conflict; the engine must not guess.
5. Read-only bindings never receive mutations.
6. Reconciliation planning is deterministic for equivalent input state.
7. A converged system produces an empty mutation plan.
8. A mutation carries the external revision observed during planning when available.
9. Derived indexes and transport protocols must not define canonical semantics.
10. Provider-specific concepts stay behind bindings/adapters unless promoted intentionally.
11. Backend-local cursors, WAL/pages, caches, and indexes never define portable replication identity.
12. Immutable replication records merge by stable typed key: identical canonical payload is idempotent; different payload for the same key fails closed.
13. Raw artifact bytes replicate by verified content digest and remain separate from metadata inventories.
14. Until source receipt clocks become replica-stable, one sourceKey has one logical ingestion authority per replication namespace; independent active-active ingestion must not be hidden by LWW.
15. Replication inventories contain descriptors only, never canonical payload bodies; externally supplied roots/fingerprints are verified before reconciliation decisions.
16. Replication apply operations are bounded; large reconciliation sets are chunked above the immutable record semantics rather than applied as one unbounded transaction.
