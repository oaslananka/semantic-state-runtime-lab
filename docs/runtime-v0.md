# Runtime v0 execution semantics

The runtime turns a side-effect-free reconciliation plan into observed convergence.

## Loop

1. Observe all bound providers.
2. Produce a deterministic reconciliation plan.
3. Stop if dry-run was requested.
4. Stop if unresolved conflicts exist.
5. Apply planned mutations with provider preconditions.
6. Observe all providers again.
7. Re-plan from observed state.

## Concurrency

When a provider exposes a revision, the mutation carries the revision observed during planning. A changed revision causes the provider write to fail rather than overwrite newer state.

Providers without revisions must enforce an equivalent value/absence precondition where possible.

## Partial application

Cross-provider atomicity is not assumed. If mutation N fails after earlier mutations succeeded, the runtime reports both the failed mutation and the exact mutations already applied.

v0 does not claim rollback, distributed transactions, or compensation.

## Retry policy

v0 performs no implicit write retry. A caller may start a new observe-plan-apply cycle from the actual external state. Retry and compensation policy will be designed only after provider failure modes are measured.
