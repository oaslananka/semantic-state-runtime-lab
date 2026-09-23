export type ContextKind =
  | "state"
  | "decision"
  | "commitment"
  | "event"
  | "artifact"
  | "relationship";

export interface EntityDescriptor {
  readonly id: string;
  readonly aliases: readonly string[];
}

export interface ContextRecord {
  readonly id: string;
  readonly entityId: string;
  readonly kind: ContextKind;
  readonly text: string;
  readonly current?: boolean;
  readonly importance?: number;
  readonly relatedEntityIds?: readonly string[];
}

export interface ContextCorpus {
  readonly entities: readonly EntityDescriptor[];
  readonly records: readonly ContextRecord[];
}

export interface ContextRequest {
  readonly query: string;
  readonly budgetTokens: number;
}

export interface ContextPackage {
  readonly records: readonly ContextRecord[];
  readonly resolvedEntityIds: readonly string[];
  readonly estimatedTokens: number;
  readonly consideredRecords: number;
}

interface RankedRecord {
  readonly record: ContextRecord;
  readonly score: number;
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function termList(value: string): string[] {
  return normalize(value)
    .split(" ")
    .filter((term) => term.length >= 2);
}

function terms(value: string): Set<string> {
  return new Set(termList(value));
}

export function estimateTokens(value: string): number {
  if (value.length === 0) return 0;
  return Math.max(1, Math.ceil(value.length / 4));
}

function recordTokens(record: ContextRecord): number {
  return estimateTokens(record.text) + 8;
}

function overlapScore(queryTerms: ReadonlySet<string>, record: ContextRecord): number {
  const recordTerms = terms(record.text);
  let overlap = 0;
  for (const term of queryTerms) {
    if (recordTerms.has(term)) overlap += 1;
  }
  return overlap;
}

function selectWithinBudget(
  ranked: readonly RankedRecord[],
  budgetTokens: number,
): { records: ContextRecord[]; estimatedTokens: number } {
  const records: ContextRecord[] = [];
  let estimatedTokens = 0;

  for (const candidate of ranked) {
    const cost = recordTokens(candidate.record);
    if (estimatedTokens + cost > budgetTokens) continue;
    records.push(candidate.record);
    estimatedTokens += cost;
  }

  return { records, estimatedTokens };
}

function entityNameMap(corpus: ContextCorpus): ReadonlyMap<string, string> {
  return new Map(corpus.entities.map((entity) => [entity.id, entity.aliases.join(" ")]));
}

const kindPriority: Readonly<Record<ContextKind, number>> = {
  state: 18,
  decision: 16,
  commitment: 14,
  relationship: 10,
  event: 6,
  artifact: 4,
};

export class ContextIndex {
  readonly #corpus: ContextCorpus;
  readonly #recordsByEntity = new Map<string, ContextRecord[]>();
  readonly #aliases: readonly { alias: string; entityId: string }[];

  constructor(corpus: ContextCorpus) {
    this.#corpus = corpus;

    for (const record of corpus.records) {
      const current = this.#recordsByEntity.get(record.entityId) ?? [];
      current.push(record);
      this.#recordsByEntity.set(record.entityId, current);
    }

    this.#aliases = corpus.entities
      .flatMap((entity) => entity.aliases.map((alias) => ({
        alias: normalize(alias),
        entityId: entity.id,
      })))
      .filter((entry) => entry.alias.length > 0)
      .sort((a, b) => b.alias.length - a.alias.length || a.entityId.localeCompare(b.entityId));
  }

  resolveEntities(query: string): string[] {
    const normalizedQuery = ` ${normalize(query)} `;
    const resolved = new Set<string>();
    for (const entry of this.#aliases) {
      if (normalizedQuery.includes(` ${entry.alias} `)) {
        resolved.add(entry.entityId);
      }
    }
    return [...resolved].sort((a, b) => a.localeCompare(b));
  }

  compile(request: ContextRequest): ContextPackage {
    const resolvedEntityIds = this.resolveEntities(request.query);
    const directEntityIds = new Set(resolvedEntityIds);
    const candidateIds = new Set<string>(resolvedEntityIds);

    for (const entityId of resolvedEntityIds) {
      for (const record of this.#recordsByEntity.get(entityId) ?? []) {
        for (const related of record.relatedEntityIds ?? []) {
          candidateIds.add(related);
        }
      }
    }

    const candidates = resolvedEntityIds.length === 0
      ? [...this.#corpus.records]
      : [...candidateIds].flatMap((entityId) => this.#recordsByEntity.get(entityId) ?? []);

    const queryTerms = terms(request.query);
    const ranked = candidates
      .map((record) => {
        const direct = directEntityIds.has(record.entityId) ? 30 : 0;
        const lexical = overlapScore(queryTerms, record) * 8;
        const current = record.current === true ? 8 : 0;
        const importance = Math.round((record.importance ?? 0.5) * 10);
        return {
          record,
          score: direct + lexical + current + importance + kindPriority[record.kind],
        };
      })
      .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));

    const selected = selectWithinBudget(ranked, request.budgetTokens);
    return {
      records: selected.records,
      resolvedEntityIds,
      estimatedTokens: selected.estimatedTokens,
      consideredRecords: candidates.length,
    };
  }
}

export function lexicalBaseline(
  corpus: ContextCorpus,
  request: ContextRequest,
): ContextPackage {
  const queryTerms = terms(request.query);
  const entityNames = entityNameMap(corpus);

  const ranked = corpus.records
    .map((record) => {
      const searchable = {
        ...record,
        text: `${entityNames.get(record.entityId) ?? ""} ${record.text}`,
      };
      return { record, score: overlapScore(queryTerms, searchable) };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));

  const selected = selectWithinBudget(ranked, request.budgetTokens);
  return {
    records: selected.records,
    resolvedEntityIds: [],
    estimatedTokens: selected.estimatedTokens,
    consideredRecords: corpus.records.length,
  };
}

export function bm25Baseline(
  corpus: ContextCorpus,
  request: ContextRequest,
  filterEntityIds?: readonly string[],
): ContextPackage {
  const filterSet = filterEntityIds === undefined || filterEntityIds.length === 0
    ? undefined
    : new Set(filterEntityIds);
  const candidates = filterSet === undefined
    ? [...corpus.records]
    : corpus.records.filter((record) => filterSet.has(record.entityId));

  if (candidates.length === 0) {
    return {
      records: [],
      resolvedEntityIds: filterEntityIds ?? [],
      estimatedTokens: 0,
      consideredRecords: 0,
    };
  }

  const entityNames = entityNameMap(corpus);
  const documents = candidates.map((record) => ({
    record,
    tokens: termList(`${entityNames.get(record.entityId) ?? ""} ${record.text}`),
  }));
  const averageLength = documents.reduce((sum, document) => sum + document.tokens.length, 0)
    / documents.length;
  const queryTerms = [...new Set(termList(request.query))];
  const k1 = 1.2;
  const b = 0.75;

  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    let frequency = 0;
    for (const document of documents) {
      if (document.tokens.includes(term)) frequency += 1;
    }
    documentFrequency.set(term, frequency);
  }

  const ranked = documents
    .map((document) => {
      const frequencies = new Map<string, number>();
      for (const token of document.tokens) {
        frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      }

      let score = 0;
      for (const term of queryTerms) {
        const tf = frequencies.get(term) ?? 0;
        if (tf === 0) continue;
        const df = documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
        const denominator = tf + k1 * (1 - b + b * document.tokens.length / averageLength);
        score += idf * (tf * (k1 + 1)) / denominator;
      }
      return { record: document.record, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));

  const selected = selectWithinBudget(ranked, request.budgetTokens);
  return {
    records: selected.records,
    resolvedEntityIds: filterEntityIds ?? [],
    estimatedTokens: selected.estimatedTokens,
    consideredRecords: candidates.length,
  };
}

export function metadataFilteredBm25Baseline(
  corpus: ContextCorpus,
  request: ContextRequest,
): ContextPackage {
  const resolvedEntityIds = new ContextIndex(corpus).resolveEntities(request.query);
  return bm25Baseline(
    corpus,
    request,
    resolvedEntityIds.length === 0 ? undefined : resolvedEntityIds,
  );
}

export function rawContext(corpus: ContextCorpus): ContextPackage {
  return {
    records: [...corpus.records],
    resolvedEntityIds: [],
    estimatedTokens: corpus.records.reduce((sum, record) => sum + recordTokens(record), 0),
    consideredRecords: corpus.records.length,
  };
}
