import type {
  Conflict,
  Mutation,
  ReconciliationPlan,
  StateValue,
} from "./model.js";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON cannot contain non-finite numbers");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((child) => {
      if (child === undefined) {
        throw new TypeError("Canonical JSON arrays cannot contain undefined");
      }
      return canonicalize(child);
    });
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON can contain only plain objects");
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  throw new TypeError(`Canonical JSON cannot contain ${typeof value}`);
}

export interface ProposalConflictCandidate {
  readonly provider: string;
  readonly externalId: string;
  readonly value: StateValue;
}

export interface ProposalConflict {
  readonly property: string;
  readonly reason: Conflict["reason"];
  readonly candidates: readonly ProposalConflictCandidate[];
}

export interface ReconciliationProposalMaterial {
  readonly schema: "ssrl-reconciliation-proposal-v1";
  readonly entityId: ReconciliationPlan["entityId"];
  readonly mutations: readonly Mutation[];
  readonly conflicts: readonly ProposalConflict[];
}

function mutationOrder(left: Mutation, right: Mutation): number {
  return left.provider.localeCompare(right.provider)
    || left.externalId.localeCompare(right.externalId)
    || left.externalPath.localeCompare(right.externalPath)
    || left.canonicalProperty.localeCompare(right.canonicalProperty)
    || canonicalJson(left).localeCompare(canonicalJson(right));
}

export function reconciliationProposalMaterial(
  plan: ReconciliationPlan,
): ReconciliationProposalMaterial {
  const mutations = [...plan.mutations].sort(mutationOrder);
  const conflicts = plan.conflicts
    .map((conflict): ProposalConflict => ({
      property: conflict.property,
      reason: conflict.reason,
      candidates: conflict.candidates
        .map((candidate) => ({
          provider: candidate.provider,
          externalId: candidate.externalId,
          value: candidate.value,
        }))
        .sort((left, right) => (
          left.provider.localeCompare(right.provider)
          || left.externalId.localeCompare(right.externalId)
          || canonicalJson(left.value).localeCompare(canonicalJson(right.value))
        )),
    }))
    .sort((left, right) => (
      left.property.localeCompare(right.property)
      || left.reason.localeCompare(right.reason)
    ));

  return {
    schema: "ssrl-reconciliation-proposal-v1",
    entityId: plan.entityId,
    mutations,
    conflicts,
  };
}

export function reconciliationProposalJson(plan: ReconciliationPlan): string {
  return canonicalJson(reconciliationProposalMaterial(plan));
}
