import { describe, expect, it } from "vitest";
import type { ReconciliationPlan } from "@ssrl/core";
import { InMemoryEventJournal } from "@ssrl/journal";
import {
  ReconciliationBlockedError,
  ReconciliationPlanDriftError,
} from "@ssrl/runtime";
import {
  EntityNotConfiguredError,
  InMemoryEntityRuntimeCatalog,
  RuntimeHost,
  sha256ProposalDigest,
} from "../src/index.js";
import {
  catalog,
  countingProvider,
  entityId,
  providers,
  registry,
} from "./fixtures.js";

describe("RuntimeHost", () => {
  it("plans then applies an unchanged proposal and converges", async () => {
    let observedAt = "2026-09-24T00:00:00Z";
    const state = providers({ now: () => observedAt });
    const host = new RuntimeHost({
      catalog: catalog(),
      registry: registry(state.primary, state.replica),
    });

    const proposal = await host.plan(entityId);
    expect(proposal.status).toBe("ready");

    observedAt = "2026-09-24T00:01:00Z";
    const result = await host.apply(entityId, proposal.digest);

    expect(result.applied).toHaveLength(1);
    expect(state.replica.read("replica-atlas").deadline).toBe("2026-11-20");
    expect(result.after?.mutations).toHaveLength(0);
  });

  it("does not change the proposal digest when only observedAt changes", async () => {
    let observedAt = "2026-09-24T00:00:00Z";
    const state = providers({ now: () => observedAt });
    const host = new RuntimeHost({
      catalog: catalog(),
      registry: registry(state.primary, state.replica),
    });

    const first = await host.plan(entityId);
    observedAt = "2026-09-24T00:05:00Z";
    const second = await host.plan(entityId);

    expect(second.digest).toBe(first.digest);
  });

  it("rejects state drift before provider apply", async () => {
    const state = providers();
    const counted = countingProvider(state.replica);
    const host = new RuntimeHost({
      catalog: catalog(),
      registry: registry(state.primary, counted.provider),
    });

    const proposal = await host.plan(entityId);
    state.replica.mutateExternally(
      "replica-atlas",
      "deadline",
      "2026-11-19",
    );

    await expect(host.apply(entityId, proposal.digest))
      .rejects.toBeInstanceOf(ReconciliationPlanDriftError);

    expect(counted.count()).toBe(0);
    expect(state.replica.read("replica-atlas").deadline).toBe("2026-11-19");
  });

  it("journals drift without creating mutation intent", async () => {
    const state = providers();
    const journal = new InMemoryEventJournal();
    const host = new RuntimeHost({
      catalog: catalog(),
      registry: registry(state.primary, state.replica),
      journal,
      now: () => "2026-09-24T00:10:00Z",
    });

    const proposal = await host.plan(entityId);
    state.replica.mutateExternally("replica-atlas", "deadline", "changed");

    await expect(host.apply(entityId, proposal.digest))
      .rejects.toBeInstanceOf(ReconciliationPlanDriftError);

    const events = await journal.eventsForEntity(entityId);
    expect(events.some((event) => event.type === "mutation.requested")).toBe(false);
    const completed = events.filter((event) => event.type === "reconciliation.completed");
    expect(completed.at(-1)?.type === "reconciliation.completed"
      ? completed.at(-1)?.payload.outcome
      : undefined).toBe("drifted");
  });

  it("does not apply a conflicted proposal", async () => {
    const state = providers({
      primaryValues: { deadline: "x" },
      replicaValues: { deadline: "y" },
    });
    const counted = countingProvider(state.replica);
    const host = new RuntimeHost({
      catalog: catalog({ authorityProvider: null }),
      registry: registry(state.primary, counted.provider),
    });

    const proposal = await host.plan(entityId);
    expect(proposal.status).toBe("blocked");

    await expect(host.apply(entityId, proposal.digest))
      .rejects.toBeInstanceOf(ReconciliationBlockedError);
    expect(counted.count()).toBe(0);
  });

  it("journals a successful apply through the host boundary", async () => {
    const state = providers();
    const journal = new InMemoryEventJournal();
    const host = new RuntimeHost({
      catalog: catalog(),
      registry: registry(state.primary, state.replica),
      journal,
      now: () => "2026-09-24T00:10:00Z",
    });

    const proposal = await host.plan(entityId);
    const result = await host.apply(entityId, proposal.digest);

    expect(result.journalRunId).toBeDefined();
    const events = await journal.eventsForRun(result.journalRunId!);
    expect(events.map((event) => event.type)).toContain("mutation.requested");
    expect(events.map((event) => event.type)).toContain("mutation.applied");
    expect(events.at(-1)?.type).toBe("reconciliation.completed");
  });

  it("fails explicitly when an entity is not configured", async () => {
    const state = providers();
    const host = new RuntimeHost({
      catalog: new InMemoryEntityRuntimeCatalog([]),
      registry: registry(state.primary, state.replica),
    });

    await expect(host.plan(entityId)).rejects.toBeInstanceOf(EntityNotConfiguredError);
  });

  it("hashes semantically identical nested object key orders identically", () => {
    const base: ReconciliationPlan = {
      entityId,
      canonical: { entityId, properties: {} },
      mutations: [{
        provider: "replica",
        externalId: "replica-atlas",
        externalPath: "metadata",
        canonicalProperty: "Project.metadata",
        nextValue: { a: 1, b: { c: true, d: "x" } },
      }],
      conflicts: [],
    };
    const reordered: ReconciliationPlan = {
      ...base,
      mutations: [{
        ...base.mutations[0]!,
        nextValue: { b: { d: "x", c: true }, a: 1 },
      }],
    };

    expect(sha256ProposalDigest(reordered)).toBe(sha256ProposalDigest(base));
  });

  it("matches the documented SHA-256 proposal test vector", () => {
    const vector: ReconciliationPlan = {
      entityId,
      canonical: { entityId, properties: {} },
      mutations: [{
        provider: "replica",
        externalId: "atlas",
        externalPath: "meta",
        canonicalProperty: "Project.metadata",
        nextValue: { b: 2, a: 1 },
        previousValue: { z: false, a: "x" },
        baseRevision: "replica:7",
      }],
      conflicts: [],
    };

    expect(sha256ProposalDigest(vector)).toBe(
      "sha256:be561a3b00f16ae8e1d665bb4c49654e2732c35ad107ade65b02f0f7c2051584",
    );
  });
});
