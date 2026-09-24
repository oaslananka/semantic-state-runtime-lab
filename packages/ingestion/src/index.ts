import {
  normalizeArtifactMediaType,
  normalizeArtifactMutation,
  type ArtifactMutation,
  type ArtifactResourceIdentity,
  type ArtifactStore,
} from "@ssrl/artifact-store";
import {
  canonicalJson,
  type SemanticRetraction,
  type TemporalObservation,
  type TemporalRelationEdge,
} from "@ssrl/core";
import {
  normalizeEntityAliasRecord,
  normalizeSemanticEntity,
  normalizeTemporalObservation,
  normalizeTemporalRelation,
  type EntityAliasRecord,
  type SemanticAppendCounts,
  type SemanticEntity,
  type SemanticStateBatch,
  type SemanticStateStore,
} from "@ssrl/state-store";

declare const ingestionSourceKeyBrand: unique symbol;
declare const sourceCheckpointBrand: unique symbol;
declare const sourceContinuationBrand: unique symbol;

export type IngestionSourceKey = string & { readonly [ingestionSourceKeyBrand]: true };
export type SourceCheckpoint = string & { readonly [sourceCheckpointBrand]: true };
export type SourceContinuation = string & { readonly [sourceContinuationBrand]: true };

export function ingestionSourceKey(value: string): IngestionSourceKey {
  if (value.trim().length === 0) throw new TypeError("Ingestion source key must not be empty");
  return value as IngestionSourceKey;
}

export function sourceCheckpoint(value: string): SourceCheckpoint {
  if (value.length === 0) throw new TypeError("Source checkpoint must not be empty");
  return value as SourceCheckpoint;
}

export function sourceContinuation(value: string): SourceContinuation {
  if (value.length === 0) throw new TypeError("Source continuation must not be empty");
  return value as SourceContinuation;
}

export interface SourceChangeDraft<TPayload = unknown> {
  readonly changeId: string;
  readonly externalType: string;
  readonly externalId: string;
  readonly kind: "upsert" | "delete";
  readonly effectiveAt?: string;
  readonly recordedAt?: string;
  readonly revision?: string;
  readonly payload?: TPayload;
}

export interface SourceChange<TPayload = unknown> extends SourceChangeDraft<TPayload> {
  readonly effectiveAt: string;
  readonly recordedAt: string;
}

export interface SourceReadRequest {
  readonly mode: "incremental" | "full";
  readonly checkpoint?: SourceCheckpoint;
  readonly continuation?: SourceContinuation;
}

export type SourcePageNext =
  | { readonly kind: "continue"; readonly cursor: SourceContinuation }
  | { readonly kind: "complete"; readonly checkpoint: SourceCheckpoint };

export type SourceReadResult<TPayload = unknown> =
  | {
      readonly kind: "page";
      readonly changes: readonly SourceChangeDraft<TPayload>[];
      readonly next: SourcePageNext;
    }
  | { readonly kind: "reset-required"; readonly reason: string };

export interface IncrementalSource<TPayload = unknown> {
  read(request: SourceReadRequest): Promise<SourceReadResult<TPayload>>;
}

export type ProjectedSlot =
  | { readonly key: string; readonly kind: "observation"; readonly record: TemporalObservation }
  | { readonly key: string; readonly kind: "relation"; readonly record: TemporalRelationEdge };

export interface DesiredProjection {
  readonly additiveEntities?: readonly SemanticEntity[];
  readonly additiveAliases?: readonly EntityAliasRecord[];
  readonly slots: readonly ProjectedSlot[];
}

export interface ProjectionMapper<TPayload = unknown> {
  project(change: SourceChange<TPayload>): Promise<DesiredProjection> | DesiredProjection;
}


export interface ArtifactProjectionDraft {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly title?: string;
  readonly sourceUri?: string;
}

export interface ArtifactProjectionMapper<TPayload = unknown> {
  projectArtifact(
    change: SourceChange<TPayload>,
  ): Promise<ArtifactProjectionDraft | undefined> | ArtifactProjectionDraft | undefined;
}

export type ArtifactPlanAction =
  | { readonly kind: "preserve" }
  | { readonly kind: "apply"; readonly mutation: ArtifactMutation };

export interface MappedIngestionPlan {
  /** Absent for provider/resource deletions. */
  readonly semantic?: DesiredProjection;
  readonly artifactAction: ArtifactPlanAction;
}

export interface ResourceArtifactProjection {
  readonly latestMutationId: string;
}

export interface ProjectionSlotTarget {
  readonly key: string;
  readonly kind: "observation" | "relation";
  readonly semanticRecordId: string;
}

export interface ResourceProjection {
  readonly sourceKey: IngestionSourceKey;
  readonly externalType: string;
  readonly externalId: string;
  readonly deleted: boolean;
  readonly slots: readonly ProjectionSlotTarget[];
  readonly artifact?: ResourceArtifactProjection;
}

export interface FullSyncGeneration {
  readonly id: string;
  readonly sourceKey: IngestionSourceKey;
  readonly observedAt: string;
}

export interface IngestionStateStore {
  checkpoint(sourceKey: IngestionSourceKey): Promise<SourceCheckpoint | undefined>;
  setCheckpoint(sourceKey: IngestionSourceKey, checkpoint: SourceCheckpoint): Promise<void>;
  projection(
    sourceKey: IngestionSourceKey,
    externalType: string,
    externalId: string,
  ): Promise<ResourceProjection | undefined>;
  putProjection(projection: ResourceProjection): Promise<void>;
  listProjections(sourceKey: IngestionSourceKey): Promise<readonly ResourceProjection[]>;
  changeReceipt<TPayload>(
    sourceKey: IngestionSourceKey,
    change: SourceChangeDraft<TPayload>,
  ): Promise<SourceChange<TPayload> | undefined>;
  putChangeReceipt<TPayload>(
    sourceKey: IngestionSourceKey,
    change: SourceChangeDraft<TPayload>,
    resolved: SourceChange<TPayload>,
  ): Promise<SourceChange<TPayload>>;
  mappedPlan(
    sourceKey: IngestionSourceKey,
    changeId: string,
  ): Promise<MappedIngestionPlan | undefined>;
  putMappedPlan(
    sourceKey: IngestionSourceKey,
    changeId: string,
    plan: MappedIngestionPlan,
  ): Promise<"inserted" | "existing">;
  activeFullSyncGeneration(sourceKey: IngestionSourceKey): Promise<FullSyncGeneration | undefined>;
  beginFullSyncGeneration(
    sourceKey: IngestionSourceKey,
    observedAt: string,
  ): Promise<FullSyncGeneration>;
  markSeen(
    generationId: string,
    externalType: string,
    externalId: string,
  ): Promise<void>;
  unseenProjections(generationId: string): Promise<readonly ResourceProjection[]>;
  completeFullSyncGeneration(
    generationId: string,
    checkpoint: SourceCheckpoint,
  ): Promise<void>;
}

export class SourceChangeCollisionError extends Error {
  constructor(
    readonly sourceKey: IngestionSourceKey,
    readonly changeId: string,
  ) {
    super(`Source change ${changeId} for ${sourceKey} was replayed with different content`);
    this.name = "SourceChangeCollisionError";
  }
}

export class InvalidSourceChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSourceChangeError";
  }
}

export class InvalidProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProjectionError";
  }
}

export class MappedProjectionCollisionError extends Error {
  constructor(
    readonly sourceKey: IngestionSourceKey,
    readonly changeId: string,
  ) {
    super(`Mapped ingestion plan for source change ${changeId} on ${sourceKey} changed across replay`);
    this.name = "MappedProjectionCollisionError";
  }
}

export class FullSyncResetLoopError extends Error {
  constructor(readonly reason: string) {
    super(`Source requested another reset while full sync was already active: ${reason}`);
    this.name = "FullSyncResetLoopError";
  }
}

export class FullSyncCompletionCollisionError extends Error {
  constructor(readonly generationId: string) {
    super(`Full sync generation ${generationId} was already completed with a different checkpoint`);
    this.name = "FullSyncCompletionCollisionError";
  }
}

function requiredString(value: string, label: string): string {
  if (value.length === 0) throw new InvalidSourceChangeError(`${label} must not be empty`);
  return value;
}

function isoTimestamp(value: string, label: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new InvalidSourceChangeError(`${label} must be a valid timestamp`);
  return new Date(millis).toISOString();
}

function containsBinaryPayload(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object") return false;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsBinaryPayload(item, seen));
  return Object.values(value as Record<string, unknown>)
    .some((item) => containsBinaryPayload(item, seen));
}

export function normalizeSourceChangeDraft<TPayload>(
  change: SourceChangeDraft<TPayload>,
): SourceChangeDraft<TPayload> {
  if (change.kind !== "upsert" && change.kind !== "delete") {
    throw new InvalidSourceChangeError("Source change kind must be upsert or delete");
  }
  if (change.payload !== undefined && containsBinaryPayload(change.payload)) {
    throw new InvalidSourceChangeError(
      "Source change payload must not contain binary buffers; route raw bytes through ArtifactProjectionMapper",
    );
  }
  const normalized: SourceChangeDraft<TPayload> = {
    changeId: requiredString(change.changeId, "changeId"),
    externalType: requiredString(change.externalType, "externalType"),
    externalId: requiredString(change.externalId, "externalId"),
    kind: change.kind,
    ...(change.effectiveAt === undefined
      ? {}
      : { effectiveAt: isoTimestamp(change.effectiveAt, "effectiveAt") }),
    ...(change.recordedAt === undefined
      ? {}
      : { recordedAt: isoTimestamp(change.recordedAt, "recordedAt") }),
    ...(change.revision === undefined
      ? {}
      : { revision: requiredString(change.revision, "revision") }),
    ...(change.payload === undefined ? {} : { payload: change.payload }),
  };
  canonicalJson(normalized);
  return normalized;
}

export function resolveSourceChange<TPayload>(
  draft: SourceChangeDraft<TPayload>,
  firstObservedAt: string,
): SourceChange<TPayload> {
  const normalized = normalizeSourceChangeDraft(draft);
  const observedAt = isoTimestamp(firstObservedAt, "firstObservedAt");
  const recordedAt = normalized.recordedAt ?? observedAt;
  const effectiveAt = normalized.effectiveAt ?? normalized.recordedAt ?? observedAt;
  return {
    ...normalized,
    effectiveAt,
    recordedAt,
  };
}

export function normalizeSourceChange<TPayload>(
  change: SourceChange<TPayload>,
): SourceChange<TPayload> {
  return resolveSourceChange(change, change.recordedAt);
}

export function canonicalSourceChangeDraftJson(change: SourceChangeDraft): string {
  return canonicalJson(normalizeSourceChangeDraft(change));
}

export function canonicalSourceChangeJson(change: SourceChange): string {
  return canonicalJson(normalizeSourceChange(change));
}


export function resolvedSourceChangeMatchesDraft<TPayload>(
  draft: SourceChangeDraft<TPayload>,
  resolved: SourceChange<TPayload>,
): boolean {
  const normalizedDraft = normalizeSourceChangeDraft(draft);
  const normalizedResolved = normalizeSourceChange(resolved);
  const draftIdentity = canonicalJson({
    changeId: normalizedDraft.changeId,
    externalType: normalizedDraft.externalType,
    externalId: normalizedDraft.externalId,
    kind: normalizedDraft.kind,
    ...(normalizedDraft.revision === undefined ? {} : { revision: normalizedDraft.revision }),
    ...(normalizedDraft.payload === undefined ? {} : { payload: normalizedDraft.payload }),
  });
  const resolvedIdentity = canonicalJson({
    changeId: normalizedResolved.changeId,
    externalType: normalizedResolved.externalType,
    externalId: normalizedResolved.externalId,
    kind: normalizedResolved.kind,
    ...(normalizedResolved.revision === undefined ? {} : { revision: normalizedResolved.revision }),
    ...(normalizedResolved.payload === undefined ? {} : { payload: normalizedResolved.payload }),
  });
  return draftIdentity === resolvedIdentity
    && (normalizedDraft.effectiveAt === undefined
      || normalizedDraft.effectiveAt === normalizedResolved.effectiveAt)
    && (normalizedDraft.recordedAt === undefined
      || normalizedDraft.recordedAt === normalizedResolved.recordedAt);
}

function parsedSourceChangeJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new InvalidSourceChangeError(`${label} is invalid JSON`);
  }
}

export function parseSourceChangeDraftJson<TPayload = unknown>(value: string): SourceChangeDraft<TPayload> {
  const parsed = parsedSourceChangeJson(value, "Source change draft");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidSourceChangeError("Source change draft JSON must be an object");
  }
  return normalizeSourceChangeDraft(parsed as SourceChangeDraft<TPayload>);
}

export function parseSourceChangeJson<TPayload = unknown>(value: string): SourceChange<TPayload> {
  const parsed = parsedSourceChangeJson(value, "Resolved source change");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidSourceChangeError("Resolved source change JSON must be an object");
  }
  const candidate = parsed as SourceChange<TPayload>;
  if (candidate.effectiveAt === undefined || candidate.recordedAt === undefined) {
    throw new InvalidSourceChangeError("Resolved source change must contain timestamps");
  }
  return normalizeSourceChange(candidate);
}

function projectionSlotTarget(slot: ProjectedSlot): ProjectionSlotTarget {
  if (slot.key.length === 0) throw new InvalidProjectionError("Projected slot key must not be empty");
  if (slot.record.id.length === 0) {
    throw new InvalidProjectionError(`Projected slot ${slot.key} semantic record id must not be empty`);
  }
  return { key: slot.key, kind: slot.kind, semanticRecordId: slot.record.id };
}

export function normalizeDesiredProjection(desired: DesiredProjection): DesiredProjection {
  const entities = (desired.additiveEntities ?? [])
    .map((entity) => normalizeSemanticEntity(entity))
    .toSorted((left, right) => left.entityId.localeCompare(right.entityId));
  const aliases = (desired.additiveAliases ?? [])
    .map((alias) => normalizeEntityAliasRecord(alias))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const seen = new Set<string>();
  const slots = desired.slots
    .map((slot): ProjectedSlot => {
      if (slot.key.length === 0) throw new InvalidProjectionError("Projected slot key must not be empty");
      if (seen.has(slot.key)) throw new InvalidProjectionError(`Duplicate projected slot key: ${slot.key}`);
      seen.add(slot.key);
      if (slot.kind === "observation") {
        return { key: slot.key, kind: slot.kind, record: normalizeTemporalObservation(slot.record) };
      }
      if (slot.kind === "relation") {
        return { key: slot.key, kind: slot.kind, record: normalizeTemporalRelation(slot.record) };
      }
      throw new InvalidProjectionError("Projected slot has invalid kind");
    })
    .toSorted((left, right) => left.key.localeCompare(right.key));
  return {
    ...(entities.length === 0 ? {} : { additiveEntities: entities }),
    ...(aliases.length === 0 ? {} : { additiveAliases: aliases }),
    slots,
  };
}

export function desiredProjectionJson(desired: DesiredProjection): string {
  return canonicalJson(normalizeDesiredProjection(desired));
}

export function parseDesiredProjectionJson(value: string): DesiredProjection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new InvalidProjectionError("Mapped projection JSON is invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidProjectionError("Mapped projection JSON must be an object");
  }
  const record = parsed as Partial<DesiredProjection>;
  if (!Array.isArray(record.slots)) {
    throw new InvalidProjectionError("Mapped projection JSON slots must be an array");
  }
  return normalizeDesiredProjection(record as DesiredProjection);
}


export function normalizeMappedIngestionPlan(plan: MappedIngestionPlan): MappedIngestionPlan {
  if (plan.artifactAction.kind !== "preserve" && plan.artifactAction.kind !== "apply") {
    throw new InvalidProjectionError("Mapped ingestion artifact action must be preserve or apply");
  }
  const semantic = plan.semantic === undefined
    ? undefined
    : normalizeDesiredProjection(plan.semantic);
  const artifactAction: ArtifactPlanAction = plan.artifactAction.kind === "preserve"
    ? { kind: "preserve" }
    : { kind: "apply", mutation: normalizeArtifactMutation(plan.artifactAction.mutation) };
  return {
    ...(semantic === undefined ? {} : { semantic }),
    artifactAction,
  };
}

export function mappedIngestionPlanJson(plan: MappedIngestionPlan): string {
  return canonicalJson(normalizeMappedIngestionPlan(plan));
}

export function parseMappedIngestionPlanJson(value: string): MappedIngestionPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new InvalidProjectionError("Mapped ingestion plan JSON is invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidProjectionError("Mapped ingestion plan JSON must be an object");
  }
  const plan = parsed as Partial<MappedIngestionPlan>;
  if (plan.artifactAction === undefined) {
    throw new InvalidProjectionError("Mapped ingestion plan requires artifactAction");
  }
  return normalizeMappedIngestionPlan(plan as MappedIngestionPlan);
}

function projectedArtifact(
  previous: ResourceProjection | undefined,
  action: ArtifactPlanAction,
): ResourceArtifactProjection | undefined {
  if (action.kind === "preserve") return previous?.artifact;
  if (action.mutation.kind === "delete") return undefined;
  return { latestMutationId: action.mutation.id };
}

function nextProjection(
  sourceKey: IngestionSourceKey,
  change: SourceChange,
  previous: ResourceProjection | undefined,
  plan: MappedIngestionPlan,
): ResourceProjection {
  const artifact = projectedArtifact(previous, plan.artifactAction);
  return {
    sourceKey,
    externalType: change.externalType,
    externalId: change.externalId,
    deleted: change.kind === "delete",
    slots: plan.semantic === undefined
      ? []
      : plan.semantic.slots.map(projectionSlotTarget).toSorted((a, b) => a.key.localeCompare(b.key)),
    ...(change.kind === "delete" || artifact === undefined ? {} : { artifact }),
  };
}

export function normalizeResourceProjection(projection: ResourceProjection): ResourceProjection {
  const sourceKey = ingestionSourceKey(projection.sourceKey);
  const externalType = projection.externalType;
  const externalId = projection.externalId;
  if (externalType.length === 0) throw new TypeError("Projection externalType must not be empty");
  if (externalId.length === 0) throw new TypeError("Projection externalId must not be empty");
  if (typeof projection.deleted !== "boolean") throw new TypeError("Projection deleted must be boolean");
  const seen = new Set<string>();
  const slots = projection.slots.map((slot) => {
    if (slot.key.length === 0) throw new TypeError("Projection slot key must not be empty");
    if (slot.kind !== "observation" && slot.kind !== "relation") {
      throw new TypeError(`Projection slot ${slot.key} has invalid kind`);
    }
    if (slot.semanticRecordId.length === 0) {
      throw new TypeError(`Projection slot ${slot.key} semanticRecordId must not be empty`);
    }
    if (seen.has(slot.key)) throw new TypeError(`Duplicate projection slot key: ${slot.key}`);
    seen.add(slot.key);
    return { ...slot };
  }).toSorted((left, right) => left.key.localeCompare(right.key));
  if (projection.deleted && slots.length > 0) {
    throw new TypeError("Deleted projection cannot keep open slots");
  }
  const artifact = projection.artifact === undefined
    ? undefined
    : {
        latestMutationId: requiredString(
          projection.artifact.latestMutationId,
          "Projection artifact latestMutationId",
        ),
      };
  if (projection.deleted && artifact !== undefined) {
    throw new TypeError("Deleted projection cannot keep a live artifact target");
  }
  return {
    sourceKey,
    externalType,
    externalId,
    deleted: projection.deleted,
    slots,
    ...(artifact === undefined ? {} : { artifact }),
  };
}

export function resourceProjectionJson(projection: ResourceProjection): string {
  return canonicalJson(normalizeResourceProjection(projection));
}

export function parseResourceProjectionJson(value: string): ResourceProjection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new TypeError("Projection JSON is invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Projection JSON must be an object");
  }
  const record = parsed as Partial<ResourceProjection>;
  if (
    typeof record.sourceKey !== "string"
    || typeof record.externalType !== "string"
    || typeof record.externalId !== "string"
    || typeof record.deleted !== "boolean"
    || !Array.isArray(record.slots)
  ) {
    throw new TypeError("Projection JSON envelope is invalid");
  }
  return normalizeResourceProjection(record as ResourceProjection);
}

export function newFullSyncGeneration(
  sourceKey: IngestionSourceKey,
  observedAt: string,
): FullSyncGeneration {
  const normalizedObservedAt = isoTimestamp(observedAt, "full sync observedAt");
  return {
    id: deterministicTupleId("ssrl-full-sync-generation-v1", [sourceKey, normalizedObservedAt]),
    sourceKey,
    observedAt: normalizedObservedAt,
  };
}

export function fullSyncGenerationId(sourceKey: IngestionSourceKey, observedAt: string): string {
  return newFullSyncGeneration(sourceKey, observedAt).id;
}

export async function ensureFullSyncGeneration(
  sourceKey: IngestionSourceKey,
  observedAt: string,
  current: () => Promise<FullSyncGeneration | undefined>,
  persist: (generation: FullSyncGeneration) => Promise<void> | void,
): Promise<FullSyncGeneration> {
  const existing = await current();
  if (existing !== undefined) return existing;
  const created = newFullSyncGeneration(sourceKey, observedAt);
  await persist(created);
  return created;
}

function deterministicTupleId(prefix: string, values: readonly string[]): string {
  return `${prefix}:${canonicalJson(values)}`;
}


export function artifactMutationId(input: {
  readonly sourceKey: IngestionSourceKey;
  readonly change: SourceChange;
  readonly kind: "upsert" | "delete";
  readonly blobDigest?: string;
  readonly previousMutationId?: string;
}): string {
  return deterministicTupleId("ssrl-artifact-mutation-v1", [
    input.sourceKey,
    input.change.externalType,
    input.change.externalId,
    input.change.changeId,
    input.kind,
    input.blobDigest ?? "",
    input.previousMutationId ?? "",
  ]);
}

function artifactResourceIdentity(
  sourceKey: IngestionSourceKey,
  change: SourceChange,
): ArtifactResourceIdentity {
  return {
    sourceKey,
    externalType: change.externalType,
    externalId: change.externalId,
  };
}

function normalizeArtifactProjectionDraft(draft: ArtifactProjectionDraft): ArtifactProjectionDraft {
  if (!(draft.bytes instanceof Uint8Array)) {
    throw new InvalidProjectionError("Artifact projection bytes must be Uint8Array");
  }
  const title = draft.title === undefined
    ? undefined
    : requiredString(draft.title, "Artifact projection title");
  const sourceUri = draft.sourceUri === undefined
    ? undefined
    : requiredString(draft.sourceUri, "Artifact projection sourceUri");
  return {
    bytes: draft.bytes,
    mediaType: normalizeArtifactMediaType(draft.mediaType),
    ...(title === undefined ? {} : { title }),
    ...(sourceUri === undefined ? {} : { sourceUri }),
  };
}

function artifactDeleteMutation(input: {
  readonly sourceKey: IngestionSourceKey;
  readonly change: SourceChange;
  readonly previousMutationId: string;
}): ArtifactMutation {
  return normalizeArtifactMutation({
    id: artifactMutationId({
      sourceKey: input.sourceKey,
      change: input.change,
      kind: "delete",
      previousMutationId: input.previousMutationId,
    }),
    resource: artifactResourceIdentity(input.sourceKey, input.change),
    kind: "delete",
    effectiveAt: input.change.effectiveAt,
    recordedAt: input.change.recordedAt,
    ...(input.change.revision === undefined ? {} : { revision: input.change.revision }),
  });
}

export function ingestionRetractionId(input: {
  readonly sourceKey: IngestionSourceKey;
  readonly externalType: string;
  readonly externalId: string;
  readonly slotKey: string;
  readonly previous: ProjectionSlotTarget;
  readonly changeId: string;
}): string {
  return deterministicTupleId("ssrl-ingestion-retraction-v1", [
    input.sourceKey,
    input.externalType,
    input.externalId,
    input.slotKey,
    input.previous.kind,
    input.previous.semanticRecordId,
    input.changeId,
  ]);
}

function retractionForSlot(input: {
  readonly sourceKey: IngestionSourceKey;
  readonly change: SourceChange;
  readonly slotKey: string;
  readonly previous: ProjectionSlotTarget;
}): SemanticRetraction {
  return {
    id: ingestionRetractionId({
      sourceKey: input.sourceKey,
      externalType: input.change.externalType,
      externalId: input.change.externalId,
      slotKey: input.slotKey,
      previous: input.previous,
      changeId: input.change.changeId,
    }),
    targetKind: input.previous.kind,
    targetId: input.previous.semanticRecordId,
    effectiveFrom: input.change.effectiveAt,
    recordedAt: input.change.recordedAt,
    source: {
      provider: "ssrl-ingestion",
      externalId: input.sourceKey,
      revision: input.change.changeId,
    },
    evidenceRefs: [`source-change:${input.change.changeId}`],
  };
}

function semanticBatchForUpsert(input: {
  readonly sourceKey: IngestionSourceKey;
  readonly change: SourceChange;
  readonly previous: ResourceProjection | undefined;
  readonly desired: DesiredProjection;
}): SemanticStateBatch {
  const observations: TemporalObservation[] = [];
  const relations: TemporalRelationEdge[] = [];
  for (const slot of input.desired.slots) {
    if (slot.kind === "observation") observations.push(slot.record);
    else relations.push(slot.record);
  }

  const nextByKey = new Map(input.desired.slots.map((slot) => [slot.key, projectionSlotTarget(slot)]));
  const retractions: SemanticRetraction[] = [];
  for (const previous of input.previous?.slots ?? []) {
    const next = nextByKey.get(previous.key);
    if (
      next?.kind === previous.kind
      && next.semanticRecordId === previous.semanticRecordId
    ) {
      continue;
    }
    retractions.push(retractionForSlot({
      sourceKey: input.sourceKey,
      change: input.change,
      slotKey: previous.key,
      previous,
    }));
  }

  return {
    ...(input.desired.additiveEntities === undefined ? {} : { entities: input.desired.additiveEntities }),
    ...(input.desired.additiveAliases === undefined ? {} : { aliases: input.desired.additiveAliases }),
    ...(observations.length === 0 ? {} : { observations }),
    ...(relations.length === 0 ? {} : { relations }),
    ...(retractions.length === 0 ? {} : { retractions }),
  };
}

function semanticBatchForDelete(input: {
  readonly sourceKey: IngestionSourceKey;
  readonly change: SourceChange;
  readonly previous: ResourceProjection | undefined;
}): SemanticStateBatch {
  const retractions = (input.previous?.slots ?? []).map((previous) => retractionForSlot({
    sourceKey: input.sourceKey,
    change: input.change,
    slotKey: previous.key,
    previous,
  }));
  return retractions.length === 0 ? {} : { retractions };
}

function hasSemanticBatch(batch: SemanticStateBatch): boolean {
  return (batch.entities?.length ?? 0) > 0
    || (batch.aliases?.length ?? 0) > 0
    || (batch.observations?.length ?? 0) > 0
    || (batch.relations?.length ?? 0) > 0
    || (batch.retractions?.length ?? 0) > 0;
}

function zeroAppendCounts(): SemanticAppendCounts {
  return { entities: 0, aliases: 0, observations: 0, relations: 0, retractions: 0 };
}

function addAppendCounts(
  target: SemanticAppendCounts,
  delta: SemanticAppendCounts,
): SemanticAppendCounts {
  return {
    entities: target.entities + delta.entities,
    aliases: target.aliases + delta.aliases,
    observations: target.observations + delta.observations,
    relations: target.relations + delta.relations,
    retractions: target.retractions + delta.retractions,
  };
}

function sourceReadRequest(
  mode: "incremental" | "full",
  durableCheckpoint: SourceCheckpoint | undefined,
  continuation: SourceContinuation | undefined,
): SourceReadRequest {
  const request: SourceReadRequest = { mode };
  if (mode === "incremental" && durableCheckpoint !== undefined) {
    Object.assign(request, { checkpoint: durableCheckpoint });
  }
  if (continuation !== undefined) Object.assign(request, { continuation });
  return request;
}

export interface IngestionEngineOptions {
  readonly semanticState: SemanticStateStore;
  readonly ingestionState: IngestionStateStore;
  readonly artifactStore?: ArtifactStore;
  readonly now?: () => string;
}

export interface IngestionSyncResult {
  readonly sourceKey: IngestionSourceKey;
  readonly mode: "incremental" | "full";
  readonly pagesRead: number;
  readonly changesProcessed: number;
  readonly sweptResources: number;
  readonly semanticAppends: SemanticAppendCounts;
  readonly artifactMutationsAppended: number;
  readonly checkpoint: SourceCheckpoint;
  readonly resetPerformed: boolean;
}

interface ProcessedSourceChanges {
  readonly semanticAppends: SemanticAppendCounts;
  readonly artifactMutationsAppended: number;
  readonly changesProcessed: number;
}

interface FullSyncSweepResult extends ProcessedSourceChanges {
  readonly sweptResources: number;
}

export class IngestionEngine {
  readonly #semanticState: SemanticStateStore;
  readonly #ingestionState: IngestionStateStore;
  readonly #artifactStore: ArtifactStore | undefined;
  readonly #now: () => string;

  constructor(options: IngestionEngineOptions) {
    this.#semanticState = options.semanticState;
    this.#ingestionState = options.ingestionState;
    this.#artifactStore = options.artifactStore;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async #artifactAction<TPayload>(input: {
    readonly sourceKey: IngestionSourceKey;
    readonly change: SourceChange<TPayload>;
    readonly previous: ResourceProjection | undefined;
    readonly artifactMapper?: ArtifactProjectionMapper<TPayload>;
  }): Promise<ArtifactPlanAction> {
    const previousMutationId = input.previous?.artifact?.latestMutationId;
    if (input.change.kind === "delete") {
      return previousMutationId === undefined
        ? { kind: "preserve" }
        : {
            kind: "apply",
            mutation: artifactDeleteMutation({
              sourceKey: input.sourceKey,
              change: input.change,
              previousMutationId,
            }),
          };
    }
    if (input.artifactMapper === undefined) return { kind: "preserve" };
    if (this.#artifactStore === undefined) {
      throw new Error("ArtifactProjectionMapper requires an ArtifactStore");
    }
    const projected = await input.artifactMapper.projectArtifact(input.change);
    if (projected === undefined) {
      return previousMutationId === undefined
        ? { kind: "preserve" }
        : {
            kind: "apply",
            mutation: artifactDeleteMutation({
              sourceKey: input.sourceKey,
              change: input.change,
              previousMutationId,
            }),
          };
    }
    const draft = normalizeArtifactProjectionDraft(projected);
    const blob = await this.#artifactStore.putBlob(draft.bytes, draft.mediaType);
    return {
      kind: "apply",
      mutation: normalizeArtifactMutation({
        id: artifactMutationId({
          sourceKey: input.sourceKey,
          change: input.change,
          kind: "upsert",
          blobDigest: blob.digest,
        }),
        resource: artifactResourceIdentity(input.sourceKey, input.change),
        kind: "upsert",
        effectiveAt: input.change.effectiveAt,
        recordedAt: input.change.recordedAt,
        ...(input.change.revision === undefined ? {} : { revision: input.change.revision }),
        ...(draft.title === undefined ? {} : { title: draft.title }),
        ...(draft.sourceUri === undefined ? {} : { sourceUri: draft.sourceUri }),
        blob,
      }),
    };
  }

  async #mappedPlan<TPayload>(input: {
    readonly sourceKey: IngestionSourceKey;
    readonly change: SourceChange<TPayload>;
    readonly previous: ResourceProjection | undefined;
    readonly mapper: ProjectionMapper<TPayload>;
    readonly artifactMapper?: ArtifactProjectionMapper<TPayload>;
  }): Promise<MappedIngestionPlan> {
    const existing = await this.#ingestionState.mappedPlan(input.sourceKey, input.change.changeId);
    if (existing !== undefined) return existing;
    const semantic = input.change.kind === "upsert"
      ? normalizeDesiredProjection(await input.mapper.project(input.change))
      : undefined;
    const artifactAction = await this.#artifactAction(input);
    const plan = normalizeMappedIngestionPlan({
      ...(semantic === undefined ? {} : { semantic }),
      artifactAction,
    });
    await this.#ingestionState.putMappedPlan(input.sourceKey, input.change.changeId, plan);
    return plan;
  }

  async #applyArtifactAction(action: ArtifactPlanAction): Promise<number> {
    if (action.kind === "preserve") return 0;
    if (this.#artifactStore === undefined) {
      throw new Error("Mapped ingestion plan requires an ArtifactStore");
    }
    return this.#artifactStore.append([action.mutation]);
  }

  async #processChange<TPayload>(input: {
    readonly sourceKey: IngestionSourceKey;
    readonly change: SourceChangeDraft<TPayload>;
    readonly mapper: ProjectionMapper<TPayload>;
    readonly artifactMapper?: ArtifactProjectionMapper<TPayload>;
  }): Promise<ProcessedSourceChanges> {
    const draft = normalizeSourceChangeDraft(input.change);
    const existing = await this.#ingestionState.changeReceipt(input.sourceKey, draft);
    const change = existing ?? await this.#ingestionState.putChangeReceipt(
      input.sourceKey,
      draft,
      resolveSourceChange(draft, this.#now()),
    );
    const previous = await this.#ingestionState.projection(
      input.sourceKey,
      change.externalType,
      change.externalId,
    );
    const plan = await this.#mappedPlan({
      sourceKey: input.sourceKey,
      change,
      previous,
      mapper: input.mapper,
      ...(input.artifactMapper === undefined ? {} : { artifactMapper: input.artifactMapper }),
    });
    const artifactMutationsAppended = await this.#applyArtifactAction(plan.artifactAction);
    const batch = plan.semantic === undefined
      ? semanticBatchForDelete({ sourceKey: input.sourceKey, change, previous })
      : semanticBatchForUpsert({
          sourceKey: input.sourceKey,
          change,
          previous,
          desired: plan.semantic,
        });
    const semanticAppends = hasSemanticBatch(batch)
      ? await this.#semanticState.append(batch)
      : zeroAppendCounts();
    await this.#ingestionState.putProjection(nextProjection(input.sourceKey, change, previous, plan));
    return { semanticAppends, artifactMutationsAppended, changesProcessed: 1 };
  }

  async #processSourceChanges<TPayload>(input: {
    readonly sourceKey: IngestionSourceKey;
    readonly changes: readonly SourceChangeDraft<TPayload>[];
    readonly mapper: ProjectionMapper<TPayload>;
    readonly artifactMapper?: ArtifactProjectionMapper<TPayload>;
    readonly generation: FullSyncGeneration | undefined;
  }): Promise<ProcessedSourceChanges> {
    let semanticAppends = zeroAppendCounts();
    let artifactMutationsAppended = 0;
    for (const rawChange of input.changes) {
      const change = normalizeSourceChangeDraft(rawChange);
      const processed = await this.#processChange({
        sourceKey: input.sourceKey,
        change,
        mapper: input.mapper,
        ...(input.artifactMapper === undefined ? {} : { artifactMapper: input.artifactMapper }),
      });
      semanticAppends = addAppendCounts(semanticAppends, processed.semanticAppends);
      artifactMutationsAppended += processed.artifactMutationsAppended;
      if (input.generation !== undefined) {
        await this.#ingestionState.markSeen(
          input.generation.id,
          change.externalType,
          change.externalId,
        );
      }
    }
    return {
      semanticAppends,
      artifactMutationsAppended,
      changesProcessed: input.changes.length,
    };
  }

  async #sweepFullSync<TPayload>(input: {
    readonly sourceKey: IngestionSourceKey;
    readonly generation: FullSyncGeneration;
    readonly mapper: ProjectionMapper<TPayload>;
  }): Promise<FullSyncSweepResult> {
    const unseen = (await this.#ingestionState.unseenProjections(input.generation.id))
      .filter((projection) => !projection.deleted)
      .toSorted(compareResourceIdentity);
    let semanticAppends = zeroAppendCounts();
    let artifactMutationsAppended = 0;
    for (const projection of unseen) {
      const deletion: SourceChange<TPayload> = {
        changeId: deterministicTupleId("ssrl-full-sync-delete-v1", [
          input.generation.id,
          projection.externalType,
          projection.externalId,
        ]),
        externalType: projection.externalType,
        externalId: projection.externalId,
        kind: "delete",
        effectiveAt: input.generation.observedAt,
        recordedAt: input.generation.observedAt,
      };
      const processed = await this.#processChange({
        sourceKey: input.sourceKey,
        change: deletion,
        mapper: input.mapper,
      });
      semanticAppends = addAppendCounts(semanticAppends, processed.semanticAppends);
      artifactMutationsAppended += processed.artifactMutationsAppended;
    }
    return {
      semanticAppends,
      artifactMutationsAppended,
      changesProcessed: unseen.length,
      sweptResources: unseen.length,
    };
  }

  async #startFullSync(
    sourceKey: IngestionSourceKey,
    mode: "incremental" | "full",
    reason: string,
  ): Promise<FullSyncGeneration> {
    if (mode === "full") throw new FullSyncResetLoopError(reason);
    const observedAt = isoTimestamp(this.#now(), "full sync observedAt");
    return this.#ingestionState.beginFullSyncGeneration(sourceKey, observedAt);
  }

  async #completeRound<TPayload>(input: {
    readonly sourceKey: IngestionSourceKey;
    readonly mapper: ProjectionMapper<TPayload>;
    readonly generation: FullSyncGeneration | undefined;
    readonly checkpoint: SourceCheckpoint;
  }): Promise<FullSyncSweepResult> {
    if (input.generation === undefined) {
      await this.#ingestionState.setCheckpoint(input.sourceKey, input.checkpoint);
      return {
        semanticAppends: zeroAppendCounts(),
        artifactMutationsAppended: 0,
        changesProcessed: 0,
        sweptResources: 0,
      };
    }
    const sweep = await this.#sweepFullSync({
      sourceKey: input.sourceKey,
      generation: input.generation,
      mapper: input.mapper,
    });
    await this.#ingestionState.completeFullSyncGeneration(input.generation.id, input.checkpoint);
    return sweep;
  }

  async sync<TPayload>(input: {
    readonly sourceKey: IngestionSourceKey;
    readonly source: IncrementalSource<TPayload>;
    readonly mapper: ProjectionMapper<TPayload>;
    readonly artifactMapper?: ArtifactProjectionMapper<TPayload>;
  }): Promise<IngestionSyncResult> {
    const durableCheckpoint = await this.#ingestionState.checkpoint(input.sourceKey);
    let generation = await this.#ingestionState.activeFullSyncGeneration(input.sourceKey);
    let mode: "incremental" | "full" = generation === undefined ? "incremental" : "full";
    let continuation: SourceContinuation | undefined;
    let pagesRead = 0;
    let changesProcessed = 0;
    let sweptResources = 0;
    let semanticAppends = zeroAppendCounts();
    let artifactMutationsAppended = 0;
    let resetPerformed = generation !== undefined;

    for (;;) {
      const result = await input.source.read(
        sourceReadRequest(mode, durableCheckpoint, continuation),
      );

      if (result.kind === "reset-required") {
        generation = await this.#startFullSync(input.sourceKey, mode, result.reason);
        mode = "full";
        resetPerformed = true;
        continuation = undefined;
        continue;
      }

      pagesRead += 1;
      const processed = await this.#processSourceChanges({
        sourceKey: input.sourceKey,
        changes: result.changes,
        mapper: input.mapper,
        ...(input.artifactMapper === undefined ? {} : { artifactMapper: input.artifactMapper }),
        generation,
      });
      semanticAppends = addAppendCounts(semanticAppends, processed.semanticAppends);
      artifactMutationsAppended += processed.artifactMutationsAppended;
      changesProcessed += processed.changesProcessed;

      if (result.next.kind === "continue") {
        continuation = result.next.cursor;
        continue;
      }

      const completion = await this.#completeRound({
        sourceKey: input.sourceKey,
        mapper: input.mapper,
        generation,
        checkpoint: result.next.checkpoint,
      });
      semanticAppends = addAppendCounts(semanticAppends, completion.semanticAppends);
      artifactMutationsAppended += completion.artifactMutationsAppended;
      changesProcessed += completion.changesProcessed;
      sweptResources += completion.sweptResources;

      return {
        sourceKey: input.sourceKey,
        mode,
        pagesRead,
        changesProcessed,
        sweptResources,
        semanticAppends,
        artifactMutationsAppended,
        checkpoint: result.next.checkpoint,
        resetPerformed,
      };
    }
  }
}

interface ChangeReceipt {
  readonly canonicalProviderChange: string;
  readonly resolvedChange: SourceChange;
  mappedPlan?: MappedIngestionPlan;
}

interface GenerationState extends FullSyncGeneration {
  readonly seen: Set<string>;
  status: "active" | "completed";
  finalCheckpoint?: SourceCheckpoint;
}

function resourceKey(externalType: string, externalId: string): string {
  return canonicalJson([externalType, externalId]);
}

export function compareResourceIdentity(
  left: Pick<ResourceProjection, "externalType" | "externalId">,
  right: Pick<ResourceProjection, "externalType" | "externalId">,
): number {
  return left.externalType.localeCompare(right.externalType)
    || left.externalId.localeCompare(right.externalId);
}

function projectionKey(sourceKey: IngestionSourceKey, externalType: string, externalId: string): string {
  return canonicalJson([sourceKey, externalType, externalId]);
}

export class InMemoryIngestionStateStore implements IngestionStateStore {
  readonly #checkpoints = new Map<IngestionSourceKey, SourceCheckpoint>();
  readonly #projections = new Map<string, ResourceProjection>();
  readonly #receipts = new Map<string, ChangeReceipt>();
  readonly #generations = new Map<string, GenerationState>();
  readonly #activeGenerationBySource = new Map<IngestionSourceKey, string>();

  async checkpoint(sourceKey: IngestionSourceKey): Promise<SourceCheckpoint | undefined> {
    return this.#checkpoints.get(sourceKey);
  }

  async setCheckpoint(sourceKey: IngestionSourceKey, checkpoint: SourceCheckpoint): Promise<void> {
    this.#checkpoints.set(sourceKey, checkpoint);
  }

  async projection(
    sourceKey: IngestionSourceKey,
    externalType: string,
    externalId: string,
  ): Promise<ResourceProjection | undefined> {
    return this.#projections.get(projectionKey(sourceKey, externalType, externalId));
  }

  async putProjection(projection: ResourceProjection): Promise<void> {
    const normalized = normalizeResourceProjection(projection);
    this.#projections.set(
      projectionKey(normalized.sourceKey, normalized.externalType, normalized.externalId),
      normalized,
    );
  }

  async listProjections(sourceKey: IngestionSourceKey): Promise<readonly ResourceProjection[]> {
    return [...this.#projections.values()]
      .filter((projection) => projection.sourceKey === sourceKey)
      .toSorted(compareResourceIdentity);
  }

  async changeReceipt<TPayload>(
    sourceKey: IngestionSourceKey,
    change: SourceChangeDraft<TPayload>,
  ): Promise<SourceChange<TPayload> | undefined> {
    const normalized = normalizeSourceChangeDraft(change);
    const key = canonicalJson([sourceKey, normalized.changeId]);
    const existing = this.#receipts.get(key);
    if (existing === undefined) return undefined;
    if (existing.canonicalProviderChange !== canonicalSourceChangeDraftJson(normalized)) {
      throw new SourceChangeCollisionError(sourceKey, normalized.changeId);
    }
    return existing.resolvedChange as SourceChange<TPayload>;
  }

  async putChangeReceipt<TPayload>(
    sourceKey: IngestionSourceKey,
    change: SourceChangeDraft<TPayload>,
    resolved: SourceChange<TPayload>,
  ): Promise<SourceChange<TPayload>> {
    const normalizedDraft = normalizeSourceChangeDraft(change);
    const normalizedResolved = normalizeSourceChange(resolved);
    if (!resolvedSourceChangeMatchesDraft(normalizedDraft, normalizedResolved)) {
      throw new SourceChangeCollisionError(sourceKey, normalizedDraft.changeId);
    }
    const key = canonicalJson([sourceKey, normalizedDraft.changeId]);
    const existing = this.#receipts.get(key);
    const providerJson = canonicalSourceChangeDraftJson(normalizedDraft);
    if (existing !== undefined) {
      if (existing.canonicalProviderChange !== providerJson) {
        throw new SourceChangeCollisionError(sourceKey, normalizedDraft.changeId);
      }
      return existing.resolvedChange as SourceChange<TPayload>;
    }
    this.#receipts.set(key, {
      canonicalProviderChange: providerJson,
      resolvedChange: normalizedResolved,
    });
    return normalizedResolved;
  }

  async mappedPlan(
    sourceKey: IngestionSourceKey,
    changeId: string,
  ): Promise<MappedIngestionPlan | undefined> {
    const receipt = this.#receipts.get(canonicalJson([sourceKey, changeId]));
    return receipt?.mappedPlan;
  }

  async putMappedPlan(
    sourceKey: IngestionSourceKey,
    changeId: string,
    plan: MappedIngestionPlan,
  ): Promise<"inserted" | "existing"> {
    const key = canonicalJson([sourceKey, changeId]);
    const receipt = this.#receipts.get(key);
    if (receipt === undefined) {
      throw new Error(`Cannot persist mapped ingestion plan before source change receipt ${changeId}`);
    }
    const normalized = normalizeMappedIngestionPlan(plan);
    if (receipt.mappedPlan !== undefined) {
      if (mappedIngestionPlanJson(receipt.mappedPlan) !== mappedIngestionPlanJson(normalized)) {
        throw new MappedProjectionCollisionError(sourceKey, changeId);
      }
      return "existing";
    }
    receipt.mappedPlan = normalized;
    return "inserted";
  }

  async activeFullSyncGeneration(
    sourceKey: IngestionSourceKey,
  ): Promise<FullSyncGeneration | undefined> {
    const id = this.#activeGenerationBySource.get(sourceKey);
    if (id === undefined) return undefined;
    const generation = this.#generations.get(id);
    if (generation?.status !== "active") {
      throw new Error(`Missing active full sync generation ${id}`);
    }
    return { id: generation.id, sourceKey: generation.sourceKey, observedAt: generation.observedAt };
  }

  async beginFullSyncGeneration(
    sourceKey: IngestionSourceKey,
    observedAt: string,
  ): Promise<FullSyncGeneration> {
    return ensureFullSyncGeneration(
      sourceKey,
      observedAt,
      () => this.activeFullSyncGeneration(sourceKey),
      (value) => {
        const state: GenerationState = { ...value, seen: new Set(), status: "active" };
        this.#generations.set(value.id, state);
        this.#activeGenerationBySource.set(sourceKey, value.id);
      },
    );
  }

  #activeGeneration(generationId: string): GenerationState {
    const generation = this.#generations.get(generationId);
    if (generation?.status !== "active") {
      throw new Error(`Unknown or completed full sync generation ${generationId}`);
    }
    return generation;
  }

  async markSeen(generationId: string, externalType: string, externalId: string): Promise<void> {
    this.#activeGeneration(generationId).seen.add(resourceKey(externalType, externalId));
  }

  async unseenProjections(generationId: string): Promise<readonly ResourceProjection[]> {
    const generation = this.#activeGeneration(generationId);
    return (await this.listProjections(generation.sourceKey))
      .filter((projection) => !generation.seen.has(resourceKey(projection.externalType, projection.externalId)));
  }

  async completeFullSyncGeneration(
    generationId: string,
    checkpoint: SourceCheckpoint,
  ): Promise<void> {
    const generation = this.#generations.get(generationId);
    if (generation === undefined) throw new Error(`Unknown full sync generation ${generationId}`);
    if (generation.status === "completed") {
      if (generation.finalCheckpoint !== checkpoint) {
        throw new FullSyncCompletionCollisionError(generationId);
      }
      return;
    }
    this.#checkpoints.set(generation.sourceKey, checkpoint);
    this.#activeGenerationBySource.delete(generation.sourceKey);
    generation.status = "completed";
    generation.finalCheckpoint = checkpoint;
    generation.seen.clear();
  }
}
