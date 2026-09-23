import { describe, expect, it } from "vitest";
import {
  planReconciliation,
  type ExternalBinding,
} from "@ssrl/core";
import {
  applyReconciliationPlan,
  InMemoryStateProvider,
  ReconciliationApplyError,
  ReconciliationBlockedError,
  StaleProviderStateError,
  observeBindings,
  reconcileOnce,
} from "../src/index.js";

const entityId = "entity://project/atlas" as const;
const observedAt = () => "2026-09-23T12:00:00Z";

function binding(provider: string): ExternalBinding {
  return {
    entityId,
    provider,
    externalId: `${provider}-atlas`,
    fields: [{
      canonical: "Project.deadline",
      external: "deadline",
      readable: true,
      writable: true,
    }],
  };
}

function provider(providerId: string, deadline: string): InMemoryStateProvider {
  return new InMemoryStateProvider(
    providerId,
    [{ externalId: `${providerId}-atlas`, values: { deadline } }],
    observedAt,
  );
}

function registry(...providers: InMemoryStateProvider[]) {
  return {
    providers: new Map(providers.map((item) => [item.id, item])),
  };
}

const authority = [{
  property: "Project.deadline",
  strategy: { kind: "provider" as const, provider: "primary" },
}];

describe("reconciliation runtime", () => {
  it("applies a plan, observes again, and proves convergence", async () => {
    const primary = provider("primary", "2026-11-20");
    const replica = provider("replica", "2026-11-15");

    const result = await reconcileOnce({
      entityId,
      bindings: [binding("primary"), binding("replica")],
      authority,
      registry: registry(primary, replica),
    });

    expect(result.applied).toHaveLength(1);
    expect(replica.read("replica-atlas").deadline).toBe("2026-11-20");
    expect(result.after?.mutations).toHaveLength(0);
    expect(result.after?.conflicts).toHaveLength(0);
  });

  it("dry-run plans without changing provider state", async () => {
    const primary = provider("primary", "2026-11-20");
    const replica = provider("replica", "2026-11-15");

    const result = await reconcileOnce({
      entityId,
      bindings: [binding("primary"), binding("replica")],
      authority,
      registry: registry(primary, replica),
      dryRun: true,
    });

    expect(result.before.mutations).toHaveLength(1);
    expect(result.applied).toHaveLength(0);
    expect(result.after).toBeUndefined();
    expect(replica.read("replica-atlas").deadline).toBe("2026-11-15");
  });

  it("rejects a stale provider revision", async () => {
    const primary = provider("primary", "2026-11-20");
    const replica = provider("replica", "2026-11-15");
    const providers = registry(primary, replica);
    const bindings = [binding("primary"), binding("replica")];
    const snapshots = await observeBindings(bindings, providers);
    const plan = planReconciliation({ entityId, snapshots, authority });

    replica.mutateExternally("replica-atlas", "deadline", "2026-11-19");

    try {
      await applyReconciliationPlan(plan, providers);
      throw new Error("expected stale revision failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ReconciliationApplyError);
      const applyError = error as ReconciliationApplyError;
      expect(applyError.applied).toHaveLength(0);
      expect(applyError.cause).toBeInstanceOf(StaleProviderStateError);
    }
    expect(replica.read("replica-atlas").deadline).toBe("2026-11-19");
  });

  it("blocks explicit application of a conflicted plan", async () => {
    const a = provider("a", "x");
    const b = provider("b", "y");
    const providers = registry(a, b);
    const snapshots = await observeBindings([binding("a"), binding("b")], providers);
    const plan = planReconciliation({ entityId, snapshots });

    expect(plan.conflicts).toHaveLength(1);
    await expect(applyReconciliationPlan(plan, providers))
      .rejects.toBeInstanceOf(ReconciliationBlockedError);
  });

  it("reports already-applied mutations when a later provider fails", async () => {
    const primary = provider("primary", "canonical");
    const replicaA = provider("replica-a", "old-a");
    const replicaB = provider("replica-b", "old-b");
    const providers = registry(primary, replicaA, replicaB);
    const bindings = [
      binding("primary"),
      binding("replica-a"),
      binding("replica-b"),
    ];
    const snapshots = await observeBindings(bindings, providers);
    const plan = planReconciliation({ entityId, snapshots, authority });

    replicaB.mutateExternally("replica-b-atlas", "deadline", "changed-after-plan");

    try {
      await applyReconciliationPlan(plan, providers);
      throw new Error("expected partial apply failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ReconciliationApplyError);
      const applyError = error as ReconciliationApplyError;
      expect(applyError.applied).toHaveLength(1);
      expect(applyError.applied[0]?.provider).toBe("replica-a");
      expect(applyError.failed.provider).toBe("replica-b");
    }

    expect(replicaA.read("replica-a-atlas").deadline).toBe("canonical");
    expect(replicaB.read("replica-b-atlas").deadline).toBe("changed-after-plan");
  });
});
