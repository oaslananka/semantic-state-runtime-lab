# Context benchmark

The benchmark exists to falsify the Context Compiler thesis, not to produce marketing numbers.

## v0

The current synthetic corpus has 5,005 records across 101 entities. It compares:

- raw context: every record
- lexical baseline: global term-overlap ranking under the same output budget
- global BM25: standard term-frequency/document-frequency retrieval over the full corpus
- metadata-filtered BM25: the same entity-resolution narrowing used by the compiler, then BM25
- compiled-v0: entity resolution followed by structured ranking with current-state, importance, and record-kind priors

Metrics include required-evidence recall, irrelevant-context ratio, estimated output tokens, returned records, returned IDs, and records considered.

## Important limitations

v0 is retrieval-only. It does not measure downstream LLM task success.

The token estimate is a model-neutral character heuristic, not a provider tokenizer.

BM25 is a substantially stronger lexical baseline than the original overlap baseline, but it still does not represent modern vector/hybrid retrieval. A compiler advantage is not considered validated until vector/hybrid baselines and held-out tasks are added.

Synthetic data can accidentally encode benchmark advantages. The temporal-stale task is intentionally adversarial because stale-vs-current state is a core system claim, but future datasets must also include alias collisions, multilingual text, partial entity resolution, cross-entity relationships, and adversarially similar distractors.

Run with:

```bash
pnpm benchmark:context
```
