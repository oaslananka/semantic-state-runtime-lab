import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EntityId } from "@ssrl/core";
import {
  InMemoryContextCapsuleStore,
  contextCapsuleJson,
  type ContextCapsule,
} from "@ssrl/materializer";
import type { SemanticChangeCursor } from "@ssrl/state-store";
import {
  CorruptCapsuleCacheError,
  SharedCapsuleCacheDatabaseNotSupportedError,
  SQLiteContextCapsuleStore,
} from "../src/index.js";

const roots: string[] = [];

async function dbPath(name = "capsules.sqlite"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ssrl-capsules-"));
  roots.push(root);
  return join(root, name);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function capsule(input: {
  readonly entityId: EntityId;
  readonly aliases: readonly string[];
  readonly materializedAt?: string;
  readonly configurationVersion?: string;
  readonly changeCursor?: SemanticChangeCursor;
  readonly nextTemporalBoundary?: string;
}): ContextCapsule {
  const materializedAt = input.materializedAt ?? "2026-09-24T00:00:00.000Z";
  return {
    schema: "ssrl-context-capsule-v1",
    entityId: input.entityId,
    materializedAt,
    configurationVersion: input.configurationVersion ?? "cfg-v1",
    ...(input.changeCursor === undefined ? {} : { changeCursor: input.changeCursor }),
    material: {
      entity: {
        id: input.entityId,
        type: "Project",
        aliases: input.aliases.map((value) => ({ value })),
      },
      state: {
        canonical: { entityId: input.entityId, properties: {} },
        conflicts: [],
        evidence: {},
        conflictEvidence: {},
      },
      activeRelations: [],
      appliedRetractions: [],
      ...(input.nextTemporalBoundary === undefined
        ? {}
        : { nextTemporalBoundary: input.nextTemporalBoundary }),
    },
  };
}

const atlas = "entity://project/atlas" as const;
const atlasTwo = "entity://project/atlas-two" as const;
const calisma = "entity://project/calisma" as const;
const fullwidth = "entity://project/fullwidth" as const;

async function populateParityStores(
  sqlite: SQLiteContextCapsuleStore,
  memory: InMemoryContextCapsuleStore,
): Promise<void> {
  const capsules = [
    capsule({ entityId: atlas, aliases: ["Atlas", "Project Atlas"] }),
    capsule({ entityId: atlasTwo, aliases: ["Atlas", "Atlas Two"] }),
    capsule({ entityId: calisma, aliases: ["Çalışma Alanı"] }),
    capsule({ entityId: fullwidth, aliases: ["Project Nova"] }),
  ];
  for (const item of capsules) {
    await sqlite.put(item);
    await memory.put(item);
  }
}

describe("SQLiteContextCapsuleStore", () => {
  it("round-trips a capsule and checkpoint exactly across close/reopen", async () => {
    const path = await dbPath();
    const cursor = "sqlite-semantic-v1:feed:42" as SemanticChangeCursor;
    const expected = capsule({
      entityId: atlas,
      aliases: ["Project Atlas", "Atlas"],
      changeCursor: cursor,
      nextTemporalBoundary: "2026-10-01T00:00:00.000Z",
    });
    const first = new SQLiteContextCapsuleStore({ path, wal: true });
    expect(await first.put(expected)).toBe("inserted");
    await first.setCheckpoint(cursor);
    expect(await first.get(atlas)).toEqual(expected);
    first.close();

    const reopened = new SQLiteContextCapsuleStore({ path });
    expect(await reopened.get(atlas)).toEqual(expected);
    expect(await reopened.checkpoint()).toBe(cursor);
    reopened.close();
  });

  it("atomically replaces alias index rows when a capsule changes", async () => {
    const path = await dbPath();
    const store = new SQLiteContextCapsuleStore({ path });
    expect(await store.put(capsule({ entityId: atlas, aliases: ["Old Atlas"] }))).toBe("inserted");
    expect((await store.search("Old Atlas", 10)).map((item) => item.entityId)).toEqual([atlas]);

    expect(await store.put(capsule({ entityId: atlas, aliases: ["New Atlas"] }))).toBe("updated");
    expect(await store.search("Old Atlas", 10)).toEqual([]);
    expect((await store.search("New Atlas", 10)).map((item) => item.entityId)).toEqual([atlas]);
    store.close();
  });

  it("matches InMemory search semantics for normalization, phrase scores, ties, and limits", async () => {
    const path = await dbPath();
    const sqlite = new SQLiteContextCapsuleStore({ path });
    const memory = new InMemoryContextCapsuleStore();
    await populateParityStores(sqlite, memory);

    const cases = [
      ["Please continue PROJECT---ATLAS today", 10],
      ["atlas and another thing", 10],
      ["ÇALIŞMA...ALANI planı", 10],
      ["ＰＲＯＪＥＣＴ ＮＯＶＡ", 10],
      ["Atlas Two and Project Atlas", 1],
      ["no matching entity", 10],
    ] as const;
    for (const [query, limit] of cases) {
      const sqliteIds = (await sqlite.search(query, limit)).map((item) => item.entityId);
      const memoryIds = (await memory.search(query, limit)).map((item) => item.entityId);
      expect(sqliteIds, query).toEqual(memoryIds);
    }
    sqlite.close();
  });

  it("selects alias candidates before deserializing unrelated capsule JSON", async () => {
    const path = await dbPath();
    const store = new SQLiteContextCapsuleStore({ path });
    await store.put(capsule({ entityId: atlas, aliases: ["Project Atlas"] }));
    await store.put(capsule({ entityId: calisma, aliases: ["Çalışma Alanı"] }));
    store.close();

    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE context_capsules SET capsule_json = ? WHERE entity_id = ?")
      .run("{}", calisma);
    raw.close();

    const reopened = new SQLiteContextCapsuleStore({ path });
    expect((await reopened.search("Project Atlas", 10)).map((item) => item.entityId)).toEqual([atlas]);
    await expect(reopened.search("Çalışma Alanı", 10)).rejects
      .toBeInstanceOf(CorruptCapsuleCacheError);
    reopened.close();
  });

  it("returns time-expired and configuration-stale ids from indexed columns", async () => {
    const path = await dbPath();
    const store = new SQLiteContextCapsuleStore({ path });
    await store.put(capsule({
      entityId: atlas,
      aliases: ["Atlas"],
      nextTemporalBoundary: "2026-09-20T00:00:00.000Z",
    }));
    await store.put(capsule({
      entityId: atlasTwo,
      aliases: ["Atlas Two"],
      configurationVersion: "cfg-old",
    }));
    await store.put(capsule({
      entityId: calisma,
      aliases: ["Çalışma Alanı"],
      nextTemporalBoundary: "2026-10-01T00:00:00.000Z",
    }));

    expect(await store.staleEntityIds("2026-09-24T00:00:00Z", "cfg-v1"))
      .toEqual([atlas, atlasTwo]);
    store.close();
  });

  it("reset removes derived capsules and checkpoint but keeps the cache reusable", async () => {
    const path = await dbPath();
    const store = new SQLiteContextCapsuleStore({ path });
    const cursor = "sqlite-semantic-v1:feed:7" as SemanticChangeCursor;
    await store.put(capsule({ entityId: atlas, aliases: ["Atlas"] }));
    await store.setCheckpoint(cursor);
    await store.reset();

    expect(await store.get(atlas)).toBeUndefined();
    expect(await store.checkpoint()).toBeUndefined();
    expect(await store.search("Atlas", 10)).toEqual([]);
    expect(await store.put(capsule({ entityId: atlasTwo, aliases: ["Atlas Two"] })))
      .toBe("inserted");
    store.close();
  });

  it("fails closed when capsule JSON and typed index columns disagree", async () => {
    const path = await dbPath();
    const store = new SQLiteContextCapsuleStore({ path });
    const value = capsule({ entityId: atlas, aliases: ["Atlas"] });
    await store.put(value);
    store.close();

    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE context_capsules SET configuration_version = ? WHERE entity_id = ?")
      .run("wrong", atlas);
    raw.close();

    const reopened = new SQLiteContextCapsuleStore({ path });
    await expect(reopened.get(atlas)).rejects.toBeInstanceOf(CorruptCapsuleCacheError);
    reopened.close();
  });

  it("refuses to initialize over an unrelated SQLite schema", async () => {
    const path = await dbPath();
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE runtime_events(id TEXT PRIMARY KEY) STRICT");
    raw.close();

    expect(() => new SQLiteContextCapsuleStore({ path }))
      .toThrow(SharedCapsuleCacheDatabaseNotSupportedError);
  });

  it("stores canonical capsule JSON", async () => {
    const path = await dbPath();
    const value = capsule({ entityId: atlas, aliases: ["Atlas"] });
    const store = new SQLiteContextCapsuleStore({ path });
    await store.put(value);
    store.close();
    const raw = new DatabaseSync(path);
    const row = raw.prepare("SELECT capsule_json FROM context_capsules WHERE entity_id = ?")
      .get(atlas) as { readonly capsule_json: string };
    expect(row.capsule_json).toBe(contextCapsuleJson(value));
    raw.close();
  });
});
