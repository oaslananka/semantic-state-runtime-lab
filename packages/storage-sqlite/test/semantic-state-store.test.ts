import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  resolveTemporalState,
  type TemporalObservation,
  type TemporalRelationEdge,
} from "@ssrl/core";
import { GraphContextCompiler } from "@ssrl/context";
import {
  CorruptSemanticStateError,
  SemanticRecordCollisionError,
  UnknownSemanticEntityError,
  typedEntitiesFromStateSnapshot,
  type SemanticStateBatch,
} from "@ssrl/state-store";
import {
  SharedSQLiteDatabaseNotSupportedError,
  SQLiteEventJournal,
  SQLiteSemanticStateStore,
  UnsupportedSemanticStateSchemaError,
} from "../src/index.js";

const roots: string[] = [];
const project = "entity://project/atlas" as const;
const oldOwner = "entity://person/atlas-owner-old" as const;
const alice = "entity://person/alice" as const;

async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ssrl-state-"));
  roots.push(root);
  return join(root, "semantic-state.sqlite");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function apiObservation(
  id: string,
  value: string,
  validFrom: string,
  validTo?: string,
): TemporalObservation {
  return {
    id,
    entityId: project,
    property: "Project.apiStyle",
    value,
    source: { provider: "adr", externalId: "atlas-api", revision: id },
    validFrom,
    ...(validTo === undefined ? {} : { validTo }),
    recordedAt: validFrom,
  };
}

function ownerRelation(
  id: string,
  to: typeof oldOwner | typeof alice,
  validFrom: string,
  validTo?: string,
): TemporalRelationEdge {
  return {
    id,
    from: project,
    to,
    relationType: "Project.owner",
    validFrom,
    ...(validTo === undefined ? {} : { validTo }),
    recordedAt: validFrom,
    evidenceRefs: [`directory:${id}`],
  };
}

function baseBatch(): SemanticStateBatch {
  return {
    entities: [
      { entityId: project, entityType: "Project" },
      { entityId: oldOwner, entityType: "Person" },
      { entityId: alice, entityType: "Person" },
    ],
    aliases: [
      {
        id: "alias-project-atlas",
        entityId: project,
        value: "Project Atlas",
        recordedAt: "2026-01-01T00:00:00Z",
        evidenceRefs: ["pm:atlas"],
      },
      {
        id: "alias-old-owner",
        entityId: oldOwner,
        value: "Deniz",
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
      apiObservation("api-rest", "REST", "2026-02-01T00:00:00Z", "2026-08-01T00:00:00Z"),
      apiObservation("api-graphql", "GraphQL", "2026-08-01T00:00:00Z"),
      {
        id: "deniz-timezone",
        entityId: oldOwner,
        property: "Person.timezone",
        value: "America/New_York",
        source: { provider: "profile", externalId: "deniz" },
        validFrom: "2026-01-01T00:00:00Z",
        recordedAt: "2026-01-02T00:00:00Z",
      },
      {
        id: "alice-timezone",
        entityId: alice,
        property: "Person.timezone",
        value: "Europe/Istanbul",
        source: { provider: "profile", externalId: "alice" },
        validFrom: "2026-01-01T00:00:00Z",
        recordedAt: "2026-01-02T00:00:00Z",
      },
    ],
    relations: [
      ownerRelation("owner-deniz", oldOwner, "2026-01-01T00:00:00Z", "2026-08-01T00:00:00Z"),
      ownerRelation("owner-alice", alice, "2026-08-01T00:00:00Z"),
    ],
  };
}

describe("SQLiteSemanticStateStore", () => {
  it("atomically persists a semantic batch and reopens with an identical deterministic snapshot", async () => {
    const path = await databasePath();
    const first = new SQLiteSemanticStateStore({ path, wal: true });
    expect(await first.append(baseBatch())).toEqual({
      entities: 3,
      aliases: 3,
      observations: 4,
      relations: 2,
    });
    const before = await first.snapshot();
    first.close();

    const reopened = new SQLiteSemanticStateStore({ path });
    const after = await reopened.snapshot();
    expect(after).toEqual(before);
    expect(canonicalJson(after)).toBe(canonicalJson(before));
    expect(after.entities.map((item) => item.entityId)).toEqual([alice, oldOwner, project]);
    expect(after.aliases.map((item) => item.id)).toEqual([
      "alias-alice",
      "alias-old-owner",
      "alias-project-atlas",
    ]);
    reopened.close();
  });

  it("treats an exact replay as an idempotent no-op", async () => {
    const path = await databasePath();
    const store = new SQLiteSemanticStateStore({ path });
    await store.append(baseBatch());

    expect(await store.append(baseBatch())).toEqual({
      entities: 0,
      aliases: 0,
      observations: 0,
      relations: 0,
    });
    expect((await store.snapshot()).observations).toHaveLength(4);
    store.close();
  });

  it("treats canonically equivalent retries as the same semantic record", async () => {
    const path = await databasePath();
    const store = new SQLiteSemanticStateStore({ path });
    await store.append({
      entities: [{ entityId: project, entityType: "Project" }],
      aliases: [{
        id: "alias-project-atlas",
        entityId: project,
        value: "Project Atlas",
        recordedAt: "2026-09-24T03:00:00+03:00",
        evidenceRefs: ["b", "a", "a"],
      }],
    });

    expect(await store.append({
      entities: [{ entityId: project, entityType: "Project" }],
      aliases: [{
        id: "alias-project-atlas",
        entityId: project,
        value: "Project Atlas",
        recordedAt: "2026-09-24T00:00:00Z",
        evidenceRefs: ["a", "b"],
      }],
    })).toEqual({ entities: 0, aliases: 0, observations: 0, relations: 0 });
    store.close();
  });

  it("rolls back every new record when a stable id collides", async () => {
    const path = await databasePath();
    const store = new SQLiteSemanticStateStore({ path });
    await store.append({ entities: [{ entityId: project, entityType: "Project" }] });

    await expect(store.append({
      entities: [
        { entityId: alice, entityType: "Person" },
        { entityId: project, entityType: "Person" },
      ],
    })).rejects.toBeInstanceOf(SemanticRecordCollisionError);

    expect((await store.snapshot()).entities).toEqual([
      { entityId: project, entityType: "Project" },
    ]);
    store.close();
  });

  it("rolls back entities added earlier in the batch when a dependent record references an unknown entity", async () => {
    const path = await databasePath();
    const store = new SQLiteSemanticStateStore({ path });
    const missing = "entity://person/missing" as const;

    await expect(store.append({
      entities: [{ entityId: project, entityType: "Project" }],
      aliases: [{
        id: "bad-alias",
        entityId: missing,
        value: "Missing",
        recordedAt: "2026-09-24T00:00:00Z",
      }],
    })).rejects.toBeInstanceOf(UnknownSemanticEntityError);

    expect((await store.snapshot()).entities).toEqual([]);
    store.close();
  });

  it("rolls back a batch when a relation endpoint is unknown", async () => {
    const path = await databasePath();
    const store = new SQLiteSemanticStateStore({ path });
    const missing = "entity://person/missing-relation-target" as const;

    await expect(store.append({
      entities: [{ entityId: project, entityType: "Project" }],
      relations: [{
        id: "bad-relation",
        from: project,
        to: missing,
        relationType: "Project.owner",
        validFrom: "2026-01-01T00:00:00Z",
        recordedAt: "2026-01-02T00:00:00Z",
      }],
    })).rejects.toBeInstanceOf(UnknownSemanticEntityError);

    expect((await store.snapshot()).entities).toEqual([]);
    store.close();
  });

  it("performs exact normalized alias lookup with typed entity and alias provenance", async () => {
    const path = await databasePath();
    const store = new SQLiteSemanticStateStore({ path });
    await store.append(baseBatch());

    const result = await store.lookupAlias("PROJECT---ATLAS");
    expect(result.normalizedValue).toBe("project atlas");
    expect(result.matches).toEqual([{
      entity: { entityId: project, entityType: "Project" },
      alias: {
        id: "alias-project-atlas",
        entityId: project,
        value: "Project Atlas",
        recordedAt: "2026-01-01T00:00:00.000Z",
        evidenceRefs: ["pm:atlas"],
      },
    }]);
    store.close();
  });

  it("returns entity-scoped observations and relations in deterministic temporal order", async () => {
    const path = await databasePath();
    const store = new SQLiteSemanticStateStore({ path });
    await store.append(baseBatch());

    expect((await store.observationsForEntity(project)).map((item) => item.id))
      .toEqual(["api-rest", "api-graphql"]);
    expect((await store.relationsFromEntity(project)).map((item) => item.id))
      .toEqual(["owner-deniz", "owner-alice"]);
    expect(await store.observationsForEntity(alice)).toEqual([
      expect.objectContaining({ id: "alice-timezone", entityId: alice }),
    ]);
    store.close();
  });

  it("round-trips nested StateValue through SQLite JSON TEXT without coercion", async () => {
    const path = await databasePath();
    const store = new SQLiteSemanticStateStore({ path });
    await store.append({
      entities: [{ entityId: project, entityType: "Project" }],
      observations: [{
        id: "complex",
        entityId: project,
        property: "Project.settings",
        value: {
          bool: false,
          number: 3.5,
          nil: null,
          list: ["x", 2, true],
          nested: { enabled: true },
        },
        source: { provider: "test", externalId: "complex" },
        validFrom: "2026-01-01T00:00:00Z",
        recordedAt: "2026-01-02T00:00:00Z",
      }],
    });

    expect((await store.observationsForEntity(project))[0]?.value).toEqual({
      bool: false,
      list: ["x", 2, true],
      nested: { enabled: true },
      nil: null,
      number: 3.5,
    });
    store.close();
  });

  it("rejects malformed stored semantic JSON instead of casting it", async () => {
    const path = await databasePath();
    const store = new SQLiteSemanticStateStore({ path });
    await store.append({
      entities: [{ entityId: project, entityType: "Project" }],
      observations: [apiObservation("api-rest", "REST", "2026-02-01T00:00:00Z")],
    });
    store.close();

    const raw = new DatabaseSync(path);
    raw.prepare(`
      UPDATE semantic_observations
      SET record_json = ?
      WHERE observation_id = ?
    `).run(JSON.stringify({ id: "api-rest", entityId: project }), "api-rest");
    raw.close();

    const reopened = new SQLiteSemanticStateStore({ path });
    await expect(reopened.snapshot()).rejects.toBeInstanceOf(CorruptSemanticStateError);
    reopened.close();
  });

  it("refuses to silently share the journal database in v1", async () => {
    const path = await databasePath();
    const journal = new SQLiteEventJournal({ path });
    journal.close();

    expect(() => new SQLiteSemanticStateStore({ path }))
      .toThrow(SharedSQLiteDatabaseNotSupportedError);
  });

  it("fails closed on a newer component-scoped schema without using PRAGMA user_version", async () => {
    const path = await databasePath();
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE semantic_state_meta (
        component TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL
      ) STRICT;
      INSERT INTO semantic_state_meta(component, schema_version)
      VALUES ('semantic-state-store', 99);
      PRAGMA user_version = 0;
    `);
    raw.close();

    expect(() => new SQLiteSemanticStateStore({ path }))
      .toThrow(UnsupportedSemanticStateSchemaError);

    const inspect = new DatabaseSync(path);
    expect(inspect.prepare("PRAGMA user_version").get()).toEqual(
      expect.objectContaining({ user_version: 0 }),
    );
    inspect.close();
  });

  it("hydrates bitemporal resolution and graph context from a reopened store", async () => {
    const path = await databasePath();
    const store = new SQLiteSemanticStateStore({ path });
    await store.append(baseBatch());
    store.close();

    const reopened = new SQLiteSemanticStateStore({ path });
    const snapshot = await reopened.snapshot();
    const projectObservations = await reopened.observationsForEntity(project);

    const march = resolveTemporalState({
      entityId: project,
      observations: projectObservations,
      validAt: "2026-03-01T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
      authority: [{ property: "Project.apiStyle", strategy: { kind: "provider", provider: "adr" } }],
    });
    const september = resolveTemporalState({
      entityId: project,
      observations: projectObservations,
      validAt: "2026-09-24T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
      authority: [{ property: "Project.apiStyle", strategy: { kind: "provider", provider: "adr" } }],
    });
    expect(march.canonical.properties["Project.apiStyle"]?.value).toBe("REST");
    expect(september.canonical.properties["Project.apiStyle"]?.value).toBe("GraphQL");

    const graph = new GraphContextCompiler({
      entityTypes: [
        { id: "Project", aliases: ["project", "proje"] },
        { id: "Person", aliases: ["person", "kişi"] },
      ],
      entities: typedEntitiesFromStateSnapshot(snapshot),
      relationTypes: [{ id: "Project.owner", aliases: ["owner", "sahibi"] }],
      relations: snapshot.relations,
      observations: snapshot.observations,
      properties: [{ property: "Person.timezone", aliases: ["timezone", "saat dilimi"] }],
      authorityByEntity: new Map([
        [oldOwner, [{ property: "Person.timezone", strategy: { kind: "provider", provider: "profile" } }]],
        [alice, [{ property: "Person.timezone", strategy: { kind: "provider", provider: "profile" } }]],
      ]),
    });

    const historical = graph.compile({
      query: "Project Atlas owner timezone?",
      budgetTokens: 160,
      validAt: "2026-03-01T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
    });
    const current = graph.compile({
      query: "Project Atlas owner timezone?",
      budgetTokens: 160,
      validAt: "2026-09-24T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
    });
    const historicalText = historical.records.map((record) => record.text).join("\n");
    const currentText = current.records.map((record) => record.text).join("\n");

    expect(historical.traversal.edgeIds).toEqual(["owner-deniz"]);
    expect(historicalText).toContain("America/New_York");
    expect(current.traversal.edgeIds).toEqual(["owner-alice"]);
    expect(currentText).toContain("Europe/Istanbul");
    reopened.close();
  });
});
