import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  FullSyncCompletionCollisionError,
  MappedProjectionCollisionError,
  SourceChangeCollisionError,
  ingestionSourceKey,
  resourceProjectionJson,
  sourceCheckpoint,
  type ResourceProjection,
} from "@ssrl/ingestion";
import {
  CorruptIngestionStateDatabaseError,
  SharedSQLiteIngestionDatabaseNotSupportedError,
  SQLiteIngestionStateStore,
  SQLiteSemanticStateStore,
} from "../src/index.js";

const roots: string[] = [];
const source = ingestionSourceKey("synthetic/account-1/projects:all");
const otherSource = ingestionSourceKey("synthetic/account-1/projects:favorites");

async function databasePath(name = "ingestion.sqlite"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ssrl-ingestion-state-"));
  roots.push(root);
  return join(root, name);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function projection(
  sourceKey = source,
  externalId = "atlas",
  semanticRecordId = "obs:atlas:r1:status",
): ResourceProjection {
  return {
    sourceKey,
    externalType: "project",
    externalId,
    deleted: false,
    slots: [{ key: "status", kind: "observation", semanticRecordId }],
  };
}

describe("SQLiteIngestionStateStore", () => {
  it("persists source-scoped checkpoints and projections across close/reopen", async () => {
    const path = await databasePath();
    const first = new SQLiteIngestionStateStore({ path, wal: true });
    await first.setCheckpoint(source, sourceCheckpoint("cp-all"));
    await first.setCheckpoint(otherSource, sourceCheckpoint("cp-favorites"));
    await first.putProjection(projection());
    await first.putProjection(projection(otherSource, "zeus", "obs:zeus:r1:status"));
    first.close();

    const reopened = new SQLiteIngestionStateStore({ path });
    expect(await reopened.checkpoint(source)).toBe(sourceCheckpoint("cp-all"));
    expect(await reopened.checkpoint(otherSource)).toBe(sourceCheckpoint("cp-favorites"));
    expect(await reopened.projection(source, "project", "atlas")).toEqual(projection());
    expect((await reopened.listProjections(source)).map((item) => item.externalId)).toEqual(["atlas"]);
    expect((await reopened.listProjections(otherSource)).map((item) => item.externalId)).toEqual(["zeus"]);
    reopened.close();
  });

  it("stores a source change identity once and fails closed on different replay content", async () => {
    const path = await databasePath();
    const store = new SQLiteIngestionStateStore({ path });
    expect(await store.assertChangeIdentity(source, "change-1", '{"a":1}')).toBe("inserted");
    expect(await store.assertChangeIdentity(source, "change-1", '{"a":1}')).toBe("existing");
    await expect(store.assertChangeIdentity(source, "change-1", '{"a":2}'))
      .rejects.toBeInstanceOf(SourceChangeCollisionError);
    expect(await store.assertChangeIdentity(otherSource, "change-1", '{"a":2}')).toBe("inserted");
    store.close();
  });

  it("persists the canonical mapped plan and rejects a different plan for the same change", async () => {
    const path = await databasePath();
    const first = new SQLiteIngestionStateStore({ path });
    await first.assertChangeIdentity(source, "change-plan", '{"changeId":"change-plan"}');
    const desired = {
      additiveEntities: [{ entityId: "entity://project/atlas" as const, entityType: "Project" }],
      slots: [{
        key: "status",
        kind: "observation" as const,
        record: {
          id: "obs:atlas:r1:status",
          entityId: "entity://project/atlas" as const,
          property: "Project.status",
          value: "active",
          source: { provider: "synthetic", externalId: "atlas", revision: "r1" },
          validFrom: "2026-09-24T00:00:00Z",
          recordedAt: "2026-09-24T00:01:00Z",
        },
      }],
    };
    expect(await first.putMappedProjection(source, "change-plan", desired)).toBe("inserted");
    first.close();

    const reopened = new SQLiteIngestionStateStore({ path });
    expect(await reopened.mappedProjection(source, "change-plan")).toEqual({
      additiveEntities: [{ entityId: "entity://project/atlas", entityType: "Project" }],
      slots: [{
        key: "status",
        kind: "observation",
        record: expect.objectContaining({
          id: "obs:atlas:r1:status",
          validFrom: "2026-09-24T00:00:00.000Z",
          recordedAt: "2026-09-24T00:01:00.000Z",
        }),
      }],
    });
    expect(await reopened.putMappedProjection(source, "change-plan", desired)).toBe("existing");
    await expect(reopened.putMappedProjection(source, "change-plan", {
      additiveEntities: desired.additiveEntities,
      slots: [{
        key: "status",
        kind: "observation",
        record: {
          id: "obs:atlas:r1:status",
          entityId: "entity://project/atlas" as const,
          property: "Project.status",
          value: "paused",
          source: { provider: "synthetic", externalId: "atlas", revision: "r1" },
          validFrom: "2026-09-24T00:00:00Z",
          recordedAt: "2026-09-24T00:01:00Z",
        },
      }],
    })).rejects.toBeInstanceOf(MappedProjectionCollisionError);
    reopened.close();
  });

  it("persists an active full-sync generation and seen set across close/reopen", async () => {
    const path = await databasePath();
    const first = new SQLiteIngestionStateStore({ path });
    await first.putProjection(projection(source, "atlas"));
    await first.putProjection(projection(source, "zeus", "obs:zeus:r1:status"));
    const generation = await first.beginFullSyncGeneration(source, "2026-10-01T03:00:00+03:00");
    await first.markSeen(generation.id, "project", "atlas");
    first.close();

    const reopened = new SQLiteIngestionStateStore({ path });
    expect(await reopened.activeFullSyncGeneration(source)).toEqual({
      ...generation,
      observedAt: "2026-10-01T00:00:00.000Z",
    });
    expect((await reopened.unseenProjections(generation.id)).map((item) => item.externalId))
      .toEqual(["zeus"]);
    reopened.close();
  });

  it("atomically commits a full-sync checkpoint and finalizes the generation", async () => {
    const path = await databasePath();
    const store = new SQLiteIngestionStateStore({ path });
    await store.setCheckpoint(source, sourceCheckpoint("cp-old"));
    const generation = await store.beginFullSyncGeneration(source, "2026-10-01T00:00:00Z");
    await store.markSeen(generation.id, "project", "atlas");

    await store.completeFullSyncGeneration(generation.id, sourceCheckpoint("cp-new"));
    expect(await store.checkpoint(source)).toBe(sourceCheckpoint("cp-new"));
    expect(await store.activeFullSyncGeneration(source)).toBeUndefined();
    await expect(store.unseenProjections(generation.id)).rejects.toThrow(/is completed/);
    await expect(store.completeFullSyncGeneration(generation.id, sourceCheckpoint("cp-new")))
      .resolves.toBeUndefined();
    await expect(store.completeFullSyncGeneration(generation.id, sourceCheckpoint("cp-other")))
      .rejects.toBeInstanceOf(FullSyncCompletionCollisionError);
    store.close();
  });

  it("keeps full-sync generations isolated by sourceKey", async () => {
    const path = await databasePath();
    const store = new SQLiteIngestionStateStore({ path });
    await store.putProjection(projection(source, "atlas"));
    await store.putProjection(projection(otherSource, "zeus", "obs:zeus:r1:status"));
    const generation = await store.beginFullSyncGeneration(source, "2026-10-01T00:00:00Z");

    expect((await store.unseenProjections(generation.id)).map((item) => item.externalId))
      .toEqual(["atlas"]);
    store.close();
  });

  it("fails closed when stored projection JSON disagrees with indexed columns", async () => {
    const path = await databasePath();
    const store = new SQLiteIngestionStateStore({ path });
    await store.putProjection(projection());
    store.close();

    const raw = new DatabaseSync(path);
    raw.prepare(`
      UPDATE ingestion_projections
      SET projection_json = ?
      WHERE source_key = ? AND external_type = 'project' AND external_id = 'atlas'
    `).run(resourceProjectionJson({ ...projection(), externalId: "different" }), source);
    raw.close();

    const reopened = new SQLiteIngestionStateStore({ path });
    await expect(reopened.projection(source, "project", "atlas"))
      .rejects.toBeInstanceOf(CorruptIngestionStateDatabaseError);
    reopened.close();
  });

  it("refuses to silently share a semantic-state database", async () => {
    const path = await databasePath();
    const semantic = new SQLiteSemanticStateStore({ path });
    semantic.close();

    expect(() => new SQLiteIngestionStateStore({ path }))
      .toThrow(SharedSQLiteIngestionDatabaseNotSupportedError);
  });
});
