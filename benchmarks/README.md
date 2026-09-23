# Context benchmark

The benchmark exists to falsify the Context Compiler thesis, not to produce marketing numbers.

## v0

The current synthetic corpus has 5,005 records across 101 entities. It compares:

- raw context: every record
- lexical baseline: global term-overlap ranking under the same output budget
- global BM25: standard term-frequency/document-frequency retrieval over the full corpus
- metadata-filtered BM25: entity-resolution narrowing followed by BM25
- state-aware BM25 heuristic: entity narrowing plus `current=true` when the English query explicitly says `current` or `currently`, then BM25
- compiled-v0: entity resolution followed by structured ranking with current-state, importance, and record-kind priors

The state-aware BM25 heuristic is deliberately a strong control, not product logic. Its query parser is intentionally trivial. If this simple baseline matches or beats the compiler, the compiler does not get credit for a ranking advantage.

Metrics include required-evidence recall, irrelevant-context ratio, estimated output tokens, returned records, returned IDs, and records considered.

## Important limitations

v0 is retrieval-only. It does not measure downstream LLM task success.

The token estimate is a model-neutral character heuristic, not a provider tokenizer.

A one-time 2026-09-23 R&D run with Transformers.js 4.3.0, MiniLM embeddings, and BM25/vector reciprocal-rank fusion showed that vector or hybrid ranking alone still selected the stale record on the tight temporal task. However, entity + `current=true` filtering made BM25, vector, and hybrid all match the compiler on that task and outperform compiled-v0 on irrelevant-context ratio in the two broader tasks.

Therefore v0 currently provides no evidence of a proprietary retrieval/ranking moat. The stronger hypothesis is that value comes from maintaining trustworthy semantic/temporal state and compiling those constraints into ordinary retrieval systems.

The vector experiment is not part of routine CI because downloading a model on every pull request would add significant cost and supply-chain surface. Future validation must use held-out datasets, reproducible model pinning/caching, and downstream model task success.

Synthetic data can accidentally encode benchmark advantages. Future datasets must include temporal state inferred from provenance rather than a pre-labeled boolean, alias collisions, multilingual text, partial entity resolution, cross-entity relationships, contradictory authorities, and adversarially similar distractors.

Run with:

```bash
pnpm benchmark:context
```
