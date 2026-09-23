import {
  planReconciliation,
  type AuthorityRule,
  type EntityId,
  type ExternalBinding,
  type ExternalSnapshot,
  type Mutation,
  type ProviderId,
  type ReconciliationPlan,
} from "@ssrl/core";

export interface StateProvider {
  readonly id: ProviderId;
  observe(binding: ExternalBinding): Promise<ExternalSnapshot>;
  apply(mutation: Mutation): Promise<void>;
}

export interface ProviderRegistry {
  readonly providers: ReadonlyMap<ProviderId, StateProvider>;
}

export class ReconciliationBlockedError extends Error {
  constructor(readonly plan: ReconciliationPlan) {
    super("Reconciliation is blocked by unresolved conflicts");
    this.name = "ReconciliationBlockedError";
  }
}

export class ReconciliationApplyError extends Error {
  constructor(
    readonly failed: Mutation,
    readonly applied: readonly Mutation[],
    options: { readonly cause: unknown },
  ) {
    super(
      `Failed applying ${failed.provider}/${failed.externalId}:${failed.externalPath}`,
      options,
    );
    this.name = "ReconciliationApplyError";
  }
}

function providerFor(registry: ProviderRegistry, providerId: ProviderId): StateProvider {
  const provider = registry.providers.get(providerId);
  if (provider === undefined) {
    throw new Error(`No provider registered for ${providerId}`);
  }
  return provider;
}

export async function observeBindings(
  bindings: readonly ExternalBinding[],
  registry: ProviderRegistry,
): Promise<ExternalSnapshot[]> {
  return Promise.all(
    bindings.map((binding) => providerFor(registry, binding.provider).observe(binding)),
  );
}

export async function applyReconciliationPlan(
  plan: ReconciliationPlan,
  registry: ProviderRegistry,
): Promise<{ readonly applied: readonly Mutation[] }> {
  if (plan.conflicts.length > 0) {
    throw new ReconciliationBlockedError(plan);
  }

  const applied: Mutation[] = [];
  for (const mutation of plan.mutations) {
    try {
      await providerFor(registry, mutation.provider).apply(mutation);
      applied.push(mutation);
    } catch (cause) {
      throw new ReconciliationApplyError(mutation, [...applied], { cause });
    }
  }
  return { applied };
}

export interface ReconcileInput {
  readonly entityId: EntityId;
  readonly bindings: readonly ExternalBinding[];
  readonly authority?: readonly AuthorityRule[];
  readonly registry: ProviderRegistry;
  readonly dryRun?: boolean;
}

export interface ReconcileResult {
  readonly before: ReconciliationPlan;
  readonly after?: ReconciliationPlan;
  readonly applied: readonly Mutation[];
}

export async function reconcileOnce(input: ReconcileInput): Promise<ReconcileResult> {
  const snapshots = await observeBindings(input.bindings, input.registry);
  const before = planReconciliation({
    entityId: input.entityId,
    snapshots,
    ...(input.authority === undefined ? {} : { authority: input.authority }),
  });

  if (input.dryRun === true || before.mutations.length === 0 || before.conflicts.length > 0) {
    return { before, applied: [] };
  }

  const { applied } = await applyReconciliationPlan(before, input.registry);
  const observedAfter = await observeBindings(input.bindings, input.registry);
  const after = planReconciliation({
    entityId: input.entityId,
    snapshots: observedAfter,
    ...(input.authority === undefined ? {} : { authority: input.authority }),
  });

  return { before, after, applied };
}
