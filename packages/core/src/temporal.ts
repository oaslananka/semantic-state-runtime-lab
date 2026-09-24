import type {
  AuthorityRule,
  Conflict,
  EntityId,
  ExternalSnapshot,
  PropertyPath,
  SourceRef,
  StateValue,
} from "./model.js";
import { planReconciliation, valuesEqual } from "./reconcile.js";
import {
  effectiveRetractionEnd,
  uniqueRetractions,
  validateUniqueRetractionIds,
  type SemanticRetraction,
} from "./retraction.js";
import { temporalWindowIsActive, timestamp } from "./time.js";

export interface TemporalObservation {
  readonly id: string;
  readonly entityId: EntityId;
  readonly property: PropertyPath;
  readonly value: StateValue;
  readonly source: SourceRef;
  /** Inclusive world-validity boundary. */
  readonly validFrom: string;
  /** Exclusive world-validity boundary. Omit for open-ended validity. */
  readonly validTo?: string;
  /** When SSRL learned/recorded this observation. */
  readonly recordedAt: string;
}

export interface TemporalEvidenceRef {
  readonly observationId: string;
  readonly source: SourceRef;
  readonly validFrom: string;
  readonly validTo?: string;
  readonly recordedAt: string;
}

export interface TemporalStateResolution {
  readonly entityId: EntityId;
  /** World-valid time being queried. */
  readonly validAt: string;
  /** Transaction/knowledge cutoff being replayed. */
  readonly knownAt: string;
  readonly canonical: ReturnType<typeof planReconciliation>["canonical"];
  readonly conflicts: readonly Conflict[];
  readonly evidence: Readonly<Record<PropertyPath, readonly TemporalEvidenceRef[]>>;
  readonly conflictEvidence: Readonly<Record<PropertyPath, readonly TemporalEvidenceRef[]>>;
  readonly appliedRetractions: readonly SemanticRetraction[];
}

export interface ResolveTemporalStateInput {
  readonly entityId: EntityId;
  readonly observations: readonly TemporalObservation[];
  readonly validAt: string;
  readonly knownAt: string;
  readonly authority?: readonly AuthorityRule[];
  readonly retractions?: readonly SemanticRetraction[];
}

export interface ResolveCurrentTemporalStateInput {
  readonly entityId: EntityId;
  readonly observations: readonly TemporalObservation[];
  /** Explicit clock value used for both world-valid and transaction time. */
  readonly at: string;
  readonly authority?: readonly AuthorityRule[];
  readonly retractions?: readonly SemanticRetraction[];
}

function validateObservation(observation: TemporalObservation): void {
  if (observation.id.length === 0) throw new Error("Temporal observation id must not be empty");
  const validFrom = timestamp(observation.validFrom, "validFrom");
  timestamp(observation.recordedAt, "recordedAt");
  if (observation.validTo === undefined) return;
  const validTo = timestamp(observation.validTo, "validTo");
  if (validTo <= validFrom) {
    throw new Error(`Temporal observation ${observation.id} must have validTo after validFrom`);
  }
}

function validateUniqueIds(observations: readonly TemporalObservation[]): void {
  const ids = new Set<string>();
  for (const observation of observations) {
    if (ids.has(observation.id)) {
      throw new Error(`Duplicate temporal observation id: ${observation.id}`);
    }
    ids.add(observation.id);
  }
}

function activeAt(
  observation: TemporalObservation,
  entityId: EntityId,
  validAt: number,
  knownAt: number,
  effectiveValidTo: number,
): boolean {
  return observation.entityId === entityId && temporalWindowIsActive({
    validFrom: observation.validFrom,
    recordedAt: observation.recordedAt,
    validAt,
    knownAt,
    effectiveValidTo,
  });
}

function observationOrder(left: TemporalObservation, right: TemporalObservation): number {
  return left.source.provider.localeCompare(right.source.provider)
    || left.source.externalId.localeCompare(right.source.externalId)
    || left.property.localeCompare(right.property)
    || left.recordedAt.localeCompare(right.recordedAt)
    || left.id.localeCompare(right.id);
}

function snapshot(observation: TemporalObservation): ExternalSnapshot {
  return {
    binding: {
      entityId: observation.entityId,
      provider: observation.source.provider,
      externalId: observation.source.externalId,
      fields: [{
        canonical: observation.property,
        external: "value",
        readable: true,
        writable: false,
      }],
    },
    ...(observation.source.revision === undefined
      ? {}
      : { revision: observation.source.revision }),
    observedAt: observation.recordedAt,
    values: { value: observation.value },
  };
}

function sourceMatches(left: SourceRef, right: SourceRef): boolean {
  return left.provider === right.provider
    && left.externalId === right.externalId
    && left.revision === right.revision;
}

function evidenceRef(observation: TemporalObservation): TemporalEvidenceRef {
  return {
    observationId: observation.id,
    source: observation.source,
    validFrom: observation.validFrom,
    ...(observation.validTo === undefined ? {} : { validTo: observation.validTo }),
    recordedAt: observation.recordedAt,
  };
}

function canonicalEvidence(
  active: readonly TemporalObservation[],
  canonical: TemporalStateResolution["canonical"],
): Readonly<Record<PropertyPath, readonly TemporalEvidenceRef[]>> {
  const result: Record<PropertyPath, readonly TemporalEvidenceRef[]> = {};
  for (const [property, state] of Object.entries(canonical.properties)) {
    result[property] = active
      .filter((observation) => observation.property === property)
      .filter((observation) => sourceMatches(observation.source, state.source))
      .filter((observation) => observation.recordedAt === state.observedAt)
      .filter((observation) => valuesEqual(observation.value, state.value))
      .map(evidenceRef);
  }
  return result;
}

function conflictCandidateMatches(
  observation: TemporalObservation,
  property: PropertyPath,
  conflict: Conflict,
): boolean {
  if (observation.property !== property) return false;
  return conflict.candidates.some((candidate) => (
    observation.source.provider === candidate.provider
    && observation.source.externalId === candidate.externalId
    && observation.recordedAt === candidate.observedAt
    && valuesEqual(observation.value, candidate.value)
  ));
}

function conflictEvidence(
  active: readonly TemporalObservation[],
  conflicts: readonly Conflict[],
): Readonly<Record<PropertyPath, readonly TemporalEvidenceRef[]>> {
  const result: Record<PropertyPath, readonly TemporalEvidenceRef[]> = {};
  for (const conflict of conflicts) {
    result[conflict.property] = active
      .filter((observation) => conflictCandidateMatches(observation, conflict.property, conflict))
      .map(evidenceRef);
  }
  return result;
}

export function resolveTemporalState(
  input: ResolveTemporalStateInput,
): TemporalStateResolution {
  const validAt = timestamp(input.validAt, "validAt");
  const knownAt = timestamp(input.knownAt, "knownAt");
  validateUniqueIds(input.observations);
  for (const observation of input.observations) validateObservation(observation);
  const retractions = input.retractions ?? [];
  validateUniqueRetractionIds(retractions);
  const observationIds = new Set(input.observations.map((observation) => observation.id));
  for (const retraction of retractions) {
    if (retraction.targetKind !== "observation" || !observationIds.has(retraction.targetId)) {
      throw new Error(`Semantic retraction ${retraction.id} targets unknown observation ${retraction.targetId}`);
    }
  }

  const appliedRetractions: SemanticRetraction[] = [];
  const active = input.observations
    .filter((observation) => {
      const effective = effectiveRetractionEnd({
        targetKind: "observation",
        targetId: observation.id,
        ...(observation.validTo === undefined ? {} : { originalValidTo: observation.validTo }),
        retractions,
        knownAt: input.knownAt,
      });
      appliedRetractions.push(...effective.retractions);
      return activeAt(observation, input.entityId, validAt, knownAt, effective.validTo);
    })
    .sort(observationOrder);
  const plan = planReconciliation({
    entityId: input.entityId,
    snapshots: active.map(snapshot),
    ...(input.authority === undefined ? {} : { authority: input.authority }),
  });

  return {
    entityId: input.entityId,
    validAt: input.validAt,
    knownAt: input.knownAt,
    canonical: plan.canonical,
    conflicts: plan.conflicts,
    evidence: canonicalEvidence(active, plan.canonical),
    conflictEvidence: conflictEvidence(active, plan.conflicts),
    appliedRetractions: uniqueRetractions(appliedRetractions),
  };
}

export function resolveCurrentTemporalState(
  input: ResolveCurrentTemporalStateInput,
): TemporalStateResolution {
  return resolveTemporalState({
    entityId: input.entityId,
    observations: input.observations,
    validAt: input.at,
    knownAt: input.at,
    ...(input.authority === undefined ? {} : { authority: input.authority }),
    ...(input.retractions === undefined ? {} : { retractions: input.retractions }),
  });
}
