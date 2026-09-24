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

## v1: semantic state before ranking

`pnpm benchmark:context:v1` tests provider authority, stale/superseded evidence, conflicts, multilingual queries, relation retrieval, alias collisions, and historical as-of questions.

Its main result is negative in the useful sense: it does not establish a proprietary ranker moat. Authority-aware state and graph semantics matter; standard graph BM25 can beat the existing compiler on relation tasks; current-only state fails historical questions. See `docs/context-benchmark-v1.md`.

## v2: typed identity and graph frontier

`pnpm benchmark:context:v2` isolates identity and one-hop relation semantics.

It compares legacy untyped retrieval with a typed semantic frontier, then compares BM25 and BM25/lexical RRF on that exact same typed frontier. The typed BM25 and RRF paths currently have identical task success, reinforcing that the measured improvement comes from identity/graph semantics rather than a special ranker.

See `docs/entity-graph-context-v1.md` for the contract, policy boundary, results, and limitations.

## Google Calendar adapter v1 fixture

`pnpm benchmark:google-calendar:v1` is a deterministic provider-adapter accounting benchmark. It uses scripted Google Calendar responses plus the real SQLite ingestion/semantic stores and existing Context Capsule worker; it does not use live credentials and makes no latency claim.

The fixture covers a multi-page initial sync, an incremental update + sparse delete, and a 410-triggered authoritative full resync with unseen-resource sweep. See `docs/google-calendar-adapter-v1.md` for the current expected counts and semantics.

## Markdown authoritative ingestion v1

`pnpm benchmark:markdown:v1` measures the correctness-first local Markdown full-scan path on deterministic 100-note and 1,000-note fixtures: recursive enumeration, exact byte reads, SHA-256, strict UTF-8 decoding, frontmatter parsing, and configured field extraction.

It also checks checkpoint stability on a byte-identical second scan. Timing is observational only; there is no latency threshold or claim that O(N files + bytes) full scans are suitable for huge vaults. See `docs/markdown-authoritative-ingestion-v1.md`.

## Context capsule cache v1

`pnpm benchmark:capsule-cache:v1` compares `InMemoryContextCapsuleStore` full alias scanning with the durable SQLite capsule cache's indexed alias candidate selection at 100 / 1,000 / 10,000 synthetic capsules.

It is an observational local benchmark, not a production SLA. See `docs/durable-capsule-cache-v1.md` for fixture details, measured values, caveats, and architecture.
