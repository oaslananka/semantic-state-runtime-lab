# Context benchmark v1: state resolution before ranking

Date: 2026-09-24

This checkpoint tests a narrower and more defensible hypothesis than the original Context Compiler v0 benchmark.

The question is not whether a proprietary ranker beats standard retrieval. The v0 BM25/vector work did not show that. The v1 question is:

> Does resolving raw, contradictory observations into canonical state with authority, conflict, identity, and relation semantics improve the evidence an AI receives?

## Corpus

The deterministic benchmark contains:

- 83 entities
- 2,009 raw observations
- 166 derived current-state/conflict records
- English and Turkish queries/text
- same-name alias collision (`Project Atlas` and a person named `Atlas`)
- cross-entity owner relation (`Project Atlas -> Alice -> timezone`)
- stale and superseded decisions
- a newer but non-authoritative proposal
- a same-time unresolved conflict
- a historical as-of question
- unrelated retrieval noise

The benchmark is synthetic. It is designed to falsify specific runtime assumptions, not to estimate production accuracy.

## Compared paths

- `raw-bm25-global`: ordinary BM25 over raw observations
- `raw-agent-entity-bm25`: entity resolution followed by BM25; counted as two retrieval steps
- `raw-temporal-asof-bm25`: raw entity BM25 with an explicit as-of observation-time filter when the query contains a date
- `freshest-state-bm25`: canonical state built with freshest-value semantics only
- `authority-state-bm25`: canonical state built with explicit provider authority
- `authority-state-graph-bm25`: authority state plus one-hop relation expansion, then BM25
- `authority-compiled-v1`: the current `ContextIndex.compile()` ranker over authority-resolved state

State generation uses the production `planReconciliation()` implementation, not a benchmark-only canonical-state algorithm.

## Deterministic evidence-level results

Six held-out-style tasks are used:

1. authoritative deadline, Turkish
2. current API decision, English
3. owner -> timezone relation hop, Turkish
4. same-name person/project alias collision, Turkish
5. unresolved release-stage conflict, Turkish
6. historical API state as of 2026-03-01

| Method | Task success | Mean evidence recall | Contradiction errors | Mean irrelevant ratio | Mean estimated tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| raw BM25 global | 50.0% | 75.0% | 1 | 61.1% | 82.7 |
| raw entity BM25 | 50.0% | 75.0% | 1 | 61.1% | 82.2 |
| raw temporal-as-of BM25 | 50.0% | 75.0% | 1 | 52.8% | 76.7 |
| freshest-state BM25 | 33.3% | 41.7% | 2 | 77.8% | 85.7 |
| authority-state BM25 | 50.0% | 58.3% | 1 | 69.5% | 85.7 |
| authority-state + graph BM25 | 66.7% | 66.7% | 1 | 63.9% | 85.5 |
| authority compiled v1 | 66.7% | 75.0% | 1 | 61.1% | 84.3 |

The state build for this corpus is approximately tens of milliseconds on the development machine. The benchmark reports the measured value on each run rather than treating that machine-specific number as a product target.

## One-time downstream model check

A one-time local R&D run was performed outside the repository with:

- `@huggingface/transformers` 4.3.0
- `onnx-community/Qwen2.5-1.5B-Instruct`
- q4 ONNX inference on CPU
- deterministic generation (`do_sample=false`)
- no model package, cache, or ML dependency committed to the repository

The smaller 0.5B model was rejected before benchmarking because it failed a trivial context-QA smoke case.

Five retrieval/state methods were evaluated across the same six tasks, for 30 downstream QA cases:

| Method | Model task success |
| --- | ---: |
| raw entity BM25 | 3/6 (50.0%) |
| raw temporal-as-of BM25 | 3/6 (50.0%) |
| freshest-state BM25 | 2/6 (33.3%) |
| authority-state + graph BM25 | 4/6 (66.7%) |
| authority compiled v1 | 4/6 (66.7%) |

The useful failures are more important than the aggregate score.

### Authority is materially different from freshness

For the deadline task, a newer chat proposal said `2026-11-25`, but the authoritative project system still said `2026-11-20`.

The downstream model answered:

- freshness-only state: `2026-11-25` — wrong
- authority-state + graph: `2026-11-20` — correct
- compiled authority state: `2026-11-20` — correct

This supports authority/provenance-aware state resolution as a real requirement. A simple "latest wins" memory system is unsafe.

### Raw retrieval can preserve contradictions that mislead the model

For the current API decision, raw BM25 returned both the old REST decision and the newer GraphQL decision.

The downstream model selected REST. Authority/current state returned only the current GraphQL decision, and the model answered GraphQL.

This is evidence for state consolidation before model context, not for a proprietary ranker.

### Relation expansion beats the current compiler

For "Who owns Atlas and what timezone is the owner in?":

- authority-state + one-hop graph BM25 returned both `Project.owner -> Alice` and `Alice.timezone`, and the model answered both fields correctly
- current compiled v1 returned the owner but missed the timezone

A standard graph-aware retrieval baseline therefore beats the current compiler on this task.

### Alias handling is still task-sensitive

For the person named Atlas, the current compiler resolved the intended person record and answered `Acme Robotics`. The simple graph-BM25 baseline returned project records and answered `UNKNOWN`.

This is a signal that entity resolution matters, but the current alias matcher is not a sufficient general solution: the relation task also showed ambiguity caused by the shared alias `Atlas`.

### Current-state compilation is wrong for historical questions

For "On 2026-03-01, what API style did Project Atlas use?":

- raw temporal-as-of retrieval answered `REST` correctly
- freshest state, authority-state graph, and compiled v1 all returned current `GraphQL` and the model answered GraphQL

This is a hard architectural gap. A current-state cache cannot safely answer historical/as-of questions. The state model needs temporal validity/history, not just `observedAt` on the currently selected value.

### Explicit conflict representation prevents false certainty

For two same-time release-stage observations (`beta` and `production`):

- raw retrieval gave the model one side and it asserted `beta`
- state-resolution paths emitted an explicit unresolved conflict containing both values
- the downstream model preserved both values instead of collapsing to one

The evaluator scores preservation of both conflicting values as success; it does not require a magic literal such as `CONFLICT`.

## Conclusion

The benchmark does **not** justify claiming a Context Compiler ranking moat.

What it does support is a stronger product thesis:

1. maintain trustworthy canonical state from contradictory sources
2. model authority/provenance explicitly
3. preserve unresolved conflicts rather than hiding them
4. resolve typed entities and relations before retrieval
5. support temporal/as-of state, not only current state
6. use standard retrieval components where they are sufficient
7. compile a small context package after those state semantics are applied

In other words, ranking is replaceable infrastructure. The harder and more defensible layer is the semantic/temporal state engine that determines what evidence is safe to rank in the first place.

## Reproduction

After building the workspace:

```bash
pnpm build
pnpm benchmark:context:v1
```

To emit the 42 task/method context packages for an external downstream-model runner:

```bash
SSRL_BENCH_MODEL_CASES=1 pnpm benchmark:context:v1
```

The repository intentionally does not download or depend on a model during normal CI.
