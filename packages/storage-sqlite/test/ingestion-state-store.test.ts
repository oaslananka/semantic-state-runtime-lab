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
  resolveSourceChange,
  resourceProjectionJson,
  sourceCheckpoint,
  type ResourceProjection,
  type SourceChangeDraft,
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

function draft(
  changeId: string,
  overrides: Partial<SourceChangeDraft<{ readonly value?: string }>> = {},
): SourceChangeDraft<{ readonly value?: string }> {
  return {
    changeId,
    externalType: "project",
    externalId: "atlas",
    kind: "upsert",
    payload: { value: "active" },
    ...overrides,
  };
}

async function persistReceipt(
  store: SQLiteIngestionStateStore,
  item: SourceChangeDraft,
  observedAt = "2026-09-24T12:00:00Z",
) {
  return store.putChangeReceipt(source, item, resolveSourceChange(item, observedAt));
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

  it("stores provider draft and resolved receipt once and fails closed on different replay content", async () => {
    const path = await databasePath();
    const store = new SQLiteIngestionStateStore({ path });
    const item = draft("change-1");

    expect(await store.changeReceipt(source, item)).toBeUndefined();
    const resolved = await persistReceipt(store, item, "2026-09-24T12:00:00Z");
    expect(resolved.effectiveAt).toBe("2026-09-24T12:00:00.000Z");
    expect(resolved.recordedAt).toBe("2026-09-24T12:00:00.000Z");
    expect(await store.changeReceipt(source, item)).toEqual(resolved);
    expect(await store.putChangeReceipt(
      source,
      item,
      resolveSourceChange(item, "2026-09-25T00:00:00Z"),
    )).toEqual(resolved);

    await expect(store.changeReceipt(source, draft("change-1", { payload: { value: "different" } })))
      .rejects.toBeInstanceOf(SourceChangeCollisionError);
    expect(await store.changeReceipt(otherSource, item)).toBeUndefined();
    store.close();
  });

  it("rejects a resolved receipt that changes provider-owned source fields", async () => {
    const path = await databasePath();
    const store = new SQLiteIngestionStateStore({ path });
    const item = draft("receipt-integrity");
    const resolved = resolveSourceChange(item, "2026-09-24T12:00:00Z");

    await expect(store.putChangeReceipt(source, item, {
      ...resolved,
      kind: "delete",
    })).rejects.toBeInstanceOf(SourceChangeCollisionError);
    expect(await store.changeReceipt(source, item)).toBeUndefined();
    store.close();
  });

  it("persists the canonical mapped plan and rejects a different plan for the same change", async () => {
    const path = await databasePath();
    const first = new SQLiteIngestionStateStore({ path });
    await persistReceipt(first, draft("change-plan", {
      effectiveAt: "2026-09-24T00:00:00Z",
      recordedAt: "2026-09-24T00:01:00Z",
    }));
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

  it("migrates v1 receipts without changing their resolved source change", async () => {
    const path = await databasePath();
    const first = new SQLiteIngestionStateStore({ path });
    const item = draft("legacy-change", {
      effectiveAt: "2026-09-24T00:00:00Z",
      recordedAt: "2026-09-24T00:01:00Z",
    });
    const expected = await persistReceipt(first, item);
    first.close();

    const raw = new DatabaseSync(path);
    raw.exec(`
      ALTER TABLE ingestion_change_receipts RENAME TO ingestion_change_receipts_v2;
      CREATE TABLE ingestion_change_receipts (
        source_key TEXT NOT NULL,
        change_id TEXT NOT NULL,
        change_json TEXT NOT NULL CHECK(json_valid(change_json)),
        projection_json TEXT CHECK(projection_json IS NULL OR json_valid(projection_json)),
        PRIMARY KEY(source_key, change_id)
      ) STRICT;
      INSERT INTO ingestion_change_receipts(source_key, change_id, change_json, projection_json)
      SELECT source_key, change_id, resolved_change_json, projection_json
      FROM ingestion_change_receipts_v2;
      DROP TABLE ingestion_change_receipts_v2;
      UPDATE ingestion_state_meta
      SET schema_version = 1
      WHERE component = 'ingestion-state-store';
    `);
    raw.close();

    const migrated = new SQLiteIngestionStateStore({ path });
    expect(await migrated.changeReceipt(source, item)).toEqual(expected);
    migrated.close();

    const inspect = new DatabaseSync(path);
    expect(inspect.prepare(`
      SELECT schema_version FROM ingestion_state_meta WHERE component = 'ingestion-state-store'
    `).get()).toEqual(expect.objectContaining({ schema_version: 2 }));
    inspect.close();
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
