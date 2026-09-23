# Context benchmark

The benchmark exists to falsify the Context Compiler thesis, not to produce marketing numbers.

## v0

The current synthetic corpus has 5,005 records across 101 entities. It compares:

- raw context: every record
- lexical baseline: global term-overlap ranking under the same output budget
- compiled-v0: entity resolution followed by structured candidate narrowing and ranking

Metrics include required-evidence recall, irrelevant-context ratio, estimated output tokens, returned records, and records considered.

## Important limitations

v0 is retrieval-only. It does not measure downstream LLM task success.

The token estimate is a model-neutral character heuristic, not a provider tokenizer.

The lexical baseline is intentionally simple and is not a sufficient RAG baseline. A compiler advantage is not considered validated until it is compared against strong BM25/metadata-filtered and vector/hybrid retrieval.

Synthetic data can accidentally encode benchmark advantages. Later datasets must include held-out tasks, temporal contradictions, alias collisions, stale state, multilingual text, and adversarially similar distractors.

Run with:

```bash
pnpm benchmark:context
```
