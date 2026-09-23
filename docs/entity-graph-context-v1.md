# Typed entity and graph context v1

Context compilation now separates three concerns that were previously entangled:

```text
identity + temporal graph + policy
              ↓
      safe semantic frontier
              ↓
         retrieval/ranking
              ↓
       token-bounded context
```

The semantic frontier is the durable contract. BM25, lexical ranking, vector search, reciprocal-rank fusion, or future retrieval methods may change without redefining identity or authorization.

## Typed identity

An entity has a stable `entity://...` ID, an explicit type, and alias evidence:

```ts
interface TypedEntity {
  id: EntityId;
  type: string;
  aliases: readonly EntityAliasEvidence[];
}
```

Types have query cues:

```text
Project -> project, proje, projesi, projesinin
Person  -> person, kişi, kişisi, kişisinin
```

The resolver returns one of three states:

```text
resolved
ambiguous
none
```

A bare shared alias such as `Atlas` is not silently broken by entity-ID ordering. If the strongest candidates tie, resolution is `ambiguous`.

A query such as `Atlas projesinin...` can resolve the Project, while `Atlas kişisinin...` can resolve the Person with the same alias.

### Score semantics

The resolver's numeric score is a deterministic matching score used to compare candidates. It is **not** a calibrated probability, model confidence, or claim that the identity is certainly correct.

Current scoring rewards:

- a longer/multi-token exact alias match
- an explicit matching entity-type cue

Aliases may carry evidence references so the system can explain why an identity candidate existed.

## Fail-closed ambiguity

`GraphContextCompiler` emits no state context when direct identity is ambiguous or absent.

This is intentional. A personal AI runtime should not merge two people, two projects, or a person and a project merely because they share a name.

A future interaction layer may ask the user to disambiguate or use additional evidence, but the core does not guess.

## Bitemporal relation edges

Relations are not static graph edges. They use the same two-clock semantics as canonical state:

```ts
interface TemporalRelationEdge {
  id: string;
  from: EntityId;
  to: EntityId;
  relationType: string;
  validFrom: string;
  validTo?: string;
  recordedAt: string;
  evidenceRefs?: readonly string[];
}
```

For example, a project's owner can change over time. A March context query and a September context query may therefore traverse different owner edges.

`validFrom` is inclusive, `validTo` is exclusive, and `recordedAt` is the knowledge/transaction-time cutoff.

## Bounded one-hop expansion

v1 traverses at most one relation hop from the resolved direct entity.

The candidate edge must:

1. be active at the requested `validAt` / `knownAt`
2. pass entity and relation visibility policy
3. have lexical overlap with the task query
4. fit the relation traversal token budget
5. remain under `maxRelationEdges`

This intentionally avoids an unbounded knowledge-graph crawl.

The compiler returns traversal metrics:

- candidate edge count
- traversed edge count
- selected edge IDs
- related entity IDs
- candidate record count
- relation traversal token cost
- final output token cost

## Policy boundary

Visibility is checked before and during graph construction.

A policy can deny:

- a direct or related entity
- a canonical property
- a relation edge

Denied direct entities are removed **before identity resolution**, so they cannot leak through ambiguity candidates.

Denied related entities cannot be traversed.

Denied properties are not converted to context records.

State values are also recursively inspected for `entity://...` references. If an otherwise-readable property contains a denied entity reference inside a string, array, or nested object, that property record is suppressed. This prevents a relation-policy bypass through values such as:

```json
{
  "primary": "entity://person/alice",
  "backups": ["entity://person/bob"]
}
```

This is a conservative v1 rule. Future redaction may support field-level partial projection, but v1 prefers non-disclosure over partial nested leakage.

## Semantic frontier

`GraphContextCompiler.frontier(request)` performs:

```text
visible entity set
  -> typed identity resolution
  -> bitemporal relation filtering
  -> relation relevance + traversal budget
  -> related entity expansion
  -> bitemporal canonical state resolution
  -> property/relation visibility filtering
  -> compact records with provenance
```

The frontier contains safe candidate records **before final retrieval ranking**.

`compile(request)` then runs standard BM25 over that frontier under the output token budget.

This split is deliberate. It lets the product improve or replace retrieval without making ranking responsible for identity, temporal truth, or privacy.

## Benchmark v2

`benchmarks/context-v2-identity-graph.ts` compares four paths on a small synthetic identity/relationship corpus:

- legacy untyped `ContextIndex`
- legacy untyped one-hop graph + BM25
- typed semantic frontier + BM25
- the exact same typed frontier + BM25/lexical reciprocal-rank fusion

Tasks include:

- a unique-identity Alice control task
- Project Atlas -> owner -> timezone in Turkish
- Person Atlas -> employer in Turkish
- Project Atlas -> robot -> status in Turkish
- bare `Atlas` ambiguity

Results on 2026-09-24:

| Method | Task success | Evidence recall | Mean estimated tokens |
| --- | ---: | ---: | ---: |
| legacy ContextIndex | 20% | 100% | 74.8 |
| legacy graph + BM25 | 20% | 100% | 67.6 |
| typed graph + BM25 | 100% | 100% | 45.2 |
| typed graph + BM25/lexical RRF | 100% | 100% | 45.2 |

Interpretation matters more than the aggregate score:

- All methods retrieve the required evidence in this small corpus.
- Legacy methods fail the collision tasks because they resolve both Project Atlas and Person Atlas as direct entities and have no explicit ambiguity contract.
- The unique Alice control succeeds for all methods, so the benchmark does not claim a universal typed-system advantage.
- Typed BM25 and typed RRF are identical on these tasks. The improvement therefore belongs to identity/graph semantics, not to a special ranker.
- The token reduction is a synthetic-corpus result, not a production cost claim.

The prior one-time MiniLM vector + BM25 hybrid experiment remains documented in the context benchmark history. It did not demonstrate a proprietary retrieval moat either.

## Limitations

v1 intentionally does not solve:

- fuzzy or typo-tolerant identity matching
- cross-source entity deduplication at ingestion time
- probabilistic/calibrated identity confidence
- multi-hop traversal
- automatic relation-type induction
- partial redaction of nested structured values
- vector retrieval in routine CI
- human disambiguation UX

The current type-cue vocabulary is configured schema, not a universal ontology.

The benchmark is synthetic and specifically stresses alias collisions and relations. It validates invariants; it is not evidence of production accuracy or market demand.
