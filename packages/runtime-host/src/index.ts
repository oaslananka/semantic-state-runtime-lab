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

export interface RuntimePrincipal {
  readonly subject: string;
  readonly scopes: readonly string[];
}

export type RuntimeAccessDecision =
  | { readonly effect: "allow" }
  | { readonly effect: "deny"; readonly code: string };

export type RuntimeAccessRequest =
  | {
    readonly kind: "operation";
    readonly operation: "plan" | "apply";
    readonly principal: RuntimePrincipal;
    readonly entityId: EntityId;
    readonly expectedDigest?: ProposalDigest;
  }
  | {
    readonly kind: "field";
    readonly operation: "read" | "write";
    readonly principal: RuntimePrincipal;
    readonly entityId: EntityId;
    readonly canonicalProperty: string;
    readonly provider: string;
    readonly externalId: string;
  }
  | {
    readonly kind: "proposal";
    readonly operation: "apply";
    readonly principal: RuntimePrincipal;
    readonly entityId: EntityId;
    readonly digest: ProposalDigest;
    readonly plan: ReconciliationPlan;
  };

export interface RuntimeAccessPolicy {
  evaluate(
    request: RuntimeAccessRequest,
  ): RuntimeAccessDecision | undefined | Promise<RuntimeAccessDecision | undefined>;
}

export class RuntimeAccessDeniedError extends Error {
  constructor(
    readonly code: string,
    readonly requestKind: RuntimeAccessRequest["kind"],
    readonly operation: RuntimeAccessRequest["operation"],
  ) {
    super(`Runtime access denied: ${code}`);
    this.name = "RuntimeAccessDeniedError";
  }
}

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
  readonly accessPolicy?: RuntimeAccessPolicy;
}

export class RuntimeHost {
  readonly #catalog: EntityRuntimeCatalog;
  readonly #registry: ProviderRegistry;
  readonly #journal: RuntimeEventSink | undefined;
  readonly #now: (() => string) | undefined;
  readonly #accessPolicy: RuntimeAccessPolicy | undefined;

  constructor(options: RuntimeHostOptions) {
    this.#catalog = options.catalog;
    this.#registry = options.registry;
    this.#journal = options.journal;
    this.#now = options.now;
    this.#accessPolicy = options.accessPolicy;
  }

  async #definition(entityId: EntityId): Promise<EntityRuntimeDefinition> {
    const definition = await this.#catalog.get(entityId);
    if (definition === undefined) {
      throw new EntityNotConfiguredError(entityId);
    }
    return definition;
  }

  #principalOrDeny(
    principal: RuntimePrincipal | undefined,
    kind: RuntimeAccessRequest["kind"],
    operation: RuntimeAccessRequest["operation"],
  ): RuntimePrincipal {
    if (principal !== undefined) return principal;
    throw new RuntimeAccessDeniedError("principal-required", kind, operation);
  }

  async #decision(request: RuntimeAccessRequest): Promise<RuntimeAccessDecision> {
    if (this.#accessPolicy === undefined) return { effect: "allow" };
    return await this.#accessPolicy.evaluate(request)
      ?? { effect: "deny", code: "no-matching-policy-rule" };
  }

  async #authorizeOperation(
    operation: "plan" | "apply",
    entityId: EntityId,
    principal: RuntimePrincipal | undefined,
    expectedDigest?: ProposalDigest,
  ): Promise<void> {
    if (this.#accessPolicy === undefined) return;
    const actor = this.#principalOrDeny(principal, "operation", operation);
    const request: RuntimeAccessRequest = {
      kind: "operation",
      operation,
      principal: actor,
      entityId,
      ...(expectedDigest === undefined ? {} : { expectedDigest }),
    };
    const decision = await this.#decision(request);
    if (decision.effect === "deny") {
      throw new RuntimeAccessDeniedError(decision.code, request.kind, request.operation);
    }
  }

  async #fieldAllowed(
    operation: "read" | "write",
    entityId: EntityId,
    binding: ExternalBinding,
    canonicalProperty: string,
    principal: RuntimePrincipal | undefined,
  ): Promise<boolean> {
    if (this.#accessPolicy === undefined) return true;
    const actor = this.#principalOrDeny(principal, "field", operation);
    const decision = await this.#decision({
      kind: "field",
      operation,
      principal: actor,
      entityId,
      canonicalProperty,
      provider: binding.provider,
      externalId: binding.externalId,
    });
    return decision.effect === "allow";
  }

  async #projectBinding(
    entityId: EntityId,
    binding: ExternalBinding,
    principal: RuntimePrincipal | undefined,
  ): Promise<ExternalBinding> {
    const fields: ExternalBinding["fields"][number][] = [];
    for (const field of binding.fields) {
      const readable = field.readable
        && await this.#fieldAllowed(
          "read",
          entityId,
          binding,
          field.canonical,
          principal,
        );
      const writable = field.writable
        && await this.#fieldAllowed(
          "write",
          entityId,
          binding,
          field.canonical,
          principal,
        );
      fields.push({ ...field, readable, writable });
    }
    return { ...binding, fields };
  }

  async #projectDefinition(
    definition: EntityRuntimeDefinition,
    principal: RuntimePrincipal | undefined,
  ): Promise<EntityRuntimeDefinition> {
    if (this.#accessPolicy === undefined) return definition;

    const bindings: ExternalBinding[] = [];
    for (const binding of definition.bindings) {
      bindings.push(await this.#projectBinding(
        definition.entityId,
        binding,
        principal,
      ));
    }

    return {
      ...definition,
      bindings,
    };
  }

  async #authorizeProposal(
    entityId: EntityId,
    plan: ReconciliationPlan,
    digest: ProposalDigest,
    principal: RuntimePrincipal | undefined,
  ): Promise<void> {
    if (this.#accessPolicy === undefined) return;
    const actor = this.#principalOrDeny(principal, "proposal", "apply");
    const request: RuntimeAccessRequest = {
      kind: "proposal",
      operation: "apply",
      principal: actor,
      entityId,
      digest,
      plan,
    };
    const decision = await this.#decision(request);
    if (decision.effect === "deny") {
      throw new RuntimeAccessDeniedError(decision.code, request.kind, request.operation);
    }
  }

  async plan(
    entityId: EntityId,
    principal?: RuntimePrincipal,
  ): Promise<ReconciliationProposal> {
    await this.#authorizeOperation("plan", entityId, principal);
    const definition = await this.#projectDefinition(
      await this.#definition(entityId),
      principal,
    );
    const result = await reconcileOnce({
      entityId,
      bindings: definition.bindings,
      registry: this.#registry,
      dryRun: true,
      ...(definition.authority === undefined ? {} : { authority: definition.authority }),
      ...(this.#journal === undefined ? {} : { journal: this.#journal }),
      ...(this.#now === undefined ? {} : { now: this.#now }),
      ...(principal === undefined ? {} : { actorSubject: principal.subject }),
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
    principal?: RuntimePrincipal,
  ): Promise<ReconcileResult> {
    assertProposalDigest(expectedDigest);
    await this.#authorizeOperation("apply", entityId, principal, expectedDigest);
    const definition = await this.#projectDefinition(
      await this.#definition(entityId),
      principal,
    );

    const result = await reconcileOnce({
      entityId,
      bindings: definition.bindings,
      registry: this.#registry,
      ...(definition.authority === undefined ? {} : { authority: definition.authority }),
      ...(this.#journal === undefined ? {} : { journal: this.#journal }),
      ...(this.#now === undefined ? {} : { now: this.#now }),
      ...(principal === undefined ? {} : { actorSubject: principal.subject }),
      planGuard: {
        expectedDigest,
        digest: async (plan) => {
          const digest = sha256ProposalDigest(plan);
          await this.#authorizeProposal(entityId, plan, digest, principal);
          return digest;
        },
      },
    });

    if (result.before.conflicts.length > 0) {
      throw new ReconciliationBlockedError(result.before);
    }
    return result;
  }
}
