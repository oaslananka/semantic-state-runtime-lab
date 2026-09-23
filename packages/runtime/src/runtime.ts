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
import type {
  RuntimeEventSink,
  RuntimeJournalEvent,
  RuntimeJournalEventType,
} from "@ssrl/journal";

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

interface MutationApplyObserver<Token> {
  before(mutation: Mutation): Promise<Token>;
  applied(mutation: Mutation, token: Token): Promise<void>;
  failed(
    mutation: Mutation,
    token: Token,
    cause: unknown,
    applied: readonly Mutation[],
  ): Promise<void>;
}

async function applyPlan<Token>(
  plan: ReconciliationPlan,
  registry: ProviderRegistry,
  observer?: MutationApplyObserver<Token>,
): Promise<{ readonly applied: readonly Mutation[] }> {
  if (plan.conflicts.length > 0) {
    throw new ReconciliationBlockedError(plan);
  }

  const applied: Mutation[] = [];
  for (const mutation of plan.mutations) {
    const token = observer === undefined
      ? undefined
      : await observer.before(mutation);

    try {
      await providerFor(registry, mutation.provider).apply(mutation);
    } catch (cause) {
      if (observer !== undefined) {
        try {
          await observer.failed(mutation, token as Token, cause, applied);
        } catch (journalCause) {
          throw new ReconciliationApplyError(mutation, [...applied], {
            cause: new AggregateError(
              [cause, journalCause],
              "Provider mutation failed and failure journaling also failed",
            ),
          });
        }
      }
      throw new ReconciliationApplyError(mutation, [...applied], { cause });
    }

    applied.push(mutation);
    if (observer !== undefined) {
      await observer.applied(mutation, token as Token);
    }
  }

  return { applied };
}

export async function applyReconciliationPlan(
  plan: ReconciliationPlan,
  registry: ProviderRegistry,
): Promise<{ readonly applied: readonly Mutation[] }> {
  return applyPlan(plan, registry);
}

type EventOf<Type extends RuntimeJournalEventType> = Extract<
  RuntimeJournalEvent,
  { readonly type: Type }
>;

type EventPayload<Type extends RuntimeJournalEventType> = EventOf<Type>["payload"];

interface JournalContext {
  readonly sink: RuntimeEventSink;
  readonly runId: string;
  readonly entityId: EntityId;
  readonly now: () => string;
}

function journalEvent<Type extends RuntimeJournalEventType>(
  context: JournalContext,
  type: Type,
  payload: EventPayload<Type>,
): EventOf<Type> {
  return {
    schemaVersion: 1,
    eventId: context.sink.createId(),
    runId: context.runId,
    entityId: context.entityId,
    type,
    occurredAt: context.now(),
    payload,
  } as EventOf<Type>;
}

async function appendEvent<Type extends RuntimeJournalEventType>(
  context: JournalContext | undefined,
  type: Type,
  payload: EventPayload<Type>,
): Promise<void> {
  if (context === undefined) return;
  await context.sink.append([journalEvent(context, type, payload)]);
}

async function appendObservations(
  context: JournalContext | undefined,
  snapshots: readonly ExternalSnapshot[],
  phase: "before" | "after",
): Promise<void> {
  if (context === undefined) return;
  await context.sink.append(
    snapshots.map((snapshot) => journalEvent(
      context,
      "observation.recorded",
      { phase, snapshot },
    )),
  );
}

function errorSummary(cause: unknown): { readonly name: string } {
  if (cause instanceof Error && cause.name.length > 0) return { name: cause.name };
  return { name: typeof cause };
}

function journalObserver(
  context: JournalContext | undefined,
): MutationApplyObserver<string> | undefined {
  if (context === undefined) return undefined;

  return {
    async before(mutation) {
      const mutationId = context.sink.createId();
      await appendEvent(context, "mutation.requested", { mutationId, mutation });
      return mutationId;
    },
    async applied(mutation, mutationId) {
      await appendEvent(context, "mutation.applied", { mutationId, mutation });
    },
    async failed(mutation, mutationId, cause, applied) {
      await context.sink.append([
        journalEvent(context, "mutation.failed", {
          mutationId,
          mutation,
          error: errorSummary(cause),
        }),
        journalEvent(context, "reconciliation.failed", {
          failed: mutation,
          applied: [...applied],
          error: errorSummary(cause),
        }),
      ]);
    },
  };
}

export interface ReconcileInput {
  readonly entityId: EntityId;
  readonly bindings: readonly ExternalBinding[];
  readonly authority?: readonly AuthorityRule[];
  readonly registry: ProviderRegistry;
  readonly dryRun?: boolean;
  readonly journal?: RuntimeEventSink;
  readonly now?: () => string;
}

export interface ReconcileResult {
  readonly before: ReconciliationPlan;
  readonly after?: ReconciliationPlan;
  readonly applied: readonly Mutation[];
  readonly journalRunId?: string;
}

function resultWithJournal(
  result: Omit<ReconcileResult, "journalRunId">,
  context: JournalContext | undefined,
): ReconcileResult {
  return context === undefined
    ? result
    : { ...result, journalRunId: context.runId };
}

export async function reconcileOnce(input: ReconcileInput): Promise<ReconcileResult> {
  const context = input.journal === undefined
    ? undefined
    : {
      sink: input.journal,
      runId: input.journal.createId(),
      entityId: input.entityId,
      now: input.now ?? (() => new Date().toISOString()),
    } satisfies JournalContext;

  await appendEvent(context, "reconciliation.started", {
    dryRun: input.dryRun === true,
  });

  const snapshots = await observeBindings(input.bindings, input.registry);
  await appendObservations(context, snapshots, "before");

  const before = planReconciliation({
    entityId: input.entityId,
    snapshots,
    ...(input.authority === undefined ? {} : { authority: input.authority }),
  });
  await appendEvent(context, "reconciliation.planned", { plan: before });

  if (input.dryRun === true || before.mutations.length === 0 || before.conflicts.length > 0) {
    const outcome = input.dryRun === true
      ? "dry-run"
      : before.conflicts.length > 0
        ? "blocked"
        : "noop";
    await appendEvent(context, "reconciliation.completed", {
      outcome,
      finalPlan: before,
    });
    return resultWithJournal({ before, applied: [] }, context);
  }

  const { applied } = await applyPlan(
    before,
    input.registry,
    journalObserver(context),
  );

  const observedAfter = await observeBindings(input.bindings, input.registry);
  await appendObservations(context, observedAfter, "after");
  const after = planReconciliation({
    entityId: input.entityId,
    snapshots: observedAfter,
    ...(input.authority === undefined ? {} : { authority: input.authority }),
  });

  const outcome = after.mutations.length === 0 && after.conflicts.length === 0
    ? "converged"
    : "not-converged";
  await appendEvent(context, "reconciliation.completed", {
    outcome,
    finalPlan: after,
  });

  return resultWithJournal({ before, after, applied }, context);
}
