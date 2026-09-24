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
  InvalidSemanticChangeCursorError,
  SemanticRecordCollisionError,
  UnknownSemanticEntityError,
  entityAliasJson,
  semanticEntityJson,
  temporalObservationJson,
  temporalRelationJson,
  typedEntitiesFromStateSnapshot,
  type SemanticChangeCursor,
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

function createV1Database(path: string): void {
  const raw = new DatabaseSync(path);
  raw.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE semantic_state_meta (
      component TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL
    ) STRICT;
    INSERT INTO semantic_state_meta(component, schema_version)
    VALUES ('semantic-state-store', 1);

    CREATE TABLE semantic_entities (
      entity_id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      record_json TEXT NOT NULL CHECK(json_valid(record_json))
    ) STRICT;
    CREATE TABLE semantic_aliases (
      alias_id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES semantic_entities(entity_id),
      alias_value TEXT NOT NULL,
      normalized_value TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      record_json TEXT NOT NULL CHECK(json_valid(record_json))
    ) STRICT;
    CREATE TABLE semantic_observations (
      observation_id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES semantic_entities(entity_id),
      property TEXT NOT NULL,
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      recorded_at TEXT NOT NULL,
      record_json TEXT NOT NULL CHECK(json_valid(record_json))
    ) STRICT;
    CREATE TABLE semantic_relations (
      relation_id TEXT PRIMARY KEY,
      from_entity_id TEXT NOT NULL REFERENCES semantic_entities(entity_id),
      to_entity_id TEXT NOT NULL REFERENCES semantic_entities(entity_id),
      relation_type TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      recorded_at TEXT NOT NULL,
      record_json TEXT NOT NULL CHECK(json_valid(record_json))
    ) STRICT;
  `);

  const projectEntity = { entityId: project, entityType: "Project" } as const;
  const aliceEntity = { entityId: alice, entityType: "Person" } as const;
  raw.prepare("INSERT INTO semantic_entities(entity_id, entity_type, record_json) VALUES (?, ?, ?)")
    .run(project, "Project", semanticEntityJson(projectEntity));
  raw.prepare("INSERT INTO semantic_entities(entity_id, entity_type, record_json) VALUES (?, ?, ?)")
    .run(alice, "Person", semanticEntityJson(aliceEntity));

  const alias = {
    id: "alias-project-atlas",
    entityId: project,
    value: "Project Atlas",
    recordedAt: "2026-01-01T00:00:00.000Z",
  } as const;
  raw.prepare(`
    INSERT INTO semantic_aliases(
      alias_id, entity_id, alias_value, normalized_value, recorded_at, record_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(alias.id, project, alias.value, "project atlas", alias.recordedAt, entityAliasJson(alias));

  const observation = apiObservation("api-rest", "REST", "2026-02-01T00:00:00Z");
  raw.prepare(`
    INSERT INTO semantic_observations(
      observation_id, entity_id, property, provider, external_id,
      valid_from, valid_to, recorded_at, record_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    observation.id,
    observation.entityId,
    observation.property,
    observation.source.provider,
    observation.source.externalId,
    "2026-02-01T00:00:00.000Z",
    null,
    "2026-02-01T00:00:00.000Z",
    temporalObservationJson(observation),
  );

  const relation = ownerRelation("owner-alice", alice, "2026-08-01T00:00:00Z");
  raw.prepare(`
    INSERT INTO semantic_relations(
      relation_id, from_entity_id, to_entity_id, relation_type,
      valid_from, valid_to, recorded_at, record_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    relation.id,
    relation.from,
    relation.to,
    relation.relationType,
    "2026-08-01T00:00:00.000Z",
    null,
    "2026-08-01T00:00:00.000Z",
    temporalRelationJson(relation),
  );
  raw.close();
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

  it("exposes entity-scoped entity and alias reads without a full snapshot", async () => {
    const path = await databasePath();
    const store = new SQLiteSemanticStateStore({ path });
    await store.append(baseBatch());

    expect(await store.entity(project)).toEqual({ entityId: project, entityType: "Project" });
    expect(await store.entity("entity://project/missing" as const)).toBeUndefined();
    expect((await store.aliasesForEntity(project)).map((item) => item.id))
      .toEqual(["alias-project-atlas"]);
    store.close();
  });

  it("emits deterministic durable changes only for actual inserts", async () => {
    const path = await databasePath();
    const store = new SQLiteSemanticStateStore({ path });
    await store.append(baseBatch());

    const page = await store.changesAfter(undefined, 100);
    expect(page.hasMore).toBe(false);
    expect(page.changes).toHaveLength(12);
    expect(page.changes.map((change) => `${change.kind}:${change.recordId}`)).toEqual([
      `entity:${alice}`,
      `entity:${oldOwner}`,
      `entity:${project}`,
      "alias:alias-alice",
      "alias:alias-old-owner",
      "alias:alias-project-atlas",
      "observation:alice-timezone",
      "observation:api-graphql",
      "observation:api-rest",
      "observation:deniz-timezone",
      "relation:owner-alice",
      "relation:owner-deniz",
    ]);
    const relationChange = page.changes.find((change) => change.recordId === "owner-alice");
    expect(relationChange?.primaryEntityId).toBe(project);
    expect(relationChange?.affectedEntityIds).toEqual([alice, project]);

    const cursor = page.nextCursor;
    expect(cursor).toBeDefined();
    await store.append(baseBatch());
    expect(await store.changesAfter(cursor)).toEqual({
      changes: [],
      nextCursor: cursor,
      hasMore: false,
    });
    store.close();
  });

  it("paginates and resumes a change cursor across close/reopen without duplicates", async () => {
    const path = await databasePath();
    const first = new SQLiteSemanticStateStore({ path });
    await first.append(baseBatch());
    const pageOne = await first.changesAfter(undefined, 5);
    expect(pageOne.changes).toHaveLength(5);
    expect(pageOne.hasMore).toBe(true);
    expect(pageOne.nextCursor).toBeDefined();
    first.close();

    const reopened = new SQLiteSemanticStateStore({ path });
    const pageTwo = await reopened.changesAfter(pageOne.nextCursor, 100);
    expect(pageTwo.changes).toHaveLength(7);
    expect(pageTwo.changes[0]?.recordId).toBe("alias-project-atlas");
    expect(new Set([
      ...pageOne.changes.map((change) => change.cursor),
      ...pageTwo.changes.map((change) => change.cursor),
    ]).size).toBe(12);
    reopened.close();
  });

  it("rolls back change rows together with a failed semantic transaction", async () => {
    const path = await databasePath();
    const store = new SQLiteSemanticStateStore({ path });
    await store.append({ entities: [{ entityId: project, entityType: "Project" }] });
    const before = await store.changesAfter();

    await expect(store.append({
      entities: [{ entityId: alice, entityType: "Person" }],
      aliases: [{
        id: "bad",
        entityId: "entity://person/missing" as const,
        value: "Missing",
        recordedAt: "2026-01-01T00:00:00Z",
      }],
    })).rejects.toBeInstanceOf(UnknownSemanticEntityError);

    expect(await store.changesAfter()).toEqual(before);
    store.close();
  });

  it("rejects malformed or foreign semantic change cursors", async () => {
    const path = await databasePath();
    const store = new SQLiteSemanticStateStore({ path });
    await expect(store.changesAfter("not-a-cursor" as SemanticChangeCursor)).rejects
      .toBeInstanceOf(InvalidSemanticChangeCursorError);
    store.close();
  });

  it("rejects a cursor from another semantic-state database", async () => {
    const firstPath = await databasePath();
    const secondPath = await databasePath();
    const first = new SQLiteSemanticStateStore({ path: firstPath });
    const second = new SQLiteSemanticStateStore({ path: secondPath });
    await first.append({ entities: [{ entityId: project, entityType: "Project" }] });
    await second.append({ entities: [{ entityId: project, entityType: "Project" }] });
    const foreignCursor = (await first.changesAfter()).nextCursor;
    expect(foreignCursor).toBeDefined();

    await expect(second.changesAfter(foreignCursor)).rejects
      .toBeInstanceOf(InvalidSemanticChangeCursorError);
    first.close();
    second.close();
  });

  it("rejects a syntactically valid cursor sequence that was never emitted", async () => {
    const path = await databasePath();
    const store = new SQLiteSemanticStateStore({ path });
    await store.append({ entities: [{ entityId: project, entityType: "Project" }] });
    const cursor = (await store.changesAfter()).nextCursor;
    expect(cursor).toBeDefined();
    const unknown = cursor!.replace(/:\d+$/, ":999999") as SemanticChangeCursor;

    await expect(store.changesAfter(unknown)).rejects
      .toBeInstanceOf(InvalidSemanticChangeCursorError);
    store.close();
  });

  it("migrates a v1 state database and bootstraps a deterministic change feed", async () => {
    const path = await databasePath();
    createV1Database(path);

    const store = new SQLiteSemanticStateStore({ path });
    const page = await store.changesAfter(undefined, 100);
    expect(page.changes.map((change) => `${change.kind}:${change.recordId}`)).toEqual([
      `entity:${alice}`,
      `entity:${project}`,
      "alias:alias-project-atlas",
      "observation:api-rest",
      "relation:owner-alice",
    ]);
    expect(page.changes.at(-1)?.affectedEntityIds).toEqual([alice, project]);
    expect((await store.snapshot()).entities).toHaveLength(2);
    store.close();

    const raw = new DatabaseSync(path);
    expect(raw.prepare(`
      SELECT schema_version FROM semantic_state_meta WHERE component = 'semantic-state-store'
    `).get()).toEqual(expect.objectContaining({ schema_version: 2 }));
    raw.close();
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
