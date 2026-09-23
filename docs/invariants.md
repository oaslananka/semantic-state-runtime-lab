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
