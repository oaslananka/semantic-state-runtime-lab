import {
  canonicalJson,
  matchEntityAliasesForQuery,
  resolveActiveRelationEdges,
  resolveTemporalState,
  type AuthorityRule,
  type EntityId,
  type SemanticRetraction,
  type TemporalObservation,
  type TemporalRelationEdge,
  type TemporalStateResolution,
  type TypedEntity,
} from "@ssrl/core";
import {
  typedEntityFromAliasRecords,
  type EntityAliasRecord,
  InvalidSemanticChangeCursorError,
  type SemanticChangeCursor,
  type SemanticStateStore,
} from "@ssrl/state-store";

export const CONTEXT_CAPSULE_SCHEMA = "ssrl-context-capsule-v1" as const;

export interface ContextCapsuleState {
  readonly canonical: TemporalStateResolution["canonical"];
  readonly conflicts: TemporalStateResolution["conflicts"];
  readonly evidence: TemporalStateResolution["evidence"];
  readonly conflictEvidence: TemporalStateResolution["conflictEvidence"];
}

export interface ContextCapsuleMaterial {
  readonly entity: TypedEntity;
  readonly state: ContextCapsuleState;
  readonly activeRelations: readonly TemporalRelationEdge[];
  readonly appliedRetractions: readonly SemanticRetraction[];
  readonly nextTemporalBoundary?: string;
}

export interface ContextCapsule {
  readonly schema: typeof CONTEXT_CAPSULE_SCHEMA;
  readonly entityId: EntityId;
  readonly materializedAt: string;
  readonly configurationVersion: string;
  readonly changeCursor?: SemanticChangeCursor;
  readonly material: ContextCapsuleMaterial;
}

export type CapsuleWriteResult = "inserted" | "updated" | "unchanged";

export interface ContextCapsuleStore {
  get(entityId: EntityId): Promise<ContextCapsule | undefined>;
  search(query: string, limit: number): Promise<readonly ContextCapsule[]>;
  put(capsule: ContextCapsule): Promise<CapsuleWriteResult>;
  delete(entityId: EntityId): Promise<boolean>;
  checkpoint(): Promise<SemanticChangeCursor | undefined>;
  setCheckpoint(cursor: SemanticChangeCursor): Promise<void>;
  reset(): Promise<void>;
  staleEntityIds(at: string, configurationVersion: string): Promise<readonly EntityId[]>;
}

export interface ContextCapsuleMaterializerOptions {
  readonly stateStore: SemanticStateStore;
  readonly authorityByEntity?: ReadonlyMap<EntityId, readonly AuthorityRule[]>;
  readonly configurationVersion?: string;
}

export interface IncrementalCapsuleWorkerOptions {
  readonly stateStore: SemanticStateStore;
  readonly capsuleStore: ContextCapsuleStore;
  readonly materializer: ContextCapsuleMaterializer;
}

export interface CapsuleWorkerRunRequest {
  readonly at: string;
  readonly limit?: number;
}

export interface CapsuleWorkerRunResult {
  readonly changesRead: number;
  readonly changedEntityIds: readonly EntityId[];
  readonly staleEntityIds: readonly EntityId[];
  readonly materializedEntityIds: readonly EntityId[];
  readonly deletedEntityIds: readonly EntityId[];
  readonly writes: Readonly<Record<CapsuleWriteResult, number>>;
  readonly checkpoint?: SemanticChangeCursor;
  readonly hasMoreChanges: boolean;
}


export interface ContextCapsuleSynchronizer {
  synchronize(at: string): Promise<ContextCapsuleSyncResult>;
}

export interface ContextCapsuleSyncResult {
  readonly pages: number;
  readonly changesRead: number;
  readonly materializedEntityIds: readonly EntityId[];
  readonly checkpoint?: SemanticChangeCursor;
  readonly bootstrapped?: boolean;
  readonly recoveredInvalidCheckpoint?: boolean;
}

export interface ContextCapsuleBootstrapResult {
  readonly entityIds: readonly EntityId[];
  readonly materializedEntityIds: readonly EntityId[];
  readonly checkpoint?: SemanticChangeCursor;
}

export class ContextCapsuleBootstrapper {
  readonly #options: IncrementalCapsuleWorkerOptions;

  constructor(options: IncrementalCapsuleWorkerOptions) {
    this.#options = options;
  }

  async rebuild(at: string): Promise<ContextCapsuleBootstrapResult> {
    const materializedAt = isoTimestamp(at, "capsule bootstrap time");
    const view = await this.#options.stateStore.bootstrapView();
    await this.#options.capsuleStore.reset();
    const materializedEntityIds: EntityId[] = [];
    for (const entityId of view.entityIds) {
      const capsule = await this.#options.materializer.materializeEntity(
        entityId,
        materializedAt,
        view.cursor,
      );
      if (capsule === undefined) continue;
      await this.#options.capsuleStore.put(capsule);
      materializedEntityIds.push(entityId);
    }
    if (view.cursor !== undefined) await this.#options.capsuleStore.setCheckpoint(view.cursor);
    return {
      entityIds: view.entityIds,
      materializedEntityIds,
      ...(view.cursor === undefined ? {} : { checkpoint: view.cursor }),
    };
  }
}

export interface IncrementalContextCapsuleSynchronizerOptions {
  readonly worker: IncrementalContextCapsuleWorker;
  readonly bootstrapper?: ContextCapsuleBootstrapper;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export class ContextCapsuleSyncLimitError extends Error {
  constructor(readonly maxPages: number) {
    super(`Context capsule synchronization exceeded ${maxPages} pages`);
    this.name = "ContextCapsuleSyncLimitError";
  }
}

function timestamp(value: string, label: string): number {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new TypeError(`${label} must be a valid timestamp`);
  return millis;
}

function isoTimestamp(value: string, label: string): string {
  return new Date(timestamp(value, label)).toISOString();
}

function sortedUniqueEntityIds(values: readonly EntityId[]): EntityId[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function aliasKnownAt(alias: EntityAliasRecord, atMillis: number): boolean {
  return timestamp(alias.recordedAt, `alias ${alias.id} recordedAt`) <= atMillis;
}

function typedEntity(
  entityId: EntityId,
  entityType: string,
  aliases: readonly EntityAliasRecord[],
  atMillis: number,
): TypedEntity {
  return typedEntityFromAliasRecords(
    { entityId, entityType },
    aliases.filter((alias) => aliasKnownAt(alias, atMillis)),
  );
}

interface TemporalWindow {
  readonly validFrom: string;
  readonly validTo?: string;
  readonly recordedAt: string;
}

function temporalBoundaries(window: TemporalWindow, atMillis: number): number[] {
  const validFrom = timestamp(window.validFrom, "validFrom");
  const recordedAt = timestamp(window.recordedAt, "recordedAt");
  const validTo = window.validTo === undefined
    ? Number.POSITIVE_INFINITY
    : timestamp(window.validTo, "validTo");
  const activation = Math.max(validFrom, recordedAt);
  if (activation >= validTo) return [];

  const candidates: number[] = [];
  if (activation > atMillis) candidates.push(activation);
  if (validTo > atMillis && Number.isFinite(validTo)) candidates.push(validTo);
  return candidates;
}

function targetWindow(
  retraction: SemanticRetraction,
  observations: readonly TemporalObservation[],
  relations: readonly TemporalRelationEdge[],
): TemporalWindow | undefined {
  if (retraction.targetKind === "observation") {
    return observations.find((observation) => observation.id === retraction.targetId);
  }
  return relations.find((relation) => relation.id === retraction.targetId);
}

function retractionBoundary(
  retraction: SemanticRetraction,
  target: TemporalWindow,
  atMillis: number,
): number | undefined {
  const effectiveFrom = timestamp(retraction.effectiveFrom, `retraction ${retraction.id} effectiveFrom`);
  const recordedAt = timestamp(retraction.recordedAt, `retraction ${retraction.id} recordedAt`);
  const originalEnd = target.validTo === undefined
    ? Number.POSITIVE_INFINITY
    : timestamp(target.validTo, "target validTo");
  if (effectiveFrom >= originalEnd) return undefined;
  const transition = Math.max(effectiveFrom, recordedAt);
  return transition > atMillis ? transition : undefined;
}

function nextTemporalBoundary(
  aliases: readonly EntityAliasRecord[],
  observations: readonly TemporalObservation[],
  relations: readonly TemporalRelationEdge[],
  retractions: readonly SemanticRetraction[],
  atMillis: number,
): string | undefined {
  const candidates: number[] = [];
  for (const alias of aliases) {
    const recordedAt = timestamp(alias.recordedAt, `alias ${alias.id} recordedAt`);
    if (recordedAt > atMillis) candidates.push(recordedAt);
  }
  for (const observation of observations) {
    candidates.push(...temporalBoundaries(observation, atMillis));
  }
  for (const relation of relations) {
    candidates.push(...temporalBoundaries(relation, atMillis));
  }
  for (const retraction of retractions) {
    const target = targetWindow(retraction, observations, relations);
    if (target === undefined) continue;
    const boundary = retractionBoundary(retraction, target, atMillis);
    if (boundary !== undefined) candidates.push(boundary);
  }
  if (candidates.length === 0) return undefined;
  return new Date(Math.min(...candidates)).toISOString();
}

export function relatedEntityIdsFromCapsule(capsule: ContextCapsule): EntityId[] {
  return sortedUniqueEntityIds(capsule.material.activeRelations.map((relation) => relation.to));
}

export function contextCapsuleMaterialJson(material: ContextCapsuleMaterial): string {
  return canonicalJson(material);
}


export class CorruptContextCapsuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptContextCapsuleError";
  }
}

function capsuleObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CorruptContextCapsuleError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function capsuleString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CorruptContextCapsuleError(`${label} must be a non-empty string`);
  }
  return value;
}

function capsuleTimestamp(value: unknown, label: string): string {
  const raw = capsuleString(value, label);
  const millis = Date.parse(raw);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== raw) {
    throw new CorruptContextCapsuleError(`${label} must be a canonical UTC timestamp`);
  }
  return raw;
}

function capsuleStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new CorruptContextCapsuleError(`${label} must be an array`);
  return value.map((item, index) => capsuleString(item, `${label}[${index}]`));
}

function validateCapsuleEntity(value: unknown, entityId: EntityId): TypedEntity {
  const entity = capsuleObject(value, "capsule.material.entity");
  if (capsuleString(entity.id, "capsule.material.entity.id") !== entityId) {
    throw new CorruptContextCapsuleError("capsule material entity id disagrees with capsule entityId");
  }
  const aliases = entity.aliases;
  if (!Array.isArray(aliases)) {
    throw new CorruptContextCapsuleError("capsule.material.entity.aliases must be an array");
  }
  for (const [index, item] of aliases.entries()) {
    const alias = capsuleObject(item, `capsule.material.entity.aliases[${index}]`);
    capsuleString(alias.value, `capsule.material.entity.aliases[${index}].value`);
    if (alias.evidenceRefs !== undefined) {
      capsuleStringArray(alias.evidenceRefs, `capsule.material.entity.aliases[${index}].evidenceRefs`);
    }
  }
  capsuleString(entity.type, "capsule.material.entity.type");
  return entity as unknown as TypedEntity;
}

function validateCapsuleState(value: unknown, entityId: EntityId): ContextCapsuleState {
  const state = capsuleObject(value, "capsule.material.state");
  const canonical = capsuleObject(state.canonical, "capsule.material.state.canonical");
  if (capsuleString(canonical.entityId, "capsule.material.state.canonical.entityId") !== entityId) {
    throw new CorruptContextCapsuleError("capsule canonical entity id disagrees with capsule entityId");
  }
  capsuleObject(canonical.properties, "capsule.material.state.canonical.properties");
  if (!Array.isArray(state.conflicts)) {
    throw new CorruptContextCapsuleError("capsule.material.state.conflicts must be an array");
  }
  capsuleObject(state.evidence, "capsule.material.state.evidence");
  capsuleObject(state.conflictEvidence, "capsule.material.state.conflictEvidence");
  return state as unknown as ContextCapsuleState;
}

function validateCapsuleMaterial(value: unknown, entityId: EntityId): ContextCapsuleMaterial {
  const material = capsuleObject(value, "capsule.material");
  validateCapsuleEntity(material.entity, entityId);
  validateCapsuleState(material.state, entityId);
  if (!Array.isArray(material.activeRelations)) {
    throw new CorruptContextCapsuleError("capsule.material.activeRelations must be an array");
  }
  if (!Array.isArray(material.appliedRetractions)) {
    throw new CorruptContextCapsuleError("capsule.material.appliedRetractions must be an array");
  }
  if (material.nextTemporalBoundary !== undefined) {
    capsuleTimestamp(material.nextTemporalBoundary, "capsule.material.nextTemporalBoundary");
  }
  return material as unknown as ContextCapsuleMaterial;
}

export function contextCapsuleJson(capsule: ContextCapsule): string {
  return canonicalJson(capsule);
}

export function parseContextCapsuleJson(value: string): ContextCapsule {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new CorruptContextCapsuleError("Context capsule is not valid JSON");
  }
  if (canonicalJson(parsed) !== value) {
    throw new CorruptContextCapsuleError("Context capsule JSON is not canonical");
  }
  const capsule = capsuleObject(parsed, "capsule");
  if (capsule.schema !== CONTEXT_CAPSULE_SCHEMA) {
    throw new CorruptContextCapsuleError("Unsupported context capsule schema");
  }
  const rawEntityId = capsuleString(capsule.entityId, "capsule.entityId");
  if (!rawEntityId.startsWith("entity://")) {
    throw new CorruptContextCapsuleError("capsule.entityId must use the entity:// scheme");
  }
  const entityId = rawEntityId as EntityId;
  capsuleTimestamp(capsule.materializedAt, "capsule.materializedAt");
  capsuleString(capsule.configurationVersion, "capsule.configurationVersion");
  if (capsule.changeCursor !== undefined) capsuleString(capsule.changeCursor, "capsule.changeCursor");
  validateCapsuleMaterial(capsule.material, entityId);
  return capsule as unknown as ContextCapsule;
}

export class ContextCapsuleMaterializer {
  readonly #stateStore: SemanticStateStore;
  readonly #authorityByEntity: ReadonlyMap<EntityId, readonly AuthorityRule[]>;
  readonly configurationVersion: string;

  constructor(options: ContextCapsuleMaterializerOptions) {
    this.#stateStore = options.stateStore;
    this.#authorityByEntity = options.authorityByEntity ?? new Map();
    this.configurationVersion = options.configurationVersion ?? "default";
    if (this.configurationVersion.length === 0) {
      throw new TypeError("configurationVersion must not be empty");
    }
  }

  async materializeEntity(
    entityId: EntityId,
    at: string,
    changeCursor?: SemanticChangeCursor,
  ): Promise<ContextCapsule | undefined> {
    const materializedAt = isoTimestamp(at, "materialization time");
    const atMillis = Date.parse(materializedAt);
    const entity = await this.#stateStore.entity(entityId);
    if (entity === undefined) return undefined;

    const [aliases, observations, relations, retractions] = await Promise.all([
      this.#stateStore.aliasesForEntity(entityId),
      this.#stateStore.observationsForEntity(entityId),
      this.#stateStore.relationsFromEntity(entityId),
      this.#stateStore.retractionsForEntity(entityId),
    ]);
    const observationRetractions = retractions.filter(
      (retraction) => retraction.targetKind === "observation",
    );
    const relationRetractions = retractions.filter(
      (retraction) => retraction.targetKind === "relation",
    );
    const resolution = resolveTemporalState({
      entityId,
      observations,
      validAt: materializedAt,
      knownAt: materializedAt,
      authority: this.#authorityByEntity.get(entityId) ?? [],
      retractions: observationRetractions,
    });
    const relationResolution = resolveActiveRelationEdges({
      edges: relations,
      fromEntityIds: [entityId],
      validAt: materializedAt,
      knownAt: materializedAt,
      retractions: relationRetractions,
    });
    const appliedRetractions = [...new Map(
      [...resolution.appliedRetractions, ...relationResolution.appliedRetractions]
        .toSorted((left, right) => left.id.localeCompare(right.id))
        .map((retraction) => [retraction.id, retraction]),
    ).values()];
    const boundary = nextTemporalBoundary(
      aliases,
      observations,
      relations,
      retractions,
      atMillis,
    );

    return {
      schema: CONTEXT_CAPSULE_SCHEMA,
      entityId,
      materializedAt,
      configurationVersion: this.configurationVersion,
      ...(changeCursor === undefined ? {} : { changeCursor }),
      material: {
        entity: typedEntity(entityId, entity.entityType, aliases, atMillis),
        state: {
          canonical: resolution.canonical,
          conflicts: resolution.conflicts,
          evidence: resolution.evidence,
          conflictEvidence: resolution.conflictEvidence,
        },
        activeRelations: relationResolution.edges,
        appliedRetractions,
        ...(boundary === undefined ? {} : { nextTemporalBoundary: boundary }),
      },
    };
  }
}

export class InMemoryContextCapsuleStore implements ContextCapsuleStore {
  readonly #capsules = new Map<EntityId, ContextCapsule>();
  #checkpoint: SemanticChangeCursor | undefined;

  async get(entityId: EntityId): Promise<ContextCapsule | undefined> {
    return this.#capsules.get(entityId);
  }


  async search(query: string, limit: number): Promise<readonly ContextCapsule[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Context capsule search limit must be an integer between 1 and 1000");
    }
    return [...this.#capsules.values()]
      .map((capsule) => ({
        capsule,
        match: matchEntityAliasesForQuery(query, capsule.material.entity),
      }))
      .filter((candidate): candidate is {
        readonly capsule: ContextCapsule;
        readonly match: NonNullable<typeof candidate.match>;
      } => candidate.match !== undefined)
      .toSorted((left, right) => (
        right.match.score - left.match.score
        || left.capsule.entityId.localeCompare(right.capsule.entityId)
      ))
      .slice(0, limit)
      .map((candidate) => candidate.capsule);
  }

  async put(capsule: ContextCapsule): Promise<CapsuleWriteResult> {
    const previous = this.#capsules.get(capsule.entityId);
    let result: CapsuleWriteResult = "inserted";
    if (previous !== undefined) {
      const sameMaterial = contextCapsuleMaterialJson(previous.material)
        === contextCapsuleMaterialJson(capsule.material);
      result = sameMaterial && previous.configurationVersion === capsule.configurationVersion
        ? "unchanged"
        : "updated";
    }
    this.#capsules.set(capsule.entityId, capsule);
    return result;
  }

  async delete(entityId: EntityId): Promise<boolean> {
    return this.#capsules.delete(entityId);
  }

  async checkpoint(): Promise<SemanticChangeCursor | undefined> {
    return this.#checkpoint;
  }

  async setCheckpoint(cursor: SemanticChangeCursor): Promise<void> {
    this.#checkpoint = cursor;
  }

  async reset(): Promise<void> {
    this.#capsules.clear();
    this.#checkpoint = undefined;
  }

  async staleEntityIds(
    at: string,
    configurationVersion: string,
  ): Promise<readonly EntityId[]> {
    const atMillis = timestamp(at, "stale check time");
    const stale: EntityId[] = [];
    for (const capsule of this.#capsules.values()) {
      const boundary = capsule.material.nextTemporalBoundary;
      const boundaryExpired = boundary !== undefined && Date.parse(boundary) <= atMillis;
      if (boundaryExpired || capsule.configurationVersion !== configurationVersion) {
        stale.push(capsule.entityId);
      }
    }
    return stale.sort((left, right) => left.localeCompare(right));
  }
}

function emptyWrites(): Record<CapsuleWriteResult, number> {
  return { inserted: 0, updated: 0, unchanged: 0 };
}

export class IncrementalContextCapsuleWorker {
  readonly #options: IncrementalCapsuleWorkerOptions;

  constructor(options: IncrementalCapsuleWorkerOptions) {
    this.#options = options;
  }

  async checkpoint(): Promise<SemanticChangeCursor | undefined> {
    return this.#options.capsuleStore.checkpoint();
  }

  async runOnce(request: CapsuleWorkerRunRequest): Promise<CapsuleWorkerRunResult> {
    const at = isoTimestamp(request.at, "worker time");
    const checkpoint = await this.#options.capsuleStore.checkpoint();
    const page = await this.#options.stateStore.changesAfter(checkpoint, request.limit ?? 100);
    const changedEntityIds = sortedUniqueEntityIds(
      page.changes.map((change) => change.primaryEntityId),
    );
    const staleEntityIds = sortedUniqueEntityIds(
      await this.#options.capsuleStore.staleEntityIds(
        at,
        this.#options.materializer.configurationVersion,
      ),
    );
    const targets = sortedUniqueEntityIds([...changedEntityIds, ...staleEntityIds]);
    const materializedEntityIds: EntityId[] = [];
    const deletedEntityIds: EntityId[] = [];
    const writes = emptyWrites();

    for (const entityId of targets) {
      const capsule = await this.#options.materializer.materializeEntity(
        entityId,
        at,
        page.nextCursor ?? checkpoint,
      );
      if (capsule === undefined) {
        if (await this.#options.capsuleStore.delete(entityId)) deletedEntityIds.push(entityId);
        continue;
      }
      const result = await this.#options.capsuleStore.put(capsule);
      writes[result] += 1;
      materializedEntityIds.push(entityId);
    }

    if (page.nextCursor !== undefined && page.nextCursor !== checkpoint) {
      await this.#options.capsuleStore.setCheckpoint(page.nextCursor);
    }
    return {
      changesRead: page.changes.length,
      changedEntityIds,
      staleEntityIds,
      materializedEntityIds,
      deletedEntityIds,
      writes,
      ...(page.nextCursor === undefined ? {} : { checkpoint: page.nextCursor }),
      hasMoreChanges: page.hasMore,
    };
  }
}


export class IncrementalContextCapsuleSynchronizer implements ContextCapsuleSynchronizer {
  readonly #worker: IncrementalContextCapsuleWorker;
  readonly #bootstrapper: ContextCapsuleBootstrapper | undefined;
  readonly #pageSize: number;
  readonly #maxPages: number;

  constructor(options: IncrementalContextCapsuleSynchronizerOptions) {
    this.#worker = options.worker;
    this.#bootstrapper = options.bootstrapper;
    this.#pageSize = options.pageSize ?? 100;
    this.#maxPages = options.maxPages ?? 100;
    if (!Number.isSafeInteger(this.#pageSize) || this.#pageSize < 1 || this.#pageSize > 1_000) {
      throw new RangeError("Context capsule sync pageSize must be an integer between 1 and 1000");
    }
    if (!Number.isSafeInteger(this.#maxPages) || this.#maxPages < 1) {
      throw new RangeError("Context capsule sync maxPages must be a positive safe integer");
    }
  }

  async #synchronizeOnce(at: string): Promise<ContextCapsuleSyncResult> {
    const materialized = new Set<EntityId>();
    let changesRead = 0;
    let checkpoint: SemanticChangeCursor | undefined;
    for (let page = 1; page <= this.#maxPages; page += 1) {
      const result = await this.#worker.runOnce({ at, limit: this.#pageSize });
      changesRead += result.changesRead;
      checkpoint = result.checkpoint ?? checkpoint;
      for (const entityId of result.materializedEntityIds) materialized.add(entityId);
      if (!result.hasMoreChanges) {
        return {
          pages: page,
          changesRead,
          materializedEntityIds: [...materialized].toSorted((left, right) => left.localeCompare(right)),
          ...(checkpoint === undefined ? {} : { checkpoint }),
        };
      }
    }
    throw new ContextCapsuleSyncLimitError(this.#maxPages);
  }

  async synchronize(at: string): Promise<ContextCapsuleSyncResult> {
    let bootstrap: ContextCapsuleBootstrapResult | undefined;
    if (this.#bootstrapper !== undefined && await this.#worker.checkpoint() === undefined) {
      bootstrap = await this.#bootstrapper.rebuild(at);
    }
    try {
      const result = await this.#synchronizeOnce(at);
      if (bootstrap === undefined) return result;
      return {
        ...result,
        materializedEntityIds: sortedUniqueEntityIds([
          ...bootstrap.materializedEntityIds,
          ...result.materializedEntityIds,
        ]),
        bootstrapped: true,
      };
    } catch (error) {
      if (!(error instanceof InvalidSemanticChangeCursorError) || this.#bootstrapper === undefined) {
        throw error;
      }
      const recovery = await this.#bootstrapper.rebuild(at);
      const result = await this.#synchronizeOnce(at);
      return {
        ...result,
        materializedEntityIds: sortedUniqueEntityIds([
          ...recovery.materializedEntityIds,
          ...result.materializedEntityIds,
        ]),
        recoveredInvalidCheckpoint: true,
      };
    }
  }
}
