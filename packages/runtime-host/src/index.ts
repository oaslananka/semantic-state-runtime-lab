import { createHash } from "node:crypto";
import {
  reconciliationProposalJson,
  type AuthorityRule,
  type EntityId,
  type ExternalBinding,
  type ReconciliationPlan,
} from "@ssrl/core";
import type { RuntimeEventSink } from "@ssrl/journal";
import {
  ReconciliationBlockedError,
  reconcileOnce,
  type ProviderRegistry,
  type ReconcileResult,
} from "@ssrl/runtime";

export type ProposalDigest = `sha256:${string}`;
export type ProposalStatus = "ready" | "blocked" | "noop";

export interface EntityRuntimeDefinition {
  readonly entityId: EntityId;
  readonly bindings: readonly ExternalBinding[];
  readonly authority?: readonly AuthorityRule[];
}

export interface EntityRuntimeCatalog {
  get(entityId: EntityId): Promise<EntityRuntimeDefinition | undefined>;
}

export class EntityNotConfiguredError extends Error {
  constructor(readonly entityId: EntityId) {
    super(`No runtime definition configured for ${entityId}`);
    this.name = "EntityNotConfiguredError";
  }
}

export class InvalidProposalDigestError extends Error {
  constructor(readonly digest: string) {
    super(`Invalid reconciliation proposal digest: ${digest}`);
    this.name = "InvalidProposalDigestError";
  }
}

export class InMemoryEntityRuntimeCatalog implements EntityRuntimeCatalog {
  readonly #definitions = new Map<EntityId, EntityRuntimeDefinition>();

  constructor(definitions: readonly EntityRuntimeDefinition[]) {
    for (const definition of definitions) {
      if (this.#definitions.has(definition.entityId)) {
        throw new Error(`Duplicate runtime definition for ${definition.entityId}`);
      }
      for (const binding of definition.bindings) {
        if (binding.entityId !== definition.entityId) {
          throw new Error(
            `Binding ${binding.provider}/${binding.externalId} belongs to ${binding.entityId}, not ${definition.entityId}`,
          );
        }
      }
      this.#definitions.set(definition.entityId, definition);
    }
  }

  async get(entityId: EntityId): Promise<EntityRuntimeDefinition | undefined> {
    return this.#definitions.get(entityId);
  }
}

export function sha256ProposalDigest(plan: ReconciliationPlan): ProposalDigest {
  const digest = createHash("sha256")
    .update(reconciliationProposalJson(plan), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

function assertProposalDigest(digest: string): asserts digest is ProposalDigest {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new InvalidProposalDigestError(digest);
  }
}

function proposalStatus(plan: ReconciliationPlan): ProposalStatus {
  if (plan.conflicts.length > 0) return "blocked";
  if (plan.mutations.length === 0) return "noop";
  return "ready";
}

export interface ReconciliationProposal {
  readonly digestAlgorithm: "sha256";
  readonly digest: ProposalDigest;
  readonly status: ProposalStatus;
  readonly plan: ReconciliationPlan;
  readonly journalRunId?: string;
}

export interface RuntimeHostOptions {
  readonly catalog: EntityRuntimeCatalog;
  readonly registry: ProviderRegistry;
  readonly journal?: RuntimeEventSink;
  readonly now?: () => string;
}

export class RuntimeHost {
  readonly #catalog: EntityRuntimeCatalog;
  readonly #registry: ProviderRegistry;
  readonly #journal: RuntimeEventSink | undefined;
  readonly #now: (() => string) | undefined;

  constructor(options: RuntimeHostOptions) {
    this.#catalog = options.catalog;
    this.#registry = options.registry;
    this.#journal = options.journal;
    this.#now = options.now;
  }

  async #definition(entityId: EntityId): Promise<EntityRuntimeDefinition> {
    const definition = await this.#catalog.get(entityId);
    if (definition === undefined) {
      throw new EntityNotConfiguredError(entityId);
    }
    return definition;
  }

  async plan(entityId: EntityId): Promise<ReconciliationProposal> {
    const definition = await this.#definition(entityId);
    const result = await reconcileOnce({
      entityId,
      bindings: definition.bindings,
      registry: this.#registry,
      dryRun: true,
      ...(definition.authority === undefined ? {} : { authority: definition.authority }),
      ...(this.#journal === undefined ? {} : { journal: this.#journal }),
      ...(this.#now === undefined ? {} : { now: this.#now }),
    });
    const digest = sha256ProposalDigest(result.before);

    return {
      digestAlgorithm: "sha256",
      digest,
      status: proposalStatus(result.before),
      plan: result.before,
      ...(result.journalRunId === undefined ? {} : { journalRunId: result.journalRunId }),
    };
  }

  async apply(
    entityId: EntityId,
    expectedDigest: string,
  ): Promise<ReconcileResult> {
    assertProposalDigest(expectedDigest);
    const definition = await this.#definition(entityId);
    const result = await reconcileOnce({
      entityId,
      bindings: definition.bindings,
      registry: this.#registry,
      ...(definition.authority === undefined ? {} : { authority: definition.authority }),
      ...(this.#journal === undefined ? {} : { journal: this.#journal }),
      ...(this.#now === undefined ? {} : { now: this.#now }),
      planGuard: {
        expectedDigest,
        digest: sha256ProposalDigest,
      },
    });

    if (result.before.conflicts.length > 0) {
      throw new ReconciliationBlockedError(result.before);
    }
    return result;
  }
}
