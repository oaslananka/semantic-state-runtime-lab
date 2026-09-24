import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntityId } from "@ssrl/core";
import type {
  SemanticChangeCursor,
  SemanticStateBatch,
} from "@ssrl/state-store";
import { SQLiteSemanticStateStore } from "@ssrl/storage-sqlite";
import { bm25Baseline, contextCorpusFromCapsules } from "@ssrl/context";
import {
  ContextCapsuleMaterializer,
  IncrementalContextCapsuleWorker,
  InMemoryContextCapsuleStore,
  contextCapsuleMaterialJson,
  relatedEntityIdsFromCapsule,
  type CapsuleWriteResult,
  type ContextCapsule,
  type ContextCapsuleStore,
} from "../src/index.js";

const roots: string[] = [];
const project = "entity://project/atlas" as const;
const alice = "entity://person/alice" as const;

async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ssrl-materializer-"));
  roots.push(root);
  return join(root, "state.sqlite");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function baseBatch(): SemanticStateBatch {
  return {
    entities: [
      { entityId: project, entityType: "Project" },
      { entityId: alice, entityType: "Person" },
    ],
    aliases: [
      {
        id: "alias-project",
        entityId: project,
        value: "Project Atlas",
        recordedAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "alias-alice",
        entityId: alice,
        value: "Alice",
        recordedAt: "2026-01-01T00:00:00Z",
      },
    ],
    observations: [
      {
        id: "api-rest",
        entityId: project,
        property: "Project.apiStyle",
        value: "REST",
        source: { provider: "adr", externalId: "atlas-api", revision: "rest" },
        validFrom: "2026-01-01T00:00:00Z",
        validTo: "2026-08-01T00:00:00Z",
        recordedAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "api-graphql",
        entityId: project,
        property: "Project.apiStyle",
        value: "GraphQL",
        source: { provider: "adr", externalId: "atlas-api", revision: "graphql" },
        validFrom: "2026-08-01T00:00:00Z",
        recordedAt: "2026-02-01T00:00:00Z",
      },
      {
        id: "alice-timezone",
        entityId: alice,
        property: "Person.timezone",
        value: "Europe/Istanbul",
        source: { provider: "profile", externalId: "alice" },
        validFrom: "2026-01-01T00:00:00Z",
        recordedAt: "2026-01-01T00:00:00Z",
      },
    ],
    relations: [{
      id: "owner-alice",
      from: project,
      to: alice,
      relationType: "Project.owner",
      validFrom: "2026-01-01T00:00:00Z",
      recordedAt: "2026-01-01T00:00:00Z",
      evidenceRefs: ["directory:owner"],
    }],
  };
}

function materializer(store: SQLiteSemanticStateStore, configurationVersion = "authority-v1") {
  return new ContextCapsuleMaterializer({
    stateStore: store,
    configurationVersion,
    authorityByEntity: new Map([
      [project, [{ property: "Project.apiStyle", strategy: { kind: "provider", provider: "adr" } }]],
      [alice, [{ property: "Person.timezone", strategy: { kind: "provider", provider: "profile" } }]],
    ]),
  });
}

class FailOnceCapsuleStore implements ContextCapsuleStore {
  readonly inner = new InMemoryContextCapsuleStore();
  #failEntity: EntityId | undefined;

  constructor(failEntity: EntityId) {
    this.#failEntity = failEntity;
  }

  async get(entityId: EntityId): Promise<ContextCapsule | undefined> {
    return this.inner.get(entityId);
  }

  async put(capsule: ContextCapsule): Promise<CapsuleWriteResult> {
    if (capsule.entityId === this.#failEntity) {
      this.#failEntity = undefined;
      throw new Error("simulated capsule write failure");
    }
    return this.inner.put(capsule);
  }

  async delete(entityId: EntityId): Promise<boolean> {
    return this.inner.delete(entityId);
  }

  async checkpoint(): Promise<SemanticChangeCursor | undefined> {
    return this.inner.checkpoint();
  }

  async setCheckpoint(cursor: SemanticChangeCursor): Promise<void> {
    await this.inner.setCheckpoint(cursor);
  }

  async staleEntityIds(at: string, configurationVersion: string): Promise<readonly EntityId[]> {
    return this.inner.staleEntityIds(at, configurationVersion);
  }
}

async function seededRuntime(
  capsuleStore: ContextCapsuleStore = new InMemoryContextCapsuleStore(),
  configurationVersion = "authority-v1",
) {
  const path = await databasePath();
  const state = new SQLiteSemanticStateStore({ path });
  await state.append(baseBatch());
  const mat = materializer(state, configurationVersion);
  const worker = new IncrementalContextCapsuleWorker({
    stateStore: state,
    capsuleStore,
    materializer: mat,
  });
  return { state, cache: capsuleStore, materializer: mat, worker };
}

describe("incremental context capsules", () => {
  it("materializes entity-local state and relations without copying related entity state", async () => {
    const { state, cache, worker } = await seededRuntime();

    const run = await worker.runOnce({ at: "2026-03-01T00:00:00Z" });
    expect(run.changesRead).toBe(8);
    expect(run.changedEntityIds).toEqual([alice, project]);
    expect(run.materializedEntityIds).toEqual([alice, project]);
    expect(run.writes).toEqual({ inserted: 2, updated: 0, unchanged: 0 });

    const projectCapsule = await cache.get(project);
    const aliceCapsule = await cache.get(alice);
    expect(projectCapsule?.material.state.canonical.properties["Project.apiStyle"]?.value).toBe("REST");
    expect(projectCapsule?.material.nextTemporalBoundary).toBe("2026-08-01T00:00:00.000Z");
    expect(projectCapsule === undefined ? [] : relatedEntityIdsFromCapsule(projectCapsule)).toEqual([alice]);
    expect(contextCapsuleMaterialJson(projectCapsule!.material)).not.toContain("Europe/Istanbul");
    expect(aliceCapsule?.material.state.canonical.properties["Person.timezone"]?.value)
      .toBe("Europe/Istanbul");
    state.close();
  });

  it("refreshes a capsule after a temporal boundary even when the change feed is empty", async () => {
    const { state, cache, worker } = await seededRuntime();
    await worker.runOnce({ at: "2026-03-01T00:00:00Z" });

    const refresh = await worker.runOnce({ at: "2026-09-01T00:00:00Z" });
    expect(refresh.changesRead).toBe(0);
    expect(refresh.changedEntityIds).toEqual([]);
    expect(refresh.staleEntityIds).toEqual([project]);
    expect(refresh.materializedEntityIds).toEqual([project]);
    expect(refresh.writes).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    expect((await cache.get(project))?.material.state.canonical.properties["Project.apiStyle"]?.value)
      .toBe("GraphQL");
    expect((await cache.get(project))?.material.nextTemporalBoundary).toBeUndefined();
    state.close();
  });

  it("rematerializes Alice only when Alice state changes", async () => {
    const { state, cache, worker } = await seededRuntime();
    await worker.runOnce({ at: "2026-09-01T00:00:00Z" });
    const projectBefore = await cache.get(project);

    await state.append({
      observations: [{
        id: "alice-timezone-london",
        entityId: alice,
        property: "Person.timezone",
        value: "Europe/London",
        source: { provider: "profile", externalId: "alice", revision: "london" },
        validFrom: "2026-09-20T00:00:00Z",
        recordedAt: "2026-09-20T00:00:00Z",
      }],
    });
    const run = await worker.runOnce({ at: "2026-09-24T00:00:00Z" });

    expect(run.changedEntityIds).toEqual([alice]);
    expect(run.materializedEntityIds).toEqual([alice]);
    expect((await cache.get(alice))?.material.state.canonical.properties["Person.timezone"]?.value)
      .toBe("Europe/London");
    expect(await cache.get(project)).toBe(projectBefore);
    state.close();
  });

  it("rematerializes the relation source capsule, not the target capsule", async () => {
    const { state, cache, worker } = await seededRuntime();
    await worker.runOnce({ at: "2026-09-01T00:00:00Z" });

    await state.append({
      relations: [{
        id: "reviewer-alice",
        from: project,
        to: alice,
        relationType: "Project.reviewer",
        validFrom: "2026-09-10T00:00:00Z",
        recordedAt: "2026-09-10T00:00:00Z",
      }],
    });
    const run = await worker.runOnce({ at: "2026-09-24T00:00:00Z" });

    expect(run.changedEntityIds).toEqual([project]);
    expect(run.materializedEntityIds).toEqual([project]);
    expect((await cache.get(project))?.material.activeRelations.map((relation) => relation.id))
      .toEqual(["owner-alice", "reviewer-alice"]);
    state.close();
  });

  it("does not advance the checkpoint until every affected capsule write succeeds", async () => {
    const failCache = new FailOnceCapsuleStore(project);
    const { state, worker } = await seededRuntime(failCache);
    const cache = failCache;

    await expect(worker.runOnce({ at: "2026-03-01T00:00:00Z" }))
      .rejects.toThrow(/simulated capsule write failure/);
    expect(await cache.checkpoint()).toBeUndefined();
    expect(await cache.get(alice)).toBeDefined();
    expect(await cache.get(project)).toBeUndefined();

    const replay = await worker.runOnce({ at: "2026-03-01T00:00:00Z" });
    expect(replay.changesRead).toBe(8);
    expect(replay.writes).toEqual({ inserted: 1, updated: 0, unchanged: 1 });
    expect(await cache.checkpoint()).toBeDefined();
    expect(await cache.get(project)).toBeDefined();
    state.close();
  });

  it("invalidates capsules deterministically when materializer configuration changes", async () => {
    const { state, cache, worker: first } = await seededRuntime(
      new InMemoryContextCapsuleStore(),
      "authority-v1",
    );
    await first.runOnce({ at: "2026-09-01T00:00:00Z" });

    const second = new IncrementalContextCapsuleWorker({
      stateStore: state,
      capsuleStore: cache,
      materializer: materializer(state, "authority-v2"),
    });
    const run = await second.runOnce({ at: "2026-09-01T00:00:00Z" });

    expect(run.changesRead).toBe(0);
    expect(run.staleEntityIds).toEqual([alice, project]);
    expect(run.writes).toEqual({ inserted: 0, updated: 2, unchanged: 0 });
    expect((await cache.get(project))?.configurationVersion).toBe("authority-v2");
    state.close();
  });

  it("projects direct and related capsules into the existing BM25 retrieval path", async () => {
    const { state, materializer: mat } = await seededRuntime();
    const projectCapsule = await mat.materializeEntity(project, "2026-09-01T00:00:00Z");
    const aliceCapsule = await mat.materializeEntity(alice, "2026-09-01T00:00:00Z");
    if (projectCapsule === undefined || aliceCapsule === undefined) {
      throw new Error("expected materialized capsules");
    }

    const corpus = contextCorpusFromCapsules([projectCapsule, aliceCapsule], {
      relationTypes: [{ id: "Project.owner", aliases: ["owner", "sahibi"] }],
      properties: [
        { property: "Project.apiStyle", aliases: ["api style"] },
        { property: "Person.timezone", aliases: ["timezone", "saat dilimi"] },
      ],
    });
    const result = bm25Baseline(
      corpus,
      { query: "Project Atlas owner timezone", budgetTokens: 160 },
      [project, alice],
    );
    const text = result.records.map((record) => record.text).join("\n");

    expect(text).toContain("Alice");
    expect(text).toContain("Europe/Istanbul");
    expect(result.estimatedTokens).toBeLessThanOrEqual(160);
    state.close();
  });

  it("produces canonical capsule material independent of append array ordering", async () => {
    const pathOne = await databasePath();
    const pathTwo = await databasePath();
    const firstState = new SQLiteSemanticStateStore({ path: pathOne });
    const secondState = new SQLiteSemanticStateStore({ path: pathTwo });
    const batch = baseBatch();
    await firstState.append(batch);
    await secondState.append({
      entities: [...(batch.entities ?? [])].reverse(),
      aliases: [...(batch.aliases ?? [])].reverse(),
      observations: [...(batch.observations ?? [])].reverse(),
      relations: [...(batch.relations ?? [])].reverse(),
    });

    const first = await materializer(firstState).materializeEntity(project, "2026-03-01T00:00:00Z");
    const second = await materializer(secondState).materializeEntity(project, "2026-03-01T00:00:00Z");
    expect(contextCapsuleMaterialJson(first!.material)).toBe(contextCapsuleMaterialJson(second!.material));
    firstState.close();
    secondState.close();
  });
});
