import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccessPrincipal } from "@ssrl/access";
import type {
  EntityId,
  SemanticRetraction,
} from "@ssrl/core";
import {
  ContextCapsuleMaterializer,
  ContextCapsuleSyncLimitError,
  IncrementalContextCapsuleSynchronizer,
  IncrementalContextCapsuleWorker,
  InMemoryContextCapsuleStore,
  type CapsuleWriteResult,
  type ContextCapsule,
  type ContextCapsuleStore,
} from "@ssrl/materializer";
import type {
  AliasLookupResult,
  EntityAliasRecord,
  SemanticAppendCounts,
  SemanticChangeCursor,
  SemanticChangePage,
  SemanticEntity,
  SemanticStateBatch,
  SemanticStateSnapshot,
  SemanticStateStore,
} from "@ssrl/state-store";
import { SQLiteSemanticStateStore } from "@ssrl/storage-sqlite";
import {
  ContextAccessDeniedError,
  ContextAccessGateway,
  ContextAccessSynchronizationLimitError,
  ContextIdentityCandidateLimitError,
  ContextRelationCandidateLimitError,
  HistoricalContextAccessUnsupportedError,
  type ContextAccessEvent,
  type ContextAccessGatewayOptions,
  type ContextAccessPolicy,
  type ContextAccessRequest,
} from "../src/index.js";

const roots: string[] = [];
const project = "entity://project/atlas" as const;
const atlasPerson = "entity://person/atlas" as const;
const alice = "entity://person/alice" as const;
const bob = "entity://person/bob" as const;
const principal: AccessPrincipal = {
  subject: "user:alice",
  scopes: ["context:read"],
};

async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ssrl-context-access-"));
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
      { entityId: atlasPerson, entityType: "Person" },
      { entityId: alice, entityType: "Person" },
      { entityId: bob, entityType: "Person" },
    ],
    aliases: [
      { id: "alias-project-atlas", entityId: project, value: "Project Atlas", recordedAt: "2026-01-01T00:00:00Z" },
      { id: "alias-project-short", entityId: project, value: "Atlas", recordedAt: "2026-01-01T00:00:00Z" },
      { id: "alias-person-atlas", entityId: atlasPerson, value: "Atlas Person", recordedAt: "2026-01-01T00:00:00Z" },
      { id: "alias-person-short", entityId: atlasPerson, value: "Atlas", recordedAt: "2026-01-01T00:00:00Z" },
      { id: "alias-alice", entityId: alice, value: "Alice", recordedAt: "2026-01-01T00:00:00Z" },
      { id: "alias-bob", entityId: bob, value: "Bob", recordedAt: "2026-01-01T00:00:00Z" },
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
        id: "project-secret",
        entityId: project,
        property: "Project.secret",
        value: "launch-code-7391",
        source: { provider: "private", externalId: "atlas-secret" },
        validFrom: "2026-01-01T00:00:00Z",
        recordedAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "project-reviewers",
        entityId: project,
        property: "Project.reviewers",
        value: { primary: alice, backup: bob },
        source: { provider: "directory", externalId: "atlas-reviewers" },
        validFrom: "2026-01-01T00:00:00Z",
        recordedAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "person-employer",
        entityId: atlasPerson,
        property: "Person.employer",
        value: "Acme Robotics",
        source: { provider: "profile", externalId: "atlas-person" },
        validFrom: "2026-01-01T00:00:00Z",
        recordedAt: "2026-01-01T00:00:00Z",
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
      {
        id: "bob-timezone",
        entityId: bob,
        property: "Person.timezone",
        value: "Europe/London",
        source: { provider: "profile", externalId: "bob" },
        validFrom: "2026-01-01T00:00:00Z",
        recordedAt: "2026-01-01T00:00:00Z",
      },
    ],
    relations: [
      {
        id: "owner-alice",
        from: project,
        to: alice,
        relationType: "Project.owner",
        validFrom: "2026-01-01T00:00:00Z",
        recordedAt: "2026-01-01T00:00:00Z",
        evidenceRefs: ["directory:owner"],
      },
      {
        id: "reviewer-bob",
        from: project,
        to: bob,
        relationType: "Project.reviewer",
        validFrom: "2026-01-01T00:00:00Z",
        recordedAt: "2026-01-01T00:00:00Z",
        evidenceRefs: ["directory:reviewer"],
      },
    ],
  };
}

class NoSnapshotSemanticStore implements SemanticStateStore {
  snapshotCalls = 0;

  constructor(readonly inner: SemanticStateStore) {}

  append(batch: SemanticStateBatch): Promise<SemanticAppendCounts> {
    return this.inner.append(batch);
  }

  snapshot(): Promise<SemanticStateSnapshot> {
    this.snapshotCalls += 1;
    throw new Error("snapshot must not be used by context access query path");
  }

  entity(entityId: EntityId): Promise<SemanticEntity | undefined> {
    return this.inner.entity(entityId);
  }

  aliasesForEntity(entityId: EntityId): Promise<readonly EntityAliasRecord[]> {
    return this.inner.aliasesForEntity(entityId);
  }

  observationsForEntity(entityId: EntityId) {
    return this.inner.observationsForEntity(entityId);
  }

  relationsFromEntity(entityId: EntityId) {
    return this.inner.relationsFromEntity(entityId);
  }

  retractionsForEntity(entityId: EntityId): Promise<readonly SemanticRetraction[]> {
    return this.inner.retractionsForEntity(entityId);
  }

  lookupAlias(value: string): Promise<AliasLookupResult> {
    return this.inner.lookupAlias(value);
  }

  changesAfter(cursor?: SemanticChangeCursor, limit?: number): Promise<SemanticChangePage> {
    return this.inner.changesAfter(cursor, limit);
  }
}

class CountingCapsuleStore implements ContextCapsuleStore {
  readonly inner = new InMemoryContextCapsuleStore();
  readonly getCalls: EntityId[] = [];

  async get(entityId: EntityId): Promise<ContextCapsule | undefined> {
    this.getCalls.push(entityId);
    return this.inner.get(entityId);
  }

  search(query: string, limit: number): Promise<readonly ContextCapsule[]> {
    return this.inner.search(query, limit);
  }

  put(capsule: ContextCapsule): Promise<CapsuleWriteResult> {
    return this.inner.put(capsule);
  }

  delete(entityId: EntityId): Promise<boolean> {
    return this.inner.delete(entityId);
  }

  checkpoint(): Promise<SemanticChangeCursor | undefined> {
    return this.inner.checkpoint();
  }

  setCheckpoint(cursor: SemanticChangeCursor): Promise<void> {
    return this.inner.setCheckpoint(cursor);
  }

  staleEntityIds(at: string, configurationVersion: string): Promise<readonly EntityId[]> {
    return this.inner.staleEntityIds(at, configurationVersion);
  }
}

interface PolicyOptions {
  readonly denyEntities?: readonly EntityId[];
  readonly denyProperties?: readonly string[];
  readonly denyRelations?: readonly string[];
  readonly denyProvenance?: boolean;
  readonly undefinedKinds?: readonly ContextAccessRequest["kind"][];
}

function allowPolicy(options: PolicyOptions = {}): ContextAccessPolicy {
  const deniedEntities = new Set(options.denyEntities ?? []);
  const deniedProperties = new Set(options.denyProperties ?? []);
  const deniedRelations = new Set(options.denyRelations ?? []);
  const undefinedKinds = new Set(options.undefinedKinds ?? []);
  return {
    evaluate(request) {
      if (undefinedKinds.has(request.kind)) return undefined;
      if (request.kind === "operation") {
        return request.principal.scopes.includes("context:read")
          ? { effect: "allow" }
          : { effect: "deny", code: "context-read-scope-required" };
      }
      if (request.kind === "entity" && deniedEntities.has(request.entityId)) {
        return { effect: "deny", code: "entity-denied" };
      }
      if (request.kind === "property" && deniedProperties.has(request.property)) {
        return { effect: "deny", code: "property-denied" };
      }
      if (request.kind === "relation" && deniedRelations.has(request.edgeId)) {
        return { effect: "deny", code: "relation-denied" };
      }
      if (request.kind === "provenance" && options.denyProvenance === true) {
        return { effect: "deny", code: "provenance-denied" };
      }
      return { effect: "allow" };
    },
  };
}

function authorityByEntity() {
  return new Map<EntityId, readonly {
    property: string;
    strategy: { kind: "provider"; provider: string };
  }[]>([
    [project, [
      { property: "Project.apiStyle", strategy: { kind: "provider", provider: "adr" } },
      { property: "Project.secret", strategy: { kind: "provider", provider: "private" } },
      { property: "Project.reviewers", strategy: { kind: "provider", provider: "directory" } },
    ]],
    [atlasPerson, [{ property: "Person.employer", strategy: { kind: "provider", provider: "profile" } }]],
    [alice, [{ property: "Person.timezone", strategy: { kind: "provider", provider: "profile" } }]],
    [bob, [{ property: "Person.timezone", strategy: { kind: "provider", provider: "profile" } }]],
  ]);
}

const entityTypes = [
  { id: "Project", aliases: ["project", "proje", "projesi", "projesinin"] },
  { id: "Person", aliases: ["person", "kişi", "kişisi", "kişisinin"] },
] as const;

const relationTypes = [
  { id: "Project.owner", aliases: ["owner", "owns", "sahibi"] },
  { id: "Project.reviewer", aliases: ["reviewer", "reviewers"] },
] as const;

const properties = [
  { property: "Project.apiStyle", aliases: ["api", "api style"] },
  { property: "Project.secret", aliases: ["secret"] },
  { property: "Project.reviewers", aliases: ["reviewers"] },
  { property: "Person.employer", aliases: ["employer"] },
  { property: "Person.timezone", aliases: ["timezone", "saat dilimi"] },
] as const;

type GatewayFixtureOptions = Pick<
  ContextAccessGatewayOptions,
  | "policy"
  | "maxBudgetTokens"
  | "maxIdentityCandidates"
  | "maxIdentityScans"
  | "maxRelationCandidates"
  | "maxRelationScans"
  | "maxRelationEdges"
  | "now"
> & {
  readonly syncPageSize?: number;
  readonly syncMaxPages?: number;
  readonly events?: ContextAccessEvent[];
};

async function gatewayFixture(options: GatewayFixtureOptions = {}) {
  const path = await databasePath();
  const sqlite = new SQLiteSemanticStateStore({ path });
  await sqlite.append(baseBatch());
  const state = new NoSnapshotSemanticStore(sqlite);
  const cache = new CountingCapsuleStore();
  const materializer = new ContextCapsuleMaterializer({
    stateStore: state,
    authorityByEntity: authorityByEntity(),
    configurationVersion: "context-access-test-v1",
  });
  const worker = new IncrementalContextCapsuleWorker({
    stateStore: state,
    capsuleStore: cache,
    materializer,
  });
  const synchronizer = new IncrementalContextCapsuleSynchronizer({
    worker,
    pageSize: options.syncPageSize ?? 100,
    maxPages: options.syncMaxPages ?? 100,
  });
  const eventSink = options.events === undefined
    ? undefined
    : { emit(event: ContextAccessEvent) { options.events!.push(event); } };
  const gateway = new ContextAccessGateway({
    capsules: cache,
    synchronizer,
    entityTypes,
    relationTypes,
    properties,
    policy: options.policy ?? allowPolicy(),
    ...(eventSink === undefined ? {} : { events: eventSink }),
    ...(options.maxBudgetTokens === undefined ? {} : { maxBudgetTokens: options.maxBudgetTokens }),
    ...(options.maxIdentityCandidates === undefined ? {} : { maxIdentityCandidates: options.maxIdentityCandidates }),
    ...(options.maxIdentityScans === undefined ? {} : { maxIdentityScans: options.maxIdentityScans }),
    ...(options.maxRelationCandidates === undefined ? {} : { maxRelationCandidates: options.maxRelationCandidates }),
    ...(options.maxRelationScans === undefined ? {} : { maxRelationScans: options.maxRelationScans }),
    ...(options.maxRelationEdges === undefined ? {} : { maxRelationEdges: options.maxRelationEdges }),
    now: options.now ?? (() => "2026-09-24T00:00:00Z"),
  });
  return { sqlite, state, cache, gateway };
}

function contextText(result: Awaited<ReturnType<ContextAccessGateway["compile"]>>): string {
  return result.context.records.map((record) => record.text).join("\n");
}


async function compileOwnerScenario(policy: ContextAccessPolicy) {
  const { sqlite, cache, gateway } = await gatewayFixture({ policy });
  const result = await gateway.compile({
    principal,
    task: "Project Atlas owner timezone",
    budgetTokens: 180,
  });
  return { sqlite, cache, result };
}


function expectOwnerNotExpanded(
  cache: CountingCapsuleStore,
  result: Awaited<ReturnType<ContextAccessGateway["compile"]>>,
): void {
  expect(result.relatedEntityIds).toEqual([]);
  expect(cache.getCalls).not.toContain(alice);
  expect(contextText(result)).not.toContain("Alice");
}

describe("ContextAccessGateway", () => {
  it("compiles allowed direct + one-hop related capsule context without a semantic snapshot", async () => {
    const { sqlite, state, gateway } = await gatewayFixture();
    const result = await gateway.compile({
      principal,
      task: "Project Atlas owner timezone",
      budgetTokens: 220,
    });
    const text = contextText(result);

    expect(result.resolution).toEqual({ status: "resolved", entityId: project, entityType: "Project" });
    expect(result.relatedEntityIds).toEqual([alice]);
    expect(text).toContain("Alice");
    expect(text).toContain("Europe/Istanbul");
    expect(result.context.estimatedTokens).toBeLessThanOrEqual(220);
    expect(state.snapshotCalls).toBe(0);
    sqlite.close();
  });

  it("filters denied homonym entities before identity resolution and visible candidate bounds", async () => {
    const { sqlite, gateway } = await gatewayFixture({
      policy: allowPolicy({ denyEntities: [atlasPerson] }),
      maxIdentityCandidates: 1,
      maxIdentityScans: 10,
    });
    const result = await gateway.compile({
      principal,
      task: "Atlas project API style",
      budgetTokens: 160,
    });

    expect(result.resolution).toEqual({ status: "resolved", entityId: project, entityType: "Project" });
    expect(contextText(result)).toContain("GraphQL");
    sqlite.close();
  });

  it("never exposes a denied direct entity's state through a shared alias", async () => {
    const { sqlite, gateway } = await gatewayFixture({
      policy: allowPolicy({ denyEntities: [project] }),
    });
    const result = await gateway.compile({
      principal,
      task: "Project Atlas secret API GraphQL",
      budgetTokens: 180,
    });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(project);
    expect(serialized).not.toContain("GraphQL");
    expect(serialized).not.toContain("launch-code-7391");
    sqlite.close();
  });

  it("denies a related entity before fetching or traversing its capsule", async () => {
    const { sqlite, cache, result } = await compileOwnerScenario(
      allowPolicy({ denyEntities: [alice] }),
    );

    expectOwnerNotExpanded(cache, result);
    expect(contextText(result)).not.toContain("Europe/Istanbul");
    sqlite.close();
  });

  it("removes denied properties before projection and ranking", async () => {
    const { sqlite, gateway } = await gatewayFixture({
      policy: allowPolicy({ denyProperties: ["Project.secret"] }),
    });
    const result = await gateway.compile({
      principal,
      task: "Project Atlas secret API style",
      budgetTokens: 200,
    });

    expect(contextText(result)).toContain("GraphQL");
    expect(contextText(result)).not.toContain("launch-code-7391");
    sqlite.close();
  });

  it("suppresses a structured property that contains a denied nested entity reference", async () => {
    const { sqlite, gateway } = await gatewayFixture({
      policy: allowPolicy({ denyEntities: [bob] }),
    });
    const result = await gateway.compile({
      principal,
      task: "Project Atlas reviewers",
      budgetTokens: 200,
    });
    const serialized = JSON.stringify(result.context.records);

    expect(serialized).not.toContain("Project reviewers");
    expect(serialized).not.toContain(bob);
    sqlite.close();
  });

  it("filters denied relations before related capsule fetch and context projection", async () => {
    const { sqlite, cache, result } = await compileOwnerScenario(
      allowPolicy({ denyRelations: ["owner-alice"] }),
    );

    expectOwnerNotExpanded(cache, result);
    sqlite.close();
  });

  it("strips denied provenance refs without removing authorized semantic text", async () => {
    const { sqlite, gateway } = await gatewayFixture({
      policy: allowPolicy({ denyProvenance: true }),
    });
    const result = await gateway.compile({
      principal,
      task: "Project Atlas owner timezone API style",
      budgetTokens: 240,
    });

    expect(contextText(result)).toContain("GraphQL");
    expect(contextText(result)).toContain("Europe/Istanbul");
    expect(result.context.records.every((record) => record.evidenceRefs === undefined)).toBe(true);
    sqlite.close();
  });

  it("fails closed for undefined operation policy decisions and missing principals", async () => {
    const undefinedPolicy = await gatewayFixture({
      policy: allowPolicy({ undefinedKinds: ["operation"] }),
    });
    await expect(undefinedPolicy.gateway.compile({
      principal,
      task: "Project Atlas",
      budgetTokens: 80,
    })).rejects.toMatchObject({
      name: "ContextAccessDeniedError",
      code: "no-matching-policy-rule",
    });
    undefinedPolicy.sqlite.close();

    const missingPrincipal = await gatewayFixture();
    await expect(missingPrincipal.gateway.compile({
      task: "Project Atlas",
      budgetTokens: 80,
    })).rejects.toBeInstanceOf(ContextAccessDeniedError);
    missingPrincipal.sqlite.close();
  });

  it("enforces token, identity-candidate, and relation-candidate bounds", async () => {
    const budget = await gatewayFixture({ maxBudgetTokens: 100 });
    await expect(budget.gateway.compile({
      principal,
      task: "Project Atlas",
      budgetTokens: 101,
    })).rejects.toThrow(/must not exceed 100/);
    budget.sqlite.close();

    const identity = await gatewayFixture({ maxIdentityCandidates: 1, maxIdentityScans: 10 });
    await expect(identity.gateway.compile({
      principal,
      task: "Atlas",
      budgetTokens: 80,
    })).rejects.toBeInstanceOf(ContextIdentityCandidateLimitError);
    identity.sqlite.close();

    const relations = await gatewayFixture({
      maxRelationCandidates: 1,
      maxRelationScans: 10,
      maxRelationEdges: 1,
    });
    await expect(relations.gateway.compile({
      principal,
      task: "Project Atlas owner reviewer Alice Bob",
      budgetTokens: 180,
    })).rejects.toBeInstanceOf(ContextRelationCandidateLimitError);
    relations.sqlite.close();
  });

  it("synchronizes time-stale capsules before search even when no semantic change occurs", async () => {
    let now = "2026-03-01T00:00:00Z";
    const { sqlite, gateway } = await gatewayFixture({ now: () => now });
    const march = await gateway.compile({
      principal,
      task: "Project Atlas API style",
      budgetTokens: 120,
    });
    expect(contextText(march)).toContain("REST");
    expect(contextText(march)).not.toContain("GraphQL");

    now = "2026-09-24T00:00:00Z";
    const september = await gateway.compile({
      principal,
      task: "Project Atlas API style",
      budgetTokens: 120,
    });
    expect(contextText(september)).toContain("GraphQL");
    expect(contextText(september)).not.toContain("REST");
    sqlite.close();
  });

  it("does not return stale context when bounded synchronization cannot catch up", async () => {
    const { sqlite, gateway } = await gatewayFixture({ syncPageSize: 1, syncMaxPages: 1 });
    await expect(gateway.compile({
      principal,
      task: "Project Atlas API style",
      budgetTokens: 120,
    })).rejects.toBeInstanceOf(ContextAccessSynchronizationLimitError);
    sqlite.close();
  });

  it("returns ambiguity metadata for visible candidates without aliases or evidence refs", async () => {
    const { sqlite, gateway } = await gatewayFixture();
    const result = await gateway.compile({
      principal,
      task: "Atlas",
      budgetTokens: 80,
    });
    const serialized = JSON.stringify(result.resolution);

    expect(result.resolution.status).toBe("ambiguous");
    expect(serialized).toContain(project);
    expect(serialized).toContain(atlasPerson);
    expect(serialized).not.toContain("evidenceRefs");
    expect(serialized).not.toContain("matchedAliases");
    expect(result.context.records).toEqual([]);
    sqlite.close();
  });

  it("audits compile metadata without raw task or context text", async () => {
    const events: ContextAccessEvent[] = [];
    const { sqlite, gateway } = await gatewayFixture({ events });
    await gateway.compile({
      principal: {
        subject: "  user:alice  ",
        scopes: ["context:read", "context:read"],
      },
      task: "Project Atlas owner timezone GraphQL secret task phrase",
      budgetTokens: 220,
    });
    const serialized = JSON.stringify(events);

    expect(events).toHaveLength(1);
    expect(serialized).not.toContain("Project Atlas");
    expect(serialized).not.toContain("GraphQL");
    expect(serialized).not.toContain("secret task phrase");
    expect(events[0]).toEqual(expect.objectContaining({
      operation: "compile",
      outcome: "allow",
      subject: "user:alice",
      resolvedEntityId: project,
    }));
    sqlite.close();
  });

  it("keeps retracted state out of context after incremental refresh", async () => {
    const { sqlite, state, gateway } = await gatewayFixture();
    const before = await gateway.compile({
      principal,
      task: "Project Atlas API style",
      budgetTokens: 120,
    });
    expect(contextText(before)).toContain("GraphQL");

    await state.append({
      retractions: [{
        id: "retract-graphql-context-access",
        targetKind: "observation",
        targetId: "api-graphql",
        effectiveFrom: "2026-09-01T00:00:00Z",
        recordedAt: "2026-09-02T00:00:00Z",
      }],
    });
    const after = await gateway.compile({
      principal,
      task: "Project Atlas API style",
      budgetTokens: 120,
    });
    expect(contextText(after)).not.toContain("GraphQL");
    sqlite.close();
  });

  it("rejects historical-as-of requests instead of treating current capsules as historical truth", async () => {
    const { sqlite, gateway } = await gatewayFixture();
    await expect(gateway.compile({
      principal,
      task: "Project Atlas API style",
      budgetTokens: 120,
      validAt: "2026-03-01T00:00:00Z",
      knownAt: "2026-03-01T00:00:00Z",
    })).rejects.toBeInstanceOf(HistoricalContextAccessUnsupportedError);
    sqlite.close();
  });
});
