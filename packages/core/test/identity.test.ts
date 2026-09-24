import { describe, expect, it } from "vitest";
import {
  TypedEntityResolver,
  activeRelationEdges,
  resolveActiveRelationEdges,
  type EntityTypeDescriptor,
  type TemporalRelationEdge,
  type TypedEntity,
} from "../src/identity.js";
import type { SemanticRetraction } from "../src/retraction.js";

const project = "entity://project/atlas" as const;
const person = "entity://person/atlas" as const;
const alice = "entity://person/alice" as const;

const types: readonly EntityTypeDescriptor[] = [
  { id: "Project", aliases: ["project", "proje", "projesi", "projesinin"] },
  { id: "Person", aliases: ["person", "kişi", "kişisi", "kişisinin"] },
];

const entities: readonly TypedEntity[] = [
  {
    id: project,
    type: "Project",
    aliases: [
      { value: "Project Atlas", evidenceRefs: ["source:project-system"] },
      { value: "Atlas" },
    ],
  },
  {
    id: person,
    type: "Person",
    aliases: [
      { value: "Atlas person" },
      { value: "Atlas", evidenceRefs: ["source:contacts"] },
    ],
  },
  {
    id: alice,
    type: "Person",
    aliases: [{ value: "Alice" }],
  },
];

function resolver() {
  return new TypedEntityResolver({ types, entities });
}

describe("TypedEntityResolver", () => {
  it("returns ambiguity for a bare shared alias instead of picking by id order", () => {
    const result = resolver().resolve("Atlas");

    expect(result.status).toBe("ambiguous");
    expect(result.candidates.map((candidate) => candidate.entityId))
      .toEqual([person, project]);
  });

  it("uses a Turkish project type cue to resolve Project Atlas", () => {
    const result = resolver().resolve("Atlas projesinin sahibi kim?");

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("expected resolved entity");
    expect(result.entityId).toBe(project);
    expect(result.candidates[0]?.matchedTypeCues).toContain("projesinin");
  });

  it("uses a Turkish person type cue to resolve the person named Atlas", () => {
    const result = resolver().resolve("Atlas kişisinin işvereni nedir?");

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("expected resolved entity");
    expect(result.entityId).toBe(person);
    expect(result.candidates[0]?.evidenceRefs).toEqual(["source:contacts"]);
  });

  it("lets a longer exact entity alias disambiguate without a type cue", () => {
    const result = resolver().resolve("What is Project Atlas doing?");

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("expected resolved entity");
    expect(result.entityId).toBe(project);
  });

  it("returns none when no entity alias is present", () => {
    expect(resolver().resolve("What is the weather?")).toEqual({
      status: "none",
      candidates: [],
    });
  });

  it("rejects entities that reference unknown types", () => {
    expect(() => new TypedEntityResolver({
      types,
      entities: [{ id: project, type: "Unknown", aliases: [{ value: "Atlas" }] }],
    })).toThrow(/unknown type/);
  });
});

describe("activeRelationEdges", () => {
  const edges: readonly TemporalRelationEdge[] = [
    {
      id: "owner-old",
      from: project,
      to: person,
      relationType: "Project.owner",
      validFrom: "2026-01-01T00:00:00Z",
      validTo: "2026-08-01T00:00:00Z",
      recordedAt: "2026-01-02T00:00:00Z",
    },
    {
      id: "owner-current",
      from: project,
      to: alice,
      relationType: "Project.owner",
      validFrom: "2026-08-01T00:00:00Z",
      recordedAt: "2026-08-02T00:00:00Z",
      evidenceRefs: ["directory:atlas-owner"],
    },
  ];

  it("selects relation edges using the same validAt/knownAt two-clock model", () => {
    const historical = activeRelationEdges({
      edges,
      fromEntityIds: [project],
      validAt: "2026-03-01T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
    });
    const current = activeRelationEdges({
      edges,
      fromEntityIds: [project],
      validAt: "2026-09-24T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
    });

    expect(historical.map((edge) => edge.id)).toEqual(["owner-old"]);
    expect(current.map((edge) => edge.id)).toEqual(["owner-current"]);
  });

  it("excludes a relation that SSRL did not know yet at the replay cutoff", () => {
    const result = activeRelationEdges({
      edges,
      fromEntityIds: [project],
      validAt: "2026-09-01T00:00:00Z",
      knownAt: "2026-07-01T00:00:00Z",
    });

    expect(result).toEqual([]);
  });

  it("removes a relation after a known retraction while preserving earlier valid time", () => {
    const retractions: readonly SemanticRetraction[] = [{
      id: "owner-removed",
      targetKind: "relation",
      targetId: "owner-current",
      effectiveFrom: "2026-09-10T00:00:00Z",
      recordedAt: "2026-09-12T00:00:00Z",
      evidenceRefs: ["directory:event-42"],
    }];

    const historical = resolveActiveRelationEdges({
      edges,
      retractions,
      fromEntityIds: [project],
      validAt: "2026-09-05T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
    });
    const beforeKnowledge = resolveActiveRelationEdges({
      edges,
      retractions,
      fromEntityIds: [project],
      validAt: "2026-09-15T00:00:00Z",
      knownAt: "2026-09-11T00:00:00Z",
    });
    const afterKnowledge = resolveActiveRelationEdges({
      edges,
      retractions,
      fromEntityIds: [project],
      validAt: "2026-09-15T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
    });

    expect(historical.edges.map((edge) => edge.id)).toEqual(["owner-current"]);
    expect(beforeKnowledge.edges.map((edge) => edge.id)).toEqual(["owner-current"]);
    expect(afterKnowledge.edges).toEqual([]);
    expect(afterKnowledge.appliedRetractions.map((item) => item.id)).toEqual(["owner-removed"]);
  });

  it("rejects relation retractions that target an unknown edge", () => {
    expect(() => activeRelationEdges({
      edges,
      retractions: [{
        id: "bad-retraction",
        targetKind: "relation",
        targetId: "missing-edge",
        effectiveFrom: "2026-09-01T00:00:00Z",
        recordedAt: "2026-09-02T00:00:00Z",
      }],
      fromEntityIds: [project],
      validAt: "2026-09-24T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
    })).toThrow(/targets unknown relation/);
  });

  it("never traverses edges from entities outside the requested frontier", () => {
    const result = activeRelationEdges({
      edges,
      fromEntityIds: [person],
      validAt: "2026-09-24T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
    });

    expect(result).toEqual([]);
  });
});
