import { describe, expect, it } from "vitest";
import type {
  AuthorityRule,
  EntityTypeDescriptor,
  RelationTypeDescriptor,
  SemanticRetraction,
  TemporalObservation,
  TemporalRelationEdge,
  TypedEntity,
} from "@ssrl/core";
import {
  GraphContextCompiler,
  type ContextPropertyDescriptor,
  type ContextVisibilityPolicy,
} from "../src/index.js";

const project = "entity://project/atlas" as const;
const atlasPerson = "entity://person/atlas" as const;
const alice = "entity://person/alice" as const;
const robot = "entity://robot/orion" as const;

const entityTypeRows: readonly (readonly [string, ...string[]])[] = [
  ["Project", "project", "proje", "projesi", "projesinin"],
  ["Person", "person", "kişi", "kişisi", "kişisinin"],
  ["Robot", "robot"],
];
const entityTypes: readonly EntityTypeDescriptor[] = entityTypeRows
  .map(([id, ...aliases]) => ({ id, aliases }));

const entities: readonly TypedEntity[] = [
  {
    id: project,
    type: "Project",
    aliases: [{ value: "Project Atlas" }, { value: "Atlas" }],
  },
  {
    id: atlasPerson,
    type: "Person",
    aliases: [{ value: "Atlas person" }, { value: "Atlas" }],
  },
  {
    id: alice,
    type: "Person",
    aliases: [{ value: "Alice" }],
  },
  {
    id: robot,
    type: "Robot",
    aliases: [{ value: "Orion" }],
  },
];

const relationTypes: readonly RelationTypeDescriptor[] = [
  { id: "Project.owner", aliases: ["owner", "sahip", "sahibi", "sahibinin"] },
  { id: "Project.robot", aliases: ["robot", "cihaz"] },
];

const properties: readonly ContextPropertyDescriptor[] = [
  { property: "Project.ownerEntityId", aliases: ["owner", "sahip", "sahibi"] },
  { property: "Person.timezone", aliases: ["timezone", "saat dilimi", "saat diliminde"] },
  { property: "Person.employer", aliases: ["employer", "işveren", "işvereni"] },
  { property: "Robot.status", aliases: ["status", "durum"] },
];

function temporal(
  id: string,
  entityId: typeof project | typeof atlasPerson | typeof alice | typeof robot,
  property: string,
  value: string,
  provider: string,
): TemporalObservation {
  return {
    id,
    entityId,
    property,
    value,
    source: { provider, externalId: id },
    validFrom: "2026-01-01T00:00:00Z",
    recordedAt: "2026-01-02T00:00:00Z",
  };
}

const observations: readonly TemporalObservation[] = [
  {
    ...temporal("project-owner-old", project, "Project.ownerEntityId", atlasPerson, "directory"),
    validTo: "2026-08-01T00:00:00Z",
  },
  {
    ...temporal("project-owner", project, "Project.ownerEntityId", alice, "directory"),
    validFrom: "2026-08-01T00:00:00Z",
  },
  temporal("alice-timezone", alice, "Person.timezone", "Europe/Istanbul", "profile"),
  temporal("atlas-person-timezone", atlasPerson, "Person.timezone", "America/New_York", "profile"),
  temporal("atlas-employer", atlasPerson, "Person.employer", "Acme Robotics", "profile"),
  temporal("orion-status", robot, "Robot.status", "charging", "robot-registry"),
];

const relations: readonly TemporalRelationEdge[] = [
  {
    id: "atlas-owner-old",
    from: project,
    to: atlasPerson,
    relationType: "Project.owner",
    validFrom: "2026-01-01T00:00:00Z",
    validTo: "2026-08-01T00:00:00Z",
    recordedAt: "2026-01-02T00:00:00Z",
    evidenceRefs: ["directory:atlas-owner-old"],
  },
  {
    id: "atlas-owner-alice",
    from: project,
    to: alice,
    relationType: "Project.owner",
    validFrom: "2026-08-01T00:00:00Z",
    recordedAt: "2026-08-02T00:00:00Z",
    evidenceRefs: ["directory:atlas-owner"],
  },
  {
    id: "atlas-robot-orion",
    from: project,
    to: robot,
    relationType: "Project.robot",
    validFrom: "2026-01-01T00:00:00Z",
    recordedAt: "2026-01-02T00:00:00Z",
  },
];

const authorityByEntity: ReadonlyMap<string, readonly AuthorityRule[]> = new Map([
  [project, [{ property: "Project.ownerEntityId", strategy: { kind: "provider", provider: "directory" } }]],
  [alice, [{ property: "Person.timezone", strategy: { kind: "provider", provider: "profile" } }]],
  [atlasPerson, [{ property: "Person.employer", strategy: { kind: "provider", provider: "profile" } }]],
]);

function compiler(options: {
  readonly visibility?: ContextVisibilityPolicy;
  readonly maxRelationEdges?: number;
  readonly retractions?: readonly SemanticRetraction[];
} = {}) {
  return new GraphContextCompiler({
    entityTypes,
    entities,
    relationTypes,
    relations,
    observations,
    properties,
    authorityByEntity: authorityByEntity as ReadonlyMap<`entity://${string}`, readonly AuthorityRule[]>,
    ...options,
  });
}

const current = {
  validAt: "2026-09-24T00:00:00Z",
  knownAt: "2026-09-24T00:00:00Z",
};

describe("GraphContextCompiler", () => {
  it("compiles Project -> owner -> timezone through one policy-visible hop", () => {
    const result = compiler().compile({
      query: "Atlas projesinin sahibi kim ve sahibi hangi saat diliminde?",
      budgetTokens: 160,
      ...current,
    });
    const text = result.records.map((record) => record.text).join("\n");

    expect(result.entityResolution.status).toBe("resolved");
    expect(result.resolvedEntityIds).toEqual([project]);
    expect(result.traversal.edgeIds).toContain("atlas-owner-alice");
    expect(result.traversal.relatedEntityIds).toContain(alice);
    expect(text).toContain("Alice");
    expect(text).toContain("Europe/Istanbul");
    expect(result.estimatedTokens).toBeLessThanOrEqual(160);
  });

  it("uses the relation and state that were valid at the requested historical time", () => {
    const result = compiler().compile({
      query: "2026 Mart ayında Atlas projesinin sahibi kim ve hangi saat dilimindeydi?",
      budgetTokens: 180,
      validAt: "2026-03-01T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
    });
    const text = result.records.map((record) => record.text).join("\n");

    expect(result.traversal.edgeIds).toContain("atlas-owner-old");
    expect(result.traversal.edgeIds).not.toContain("atlas-owner-alice");
    expect(result.traversal.relatedEntityIds).toContain(atlasPerson);
    expect(text).toContain("America/New_York");
    expect(text).not.toContain("Europe/Istanbul");
  });

  it("uses typed identity cues to compile the person named Atlas instead of the project", () => {
    const result = compiler().compile({
      query: "Atlas kişisinin işvereni nedir?",
      budgetTokens: 100,
      ...current,
    });
    const text = result.records.map((record) => record.text).join("\n");

    expect(result.entityResolution.status).toBe("resolved");
    expect(result.resolvedEntityIds).toEqual([atlasPerson]);
    expect(result.traversal.traversedEdges).toBe(0);
    expect(text).toContain("Acme Robotics");
    expect(text).not.toContain("Europe/Istanbul");
  });

  it("returns an ambiguity state and no context for a bare shared alias", () => {
    const result = compiler().compile({
      query: "Atlas",
      budgetTokens: 100,
      ...current,
    });

    expect(result.entityResolution.status).toBe("ambiguous");
    expect(result.records).toEqual([]);
    expect(result.traversal.traversedEdges).toBe(0);
  });

  it("does not traverse a relation that is retracted at the requested valid/known time", () => {
    const result = compiler({
      retractions: [{
        id: "retract-owner-alice",
        targetKind: "relation",
        targetId: "atlas-owner-alice",
        effectiveFrom: "2026-09-01T00:00:00Z",
        recordedAt: "2026-09-02T00:00:00Z",
      }],
    }).compile({
      query: "Atlas projesinin sahibi kim ve sahibi hangi saat diliminde?",
      budgetTokens: 160,
      ...current,
    });
    const text = result.records.map((record) => record.text).join("\n");

    expect(result.traversal.edgeIds).not.toContain("atlas-owner-alice");
    expect(result.traversal.relatedEntityIds).not.toContain(alice);
    expect(text).not.toContain("Alice");
    expect(text).not.toContain("Europe/Istanbul");
  });

  it("does not traverse into a policy-denied related entity", () => {
    const visibility: ContextVisibilityPolicy = {
      allow(request) {
        return request.kind !== "entity" || request.entityId !== alice;
      },
    };
    const result = compiler({ visibility }).compile({
      query: "Atlas projesinin sahibi hangi saat diliminde?",
      budgetTokens: 160,
      ...current,
    });
    const serialized = JSON.stringify(result);

    expect(result.traversal.edgeIds).not.toContain("atlas-owner-alice");
    expect(serialized).not.toContain("Europe/Istanbul");
    expect(serialized).not.toContain("alice-timezone");
    expect(serialized).not.toContain(alice);
  });

  it("can traverse a visible relation while filtering a denied target property", () => {
    const visibility: ContextVisibilityPolicy = {
      allow(request) {
        return request.kind !== "property" || request.property !== "Person.timezone";
      },
    };
    const result = compiler({ visibility }).compile({
      query: "Atlas projesinin sahibi kim ve sahibi hangi saat diliminde?",
      budgetTokens: 160,
      ...current,
    });
    const serialized = JSON.stringify(result);

    expect(result.traversal.edgeIds).toContain("atlas-owner-alice");
    expect(serialized).toContain("Alice");
    expect(serialized).not.toContain("Europe/Istanbul");
    expect(serialized).not.toContain("alice-timezone");
  });

  it("bounds relation traversal and exposes candidate/traversal/token metrics", () => {
    const result = compiler({ maxRelationEdges: 1 }).compile({
      query: "Atlas projesinin sahibi ve robot durumu nedir?",
      budgetTokens: 120,
      ...current,
    });

    expect(result.traversal.candidateEdges).toBe(2);
    expect(result.traversal.traversedEdges).toBe(1);
    expect(result.traversal.edgeIds).toHaveLength(1);
    expect(result.traversal.candidateRecords).toBeGreaterThan(0);
    expect(result.traversal.relationTraversalTokens).toBeGreaterThan(0);
    expect(result.traversal.relationTraversalTokens).toBeLessThanOrEqual(120);
    expect(result.traversal.outputTokens).toBe(result.estimatedTokens);
    expect(result.estimatedTokens).toBeLessThanOrEqual(120);
  });

  it("suppresses nested state values that reference a denied entity", () => {
    const nestedObservations: readonly TemporalObservation[] = [
      ...observations,
      {
        id: "project-reviewers",
        entityId: project,
        property: "Project.reviewers",
        value: { primary: alice, backups: [atlasPerson] },
        source: { provider: "directory", externalId: "reviewers" },
        validFrom: "2026-01-01T00:00:00Z",
        recordedAt: "2026-01-02T00:00:00Z",
      },
    ];
    const visibility: ContextVisibilityPolicy = {
      allow(request) {
        return request.kind !== "entity" || request.entityId !== alice;
      },
    };
    const graph = new GraphContextCompiler({
      entityTypes,
      entities,
      relationTypes,
      relations,
      observations: nestedObservations,
      properties: [
        ...properties,
        { property: "Project.reviewers", aliases: ["reviewers", "inceleyenler"] },
      ],
      visibility,
    });
    const result = graph.compile({
      query: "Atlas projesinin reviewers bilgisi nedir?",
      budgetTokens: 160,
      ...current,
    });

    expect(JSON.stringify(result)).not.toContain(alice);
  });

  it("rejects duplicate retraction ids even when they target different entities or record kinds", () => {
    expect(() => compiler({
      retractions: [
        {
          id: "duplicate-retraction",
          targetKind: "relation",
          targetId: "atlas-owner-alice",
          effectiveFrom: "2026-09-01T00:00:00Z",
          recordedAt: "2026-09-02T00:00:00Z",
        },
        {
          id: "duplicate-retraction",
          targetKind: "observation",
          targetId: "alice-timezone",
          effectiveFrom: "2026-09-01T00:00:00Z",
          recordedAt: "2026-09-02T00:00:00Z",
        },
      ],
    })).toThrow(/Duplicate semantic retraction id/);
  });

  it("rejects invalid graph bounds during construction", () => {
    expect(() => compiler({ maxRelationEdges: -1 })).toThrow(/non-negative integer/);
  });

  it("skips relation traversal when the relation record cannot fit the token budget", () => {
    const result = compiler().compile({
      query: "Atlas projesinin sahibi kim?",
      budgetTokens: 1,
      ...current,
    });

    expect(result.traversal.candidateEdges).toBeGreaterThan(0);
    expect(result.traversal.traversedEdges).toBe(0);
    expect(result.traversal.relationTraversalTokens).toBe(0);
    expect(result.estimatedTokens).toBeLessThanOrEqual(1);
  });

  it("never exposes a policy-denied direct entity through ambiguity candidates", () => {
    const visibility: ContextVisibilityPolicy = {
      allow(request) {
        return request.kind !== "entity" || request.entityId !== atlasPerson;
      },
    };
    const result = compiler({ visibility }).compile({
      query: "Atlas",
      budgetTokens: 100,
      ...current,
    });

    expect(result.entityResolution.status).toBe("resolved");
    if (result.entityResolution.status !== "resolved") {
      throw new Error("expected one visible Atlas entity");
    }
    expect(result.entityResolution.entityId).toBe(project);
    expect(JSON.stringify(result.entityResolution)).not.toContain(atlasPerson);
  });
});
