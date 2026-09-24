import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntityId, StateValue } from "@ssrl/core";
import {
  ArtifactBlobCorruptError,
  type ArtifactMutation,
  type ArtifactStore,
} from "@ssrl/artifact-store";
import { LocalArtifactStore } from "@ssrl/storage-local-artifacts";
import { TestSemanticStateStore } from "./test-semantic-store.js";
import {
  InMemoryIngestionStateStore,
  IngestionEngine,
  InvalidSourceChangeError,
  mappedIngestionPlanJson,
  SourceChangeCollisionError,
  ingestionSourceKey,
  resolveSourceChange,
  sourceCheckpoint,
  sourceContinuation,
  type ArtifactProjectionMapper,
  type DesiredProjection,
  type IncrementalSource,
  type IngestionStateStore,
  type IngestionSourceKey,
  type MappedIngestionPlan,
  type ProjectionMapper,
  type ResourceProjection,
  type SourceChange,
  type SourceChangeDraft,
  type SourceCheckpoint,
  type SourceReadRequest,
  type SourceReadResult,
} from "../src/index.js";

const roots: string[] = [];
const project = "entity://project/atlas" as const;
const alice = "entity://person/alice" as const;
const bob = "entity://person/bob" as const;
const sourceKey = ingestionSourceKey("synthetic/account-1/projects:all");

async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ssrl-ingestion-"));
  roots.push(root);
  return join(root, "semantic.sqlite");
}

async function artifactRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ssrl-ingestion-artifact-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface ProjectPayload {
  readonly name: string;
  readonly status?: StateValue;
  readonly ownerId?: EntityId;
  readonly ownerName?: string;
}

function change(
  changeId: string,
  externalId: string,
  payload: ProjectPayload | undefined,
  options: {
    readonly kind?: "upsert" | "delete";
    readonly revision?: string;
    readonly effectiveAt?: string;
    readonly recordedAt?: string;
  } = {},
): SourceChange<ProjectPayload> {
  return {
    changeId,
    externalType: "project",
    externalId,
    kind: options.kind ?? "upsert",
    effectiveAt: options.effectiveAt ?? "2026-09-24T00:00:00Z",
    recordedAt: options.recordedAt ?? "2026-09-24T00:00:01Z",
    ...(options.revision === undefined ? {} : { revision: options.revision }),
    ...(payload === undefined ? {} : { payload }),
  };
}

function entityFor(externalId: string): EntityId {
  return `entity://project/${externalId}` as EntityId;
}

const mapper: ProjectionMapper<ProjectPayload> = {
  project(item): DesiredProjection {
    if (item.payload === undefined) throw new Error("upsert payload required");
    const entityId = entityFor(item.externalId);
    const revision = item.revision ?? item.changeId;
    const entities = [{ entityId, entityType: "Project" }];
    const aliases = [{
      id: `alias:${item.externalId}`,
      entityId,
      value: item.payload.name,
      recordedAt: "2026-01-01T00:00:00Z",
      evidenceRefs: [`synthetic:${item.externalId}`],
    }];
    const slots: DesiredProjection["slots"][number][] = [];
    if (item.payload.status !== undefined) {
      slots.push({
        key: "status",
        kind: "observation",
        record: {
          id: `obs:${item.externalId}:${revision}:status`,
          entityId,
          property: "Project.status",
          value: item.payload.status,
          source: { provider: "synthetic", externalId: item.externalId, revision },
          validFrom: item.effectiveAt,
          recordedAt: item.recordedAt,
        },
      });
    }
    if (item.payload.ownerId !== undefined) {
      entities.push({ entityId: item.payload.ownerId, entityType: "Person" });
      if (item.payload.ownerName !== undefined) {
        aliases.push({
          id: `alias:${item.payload.ownerId}`,
          entityId: item.payload.ownerId,
          value: item.payload.ownerName,
          recordedAt: "2026-01-01T00:00:00Z",
          evidenceRefs: [`synthetic:${item.payload.ownerId}`],
        });
      }
      slots.push({
        key: "owner",
        kind: "relation",
        record: {
          id: `rel:${item.externalId}:${revision}:owner`,
          from: entityId,
          to: item.payload.ownerId,
          relationType: "Project.owner",
          validFrom: item.effectiveAt,
          recordedAt: item.recordedAt,
          evidenceRefs: [`synthetic:${item.changeId}`],
        },
      });
    }
    return { additiveEntities: entities, additiveAliases: aliases, slots };
  },
};

class CallbackSource implements IncrementalSource<ProjectPayload> {
  readonly requests: SourceReadRequest[] = [];
  constructor(
    readonly callback: (
      request: SourceReadRequest,
      call: number,
    ) => Promise<SourceReadResult<ProjectPayload>> | SourceReadResult<ProjectPayload>,
  ) {}

  async read(request: SourceReadRequest): Promise<SourceReadResult<ProjectPayload>> {
    this.requests.push(request);
    return this.callback(request, this.requests.length);
  }
}

class DelegatingIngestionState implements IngestionStateStore {
  constructor(readonly inner: IngestionStateStore) {}
  checkpoint(source: IngestionSourceKey) { return this.inner.checkpoint(source); }
  setCheckpoint(source: IngestionSourceKey, checkpoint: SourceCheckpoint) {
    return this.inner.setCheckpoint(source, checkpoint);
  }
  projection(source: IngestionSourceKey, externalType: string, externalId: string) {
    return this.inner.projection(source, externalType, externalId);
  }
  putProjection(projection: ResourceProjection) { return this.inner.putProjection(projection); }
  listProjections(source: IngestionSourceKey) { return this.inner.listProjections(source); }
  changeReceipt<TPayload>(source: IngestionSourceKey, change: SourceChangeDraft<TPayload>) {
    return this.inner.changeReceipt(source, change);
  }
  putChangeReceipt<TPayload>(
    source: IngestionSourceKey,
    change: SourceChangeDraft<TPayload>,
    resolved: SourceChange<TPayload>,
  ) {
    return this.inner.putChangeReceipt(source, change, resolved);
  }
  mappedPlan(source: IngestionSourceKey, changeId: string) {
    return this.inner.mappedPlan(source, changeId);
  }
  putMappedPlan(
    source: IngestionSourceKey,
    changeId: string,
    plan: MappedIngestionPlan,
  ) {
    return this.inner.putMappedPlan(source, changeId, plan);
  }
  activeFullSyncGeneration(source: IngestionSourceKey) {
    return this.inner.activeFullSyncGeneration(source);
  }
  beginFullSyncGeneration(source: IngestionSourceKey, observedAt: string) {
    return this.inner.beginFullSyncGeneration(source, observedAt);
  }
  markSeen(generationId: string, externalType: string, externalId: string) {
    return this.inner.markSeen(generationId, externalType, externalId);
  }
  unseenProjections(generationId: string) { return this.inner.unseenProjections(generationId); }
  completeFullSyncGeneration(generationId: string, checkpoint: SourceCheckpoint) {
    return this.inner.completeFullSyncGeneration(generationId, checkpoint);
  }
}

class FailProjectionOnceState extends DelegatingIngestionState {
  #failed = false;
  override async putProjection(projection: ResourceProjection): Promise<void> {
    if (!this.#failed) {
      this.#failed = true;
      throw new Error("simulated projection persistence crash");
    }
    await super.putProjection(projection);
  }
}

class FailCheckpointOnceState extends DelegatingIngestionState {
  #failed = false;
  override async setCheckpoint(source: IngestionSourceKey, checkpoint: SourceCheckpoint): Promise<void> {
    if (!this.#failed) {
      this.#failed = true;
      throw new Error("simulated checkpoint crash");
    }
    await super.setCheckpoint(source, checkpoint);
  }
}

class FailMappedPlanOnceState extends DelegatingIngestionState {
  #failed = false;
  override async putMappedPlan(
    source: IngestionSourceKey,
    changeId: string,
    plan: MappedIngestionPlan,
  ): Promise<"inserted" | "existing"> {
    if (!this.#failed) {
      this.#failed = true;
      throw new Error("simulated mapped-plan persistence crash");
    }
    return super.putMappedPlan(source, changeId, plan);
  }
}

class RecordingIngestionState extends DelegatingIngestionState {
  constructor(inner: IngestionStateStore, readonly events: string[]) { super(inner); }
  override async putMappedPlan(source: IngestionSourceKey, changeId: string, plan: MappedIngestionPlan) {
    const result = await super.putMappedPlan(source, changeId, plan);
    this.events.push("plan");
    return result;
  }
  override async putProjection(projection: ResourceProjection): Promise<void> {
    await super.putProjection(projection);
    this.events.push("projection");
  }
  override async setCheckpoint(source: IngestionSourceKey, checkpoint: SourceCheckpoint): Promise<void> {
    await super.setCheckpoint(source, checkpoint);
    this.events.push("checkpoint");
  }
}

class RecordingArtifactStore implements ArtifactStore {
  #failAppendOnce = false;
  constructor(
    readonly inner: ArtifactStore,
    readonly events: string[],
  ) {}
  failNextAppend() { this.#failAppendOnce = true; }
  async putBlob(bytes: Uint8Array, mediaType: string) {
    const blob = await this.inner.putBlob(bytes, mediaType);
    this.events.push("blob");
    return blob;
  }
  headBlob(...args: Parameters<ArtifactStore["headBlob"]>) { return this.inner.headBlob(...args); }
  readBlobRange(...args: Parameters<ArtifactStore["readBlobRange"]>) {
    return this.inner.readBlobRange(...args);
  }
  async append(mutations: readonly ArtifactMutation[]) {
    this.events.push("artifact");
    if (this.#failAppendOnce) {
      this.#failAppendOnce = false;
      throw new Error("simulated artifact append failure");
    }
    return this.inner.append(mutations);
  }
  mutation(...args: Parameters<ArtifactStore["mutation"]>) { return this.inner.mutation(...args); }
  mutationsForResource(...args: Parameters<ArtifactStore["mutationsForResource"]>) {
    return this.inner.mutationsForResource(...args);
  }
  snapshot() { return this.inner.snapshot(); }
}

class RecordingSemanticStore extends TestSemanticStateStore {
  #failAppendOnce = false;
  constructor(readonly events: string[]) { super(); }
  failNextAppend() { this.#failAppendOnce = true; }
  override async append(batch: Parameters<TestSemanticStateStore["append"]>[0]) {
    this.events.push("semantic");
    if (this.#failAppendOnce) {
      this.#failAppendOnce = false;
      throw new Error("simulated semantic append failure");
    }
    return super.append(batch);
  }
}

function rawArtifactMapper(
  bytes: Uint8Array,
  calls?: { count: number },
): ArtifactProjectionMapper<ProjectPayload> {
  return {
    projectArtifact() {
      if (calls !== undefined) calls.count += 1;
      return {
        bytes,
        mediaType: "application/octet-stream",
        title: "Atlas raw payload",
        sourceUri: "source://synthetic/atlas",
      };
    },
  };
}

async function runtime(
  ingestionState: IngestionStateStore = new InMemoryIngestionStateStore(),
  options: { readonly artifactStore?: ArtifactStore; readonly semantic?: TestSemanticStateStore } = {},
) {
  await databasePath();
  const semantic = options.semantic ?? new TestSemanticStateStore();
  const engine = new IngestionEngine({
    semanticState: semantic,
    ingestionState,
    ...(options.artifactStore === undefined ? {} : { artifactStore: options.artifactStore }),
    now: () => "2026-09-24T12:00:00Z",
  });
  return { semantic, ingestionState, engine };
}

function singlePageSource(
  changes: readonly SourceChange<ProjectPayload>[],
  checkpoint = sourceCheckpoint("cp-1"),
): CallbackSource {
  return new CallbackSource(() => ({
    kind: "page",
    changes,
    next: { kind: "complete", checkpoint },
  }));
}

describe("IngestionEngine", () => {
  it("processes a multi-page initial sync and persists only the completed checkpoint", async () => {
    const state = new InMemoryIngestionStateStore();
    const { semantic, engine } = await runtime(state);
    const source = new CallbackSource(async (request, call) => {
      expect(await state.checkpoint(sourceKey)).toBeUndefined();
      if (call === 1) {
        expect(request).toEqual({ mode: "incremental" });
        return {
          kind: "page",
          changes: [change("c1", "atlas", { name: "Atlas", status: "active" }, { revision: "r1" })],
          next: { kind: "continue", cursor: sourceContinuation("page-2") },
        };
      }
      expect(request).toEqual({ mode: "incremental", continuation: sourceContinuation("page-2") });
      return {
        kind: "page",
        changes: [change("c2", "zeus", { name: "Zeus", status: "paused" }, { revision: "r1" })],
        next: { kind: "complete", checkpoint: sourceCheckpoint("cp-initial") },
      };
    });

    const result = await engine.sync({ sourceKey, source, mapper });
    expect(result.pagesRead).toBe(2);
    expect(result.changesProcessed).toBe(2);
    expect(result.checkpoint).toBe(sourceCheckpoint("cp-initial"));
    expect(await state.checkpoint(sourceKey)).toBe(sourceCheckpoint("cp-initial"));
    expect((await semantic.snapshot()).observations.map((item) => item.id)).toEqual([
      "obs:atlas:r1:status",
      "obs:zeus:r1:status",
    ]);
    semantic.close();
  });

  it("turns changed and removed observation/relation slots into deterministic retractions", async () => {
    const { semantic, ingestionState, engine } = await runtime();
    await engine.sync({
      sourceKey,
      source: singlePageSource([change("c1", "atlas", {
        name: "Atlas",
        status: "active",
        ownerId: alice,
        ownerName: "Alice",
      }, { revision: "r1" })]),
      mapper,
    });

    const update = change("c2", "atlas", { name: "Atlas", status: "paused" }, {
      revision: "r2",
      effectiveAt: "2026-09-25T08:00:00Z",
      recordedAt: "2026-09-25T08:05:00Z",
    });
    await engine.sync({
      sourceKey,
      source: singlePageSource([update], sourceCheckpoint("cp-2")),
      mapper,
    });

    const snapshot = await semantic.snapshot();
    expect(snapshot.observations.map((item) => item.id)).toEqual([
      "obs:atlas:r1:status",
      "obs:atlas:r2:status",
    ]);
    expect(snapshot.relations.map((item) => item.id)).toEqual(["rel:atlas:r1:owner"]);
    expect(snapshot.retractions).toHaveLength(2);
    expect(snapshot.retractions.map((item) => [
      item.targetKind,
      item.targetId,
      item.effectiveFrom,
      item.recordedAt,
    ]).toSorted((left, right) => String(left[0]).localeCompare(String(right[0])))).toEqual([
      ["observation", "obs:atlas:r1:status", "2026-09-25T08:00:00.000Z", "2026-09-25T08:05:00.000Z"],
      ["relation", "rel:atlas:r1:owner", "2026-09-25T08:00:00.000Z", "2026-09-25T08:05:00.000Z"],
    ]);
    expect((await ingestionState.projection(sourceKey, "project", "atlas"))?.slots).toEqual([
      { key: "status", kind: "observation", semanticRecordId: "obs:atlas:r2:status" },
    ]);
    semantic.close();
  });

  it("replaces a changed relation slot with a new assertion and retracts the prior target", async () => {
    const { semantic, ingestionState, engine } = await runtime();
    await engine.sync({
      sourceKey,
      source: singlePageSource([change("owner-1", "atlas", {
        name: "Atlas",
        ownerId: alice,
        ownerName: "Alice",
      }, { revision: "r1" })]),
      mapper,
    });
    await engine.sync({
      sourceKey,
      source: singlePageSource([change("owner-2", "atlas", {
        name: "Atlas",
        ownerId: bob,
        ownerName: "Bob",
      }, {
        revision: "r2",
        effectiveAt: "2026-09-26T00:00:00Z",
        recordedAt: "2026-09-26T00:01:00Z",
      })], sourceCheckpoint("cp-owner-2")),
      mapper,
    });

    const snapshot = await semantic.snapshot();
    expect(snapshot.relations.map((item) => item.id)).toEqual([
      "rel:atlas:r1:owner",
      "rel:atlas:r2:owner",
    ]);
    expect(snapshot.retractions).toEqual([
      expect.objectContaining({
        targetKind: "relation",
        targetId: "rel:atlas:r1:owner",
        effectiveFrom: "2026-09-26T00:00:00.000Z",
        recordedAt: "2026-09-26T00:01:00.000Z",
      }),
    ]);
    expect((await ingestionState.projection(sourceKey, "project", "atlas"))?.slots).toEqual([
      { key: "owner", kind: "relation", semanticRecordId: "rel:atlas:r2:owner" },
    ]);
    semantic.close();
  });

  it("treats duplicate delivery of the same stable change as an idempotent replay", async () => {
    const { semantic, ingestionState, engine } = await runtime();
    const duplicate = change("dup-1", "atlas", { name: "Atlas", status: "active" }, { revision: "r1" });
    const result = await engine.sync({
      sourceKey,
      source: singlePageSource([duplicate, duplicate], sourceCheckpoint("cp-dup")),
      mapper,
    });

    expect(result.changesProcessed).toBe(2);
    expect(result.semanticAppends).toEqual({
      entities: 1,
      aliases: 1,
      observations: 1,
      relations: 0,
      retractions: 0,
    });
    expect((await semantic.snapshot()).observations.map((item) => item.id))
      .toEqual(["obs:atlas:r1:status"]);
    expect(await ingestionState.checkpoint(sourceKey)).toBe(sourceCheckpoint("cp-dup"));
    semantic.close();
  });

  it("retracts every open slot when the provider deletes a resource", async () => {
    const { semantic, engine } = await runtime();
    await engine.sync({
      sourceKey,
      source: singlePageSource([change("c1", "atlas", {
        name: "Atlas",
        status: "active",
        ownerId: alice,
        ownerName: "Alice",
      }, { revision: "r1" })]),
      mapper,
    });
    await engine.sync({
      sourceKey,
      source: singlePageSource([
        change("delete-1", "atlas", undefined, {
          kind: "delete",
          effectiveAt: "2026-10-01T00:00:00Z",
          recordedAt: "2026-10-01T00:05:00Z",
        }),
      ], sourceCheckpoint("cp-2")),
      mapper,
    });

    const snapshot = await semantic.snapshot();
    expect(snapshot.retractions).toHaveLength(2);
    expect(snapshot.retractions.every((item) => item.effectiveFrom === "2026-10-01T00:00:00.000Z"))
      .toBe(true);
    semantic.close();
  });

  it("safely replays after semantic append succeeds but projection persistence crashes", async () => {
    const inner = new InMemoryIngestionStateStore();
    const failing = new FailProjectionOnceState(inner);
    const { semantic } = await runtime(failing);
    const source = singlePageSource([
      change("c1", "atlas", { name: "Atlas", status: "active" }, { revision: "r1" }),
    ]);
    const first = new IngestionEngine({ semanticState: semantic, ingestionState: failing });

    await expect(first.sync({ sourceKey, source, mapper })).rejects
      .toThrow(/projection persistence crash/);
    expect((await semantic.snapshot()).observations).toHaveLength(1);
    expect(await inner.projection(sourceKey, "project", "atlas")).toBeUndefined();
    expect(await inner.checkpoint(sourceKey)).toBeUndefined();

    const replay = new IngestionEngine({ semanticState: semantic, ingestionState: failing });
    const mapperThatMustNotRun: ProjectionMapper<ProjectPayload> = {
      project() {
        throw new Error("stored mapped plan should bypass mapper on replay");
      },
    };
    const result = await replay.sync({ sourceKey, source, mapper: mapperThatMustNotRun });
    expect(result.semanticAppends.observations).toBe(0);
    expect((await semantic.snapshot()).observations).toHaveLength(1);
    expect(await inner.projection(sourceKey, "project", "atlas")).toBeDefined();
    expect(await inner.checkpoint(sourceKey)).toBe(sourceCheckpoint("cp-1"));
    semantic.close();
  });

  it("safely replays after projection persistence succeeds but checkpoint persistence crashes", async () => {
    const inner = new InMemoryIngestionStateStore();
    const failing = new FailCheckpointOnceState(inner);
    const { semantic } = await runtime(failing);
    const source = singlePageSource([
      change("c1", "atlas", { name: "Atlas", status: "active" }, { revision: "r1" }),
    ]);
    const engine = new IngestionEngine({ semanticState: semantic, ingestionState: failing });

    await expect(engine.sync({ sourceKey, source, mapper })).rejects.toThrow(/checkpoint crash/);
    expect(await inner.projection(sourceKey, "project", "atlas")).toBeDefined();
    expect(await inner.checkpoint(sourceKey)).toBeUndefined();

    const result = await engine.sync({ sourceKey, source, mapper });
    expect(result.semanticAppends).toEqual({
      entities: 0,
      aliases: 0,
      observations: 0,
      relations: 0,
      retractions: 0,
    });
    expect(await inner.checkpoint(sourceKey)).toBe(sourceCheckpoint("cp-1"));
    semantic.close();
  });

  it("durably stamps missing provider timestamps once and reuses them without calling the clock on replay", async () => {
    const semantic = new TestSemanticStateStore();
    const ingestionState = new InMemoryIngestionStateStore();
    let clockCalls = 0;
    const engine = new IngestionEngine({
      semanticState: semantic,
      ingestionState,
      now: () => {
        clockCalls += 1;
        return "2026-09-24T12:34:56Z";
      },
    });
    const missingTimes: SourceChangeDraft<ProjectPayload> = {
      changeId: "missing-times-r1",
      externalType: "project",
      externalId: "atlas",
      kind: "upsert",
      revision: "r1",
      payload: { name: "Atlas", status: "active" },
    };
    const source = new CallbackSource(() => ({
      kind: "page",
      changes: [missingTimes],
      next: { kind: "complete", checkpoint: sourceCheckpoint("cp-any") },
    }));

    await engine.sync({ sourceKey, source, mapper });
    expect(clockCalls).toBe(1);
    const firstSnapshot = await semantic.snapshot();
    const first = firstSnapshot.observations.find((item) => item.id === "obs:atlas:r1:status");
    expect(first?.validFrom).toBe("2026-09-24T12:34:56.000Z");
    expect(first?.recordedAt).toBe("2026-09-24T12:34:56.000Z");

    await engine.sync({ sourceKey, source, mapper });
    expect(clockCalls).toBe(1);
    const secondSnapshot = await semantic.snapshot();
    expect(secondSnapshot.observations.filter((item) => item.id === "obs:atlas:r1:status"))
      .toHaveLength(1);
  });

  it("rejects a resolved receipt that changes provider-owned source fields", async () => {
    const state = new InMemoryIngestionStateStore();
    const draft: SourceChangeDraft<ProjectPayload> = {
      changeId: "receipt-integrity",
      externalType: "project",
      externalId: "atlas",
      kind: "upsert",
      revision: "r1",
      payload: { name: "Atlas", status: "active" },
    };
    const resolved = resolveSourceChange(draft, "2026-09-24T12:00:00Z");

    await expect(state.putChangeReceipt(sourceKey, draft, {
      ...resolved,
      externalId: "zeus",
    })).rejects.toBeInstanceOf(SourceChangeCollisionError);
    expect(await state.changeReceipt(sourceKey, draft)).toBeUndefined();
  });

  it("fails closed when one source change id is replayed with different content", async () => {
    const { semantic, ingestionState, engine } = await runtime();
    const source = new CallbackSource((_request, call) => ({
      kind: "page",
      changes: [call === 1
        ? change("same-id", "atlas", { name: "Atlas", status: "active" }, { revision: "r1" })
        : change("same-id", "atlas", { name: "Atlas", status: "paused" }, { revision: "r2" })],
      next: call === 1
        ? { kind: "continue", cursor: sourceContinuation("second") }
        : { kind: "complete", checkpoint: sourceCheckpoint("cp-bad") },
    }));

    await expect(engine.sync({ sourceKey, source, mapper })).rejects
      .toBeInstanceOf(SourceChangeCollisionError);
    expect(await ingestionState.checkpoint(sourceKey)).toBeUndefined();
    expect((await semantic.snapshot()).observations.map((item) => item.id))
      .toEqual(["obs:atlas:r1:status"]);
    semantic.close();
  });

  it("does not sweep unseen resources when a reset full sync crashes before completion", async () => {
    const state = new InMemoryIngestionStateStore();
    const { semantic, engine } = await runtime(state);
    await engine.sync({
      sourceKey,
      source: singlePageSource([
        change("a1", "atlas", { name: "Atlas", status: "active" }, { revision: "r1" }),
        change("z1", "zeus", { name: "Zeus", status: "active" }, { revision: "r1" }),
      ], sourceCheckpoint("cp-old")),
      mapper,
    });

    const interrupted = new CallbackSource((request, call) => {
      if (call === 1) return { kind: "reset-required", reason: "expired checkpoint" };
      if (call === 2) {
        expect(request.mode).toBe("full");
        return {
          kind: "page",
          changes: [change("a2", "atlas", { name: "Atlas", status: "active" }, { revision: "r2" })],
          next: { kind: "continue", cursor: sourceContinuation("full-page-2") },
        };
      }
      throw new Error("simulated full-sync transport crash");
    });

    await expect(engine.sync({ sourceKey, source: interrupted, mapper })).rejects
      .toThrow(/transport crash/);
    const zeus = await state.projection(sourceKey, "project", "zeus");
    expect(zeus?.deleted).toBe(false);
    expect((await semantic.snapshot()).retractions.some((item) => item.targetId === "obs:zeus:r1:status"))
      .toBe(false);
    expect(await state.checkpoint(sourceKey)).toBe(sourceCheckpoint("cp-old"));
    expect(await state.activeFullSyncGeneration(sourceKey)).toBeDefined();
    semantic.close();
  });

  it("resumes an active full-sync generation from the beginning and sweeps missing resources only on completion", async () => {
    const state = new InMemoryIngestionStateStore();
    const { semantic, engine } = await runtime(state);
    await engine.sync({
      sourceKey,
      source: singlePageSource([
        change("a1", "atlas", { name: "Atlas", status: "active" }, { revision: "r1" }),
        change("z1", "zeus", { name: "Zeus", status: "active" }, { revision: "r1" }),
      ], sourceCheckpoint("cp-old")),
      mapper,
    });
    await state.beginFullSyncGeneration(sourceKey, "2026-10-01T00:00:00Z");

    const full = new CallbackSource((request, call) => {
      expect(request.mode).toBe("full");
      if (call === 1) {
        expect(request.continuation).toBeUndefined();
        return {
          kind: "page",
          changes: [change("a2", "atlas", { name: "Atlas", status: "active" }, { revision: "r2" })],
          next: { kind: "continue", cursor: sourceContinuation("page-2") },
        };
      }
      return {
        kind: "page",
        changes: [],
        next: { kind: "complete", checkpoint: sourceCheckpoint("cp-new") },
      };
    });

    const result = await engine.sync({ sourceKey, source: full, mapper });
    expect(result.mode).toBe("full");
    expect(result.sweptResources).toBe(1);
    expect(await state.checkpoint(sourceKey)).toBe(sourceCheckpoint("cp-new"));
    expect(await state.activeFullSyncGeneration(sourceKey)).toBeUndefined();
    expect((await state.projection(sourceKey, "project", "zeus"))?.deleted).toBe(true);
    const zeusRetraction = (await semantic.snapshot()).retractions
      .find((item) => item.targetId === "obs:zeus:r1:status");
    expect(zeusRetraction).toEqual(expect.objectContaining({
      effectiveFrom: "2026-10-01T00:00:00.000Z",
      recordedAt: "2026-10-01T00:00:00.000Z",
    }));
    semantic.close();
  });

  it("rejects binary provider payloads so raw bytes cannot enter durable change receipts", () => {
    expect(() => resolveSourceChange({
      changeId: "binary-payload",
      externalType: "project",
      externalId: "atlas",
      kind: "upsert",
      payload: { raw: new Uint8Array([0, 255, 1]) },
    }, "2026-09-24T00:00:00Z")).toThrow(InvalidSourceChangeError);
  });

  it("orders artifact ingestion as blob -> durable plan -> artifact -> semantic -> projection -> checkpoint", async () => {
    const events: string[] = [];
    const innerState = new InMemoryIngestionStateStore();
    const ingestionState = new RecordingIngestionState(innerState, events);
    const localArtifacts = new LocalArtifactStore({ root: await artifactRoot() });
    const artifacts = new RecordingArtifactStore(localArtifacts, events);
    const semantic = new RecordingSemanticStore(events);
    const { engine } = await runtime(ingestionState, { artifactStore: artifacts, semantic });
    const bytes = new Uint8Array([0, 1, 2, 255, 4]);

    const result = await engine.sync({
      sourceKey,
      source: singlePageSource([
        change("artifact-order", "atlas", { name: "Atlas", status: "active" }, { revision: "r1" }),
      ], sourceCheckpoint("cp-artifact-order")),
      mapper,
      artifactMapper: rawArtifactMapper(bytes),
    });

    expect(events).toEqual(["blob", "plan", "artifact", "semantic", "projection", "checkpoint"]);
    expect(result.artifactMutationsAppended).toBe(1);
    expect((await localArtifacts.snapshot()).mutations).toHaveLength(1);
    const plan = await innerState.mappedPlan(sourceKey, "artifact-order");
    expect(plan).toBeDefined();
    const planJson = mappedIngestionPlanJson(plan!);
    expect(planJson).not.toContain("\"bytes\"");
    expect(planJson).not.toContain("255");
    expect(planJson).not.toContain("RAW-PAYLOAD");
    expect(plan?.artifactAction.kind).toBe("apply");
    if (plan?.artifactAction.kind !== "apply" || plan.artifactAction.mutation.kind !== "upsert") {
      throw new Error("expected artifact upsert plan");
    }
    expect(plan.artifactAction.mutation).toEqual(expect.objectContaining({
      resource: { sourceKey, externalType: "project", externalId: "atlas" },
      effectiveAt: "2026-09-24T00:00:00.000Z",
      recordedAt: "2026-09-24T00:00:01.000Z",
      revision: "r1",
    }));
    const read = await localArtifacts.readBlobRange(plan.artifactAction.mutation.blob.digest, {
      maxBytes: bytes.byteLength,
    });
    expect([...read.bytes]).toEqual([...bytes]);
    expect((await innerState.projection(sourceKey, "project", "atlas"))?.artifact)
      .toEqual(expect.objectContaining({ latestMutationId: expect.any(String) }));
    localArtifacts.close();
    semantic.close();
  });

  it("safely retries when the process crashes after blob installation but before plan persistence", async () => {
    const innerState = new InMemoryIngestionStateStore();
    const failingPlan = new FailMappedPlanOnceState(innerState);
    const root = await artifactRoot();
    const localArtifacts = new LocalArtifactStore({ root });
    const semantic = new TestSemanticStateStore();
    const engine = new IngestionEngine({
      semanticState: semantic,
      ingestionState: failingPlan,
      artifactStore: localArtifacts,
      now: () => "2026-09-24T12:00:00Z",
    });
    const source = singlePageSource([
      change("blob-before-plan", "atlas", { name: "Atlas", status: "active" }, { revision: "r1" }),
    ]);
    const artifactCalls = { count: 0 };
    let semanticMapperCalls = 0;
    const countingMapper: ProjectionMapper<ProjectPayload> = {
      project(item) {
        semanticMapperCalls += 1;
        return mapper.project(item);
      },
    };

    await expect(engine.sync({
      sourceKey,
      source,
      mapper: countingMapper,
      artifactMapper: rawArtifactMapper(new Uint8Array([31, 0, 255, 32]), artifactCalls),
    })).rejects.toThrow(/mapped-plan persistence crash/);
    expect(artifactCalls.count).toBe(1);
    expect(semanticMapperCalls).toBe(1);
    expect((await localArtifacts.snapshot()).blobs).toHaveLength(1);
    expect((await localArtifacts.snapshot()).mutations).toHaveLength(0);
    expect(await innerState.mappedPlan(sourceKey, "blob-before-plan")).toBeUndefined();
    expect(await innerState.checkpoint(sourceKey)).toBeUndefined();

    const replay = await engine.sync({
      sourceKey,
      source,
      mapper: countingMapper,
      artifactMapper: rawArtifactMapper(new Uint8Array([31, 0, 255, 32]), artifactCalls),
    });
    expect(artifactCalls.count).toBe(2);
    expect(semanticMapperCalls).toBe(2);
    expect(replay.artifactMutationsAppended).toBe(1);
    expect((await localArtifacts.snapshot()).blobs).toHaveLength(1);
    expect((await localArtifacts.snapshot()).mutations).toHaveLength(1);
    localArtifacts.close();
    semantic.close();
  });

  it("replays a persisted artifact plan without rerunning semantic or artifact mappers", async () => {
    const innerState = new InMemoryIngestionStateStore();
    const failingProjection = new FailProjectionOnceState(innerState);
    const localArtifacts = new LocalArtifactStore({ root: await artifactRoot() });
    const semantic = new TestSemanticStateStore();
    const engine = new IngestionEngine({
      semanticState: semantic,
      ingestionState: failingProjection,
      artifactStore: localArtifacts,
      now: () => "2026-09-24T12:00:00Z",
    });
    const source = singlePageSource([
      change("artifact-plan-replay", "atlas", { name: "Atlas", status: "active" }, { revision: "r1" }),
    ]);
    const artifactCalls = { count: 0 };
    let semanticMapperCalls = 0;
    const countingMapper: ProjectionMapper<ProjectPayload> = {
      project(item) {
        semanticMapperCalls += 1;
        return mapper.project(item);
      },
    };

    await expect(engine.sync({
      sourceKey,
      source,
      mapper: countingMapper,
      artifactMapper: rawArtifactMapper(new Uint8Array([9, 8, 7]), artifactCalls),
    })).rejects.toThrow(/projection persistence crash/);
    expect(semanticMapperCalls).toBe(1);
    expect(artifactCalls.count).toBe(1);
    expect((await localArtifacts.snapshot()).mutations).toHaveLength(1);

    const mustNotRunMapper: ProjectionMapper<ProjectPayload> = {
      project() { throw new Error("semantic mapper must not rerun"); },
    };
    const mustNotRunArtifact: ArtifactProjectionMapper<ProjectPayload> = {
      projectArtifact() { throw new Error("artifact mapper must not rerun"); },
    };
    const replay = await engine.sync({
      sourceKey,
      source,
      mapper: mustNotRunMapper,
      artifactMapper: mustNotRunArtifact,
    });
    expect(replay.artifactMutationsAppended).toBe(0);
    expect((await localArtifacts.snapshot()).mutations).toHaveLength(1);
    expect(await innerState.checkpoint(sourceKey)).toBe(sourceCheckpoint("cp-1"));
    localArtifacts.close();
    semantic.close();
  });

  it("stops before semantic/projection/checkpoint when artifact append fails and safely replays", async () => {
    const events: string[] = [];
    const innerState = new InMemoryIngestionStateStore();
    const ingestionState = new RecordingIngestionState(innerState, events);
    const localArtifacts = new LocalArtifactStore({ root: await artifactRoot() });
    const artifacts = new RecordingArtifactStore(localArtifacts, events);
    artifacts.failNextAppend();
    const semantic = new RecordingSemanticStore(events);
    const { engine } = await runtime(ingestionState, { artifactStore: artifacts, semantic });
    const source = singlePageSource([
      change("artifact-fail", "atlas", { name: "Atlas", status: "active" }, { revision: "r1" }),
    ]);

    await expect(engine.sync({
      sourceKey,
      source,
      mapper,
      artifactMapper: rawArtifactMapper(new Uint8Array([4, 5, 6])),
    })).rejects.toThrow(/artifact append failure/);
    expect(events).toEqual(["blob", "plan", "artifact"]);
    expect((await semantic.snapshot()).observations).toEqual([]);
    expect(await innerState.projection(sourceKey, "project", "atlas")).toBeUndefined();
    expect(await innerState.checkpoint(sourceKey)).toBeUndefined();

    events.length = 0;
    const result = await engine.sync({
      sourceKey,
      source,
      mapper: { project() { throw new Error("stored plan should bypass semantic mapper"); } },
      artifactMapper: { projectArtifact() { throw new Error("stored plan should bypass artifact mapper"); } },
    });
    expect(events).toEqual(["artifact", "semantic", "projection", "checkpoint"]);
    expect(result.artifactMutationsAppended).toBe(1);
    localArtifacts.close();
    semantic.close();
  });

  it("fails closed when a persisted artifact plan references a missing blob and never reruns mappers", async () => {
    const innerState = new InMemoryIngestionStateStore();
    const localRoot = await artifactRoot();
    const localArtifacts = new LocalArtifactStore({ root: localRoot });
    const artifacts = new RecordingArtifactStore(localArtifacts, []);
    artifacts.failNextAppend();
    const semantic = new TestSemanticStateStore();
    const engine = new IngestionEngine({
      semanticState: semantic,
      ingestionState: innerState,
      artifactStore: artifacts,
      now: () => "2026-09-24T12:00:00Z",
    });
    const source = singlePageSource([
      change("missing-planned-blob", "atlas", { name: "Atlas", status: "active" }, { revision: "r1" }),
    ]);

    await expect(engine.sync({
      sourceKey,
      source,
      mapper,
      artifactMapper: rawArtifactMapper(new Uint8Array([51, 52, 53])),
    })).rejects.toThrow(/artifact append failure/);
    const plan = await innerState.mappedPlan(sourceKey, "missing-planned-blob");
    if (plan?.artifactAction.kind !== "apply" || plan.artifactAction.mutation.kind !== "upsert") {
      throw new Error("expected persisted artifact upsert plan");
    }
    const digest = plan.artifactAction.mutation.blob.digest;
    await unlink(join(localRoot, "blobs", "sha256", digest.slice("sha256:".length)));

    await expect(engine.sync({
      sourceKey,
      source,
      mapper: { project() { throw new Error("semantic mapper must not rerun"); } },
      artifactMapper: { projectArtifact() { throw new Error("artifact mapper must not rerun"); } },
    })).rejects.toBeInstanceOf(ArtifactBlobCorruptError);
    expect((await semantic.snapshot()).observations).toEqual([]);
    expect(await innerState.projection(sourceKey, "project", "atlas")).toBeUndefined();
    expect(await innerState.checkpoint(sourceKey)).toBeUndefined();
    localArtifacts.close();
    semantic.close();
  });

  it("leaves durable artifact evidence but no projection/checkpoint when semantic append fails", async () => {
    const innerState = new InMemoryIngestionStateStore();
    const localArtifacts = new LocalArtifactStore({ root: await artifactRoot() });
    const semantic = new RecordingSemanticStore([]);
    semantic.failNextAppend();
    const { engine } = await runtime(innerState, { artifactStore: localArtifacts, semantic });
    const source = singlePageSource([
      change("semantic-fail-after-artifact", "atlas", { name: "Atlas", status: "active" }, { revision: "r1" }),
    ]);

    await expect(engine.sync({
      sourceKey,
      source,
      mapper,
      artifactMapper: rawArtifactMapper(new Uint8Array([1, 3, 3, 7])),
    })).rejects.toThrow(/semantic append failure/);
    expect((await localArtifacts.snapshot()).mutations).toHaveLength(1);
    expect(await innerState.projection(sourceKey, "project", "atlas")).toBeUndefined();
    expect(await innerState.checkpoint(sourceKey)).toBeUndefined();

    const replay = await engine.sync({
      sourceKey,
      source,
      mapper: { project() { throw new Error("stored plan should bypass semantic mapper"); } },
      artifactMapper: { projectArtifact() { throw new Error("stored plan should bypass artifact mapper"); } },
    });
    expect(replay.artifactMutationsAppended).toBe(0);
    expect((await semantic.snapshot()).observations).toHaveLength(1);
    localArtifacts.close();
    semantic.close();
  });

  it("deletes a live artifact when configured mapper later returns no raw content", async () => {
    const innerState = new InMemoryIngestionStateStore();
    const localArtifacts = new LocalArtifactStore({ root: await artifactRoot() });
    const { semantic, engine } = await runtime(innerState, { artifactStore: localArtifacts });
    await engine.sync({
      sourceKey,
      source: singlePageSource([
        change("artifact-v1", "atlas", { name: "Atlas", status: "active" }, { revision: "r1" }),
      ]),
      mapper,
      artifactMapper: rawArtifactMapper(new Uint8Array([10, 11])),
    });
    const previous = await innerState.projection(sourceKey, "project", "atlas");
    expect(previous?.artifact).toBeDefined();

    await engine.sync({
      sourceKey,
      source: singlePageSource([
        change("artifact-none", "atlas", { name: "Atlas", status: "paused" }, {
          revision: "r2",
          effectiveAt: "2026-09-25T00:00:00Z",
          recordedAt: "2026-09-25T00:01:00Z",
        }),
      ], sourceCheckpoint("cp-artifact-none")),
      mapper,
      artifactMapper: { projectArtifact: () => undefined },
    });
    const history = await localArtifacts.mutationsForResource({
      sourceKey,
      externalType: "project",
      externalId: "atlas",
    });
    expect(history.map((item) => item.kind)).toEqual(["upsert", "delete"]);
    expect((await innerState.projection(sourceKey, "project", "atlas"))?.artifact).toBeUndefined();
    semantic.close();
    localArtifacts.close();
  });

  it("preserves a live artifact on structured-only upsert and deletes it on provider delete", async () => {
    const innerState = new InMemoryIngestionStateStore();
    const localArtifacts = new LocalArtifactStore({ root: await artifactRoot() });
    const { semantic, engine } = await runtime(innerState, { artifactStore: localArtifacts });
    await engine.sync({
      sourceKey,
      source: singlePageSource([
        change("artifact-start", "atlas", { name: "Atlas", status: "active" }, { revision: "r1" }),
      ]),
      mapper,
      artifactMapper: rawArtifactMapper(new Uint8Array([21, 22])),
    });
    const live = (await innerState.projection(sourceKey, "project", "atlas"))?.artifact;

    await engine.sync({
      sourceKey,
      source: singlePageSource([
        change("structured-only", "atlas", { name: "Atlas", status: "paused" }, { revision: "r2" }),
      ], sourceCheckpoint("cp-structured")),
      mapper,
    });
    expect((await innerState.projection(sourceKey, "project", "atlas"))?.artifact).toEqual(live);

    await engine.sync({
      sourceKey,
      source: singlePageSource([
        change("provider-delete", "atlas", undefined, { kind: "delete", revision: "r3" }),
      ], sourceCheckpoint("cp-delete")),
      mapper,
    });
    expect((await innerState.projection(sourceKey, "project", "atlas"))?.artifact).toBeUndefined();
    const history = await localArtifacts.mutationsForResource({ sourceKey, externalType: "project", externalId: "atlas" });
    expect(history.map((item) => item.kind)).toEqual(["upsert", "delete"]);
    localArtifacts.close();
    semantic.close();
  });

  it("full-sync sweep deletes an unseen live artifact without requiring the artifact mapper", async () => {
    const state = new InMemoryIngestionStateStore();
    const localArtifacts = new LocalArtifactStore({ root: await artifactRoot() });
    const { semantic, engine } = await runtime(state, { artifactStore: localArtifacts });
    await engine.sync({
      sourceKey,
      source: singlePageSource([
        change("full-artifact-start", "atlas", { name: "Atlas", status: "active" }, { revision: "r1" }),
      ]),
      mapper,
      artifactMapper: rawArtifactMapper(new Uint8Array([71, 72, 73])),
    });
    await state.beginFullSyncGeneration(sourceKey, "2026-10-01T00:00:00Z");

    const result = await engine.sync({
      sourceKey,
      source: singlePageSource([], sourceCheckpoint("cp-full-artifact-delete")),
      mapper,
    });

    expect(result.sweptResources).toBe(1);
    expect(result.artifactMutationsAppended).toBe(1);
    const history = await localArtifacts.mutationsForResource({
      sourceKey,
      externalType: "project",
      externalId: "atlas",
    });
    expect(history.map((item) => item.kind)).toEqual(["upsert", "delete"]);
    expect((await state.projection(sourceKey, "project", "atlas"))?.deleted).toBe(true);
    expect((await state.projection(sourceKey, "project", "atlas"))?.artifact).toBeUndefined();
    localArtifacts.close();
    semantic.close();
  });

  it("keeps full-sync sweeping isolated by sourceKey scope", async () => {
    const state = new InMemoryIngestionStateStore();
    const { semantic, engine } = await runtime(state);
    const other = ingestionSourceKey("synthetic/account-1/projects:favorite-only");
    await engine.sync({
      sourceKey,
      source: singlePageSource([
        change("all-a", "atlas", { name: "Atlas", status: "active" }, { revision: "all-r1" }),
      ], sourceCheckpoint("all-cp")),
      mapper,
    });
    await engine.sync({
      sourceKey: other,
      source: singlePageSource([
        change("fav-z", "zeus", { name: "Zeus", status: "active" }, { revision: "fav-r1" }),
      ], sourceCheckpoint("fav-cp")),
      mapper,
    });
    await state.beginFullSyncGeneration(sourceKey, "2026-10-01T00:00:00Z");

    await engine.sync({
      sourceKey,
      source: singlePageSource([], sourceCheckpoint("all-cp-2")),
      mapper,
    });

    expect((await state.projection(sourceKey, "project", "atlas"))?.deleted).toBe(true);
    expect((await state.projection(other, "project", "zeus"))?.deleted).toBe(false);
    semantic.close();
  });
});
