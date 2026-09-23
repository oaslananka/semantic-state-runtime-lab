import type {
  AuthorityRule,
  CandidateValue,
  CanonicalPropertyState,
  Conflict,
  ConflictCandidate,
  EntityId,
  ExternalSnapshot,
  Mutation,
  ReconciliationPlan,
  SourceRef,
  StateValue,
} from "./model.js";

function normalizeValue(value: StateValue): unknown {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, normalizeValue(child)]),
    );
  }
  return value;
}

export function valuesEqual(left: StateValue | undefined, right: StateValue | undefined): boolean {
  return JSON.stringify(left === undefined ? "__undefined__" : normalizeValue(left))
    === JSON.stringify(right === undefined ? "__undefined__" : normalizeValue(right));
}

function sourceFor(snapshot: ExternalSnapshot): SourceRef {
  const base = {
    provider: snapshot.binding.provider,
    externalId: snapshot.binding.externalId,
  };
  return snapshot.revision === undefined ? base : { ...base, revision: snapshot.revision };
}

function candidatesFrom(snapshot: ExternalSnapshot): CandidateValue[] {
  const candidates: CandidateValue[] = [];
  for (const field of snapshot.binding.fields) {
    if (!field.readable) continue;
    const value = snapshot.values[field.external];
    if (value === undefined) continue;
    candidates.push({
      entityId: snapshot.binding.entityId,
      property: field.canonical,
      value,
      source: sourceFor(snapshot),
      observedAt: snapshot.observedAt,
    });
  }
  return candidates;
}

function candidateOrder(a: CandidateValue, b: CandidateValue): number {
  return a.source.provider.localeCompare(b.source.provider)
    || a.source.externalId.localeCompare(b.source.externalId)
    || JSON.stringify(normalizeValue(a.value)).localeCompare(JSON.stringify(normalizeValue(b.value)));
}

function conflictCandidate(candidate: CandidateValue): ConflictCandidate {
  return {
    provider: candidate.source.provider,
    externalId: candidate.source.externalId,
    value: candidate.value,
    observedAt: candidate.observedAt,
  };
}

function observedTime(candidate: CandidateValue): number {
  const timestamp = Date.parse(candidate.observedAt);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid observedAt timestamp: ${candidate.observedAt}`);
  }
  return timestamp;
}

function selectLatest(
  property: string,
  candidates: readonly CandidateValue[],
  reason: Conflict["reason"],
): { selected?: CandidateValue; conflict?: Conflict } {
  if (candidates.length === 0) return {};
  const newest = Math.max(...candidates.map(observedTime));
  const latest = candidates
    .filter((candidate) => observedTime(candidate) === newest)
    .sort(candidateOrder);
  const distinct = new Map(latest.map((candidate) => [
    JSON.stringify(normalizeValue(candidate.value)),
    candidate,
  ]));
  if (distinct.size > 1) {
    return {
      conflict: {
        property,
        reason,
        candidates: latest.map(conflictCandidate),
      },
    };
  }
  const selected = latest[0];
  if (selected === undefined) return {};
  return { selected };
}

function selectCanonical(
  property: string,
  candidates: readonly CandidateValue[],
  rule: AuthorityRule | undefined,
): { selected?: CandidateValue; conflict?: Conflict } {
  if (rule?.strategy.kind === "provider") {
    const providers = [rule.strategy.provider, ...(rule.strategy.fallback ?? [])];
    for (const provider of providers) {
      const matching = candidates.filter((candidate) => candidate.source.provider === provider);
      if (matching.length > 0) return selectLatest(property, matching, "ambiguous-authority");
    }
    return {};
  }
  return selectLatest(property, candidates, "ambiguous-freshest");
}

function canonicalProperty(candidate: CandidateValue): CanonicalPropertyState {
  return {
    property: candidate.property,
    value: candidate.value,
    source: candidate.source,
    observedAt: candidate.observedAt,
  };
}

function snapshotOrder(a: ExternalSnapshot, b: ExternalSnapshot): number {
  return a.binding.provider.localeCompare(b.binding.provider)
    || a.binding.externalId.localeCompare(b.binding.externalId);
}

export function planReconciliation(input: {
  readonly entityId: EntityId;
  readonly snapshots: readonly ExternalSnapshot[];
  readonly authority?: readonly AuthorityRule[];
}): ReconciliationPlan {
  for (const snapshot of input.snapshots) {
    if (snapshot.binding.entityId !== input.entityId) {
      throw new Error(`Snapshot ${snapshot.binding.provider}/${snapshot.binding.externalId} belongs to another entity`);
    }
  }

  const rules = new Map((input.authority ?? []).map((rule) => [rule.property, rule]));
  const grouped = new Map<string, CandidateValue[]>();
  for (const snapshot of input.snapshots) {
    for (const candidate of candidatesFrom(snapshot)) {
      const current = grouped.get(candidate.property) ?? [];
      current.push(candidate);
      grouped.set(candidate.property, current);
    }
  }

  const properties: Record<string, CanonicalPropertyState> = {};
  const conflicts: Conflict[] = [];
  for (const property of [...grouped.keys()].sort()) {
    const result = selectCanonical(property, grouped.get(property) ?? [], rules.get(property));
    if (result.conflict !== undefined) conflicts.push(result.conflict);
    if (result.selected !== undefined) properties[property] = canonicalProperty(result.selected);
  }

  const mutations: Mutation[] = [];
  for (const snapshot of [...input.snapshots].sort(snapshotOrder)) {
    for (const field of [...snapshot.binding.fields].sort((a, b) => a.external.localeCompare(b.external))) {
      if (!field.writable) continue;
      const state = properties[field.canonical];
      if (state === undefined) continue;
      const current = snapshot.values[field.external];
      if (valuesEqual(current, state.value)) continue;

      const mutation: Mutation = {
        provider: snapshot.binding.provider,
        externalId: snapshot.binding.externalId,
        externalPath: field.external,
        canonicalProperty: field.canonical,
        nextValue: state.value,
        ...(current === undefined ? {} : { previousValue: current }),
        ...(snapshot.revision === undefined ? {} : { baseRevision: snapshot.revision }),
      };
      mutations.push(mutation);
    }
  }

  return {
    entityId: input.entityId,
    canonical: { entityId: input.entityId, properties },
    mutations,
    conflicts,
  };
}
