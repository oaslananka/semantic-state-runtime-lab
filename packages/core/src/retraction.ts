import type { SourceRef } from "./model.js";
import { timestamp } from "./time.js";

export type RetractableSemanticRecordKind = "observation" | "relation";

export interface SemanticRetraction {
  readonly id: string;
  readonly targetKind: RetractableSemanticRecordKind;
  readonly targetId: string;
  /** World-valid time from which the target assertion no longer applies. */
  readonly effectiveFrom: string;
  /** Knowledge/system time when SSRL learned the invalidation. */
  readonly recordedAt: string;
  readonly source?: SourceRef;
  readonly evidenceRefs?: readonly string[];
}

export interface RetractionApplication {
  readonly targetKind: RetractableSemanticRecordKind;
  readonly targetId: string;
  readonly effectiveValidTo?: string;
  readonly retractions: readonly SemanticRetraction[];
}

function validateSource(source: SourceRef, retractionId: string): void {
  if (source.provider.length === 0) {
    throw new Error(`Semantic retraction ${retractionId} source provider must not be empty`);
  }
  if (source.externalId.length === 0) {
    throw new Error(`Semantic retraction ${retractionId} source externalId must not be empty`);
  }
  if (source.revision?.length === 0) {
    throw new Error(`Semantic retraction ${retractionId} source revision must not be empty`);
  }
}

export function validateSemanticRetraction(retraction: SemanticRetraction): void {
  if (retraction.id.length === 0) throw new Error("Semantic retraction id must not be empty");
  if (retraction.targetId.length === 0) {
    throw new Error(`Semantic retraction ${retraction.id} targetId must not be empty`);
  }
  timestamp(retraction.effectiveFrom, "retraction effectiveFrom");
  timestamp(retraction.recordedAt, "retraction recordedAt");
  if (retraction.source !== undefined) validateSource(retraction.source, retraction.id);
  for (const evidenceRef of retraction.evidenceRefs ?? []) {
    if (evidenceRef.length === 0) {
      throw new Error(`Semantic retraction ${retraction.id} evidence ref must not be empty`);
    }
  }
}

export function validateUniqueRetractionIds(retractions: readonly SemanticRetraction[]): void {
  const ids = new Set<string>();
  for (const retraction of retractions) {
    validateSemanticRetraction(retraction);
    if (ids.has(retraction.id)) {
      throw new Error(`Duplicate semantic retraction id: ${retraction.id}`);
    }
    ids.add(retraction.id);
  }
}

function retractionOrder(left: SemanticRetraction, right: SemanticRetraction): number {
  return left.effectiveFrom.localeCompare(right.effectiveFrom)
    || left.recordedAt.localeCompare(right.recordedAt)
    || left.id.localeCompare(right.id);
}

export function applicableRetractions(input: {
  readonly targetKind: RetractableSemanticRecordKind;
  readonly targetId: string;
  readonly retractions: readonly SemanticRetraction[];
  readonly knownAt: string;
}): SemanticRetraction[] {
  const knownAt = timestamp(input.knownAt, "retraction knownAt");
  validateUniqueRetractionIds(input.retractions);
  return input.retractions
    .filter((retraction) => retraction.targetKind === input.targetKind)
    .filter((retraction) => retraction.targetId === input.targetId)
    .filter((retraction) => Date.parse(retraction.recordedAt) <= knownAt)
    .toSorted(retractionOrder);
}

export function retractionApplication(input: {
  readonly targetKind: RetractableSemanticRecordKind;
  readonly targetId: string;
  readonly originalValidTo?: string;
  readonly retractions: readonly SemanticRetraction[];
  readonly knownAt: string;
}): RetractionApplication {
  const known = applicableRetractions(input);
  const originalValidTo = input.originalValidTo === undefined
    ? Number.POSITIVE_INFINITY
    : timestamp(input.originalValidTo, "target validTo");
  const earliestRetraction = known.length === 0
    ? Number.POSITIVE_INFINITY
    : Math.min(...known.map((retraction) => Date.parse(retraction.effectiveFrom)));
  const effectiveValidTo = Math.min(originalValidTo, earliestRetraction);
  const shorteningRetractions = known.filter(
    (retraction) => Date.parse(retraction.effectiveFrom) === effectiveValidTo
      && effectiveValidTo < originalValidTo,
  );
  return {
    targetKind: input.targetKind,
    targetId: input.targetId,
    ...(Number.isFinite(effectiveValidTo)
      ? { effectiveValidTo: new Date(effectiveValidTo).toISOString() }
      : {}),
    retractions: shorteningRetractions,
  };
}


export function effectiveRetractionEnd(input: {
  readonly targetKind: RetractableSemanticRecordKind;
  readonly targetId: string;
  readonly originalValidTo?: string;
  readonly retractions: readonly SemanticRetraction[];
  readonly knownAt: string;
}): { readonly validTo: number; readonly retractions: readonly SemanticRetraction[] } {
  const application = retractionApplication(input);
  return {
    validTo: application.effectiveValidTo === undefined
      ? Number.POSITIVE_INFINITY
      : Date.parse(application.effectiveValidTo),
    retractions: application.retractions,
  };
}

export function uniqueRetractions(
  retractions: readonly SemanticRetraction[],
): SemanticRetraction[] {
  return [...new Map(
    retractions
      .toSorted((left, right) => left.id.localeCompare(right.id))
      .map((retraction) => [retraction.id, retraction]),
  ).values()];
}
