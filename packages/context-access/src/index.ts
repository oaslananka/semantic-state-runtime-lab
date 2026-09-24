import {
  normalizeAccessPrincipal,
  type AccessDecision,
  type AccessPrincipal,
} from "@ssrl/access";
import {
  TypedEntityResolver,
  normalizeEntityAlias,
  type EntityId,
  type EntityResolution,
  type EntityTypeDescriptor,
  type RelationTypeDescriptor,
  type StateValue,
  type TemporalRelationEdge,
} from "@ssrl/core";
import {
  bm25Baseline,
  contextCorpusFromCapsules,
  type ContextPackage,
  type ContextPropertyDescriptor,
  type ContextRecord,
} from "@ssrl/context";
import type {
  ContextCapsule,
  ContextCapsuleStore,
  ContextCapsuleSynchronizer,
} from "@ssrl/materializer";

export type ContextAccessRequest =
  | {
      readonly kind: "operation";
      readonly operation: "compile";
      readonly principal: AccessPrincipal;
      readonly budgetTokens: number;
    }
  | {
      readonly kind: "entity";
      readonly principal: AccessPrincipal;
      readonly entityId: EntityId;
    }
  | {
      readonly kind: "property";
      readonly principal: AccessPrincipal;
      readonly entityId: EntityId;
      readonly property: string;
    }
  | {
      readonly kind: "relation";
      readonly principal: AccessPrincipal;
      readonly edgeId: string;
      readonly from: EntityId;
      readonly to: EntityId;
      readonly relationType: string;
    }
  | {
      readonly kind: "provenance";
      readonly principal: AccessPrincipal;
      readonly entityId: EntityId;
      readonly recordId: string;
      readonly evidenceRef: string;
    };

type ContextAccessRequestWithoutPrincipal = ContextAccessRequest extends infer Request
  ? Request extends ContextAccessRequest
    ? Omit<Request, "principal">
    : never
  : never;

export interface ContextAccessPolicy {
  evaluate(
    request: ContextAccessRequest,
  ): AccessDecision | undefined | Promise<AccessDecision | undefined>;
}

export interface ContextAccessEvent {
  readonly at: string;
  readonly operation: "compile";
  readonly outcome: "allow" | "deny";
  readonly subject?: string;
  readonly code?: string;
  readonly requestedBudgetTokens: number;
  readonly effectiveBudgetTokens?: number;
  readonly resolutionStatus?: ContextAccessResolution["status"];
  readonly resolvedEntityId?: EntityId;
  readonly returnedRecords?: number;
  readonly returnedTokens?: number;
}

export interface ContextAccessEventSink {
  emit(event: ContextAccessEvent): void | Promise<void>;
}

export interface ContextAccessCompileRequest {
  readonly principal?: AccessPrincipal;
  readonly task: string;
  readonly budgetTokens: number;
  readonly validAt?: string;
  readonly knownAt?: string;
}

export type ContextAccessResolution =
  | { readonly status: "none" }
  | {
      readonly status: "resolved";
      readonly entityId: EntityId;
      readonly entityType: string;
    }
  | {
      readonly status: "ambiguous";
      readonly candidates: readonly {
        readonly entityId: EntityId;
        readonly entityType: string;
      }[];
    };

export interface ContextAccessResult {
  readonly resolution: ContextAccessResolution;
  readonly context: ContextPackage;
  readonly relatedEntityIds: readonly EntityId[];
}

export interface ContextAccessGatewayOptions {
  readonly capsules: ContextCapsuleStore;
  readonly synchronizer: ContextCapsuleSynchronizer;
  readonly entityTypes: readonly EntityTypeDescriptor[];
  readonly relationTypes: readonly RelationTypeDescriptor[];
  readonly properties?: readonly ContextPropertyDescriptor[];
  readonly policy?: ContextAccessPolicy;
  readonly events?: ContextAccessEventSink;
  readonly maxBudgetTokens?: number;
  readonly maxIdentityCandidates?: number;
  readonly maxIdentityScans?: number;
  readonly maxRelationCandidates?: number;
  readonly maxRelationScans?: number;
  readonly maxRelationEdges?: number;
  readonly now?: () => string;
}

export class ContextAccessDeniedError extends Error {
  constructor(readonly code: string) {
    super(`Context access denied: ${code}`);
    this.name = "ContextAccessDeniedError";
  }
}

export class ContextIdentityCandidateLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Context identity candidate search exceeded ${limit} candidates`);
    this.name = "ContextIdentityCandidateLimitError";
  }
}

export class ContextIdentityScanLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Context identity scan exceeded ${limit} derived capsules`);
    this.name = "ContextIdentityScanLimitError";
  }
}

export class ContextRelationCandidateLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Context visible relation candidates exceeded ${limit} relations`);
    this.name = "ContextRelationCandidateLimitError";
  }
}

export class ContextRelationScanLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Context relation scan exceeded ${limit} active relations`);
    this.name = "ContextRelationScanLimitError";
  }
}

export class HistoricalContextAccessUnsupportedError extends Error {
  constructor() {
    super("Context Access Gateway v1 compiles current capsules only");
    this.name = "HistoricalContextAccessUnsupportedError";
  }
}

function safeInteger(value: number, label: string, max?: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || (max !== undefined && value > max)) {
    throw new RangeError(`${label} must be a positive safe integer${max === undefined ? "" : ` <= ${max}`}`);
  }
  return value;
}

function accessTime(value: string, label: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new TypeError(`${label} must be a valid timestamp`);
  return new Date(millis).toISOString();
}

function terms(value: string): ReadonlySet<string> {
  return new Set(normalizeEntityAlias(value).split(" ").filter((term) => term.length >= 2));
}

function relationSearchText(
  edge: TemporalRelationEdge,
  target: ContextCapsule,
  relationTypes: ReadonlyMap<string, RelationTypeDescriptor>,
): string {
  const targetAliases = target.material.entity.aliases.map((alias) => alias.value);
  const aliases = relationTypes.get(edge.relationType)?.aliases ?? [edge.relationType];
  return [...aliases, ...targetAliases].join(" ");
}

function relationScore(
  taskTerms: ReadonlySet<string>,
  text: string,
): number {
  const searchable = terms(text);
  let score = 0;
  for (const term of taskTerms) if (searchable.has(term)) score += 1;
  return score;
}

function emptyContext(): ContextPackage {
  return { records: [], resolvedEntityIds: [], estimatedTokens: 0, consideredRecords: 0 };
}

function entityReferences(value: StateValue): EntityId[] {
  if (typeof value === "string") {
    return value.startsWith("entity://") ? [value as EntityId] : [];
  }
  if (Array.isArray(value)) return value.flatMap(entityReferences);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(entityReferences);
  }
  return [];
}

function sanitizedResolution(resolution: EntityResolution): ContextAccessResolution {
  if (resolution.status === "none") return { status: "none" };
  if (resolution.status === "resolved") {
    const candidate = resolution.candidates.find((item) => item.entityId === resolution.entityId);
    if (candidate === undefined) throw new Error("Resolved entity candidate metadata is missing");
    return {
      status: "resolved",
      entityId: resolution.entityId,
      entityType: candidate.entityType,
    };
  }
  return {
    status: "ambiguous",
    candidates: resolution.candidates.map((candidate) => ({
      entityId: candidate.entityId,
      entityType: candidate.entityType,
    })),
  };
}

export class ContextAccessGateway {
  readonly #capsules: ContextCapsuleStore;
  readonly #synchronizer: ContextCapsuleSynchronizer;
  readonly #entityTypes: readonly EntityTypeDescriptor[];
  readonly #relationTypes: ReadonlyMap<string, RelationTypeDescriptor>;
  readonly #relationTypeList: readonly RelationTypeDescriptor[];
  readonly #properties: readonly ContextPropertyDescriptor[];
  readonly #policy: ContextAccessPolicy | undefined;
  readonly #events: ContextAccessEventSink | undefined;
  readonly #maxBudgetTokens: number;
  readonly #maxIdentityCandidates: number;
  readonly #maxIdentityScans: number;
  readonly #maxRelationCandidates: number;
  readonly #maxRelationScans: number;
  readonly #maxRelationEdges: number;
  readonly #now: () => string;

  constructor(options: ContextAccessGatewayOptions) {
    this.#capsules = options.capsules;
    this.#synchronizer = options.synchronizer;
    this.#entityTypes = options.entityTypes;
    this.#relationTypeList = options.relationTypes;
    this.#relationTypes = new Map(options.relationTypes.map((type) => [type.id, type]));
    this.#properties = options.properties ?? [];
    this.#policy = options.policy;
    this.#events = options.events;
    this.#maxBudgetTokens = safeInteger(options.maxBudgetTokens ?? 4_096, "maxBudgetTokens");
    this.#maxIdentityCandidates = safeInteger(
      options.maxIdentityCandidates ?? 64,
      "maxIdentityCandidates",
      999,
    );
    this.#maxIdentityScans = safeInteger(
      options.maxIdentityScans ?? 256,
      "maxIdentityScans",
      999,
    );
    this.#maxRelationCandidates = safeInteger(
      options.maxRelationCandidates ?? 64,
      "maxRelationCandidates",
    );
    this.#maxRelationScans = safeInteger(
      options.maxRelationScans ?? 256,
      "maxRelationScans",
    );
    this.#maxRelationEdges = safeInteger(options.maxRelationEdges ?? 4, "maxRelationEdges");
    if (this.#maxIdentityCandidates > this.#maxIdentityScans) {
      throw new RangeError("maxIdentityCandidates must not exceed maxIdentityScans");
    }
    if (this.#maxRelationCandidates > this.#maxRelationScans) {
      throw new RangeError("maxRelationCandidates must not exceed maxRelationScans");
    }
    if (this.#maxRelationEdges > this.#maxRelationCandidates) {
      throw new RangeError("maxRelationEdges must not exceed maxRelationCandidates");
    }
    this.#now = options.now ?? (() => new Date().toISOString());
    if (this.#relationTypes.size !== options.relationTypes.length) {
      throw new Error("Context Access relation type ids must be unique");
    }
  }

  #principal(principal: AccessPrincipal | undefined): AccessPrincipal | undefined {
    if (principal !== undefined) return normalizeAccessPrincipal(principal);
    if (this.#policy === undefined) return undefined;
    throw new ContextAccessDeniedError("principal-required");
  }

  async #decision(request: ContextAccessRequest): Promise<AccessDecision> {
    if (this.#policy === undefined) return { effect: "allow" };
    return await this.#policy.evaluate(request) ?? { effect: "deny", code: "no-matching-policy-rule" };
  }

  async #allows(
    principal: AccessPrincipal | undefined,
    request: ContextAccessRequestWithoutPrincipal,
  ): Promise<boolean> {
    if (this.#policy === undefined) return true;
    const actor = this.#principal(principal)!;
    return (await this.#decision({ ...request, principal: actor } as ContextAccessRequest)).effect === "allow";
  }

  async #emit(event: Omit<ContextAccessEvent, "at">): Promise<void> {
    if (this.#events === undefined) return;
    await this.#events.emit({ at: accessTime(this.#now(), "context access event time"), ...event });
  }

  #currentTime(request: ContextAccessCompileRequest): string {
    if (request.validAt !== undefined || request.knownAt !== undefined) {
      throw new HistoricalContextAccessUnsupportedError();
    }
    return accessTime(this.#now(), "context access time");
  }

  async #emitAllowed(
    principal: AccessPrincipal | undefined,
    budgetTokens: number,
    resolution: ContextAccessResolution,
    context: ContextPackage,
    resolvedEntityId?: EntityId,
  ): Promise<void> {
    await this.#emit({
      operation: "compile",
      outcome: "allow",
      ...(principal === undefined ? {} : { subject: principal.subject }),
      requestedBudgetTokens: budgetTokens,
      effectiveBudgetTokens: budgetTokens,
      resolutionStatus: resolution.status,
      ...(resolvedEntityId === undefined ? {} : { resolvedEntityId }),
      returnedRecords: context.records.length,
      returnedTokens: context.estimatedTokens,
    });
  }

  async #authorizeOperation(
    principal: AccessPrincipal | undefined,
    budgetTokens: number,
  ): Promise<void> {
    if (this.#policy === undefined) return;
    const actor = this.#principal(principal)!;
    const decision = await this.#decision({
      kind: "operation",
      operation: "compile",
      principal: actor,
      budgetTokens,
    });
    if (decision.effect === "allow") return;
    await this.#emit({
      operation: "compile",
      outcome: "deny",
      subject: actor.subject,
      code: decision.code,
      requestedBudgetTokens: budgetTokens,
    });
    throw new ContextAccessDeniedError(decision.code);
  }

  async #entityAllowed(principal: AccessPrincipal | undefined, entityId: EntityId): Promise<boolean> {
    return this.#allows(principal, { kind: "entity", entityId });
  }

  async #stateValueAllowed(principal: AccessPrincipal | undefined, value: StateValue): Promise<boolean> {
    const refs = [...new Set(entityReferences(value))].toSorted((left, right) => left.localeCompare(right));
    for (const entityId of refs) {
      if (!(await this.#entityAllowed(principal, entityId))) return false;
    }
    return true;
  }

  async #visibleCapsule(
    capsule: ContextCapsule,
    principal: AccessPrincipal | undefined,
    activeRelations: readonly TemporalRelationEdge[],
  ): Promise<ContextCapsule> {
    const properties: Record<string, (typeof capsule.material.state.canonical.properties)[string]> = {};
    const evidence: Record<string, (typeof capsule.material.state.evidence)[string]> = {};
    for (const [property, state] of Object.entries(capsule.material.state.canonical.properties)) {
      if (!(await this.#allows(principal, { kind: "property", entityId: capsule.entityId, property }))) {
        continue;
      }
      if (!(await this.#stateValueAllowed(principal, state.value))) continue;
      properties[property] = state;
      const propertyEvidence = capsule.material.state.evidence[property];
      if (propertyEvidence !== undefined) evidence[property] = propertyEvidence;
    }

    const conflicts = [] as typeof capsule.material.state.conflicts[number][];
    const conflictEvidence: Record<string, (typeof capsule.material.state.conflictEvidence)[string]> = {};
    for (const conflict of capsule.material.state.conflicts) {
      if (!(await this.#allows(principal, {
        kind: "property",
        entityId: capsule.entityId,
        property: conflict.property,
      }))) continue;
      let visible = true;
      for (const candidate of conflict.candidates) {
        if (!(await this.#stateValueAllowed(principal, candidate.value))) {
          visible = false;
          break;
        }
      }
      if (!visible) continue;
      conflicts.push(conflict);
      const propertyConflictEvidence = capsule.material.state.conflictEvidence[conflict.property];
      if (propertyConflictEvidence !== undefined) {
        conflictEvidence[conflict.property] = propertyConflictEvidence;
      }
    }

    return {
      ...capsule,
      material: {
        ...capsule.material,
        state: {
          canonical: { entityId: capsule.entityId, properties },
          conflicts,
          evidence,
          conflictEvidence,
        },
        activeRelations,
      },
    };
  }

  async #visibleEvidence(
    principal: AccessPrincipal | undefined,
    records: readonly ContextRecord[],
  ): Promise<ContextRecord[]> {
    const result: ContextRecord[] = [];
    for (const record of records) {
      const refs: string[] = [];
      for (const evidenceRef of record.evidenceRefs ?? []) {
        const entityId = record.entityId as EntityId;
        if (await this.#allows(principal, {
          kind: "provenance",
          entityId,
          recordId: record.id,
          evidenceRef,
        })) refs.push(evidenceRef);
      }
      const { evidenceRefs: _evidenceRefs, ...base } = record;
      result.push({
        ...base,
        ...(refs.length === 0 ? {} : { evidenceRefs: refs }),
      });
    }
    return result;
  }

  async #relatedCapsules(
    direct: ContextCapsule,
    task: string,
    principal: AccessPrincipal | undefined,
  ): Promise<{
    readonly directRelations: readonly TemporalRelationEdge[];
    readonly capsules: readonly ContextCapsule[];
  }> {
    if (direct.material.activeRelations.length > this.#maxRelationScans) {
      throw new ContextRelationScanLimitError(this.#maxRelationScans);
    }
    const taskTerms = terms(task);
    const candidates: Array<{
      readonly edge: TemporalRelationEdge;
      readonly capsule: ContextCapsule;
      readonly score: number;
    }> = [];
    for (const edge of direct.material.activeRelations) {
      if (!(await this.#allows(principal, {
        kind: "relation",
        edgeId: edge.id,
        from: edge.from,
        to: edge.to,
        relationType: edge.relationType,
      }))) continue;
      if (!(await this.#entityAllowed(principal, edge.to))) continue;
      const target = await this.#capsules.get(edge.to);
      if (target === undefined) continue;
      const score = relationScore(
        taskTerms,
        relationSearchText(edge, target, this.#relationTypes),
      );
      if (score === 0) continue;
      candidates.push({ edge, capsule: target, score });
    }
    if (candidates.length > this.#maxRelationCandidates) {
      throw new ContextRelationCandidateLimitError(this.#maxRelationCandidates);
    }
    const selected = candidates
      .toSorted((left, right) => right.score - left.score || left.edge.id.localeCompare(right.edge.id))
      .slice(0, this.#maxRelationEdges);
    return {
      directRelations: selected.map((item) => item.edge),
      capsules: selected.map((item) => item.capsule),
    };
  }

  async compile(request: ContextAccessCompileRequest): Promise<ContextAccessResult> {
    if (request.task.trim().length === 0) throw new TypeError("Context task must not be empty");
    const budgetTokens = safeInteger(request.budgetTokens, "context budgetTokens");
    if (budgetTokens > this.#maxBudgetTokens) {
      throw new RangeError(`context budgetTokens must not exceed ${this.#maxBudgetTokens}`);
    }
    const principal = this.#principal(request.principal);
    await this.#authorizeOperation(principal, budgetTokens);
    const at = this.#currentTime(request);
    await this.#synchronizer.synchronize(at);

    const searched = await this.#capsules.search(request.task, this.#maxIdentityScans + 1);
    if (searched.length > this.#maxIdentityScans) {
      throw new ContextIdentityScanLimitError(this.#maxIdentityScans);
    }
    const visibleCandidates: ContextCapsule[] = [];
    for (const capsule of searched) {
      if (await this.#entityAllowed(principal, capsule.entityId)) visibleCandidates.push(capsule);
    }
    if (visibleCandidates.length > this.#maxIdentityCandidates) {
      throw new ContextIdentityCandidateLimitError(this.#maxIdentityCandidates);
    }
    const resolution = new TypedEntityResolver({
      types: this.#entityTypes,
      entities: visibleCandidates.map((capsule) => capsule.material.entity),
    }).resolve(request.task);
    const safeResolution = sanitizedResolution(resolution);
    if (resolution.status !== "resolved") {
      const context = emptyContext();
      await this.#emitAllowed(principal, budgetTokens, safeResolution, context);
      return { resolution: safeResolution, context, relatedEntityIds: [] };
    }

    const direct = visibleCandidates.find((capsule) => capsule.entityId === resolution.entityId);
    if (direct === undefined) throw new Error("Resolved context capsule is missing");
    const related = await this.#relatedCapsules(direct, request.task, principal);
    const directVisible = await this.#visibleCapsule(direct, principal, related.directRelations);
    const relatedVisible: ContextCapsule[] = [];
    for (const capsule of related.capsules) {
      relatedVisible.push(await this.#visibleCapsule(capsule, principal, []));
    }
    const projected = contextCorpusFromCapsules(
      [directVisible, ...relatedVisible],
      { relationTypes: this.#relationTypeList, properties: this.#properties },
    );
    const ranked = bm25Baseline(
      projected,
      { query: request.task, budgetTokens },
      [resolution.entityId, ...relatedVisible.map((capsule) => capsule.entityId)],
    );
    const context: ContextPackage = {
      ...ranked,
      records: await this.#visibleEvidence(principal, ranked.records),
    };
    const relatedEntityIds = relatedVisible.map((capsule) => capsule.entityId);
    await this.#emitAllowed(
      principal,
      budgetTokens,
      safeResolution,
      context,
      resolution.entityId,
    );
    return { resolution: safeResolution, context, relatedEntityIds };
  }
}
