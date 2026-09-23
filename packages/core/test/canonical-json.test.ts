import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  reconciliationProposalJson,
  reconciliationProposalMaterial,
  type ReconciliationPlan,
} from "../src/index.js";

const entityId = "entity://project/atlas" as const;

function plan(nextValue: Record<string, unknown>): ReconciliationPlan {
  return {
    entityId,
    canonical: {
      entityId,
      properties: {},
    },
    mutations: [{
      provider: "replica",
      externalId: "atlas",
      externalPath: "meta",
      canonicalProperty: "Project.metadata",
      nextValue: nextValue as never,
      previousValue: { z: false, a: "x" },
      baseRevision: "replica:7",
    }],
    conflicts: [],
  };
}

describe("canonical proposal material", () => {
  it("canonicalizes nested object keys deterministically", () => {
    expect(canonicalJson({ z: 2, a: { y: 1, b: true } }))
      .toBe('{"a":{"b":true,"y":1},"z":2}');
  });

  it("excludes observation timestamps and canonical display state from approval material", () => {
    const base = plan({ b: 2, a: 1 });
    const withDifferentCanonical: ReconciliationPlan = {
      ...base,
      canonical: {
        entityId,
        properties: {
          "Project.metadata": {
            property: "Project.metadata",
            value: { a: 1, b: 2 },
            source: {
              provider: "primary",
              externalId: "atlas",
              revision: "primary:9",
            },
            observedAt: "2099-01-01T00:00:00Z",
          },
        },
      },
    };

    expect(reconciliationProposalMaterial(withDifferentCanonical))
      .toEqual(reconciliationProposalMaterial(base));
  });

  it("produces the documented v1 canonical JSON test vector", () => {
    expect(reconciliationProposalJson(plan({ b: 2, a: 1 }))).toBe(
      '{"conflicts":[],"entityId":"entity://project/atlas","mutations":[{"baseRevision":"replica:7","canonicalProperty":"Project.metadata","externalId":"atlas","externalPath":"meta","nextValue":{"a":1,"b":2},"previousValue":{"a":"x","z":false},"provider":"replica"}],"schema":"ssrl-reconciliation-proposal-v1"}',
    );
  });
});
