# Bitemporal state v1

The state runtime must distinguish two different questions:

1. **When was this value true in the modeled world?**
2. **When did SSRL know this evidence?**

Treating those as one timestamp causes current-state systems to answer historical questions with future knowledge or current truth.

## Temporal observation

A temporal observation is immutable evidence about one canonical property:

```ts
interface TemporalObservation {
  id: string;
  entityId: EntityId;
  property: PropertyPath;
  value: StateValue;
  source: SourceRef;
  validFrom: string;
  validTo?: string;
  recordedAt: string;
}
```

Semantics:

- `validFrom` is inclusive.
- `validTo` is exclusive: `[validFrom, validTo)`.
- no `validTo` means open-ended validity.
- `recordedAt` is transaction/knowledge time: when SSRL learned or recorded the evidence.
- observations are not overwritten when later evidence arrives.

The model intentionally does not require `recordedAt >= validFrom`. Late-arriving historical evidence and known future/scheduled state are both valid use cases.

## Query

`resolveTemporalState()` requires both clocks explicitly:

```ts
resolveTemporalState({
  entityId,
  observations,
  validAt,
  knownAt,
  authority,
})
```

There is no implicit `Date.now()` inside the core resolver.

Examples:

### Current state

```text
validAt = now
knownAt = now
```

`resolveCurrentTemporalState({ at })` is a convenience helper that sets both to the same explicit timestamp.

### Historical truth using everything known today

```text
validAt = 2026-03-01
knownAt = today
```

This answers: "Given everything we know now, what was valid on March 1?"

### Historical belief replay

```text
validAt = 2026-03-01
knownAt = 2026-03-15
```

This answers: "What would SSRL have believed on March 15 about the state valid on March 1?"

Late evidence recorded in September is excluded from that replay even when its world-valid interval covers March.

## Authority and conflicts

Temporal resolution does not implement a second authority algorithm.

After filtering observations by `validAt` and `knownAt`, active observations are projected into read-only snapshots and passed through the existing `planReconciliation()` canonical selection logic.

Therefore the same rules apply to temporal and non-temporal state:

- explicit provider authority beats a newer non-authoritative source
- provider fallbacks remain available
- without authority, freshest known evidence is selected
- equal-knowledge-time disagreements surface as explicit conflicts instead of arbitrary truth

This reuse is deliberate. Maintaining separate current-state and historical-state truth algorithms would create semantic drift.

## Provenance

A temporal resolution returns canonical state plus evidence references:

```text
canonical property
    -> exact temporal observation id(s)
    -> source provider/external id/revision
    -> valid interval
    -> recordedAt
```

Unresolved conflicts carry their own evidence references for every conflicting candidate.

The context layer copies observation IDs into `ContextRecord.evidenceRefs`. An agent can therefore receive a compact resolved value while the runtime retains a path back to immutable evidence.

## Temporal context compilation

`TemporalContextCompiler` accepts:

- typed `entity://...` descriptors and aliases
- immutable temporal observations
- authority rules by entity
- a task query and token budget
- explicit `validAt` and `knownAt`

It performs:

```text
query
  -> entity alias resolution
  -> bitemporal state slice
  -> authority/conflict resolution
  -> compact state/conflict records with evidence refs
  -> existing ContextIndex ranking + token budget
```

It does **not** query Markdown, Gmail, a remote API, or any other source system during compilation. Source ingestion/normalization is upstream.

Typed entity disambiguation and relation expansion are intentionally separate work in #22.

## Example: REST -> GraphQL

Evidence:

```text
REST
  valid:    [2026-02-10, 2026-08-20)
  recorded: 2026-02-10

GraphQL
  valid:    [2026-08-20, infinity)
  recorded: 2026-08-20
```

Queries on 2026-09-24:

```text
validAt=2026-09-24, knownAt=2026-09-24 -> GraphQL
validAt=2026-03-01, knownAt=2026-09-24 -> REST
validAt=2026-01-01, knownAt=2026-09-24 -> no asserted value
```

This closes the correctness gap exposed by Context Benchmark v1, where a current-state-only compiler answered the March historical question with GraphQL.

## Non-goals in v1

This layer is not yet:

- a persistent temporal database
- a temporal SQL/query language
- automatic validity inference from natural language
- an event-sourcing rewrite
- an unbounded historical graph
- a policy engine

Persistence, policy projection, typed identity/relation semantics, and incremental indexing can wrap this deterministic core without changing its two-clock contract.
