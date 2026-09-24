import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import {
  InMemoryContextCapsuleStore,
  contextCapsuleJson,
  type ContextCapsule,
} from "../packages/materializer/dist/index.js";
import { SQLiteContextCapsuleStore } from "../packages/storage-sqlite-capsules/dist/index.js";
import {
  entityAliasScore,
  normalizeEntityAlias,
  type EntityId,
} from "../packages/core/dist/index.js";

function capsule(index: number): ContextCapsule {
  const entityId = `entity://project/benchmark-${index}` as EntityId;
  return {
    schema: "ssrl-context-capsule-v1",
    entityId,
    materializedAt: "2026-09-24T00:00:00.000Z",
    configurationVersion: "benchmark-v1",
    material: {
      entity: {
        id: entityId,
        type: "Project",
        aliases: [
          { value: `Benchmark Project ${index}` },
          { value: `Workspace ${index}` },
        ],
      },
      state: {
        canonical: { entityId, properties: {} },
        conflicts: [],
        evidence: {},
        conflictEvidence: {},
      },
      activeRelations: [],
      appliedRetractions: [],
    },
  };
}


function seedSqlite(path: string, values: readonly ContextCapsule[]): void {
  const initializer = new SQLiteContextCapsuleStore({ path, wal: false });
  initializer.close();
  const db = new DatabaseSync(path);
  const insertCapsule = db.prepare(`
    INSERT INTO context_capsules(
      entity_id, materialized_at, configuration_version,
      change_cursor, next_temporal_boundary, capsule_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertAlias = db.prepare(`
    INSERT INTO context_capsule_aliases(entity_id, normalized_alias, alias_score, token_count)
    VALUES (?, ?, ?, ?)
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const value of values) {
      insertCapsule.run(
        value.entityId,
        value.materializedAt,
        value.configurationVersion,
        value.changeCursor ?? null,
        value.material.nextTemporalBoundary ?? null,
        contextCapsuleJson(value),
      );
      for (const alias of value.material.entity.aliases) {
        const normalized = normalizeEntityAlias(alias.value);
        insertAlias.run(
          value.entityId,
          normalized,
          entityAliasScore(alias.value),
          normalized.split(" ").length,
        );
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

async function meanSearchMs(
  search: (query: string, limit: number) => Promise<readonly ContextCapsule[]>,
  query: string,
  iterations = 40,
): Promise<number> {
  for (let i = 0; i < 5; i += 1) await search(query, 5);
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) await search(query, 5);
  return (performance.now() - start) / iterations;
}

const sizes = [100, 1_000, 10_000] as const;
const rows = [];
for (const size of sizes) {
  const root = mkdtempSync(join(tmpdir(), "ssrl-capsule-bench-"));
  const path = join(root, "capsules.sqlite");
  const values = Array.from({ length: size }, (_, index) => capsule(index));
  seedSqlite(path, values);
  const sqlite = new SQLiteContextCapsuleStore({ path, wal: false });
  const memory = new InMemoryContextCapsuleStore();
  try {
    for (const value of values) await memory.put(value);
    const query = `Please continue Benchmark Project ${size - 1}`;
    const sqliteMs = await meanSearchMs((value, limit) => sqlite.search(value, limit), query);
    const memoryMs = await meanSearchMs((value, limit) => memory.search(value, limit), query);
    const sqliteResult = (await sqlite.search(query, 5)).map((item) => item.entityId);
    const inMemoryResult = (await memory.search(query, 5)).map((item) => item.entityId);
    if (JSON.stringify(sqliteResult) !== JSON.stringify(inMemoryResult)) {
      throw new Error(`Capsule cache search parity failed at size ${size}`);
    }
    rows.push({
      capsules: size,
      sqliteMeanSearchMs: Number(sqliteMs.toFixed(3)),
      inMemoryMeanSearchMs: Number(memoryMs.toFixed(3)),
      sqliteDbBytes: statSync(path).size,
      sqliteResult,
      inMemoryResult,
    });
  } finally {
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({
  benchmark: "capsule-cache-v1",
  warning: "Observational local benchmark only; results depend on hardware, filesystem, Node, SQLite, warmup, and fixture shape.",
  rows,
}, null, 2));
