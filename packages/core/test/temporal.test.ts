import { describe, expect, it } from "vitest";
import type { AuthorityRule, StateValue } from "../src/model.js";
import {
  resolveCurrentTemporalState,
  resolveTemporalState,
  type TemporalObservation,
} from "../src/temporal.js";
import type { SemanticRetraction } from "../src/retraction.js";

const entityId = "entity://project/atlas" as const;
const property = "Project.apiStyle";

function observation(
  id: string,
  value: StateValue,
  validFrom: string,
  validTo: string | undefined,
  recordedAt: string,
  provider = "adr",
  externalId = "atlas-api",
): TemporalObservation {
  return {
    id,
    entityId,
    property,
    value,
    source: { provider, externalId, revision: id },
    validFrom,
    ...(validTo === undefined ? {} : { validTo }),
    recordedAt,
  };
}

const authority: readonly AuthorityRule[] = [{
  property,
  strategy: { kind: "provider", provider: "adr" },
}];


function retraction(
  id: string,
  targetId: string,
  effectiveFrom: string,
  recordedAt: string,
): SemanticRetraction {
  return {
    id,
    targetKind: "observation",
    targetId,
    effectiveFrom,
    recordedAt,
    source: { provider: "source-sync", externalId: targetId, revision: id },
    evidenceRefs: [`event:${id}`],
  };
}

const history = [
  observation(
    "rest",
    "REST",
    "2026-02-10T00:00:00Z",
    "2026-08-20T00:00:00Z",
    "2026-02-10T10:00:00Z",
  ),
  observation(
    "graphql",
    "GraphQL",
    "2026-08-20T00:00:00Z",
    undefined,
    "2026-08-20T10:00:00Z",
  ),
] as const;

describe("resolveTemporalState", () => {
  it("resolves current state with an explicit clock value", () => {
    const state = resolveCurrentTemporalState({
      entityId,
      observations: history,
      at: "2026-09-24T00:00:00Z",
      authority,
    });

    expect(state.canonical.properties[property]?.value).toBe("GraphQL");
    expect(state.evidence[property]?.map((item) => item.observationId)).toEqual(["graphql"]);
  });

  it("applies retractions through the current-state convenience wrapper", () => {
    const observations = [
      observation("current-open", "REST", "2026-02-01T00:00:00Z", undefined, "2026-02-01T00:00:00Z"),
    ];
    const state = resolveCurrentTemporalState({
      entityId,
      observations,
      retractions: [
        retraction(
          "current-delete",
          "current-open",
          "2026-09-01T00:00:00Z",
          "2026-09-02T00:00:00Z",
        ),
      ],
      at: "2026-09-24T00:00:00Z",
      authority,
    });

    expect(state.canonical.properties[property]).toBeUndefined();
    expect(state.appliedRetractions.map((item) => item.id)).toEqual(["current-delete"]);
  });

  it("resolves historical state by valid time using knowledge available later", () => {
    const state = resolveTemporalState({
      entityId,
      observations: history,
      validAt: "2026-03-01T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
      authority,
    });

    expect(state.canonical.properties[property]?.value).toBe("REST");
    expect(state.evidence[property]?.[0]?.observationId).toBe("rest");
  });

  it("does not backfill a future value before its validFrom boundary", () => {
    const state = resolveTemporalState({
      entityId,
      observations: history,
      validAt: "2026-01-01T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
      authority,
    });

    expect(state.canonical.properties[property]).toBeUndefined();
    expect(state.conflicts).toHaveLength(0);
  });

  it("treats validFrom as inclusive and validTo as exclusive", () => {
    const beforeBoundary = resolveTemporalState({
      entityId,
      observations: history,
      validAt: "2026-08-19T23:59:59Z",
      knownAt: "2026-09-24T00:00:00Z",
      authority,
    });
    const atBoundary = resolveTemporalState({
      entityId,
      observations: history,
      validAt: "2026-08-20T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
      authority,
    });

    expect(beforeBoundary.canonical.properties[property]?.value).toBe("REST");
    expect(atBoundary.canonical.properties[property]?.value).toBe("GraphQL");
  });

  it("replays what SSRL knew before and after late-arriving evidence", () => {
    const observations = [
      observation(
        "initial",
        "REST",
        "2026-02-01T00:00:00Z",
        "2026-08-01T00:00:00Z",
        "2026-02-02T00:00:00Z",
      ),
      observation(
        "late-correction",
        "gRPC",
        "2026-02-01T00:00:00Z",
        "2026-08-01T00:00:00Z",
        "2026-09-01T00:00:00Z",
      ),
    ];

    const beforeCorrection = resolveTemporalState({
      entityId,
      observations,
      validAt: "2026-03-01T00:00:00Z",
      knownAt: "2026-08-15T00:00:00Z",
      authority,
    });
    const afterCorrection = resolveTemporalState({
      entityId,
      observations,
      validAt: "2026-03-01T00:00:00Z",
      knownAt: "2026-09-15T00:00:00Z",
      authority,
    });

    expect(beforeCorrection.canonical.properties[property]?.value).toBe("REST");
    expect(afterCorrection.canonical.properties[property]?.value).toBe("gRPC");
    expect(afterCorrection.evidence[property]?.[0]?.observationId).toBe("late-correction");
  });

  it("surfaces same-knowledge-time conflicting values instead of guessing", () => {
    const observations = [
      observation(
        "ops-beta",
        "beta",
        "2026-09-01T00:00:00Z",
        undefined,
        "2026-09-20T10:00:00Z",
        "ops",
        "atlas-release",
      ),
      observation(
        "pm-production",
        "production",
        "2026-09-01T00:00:00Z",
        undefined,
        "2026-09-20T10:00:00Z",
        "pm",
        "atlas-release",
      ),
    ];

    const state = resolveTemporalState({
      entityId,
      observations,
      validAt: "2026-09-24T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
    });

    expect(state.canonical.properties[property]).toBeUndefined();
    expect(state.conflicts).toHaveLength(1);
    expect(state.conflictEvidence[property]?.map((item) => item.observationId).sort())
      .toEqual(["ops-beta", "pm-production"]);
  });

  it("lets explicit authority resolve an overlapping cross-provider disagreement", () => {
    const observations = [
      observation("chat", "proposal", "2026-09-01T00:00:00Z", undefined, "2026-09-22T00:00:00Z", "chat"),
      observation("pm", "approved", "2026-09-01T00:00:00Z", undefined, "2026-09-20T00:00:00Z", "pm"),
    ];

    const state = resolveTemporalState({
      entityId,
      observations,
      validAt: "2026-09-24T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
      authority: [{ property, strategy: { kind: "provider", provider: "pm" } }],
    });

    expect(state.canonical.properties[property]?.value).toBe("approved");
    expect(state.conflicts).toHaveLength(0);
  });

  it("applies a scheduled observation retraction at effectiveFrom without mutating the assertion", () => {
    const observations = [
      observation("open-rest", "REST", "2026-02-01T00:00:00Z", undefined, "2026-02-01T00:00:00Z"),
    ];
    const retractions = [
      retraction("delete-rest", "open-rest", "2026-08-01T00:00:00Z", "2026-07-01T00:00:00Z"),
    ];

    const july = resolveTemporalState({
      entityId,
      observations,
      retractions,
      validAt: "2026-07-31T23:59:59Z",
      knownAt: "2026-07-31T23:59:59Z",
      authority,
    });
    const august = resolveTemporalState({
      entityId,
      observations,
      retractions,
      validAt: "2026-08-01T00:00:00Z",
      knownAt: "2026-08-01T00:00:00Z",
      authority,
    });

    expect(july.canonical.properties[property]?.value).toBe("REST");
    expect(august.canonical.properties[property]).toBeUndefined();
    expect(august.appliedRetractions.map((item) => item.id)).toEqual(["delete-rest"]);
    expect(observations[0]?.validTo).toBeUndefined();
  });

  it("preserves prior knowledge before a late retraction and corrects history after it is learned", () => {
    const observations = [
      observation("open-rest", "REST", "2026-02-01T00:00:00Z", undefined, "2026-02-01T00:00:00Z"),
    ];
    const retractions = [
      retraction("late-delete", "open-rest", "2026-08-01T00:00:00Z", "2026-08-10T00:00:00Z"),
    ];

    const beforeKnowledge = resolveTemporalState({
      entityId,
      observations,
      retractions,
      validAt: "2026-08-05T00:00:00Z",
      knownAt: "2026-08-05T00:00:00Z",
      authority,
    });
    const afterKnowledge = resolveTemporalState({
      entityId,
      observations,
      retractions,
      validAt: "2026-08-05T00:00:00Z",
      knownAt: "2026-08-10T00:00:00Z",
      authority,
    });

    expect(beforeKnowledge.canonical.properties[property]?.value).toBe("REST");
    expect(beforeKnowledge.appliedRetractions).toEqual([]);
    expect(afterKnowledge.canonical.properties[property]).toBeUndefined();
    expect(afterKnowledge.appliedRetractions.map((item) => item.id)).toEqual(["late-delete"]);
  });

  it("can fully void an observation for corrected history after the retraction is known", () => {
    const observations = [
      observation("bad-rest", "REST", "2026-02-01T00:00:00Z", undefined, "2026-02-02T00:00:00Z"),
    ];
    const retractions = [
      retraction("void-rest", "bad-rest", "2026-01-01T00:00:00Z", "2026-09-01T00:00:00Z"),
    ];

    const state = resolveTemporalState({
      entityId,
      observations,
      retractions,
      validAt: "2026-03-01T00:00:00Z",
      knownAt: "2026-09-02T00:00:00Z",
      authority,
    });

    expect(state.canonical.properties[property]).toBeUndefined();
    expect(state.appliedRetractions.map((item) => item.id)).toEqual(["void-rest"]);
  });

  it("does not extend an assertion whose original validTo precedes the retraction", () => {
    const observations = [
      observation(
        "closed-rest",
        "REST",
        "2026-02-01T00:00:00Z",
        "2026-06-01T00:00:00Z",
        "2026-02-02T00:00:00Z",
      ),
    ];
    const retractions = [
      retraction("too-late", "closed-rest", "2026-08-01T00:00:00Z", "2026-05-01T00:00:00Z"),
    ];

    const state = resolveTemporalState({
      entityId,
      observations,
      retractions,
      validAt: "2026-07-01T00:00:00Z",
      knownAt: "2026-09-01T00:00:00Z",
      authority,
    });

    expect(state.canonical.properties[property]).toBeUndefined();
    expect(state.appliedRetractions).toEqual([]);
  });

  it("uses the earliest effectiveFrom when multiple known retractions target one observation", () => {
    const observations = [
      observation("open-rest", "REST", "2026-02-01T00:00:00Z", undefined, "2026-02-01T00:00:00Z"),
    ];
    const retractions = [
      retraction("later-end", "open-rest", "2026-09-01T00:00:00Z", "2026-07-01T00:00:00Z"),
      retraction("earlier-end", "open-rest", "2026-08-01T00:00:00Z", "2026-07-15T00:00:00Z"),
    ];

    const state = resolveTemporalState({
      entityId,
      observations,
      retractions,
      validAt: "2026-08-15T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
      authority,
    });

    expect(state.canonical.properties[property]).toBeUndefined();
    expect(state.appliedRetractions.map((item) => item.id)).toEqual(["earlier-end"]);
  });

  it("rejects a retraction that does not target an observation in the supplied universe", () => {
    expect(() => resolveTemporalState({
      entityId,
      observations: history,
      retractions: [retraction("unknown", "missing", "2026-08-01T00:00:00Z", "2026-08-02T00:00:00Z")],
      validAt: "2026-09-24T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
      authority,
    })).toThrow(/targets unknown observation/);
  });

  it("is deterministic regardless of observation input order", () => {
    const forward = resolveTemporalState({
      entityId,
      observations: history,
      validAt: "2026-03-01T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
      authority,
    });
    const reverse = resolveTemporalState({
      entityId,
      observations: [...history].reverse(),
      validAt: "2026-03-01T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
      authority,
    });

    expect(reverse).toEqual(forward);
  });

  it("rejects duplicate observation ids", () => {
    expect(() => resolveTemporalState({
      entityId,
      observations: [history[0], { ...history[1], id: history[0].id }],
      validAt: "2026-09-24T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
      authority,
    })).toThrow(/Duplicate temporal observation id/);
  });

  it("rejects malformed timestamps and inverted validity intervals", () => {
    expect(() => resolveTemporalState({
      entityId,
      observations: [
        observation("bad", "REST", "not-a-time", undefined, "2026-09-01T00:00:00Z"),
      ],
      validAt: "2026-09-24T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
    })).toThrow(/Invalid validFrom timestamp/);

    expect(() => resolveTemporalState({
      entityId,
      observations: [
        observation(
          "inverted",
          "REST",
          "2026-09-10T00:00:00Z",
          "2026-09-01T00:00:00Z",
          "2026-09-01T00:00:00Z",
        ),
      ],
      validAt: "2026-09-24T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
    })).toThrow(/validTo after validFrom/);
  });
});
