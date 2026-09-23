import { describe, expect, it } from "vitest";
import {
  entityAliasJson,
  normalizeTemporalObservation,
  typedEntitiesFromStateSnapshot,
  type SemanticStateSnapshot,
} from "../src/index.js";

const project = "entity://project/atlas" as const;

describe("state-store contracts", () => {
  it("normalizes equivalent timestamps and evidence-ref order for stable identity", () => {
    const first = entityAliasJson({
      id: "alias-atlas",
      entityId: project,
      value: "Atlas",
      recordedAt: "2026-09-24T03:00:00+03:00",
      evidenceRefs: ["b", "a", "a"],
    });
    const second = entityAliasJson({
      id: "alias-atlas",
      entityId: project,
      value: "Atlas",
      recordedAt: "2026-09-24T00:00:00Z",
      evidenceRefs: ["a", "b"],
    });

    expect(second).toBe(first);
  });

  it("round-trips nested StateValue without coercion", () => {
    const observation = normalizeTemporalObservation({
      id: "obs-complex",
      entityId: project,
      property: "Project.settings",
      value: {
        enabled: true,
        count: 4,
        nullable: null,
        names: ["a", "b"],
        nested: { ratio: 0.5 },
      },
      source: { provider: "test", externalId: "complex" },
      validFrom: "2026-01-01T00:00:00Z",
      recordedAt: "2026-01-02T00:00:00Z",
    });

    expect(observation.value).toEqual({
      count: 4,
      enabled: true,
      names: ["a", "b"],
      nested: { ratio: 0.5 },
      nullable: null,
    });
  });

  it("hydrates typed entities from alias evidence deterministically", () => {
    const snapshot: SemanticStateSnapshot = {
      schema: "ssrl-semantic-state-snapshot-v1",
      entities: [{ entityId: project, entityType: "Project" }],
      aliases: [
        {
          id: "b",
          entityId: project,
          value: "Atlas",
          recordedAt: "2026-09-24T00:00:00Z",
        },
        {
          id: "a",
          entityId: project,
          value: "Project Atlas",
          recordedAt: "2026-09-24T00:00:00Z",
          evidenceRefs: ["source:pm"],
        },
      ],
      observations: [],
      relations: [],
    };

    expect(typedEntitiesFromStateSnapshot(snapshot)).toEqual([{
      id: project,
      type: "Project",
      aliases: [
        { value: "Project Atlas", evidenceRefs: ["source:pm"] },
        { value: "Atlas" },
      ],
    }]);
  });
});
