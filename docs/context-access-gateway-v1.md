# Context Access Gateway v1

The Context Access Gateway is the authorization boundary for derived semantic context.

SSRL already has durable semantic state, incremental context capsules, standard retrieval baselines, raw Artifact Plane access, and authenticated MCP HTTP. None of those components individually answers the security question:

> Which derived facts and relationships may this principal receive for this task?

`@ssrl/context-access` provides that boundary before any remote `context.compile` tool is exposed.

## Layering

```text
connector/artifact ingestion
        ↓
Semantic State Store (truth/evidence)
        ↓
Incremental Context Capsules (derived/rebuildable)
        ↓
Context Access Gateway (principal + policy)
        ↓
existing ContextCorpus + BM25
        ↓
future MCP context.compile adapter
```

Transport authentication does not authorize context. A valid OAuth/MCP bearer identifies the caller; the Context Access Gateway decides which derived context that caller may receive.

## No full semantic snapshot on the query path

The query path does not call `SemanticStateStore.snapshot()` and does not scan raw artifacts.

Instead, the derived capsule cache now supports bounded alias search:

```ts
ContextCapsuleStore.search(query, limit)
```

The in-memory implementation scans only materialized capsules. Future durable cache/index backends can replace that scan without changing gateway semantics.

Alias search uses the same Unicode normalization and phrase-match scoring as typed entity resolution through `matchEntityAliasesForQuery()` in `@ssrl/core`.

## Freshness before retrieval

A query never trusts a cache blindly.

`IncrementalContextCapsuleSynchronizer` repeatedly runs the existing incremental worker until:

- the durable semantic change feed is drained for the configured page bounds; and
- time/configuration-stale capsules are refreshed.

This preserves the earlier invariant that time itself may invalidate current state even when the change feed is empty.

Synchronization is bounded by `pageSize` and `maxPages`. If it cannot catch up, it throws `ContextCapsuleSyncLimitError`; the gateway returns no stale context.

## Current-only v1

v1 deliberately compiles **current** capsules only.

Supplying `validAt` or `knownAt` throws `HistoricalContextAccessUnsupportedError`. A historical-as-of gateway must resolve historical state directly from bitemporal evidence or maintain historical materializations; pretending a current capsule is historical truth would be incorrect.

## Policy model

When a `ContextAccessPolicy` is configured, a principal is mandatory and every undefined decision is deny-by-default.

The policy can evaluate:

```text
operation: compile
entity
property
relation
provenance/evidence ref
```

The gateway normalizes `AccessPrincipal` before policy evaluation.

### Authorization ordering

Security-sensitive ordering is explicit:

```text
compile operation policy
  ↓
synchronize cache
  ↓
search derived capsules
  ↓
ENTITY POLICY FILTER
  ↓
typed identity resolution
  ↓
relation + target-entity policy
  ↓
property + nested-reference policy
  ↓
projection/ranking
  ↓
provenance policy
```

Denied entities therefore never participate in identity resolution. This prevents a hidden entity from leaking through ambiguity candidates or changing which visible entity wins a tie.

## Candidate scan bounds

Raw derived-cache scans and visible candidates are separate limits.

For identity:

```text
maxIdentityScans       // internal bounded work
policy filter
maxIdentityCandidates  // visible resolver candidates
```

For relations:

```text
maxRelationScans       // active edges on direct capsule
policy + target filter + relevance
maxRelationCandidates  // visible relevant candidates
maxRelationEdges       // selected one-hop expansion
```

This distinction matters. A large number of policy-denied entities or relations must not consume the visible-candidate limit and change an otherwise valid result.

If an internal scan bound itself is exceeded, the gateway fails closed rather than resolving from a truncated universe.

## Identity resolution

Search only performs bounded alias candidate discovery.

`TypedEntityResolver` remains responsible for deterministic typed resolution and explicit `none / resolved / ambiguous` outcomes.

An external ambiguity result contains only:

```text
entityId
entityType
```

for policy-visible candidates. It does not expose matched aliases, alias evidence refs, scores, hidden candidate counts, or denied entity IDs.

## One-hop relation expansion

v1 expands only relations from the resolved direct entity capsule.

A relation contributes only when:

1. relation policy allows it;
2. target entity policy allows it;
3. the target capsule exists;
4. relation aliases or visible target aliases overlap the task; and
5. configured relation bounds permit it.

The direct entity name is intentionally excluded from relation relevance scoring. Otherwise every outgoing edge from `Project Atlas` would receive a positive score merely because the task also mentions `Project Atlas`.

Related capsules are projected with their own outgoing relations removed, preserving one-hop semantics.

## Property and nested entity filtering

Every canonical property and conflict is independently policy checked before projection.

Structured `StateValue` is recursively inspected for `entity://...` references. If any referenced entity is denied, v1 suppresses the whole property/conflict record rather than partially redacting an arbitrary nested structure.

This is conservative by design and matches the earlier graph-context privacy rule.

## Provenance

Current context records may carry internal evidence identifiers such as observation IDs or relation evidence refs.

Every evidence ref is independently checked using the `provenance` policy request. Denied refs are omitted entirely from the returned record. Denying provenance does not remove otherwise authorized semantic text.

Raw artifact bytes are never expanded by this gateway. They remain behind `ArtifactAccessGateway`.

A future opaque `ctx://...` evidence-handle layer can replace internal refs without changing this authorization boundary.

## Ranking and token budget

The gateway does not introduce a proprietary ranker.

After authorization/redaction, it uses:

```text
contextCorpusFromCapsules()
        ↓
bm25Baseline()
```

The configured `maxBudgetTokens` is a hard server-side cap. The caller's final `ContextPackage.estimatedTokens` remains within the accepted budget.

This preserves the repository's measured conclusion: identity/state/graph semantics and access control are product logic; the retrieval ranker remains replaceable infrastructure.

## Audit events

An optional `ContextAccessEventSink` receives metadata only:

```text
at
operation
outcome
subject
optional denial code
requested/effective token budget
resolution status
allowed resolved entity ID
returned record/token counts
```

It intentionally does **not** receive:

- raw task text;
- returned context text;
- evidence payloads;
- bearer tokens;
- OAuth claims.

## Verified cases

The v1 integration suite uses real SQLite semantic state, the real incremental materializer, searchable capsules, and the existing BM25 path. It verifies:

- allowed `Project Atlas -> owner -> timezone` context;
- query path never calls `SemanticStateStore.snapshot()`;
- denied homonym filtered before resolver and visible-candidate cap;
- denied direct entity state never leaks through a shared alias;
- denied related entity is rejected before target capsule `get()`;
- denied relation is not traversed;
- denied property is absent before ranking;
- nested state containing a denied entity reference is suppressed;
- denied provenance refs are removed while authorized semantic text remains;
- undefined policy operation fails closed;
- missing principal fails closed when policy is configured;
- server token budget cap;
- identity/relation candidate bounds;
- zero-change temporal-boundary refresh before search;
- sync-limit failure returns no stale context;
- ambiguity metadata contains no aliases/evidence refs;
- audit sink contains no task/context text;
- retracted state does not reappear after incremental refresh;
- historical-as-of request is explicitly rejected in current-only v1.

## Non-goals

v1 does not implement:

- MCP `context.compile` transport tool;
- historical-as-of context access;
- vector search/embeddings;
- LLM summaries;
- multi-hop graph traversal;
- raw artifact expansion;
- durable capsule-cache backend;
- policy authoring UI;
- opaque evidence handle registry;
- cloud tenancy.

## Next step

The next adapter should be deliberately thin:

```text
MCP context.compile
  + coarse context:read scope challenge
  + authenticated request principal
        ↓
ContextAccessGateway.compile()
```

MCP must not reimplement identity resolution, context filtering, evidence policy, or ranking.
