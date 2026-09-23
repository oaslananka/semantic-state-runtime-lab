import { describe, expect, it } from "vitest";
import type {
  AuthorityRule,
  TemporalObservation,
} from "@ssrl/core";
import {
  TemporalContextCompiler,
  type TemporalEntityDescriptor,
} from "../src/index.js";

const atlas = "entity://project/atlas" as const;
const entities: readonly TemporalEntityDescriptor[] = [{
  id: atlas,
  aliases: ["Project Atlas", "Atlas", "Atlas projesi"],
}];
const property = "Project.apiStyle";
const authority: readonly AuthorityRule[] = [{
  property,
  strategy: { kind: "provider", provider: "adr" },
}];

type TemporalRow = readonly [
  id: string,
  value: string,
  validFrom: string,
  validTo: string | null,
  recordedAt: string,
];

function observations(rows: readonly TemporalRow[]): TemporalObservation[] {
  return rows.map(([id, value, validFrom, validTo, recordedAt]) => ({
    id,
    entityId: atlas,
    property,
    value,
    source: { provider: "adr", externalId: "atlas-api", revision: id },
    validFrom,
    ...(validTo === null ? {} : { validTo }),
    recordedAt,
  }));
}

const history = observations([
  ["rest", "REST", "2026-02-10T00:00:00Z", "2026-08-20T00:00:00Z", "2026-02-10T10:00:00Z"],
  ["graphql", "GraphQL", "2026-08-20T00:00:00Z", null, "2026-08-20T10:00:00Z"],
]);

function correctionHistory(): TemporalObservation[] {
  return observations([
    ["initial", "REST", "2026-02-01T00:00:00Z", "2026-08-01T00:00:00Z", "2026-02-02T00:00:00Z"],
    ["late-correction", "gRPC", "2026-02-01T00:00:00Z", "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z"],
  ]);
}

function compiler(observations: readonly TemporalObservation[] = history) {
  return new TemporalContextCompiler({
    entities,
    observations,
    authorityByEntity: new Map([[atlas, authority]]),
  });
}

describe("TemporalContextCompiler", () => {
  it("compiles current state from temporal observations", () => {
    const result = compiler().compile({
      query: "What API style does Project Atlas use?",
      budgetTokens: 120,
      validAt: "2026-09-24T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
    });

    expect(result.resolvedEntityIds).toEqual([atlas]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.text).toContain("GraphQL");
    expect(result.records[0]?.evidenceRefs).toEqual(["graphql"]);
  });

  it("compiles historical as-of state instead of leaking current truth", () => {
    const result = compiler().compile({
      query: "On 2026-03-01, what API style did Project Atlas use?",
      budgetTokens: 120,
      validAt: "2026-03-01T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
    });

    expect(result.records[0]?.text).toContain("REST");
    expect(result.records[0]?.text).not.toContain("GraphQL");
    expect(result.records[0]?.evidenceRefs).toEqual(["rest"]);
  });

  it("replays knowledge time for late-arriving corrections", () => {
    const observations = correctionHistory();

    const before = compiler(observations).compile({
      query: "What API style did Atlas use in March?",
      budgetTokens: 120,
      validAt: "2026-03-01T00:00:00Z",
      knownAt: "2026-08-15T00:00:00Z",
    });
    const after = compiler(observations).compile({
      query: "What API style did Atlas use in March?",
      budgetTokens: 120,
      validAt: "2026-03-01T00:00:00Z",
      knownAt: "2026-09-15T00:00:00Z",
    });

    expect(before.records[0]?.text).toContain("REST");
    expect(after.records[0]?.text).toContain("gRPC");
    expect(after.records[0]?.evidenceRefs).toEqual(["late-correction"]);
  });

  it("emits an explicit conflict record with both evidence refs", () => {
    const observations: TemporalObservation[] = [
      {
        id: "ops-beta",
        entityId: atlas,
        property: "Project.releaseStage",
        value: "beta",
        source: { provider: "ops", externalId: "atlas-release" },
        validFrom: "2026-09-01T00:00:00Z",
        recordedAt: "2026-09-20T10:00:00Z",
      },
      {
        id: "pm-production",
        entityId: atlas,
        property: "Project.releaseStage",
        value: "production",
        source: { provider: "pm", externalId: "atlas-release" },
        validFrom: "2026-09-01T00:00:00Z",
        recordedAt: "2026-09-20T10:00:00Z",
      },
    ];

    const result = compiler(observations).compile({
      query: "Atlas projesinin release stage durumu nedir?",
      budgetTokens: 160,
      validAt: "2026-09-24T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
    });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.text).toContain("beta");
    expect(result.records[0]?.text).toContain("production");
    expect([...(result.records[0]?.evidenceRefs ?? [])].sort()).toEqual(["ops-beta", "pm-production"]);
  });

  it("returns no state before the first valid observation", () => {
    const result = compiler().compile({
      query: "What API style does Project Atlas use?",
      budgetTokens: 120,
      validAt: "2026-01-01T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
    });

    expect(result.records).toEqual([]);
    expect(result.resolvedEntityIds).toEqual([atlas]);
  });

  it("keeps temporal context inside the requested token budget", () => {
    const result = compiler().compile({
      query: "What API style does Project Atlas use?",
      budgetTokens: 35,
      validAt: "2026-09-24T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
    });

    expect(result.estimatedTokens).toBeLessThanOrEqual(35);
  });
});
