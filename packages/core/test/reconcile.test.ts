import { describe, expect, it } from "vitest";
import type {
  ExternalBinding,
  ExternalSnapshot,
  StateValue,
} from "../src/model.js";
import { planReconciliation } from "../src/reconcile.js";

const entityId = "entity://project/atlas" as const;

function binding(
  provider: string,
  writable = true,
): ExternalBinding {
  return {
    entityId,
    provider,
    externalId: `${provider}-atlas`,
    fields: [
      {
        canonical: "Project.deadline",
        external: "deadline",
        readable: true,
        writable,
      },
    ],
  };
}

function snapshot(
  provider: string,
  value: StateValue,
  observedAt: string,
  writable = true,
): ExternalSnapshot {
  return {
    binding: binding(provider, writable),
    revision: `${provider}-r1`,
    observedAt,
    values: { deadline: value },
  };
}

describe("planReconciliation", () => {
  it("lets explicit field authority beat a newer replica", () => {
    const plan = planReconciliation({
      entityId,
      snapshots: [
        snapshot("obsidian", "2026-11-25", "2026-09-23T11:00:00Z"),
        snapshot("project-system", "2026-11-20", "2026-09-23T10:00:00Z"),
      ],
      authority: [
        {
          property: "Project.deadline",
          strategy: { kind: "provider", provider: "project-system" },
        },
      ],
    });

    expect(plan.canonical.properties["Project.deadline"]?.value).toBe("2026-11-20");
    expect(plan.canonical.properties["Project.deadline"]?.source.provider).toBe("project-system");
    expect(plan.mutations).toEqual([
      expect.objectContaining({
        provider: "obsidian",
        nextValue: "2026-11-20",
      }),
    ]);
  });

  it("defaults to freshest observation when no authority rule exists", () => {
    const plan = planReconciliation({
      entityId,
      snapshots: [
        snapshot("a", "old", "2026-09-23T10:00:00Z"),
        snapshot("b", "new", "2026-09-23T11:00:00Z"),
      ],
    });

    expect(plan.canonical.properties["Project.deadline"]?.value).toBe("new");
    expect(plan.mutations).toHaveLength(1);
    expect(plan.mutations[0]?.provider).toBe("a");
  });

  it("surfaces a conflict instead of guessing on an equal-time disagreement", () => {
    const plan = planReconciliation({
      entityId,
      snapshots: [
        snapshot("a", "x", "2026-09-23T11:00:00Z"),
        snapshot("b", "y", "2026-09-23T11:00:00Z"),
      ],
    });

    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]?.reason).toBe("ambiguous-freshest");
    expect(plan.canonical.properties["Project.deadline"]).toBeUndefined();
    expect(plan.mutations).toHaveLength(0);
  });

  it("never plans a write through a read-only binding", () => {
    const plan = planReconciliation({
      entityId,
      snapshots: [
        snapshot("primary", "canonical", "2026-09-23T10:00:00Z"),
        snapshot("readonly", "stale", "2026-09-23T09:00:00Z", false),
      ],
      authority: [
        {
          property: "Project.deadline",
          strategy: { kind: "provider", provider: "primary" },
        },
      ],
    });

    expect(plan.mutations).toHaveLength(0);
  });

  it("is deterministic regardless of snapshot input order", () => {
    const snapshots = [
      snapshot("a", "same", "2026-09-23T10:00:00Z"),
      snapshot("b", "stale", "2026-09-23T09:00:00Z"),
    ];

    const forward = planReconciliation({ entityId, snapshots });
    const reverse = planReconciliation({ entityId, snapshots: [...snapshots].reverse() });

    expect(reverse).toEqual(forward);
  });

  it("is a no-op when all writable projections already converge", () => {
    const plan = planReconciliation({
      entityId,
      snapshots: [
        snapshot("a", "same", "2026-09-23T10:00:00Z"),
        snapshot("b", "same", "2026-09-23T10:00:00Z"),
      ],
    });

    expect(plan.conflicts).toHaveLength(0);
    expect(plan.mutations).toHaveLength(0);
  });

  it("accepts equal-time duplicate observations when their values agree", () => {
    const plan = planReconciliation({
      entityId,
      snapshots: [
        snapshot("a", "same", "2026-09-23T11:00:00Z"),
        snapshot("b", "same", "2026-09-23T11:00:00Z"),
      ],
    });

    expect(plan.conflicts).toHaveLength(0);
    expect(plan.canonical.properties["Project.deadline"]?.value).toBe("same");
  });

  it("becomes a no-op after its planned mutation has converged the replica", () => {
    const first = planReconciliation({
      entityId,
      snapshots: [
        snapshot("primary", "canonical", "2026-09-23T10:00:00Z"),
        snapshot("replica", "stale", "2026-09-23T09:00:00Z"),
      ],
      authority: [{ property: "Project.deadline", strategy: { kind: "provider", provider: "primary" } }],
    });
    expect(first.mutations).toHaveLength(1);

    const second = planReconciliation({
      entityId,
      snapshots: [
        snapshot("primary", "canonical", "2026-09-23T10:00:00Z"),
        snapshot("replica", "canonical", "2026-09-23T11:00:00Z"),
      ],
      authority: [{ property: "Project.deadline", strategy: { kind: "provider", provider: "primary" } }],
    });
    expect(second.mutations).toHaveLength(0);
  });

  it("rejects malformed observation timestamps", () => {
    expect(() => planReconciliation({
      entityId,
      snapshots: [snapshot("a", "x", "not-a-timestamp")],
    })).toThrow(/Invalid observedAt timestamp/);
  });

  it("rejects snapshots bound to a different canonical entity", () => {
    const wrong = snapshot("a", "x", "2026-09-23T10:00:00Z");
    const invalid: ExternalSnapshot = {
      ...wrong,
      binding: {
        ...wrong.binding,
        entityId: "entity://project/other",
      },
    };

    expect(() => planReconciliation({ entityId, snapshots: [invalid] }))
      .toThrow(/belongs to another entity/);
  });
});
