import { describe, expect, it } from "vitest";
import type { ExternalBinding } from "@ssrl/core";
import {
  InMemoryEventJournal,
  indeterminateMutations,
  type RuntimeEventJournal,
  type RuntimeJournalEvent,
} from "@ssrl/journal";
import {
  InMemoryStateProvider,
  ReconciliationApplyError,
  reconcileOnce,
  type StateProvider,
} from "../src/index.js";

const entityId = "entity://project/atlas" as const;
const now = () => "2026-09-23T21:45:00Z";

function binding(provider: string): ExternalBinding {
  return {
    entityId,
    provider,
    externalId: `${provider}-atlas`,
    fields: [{
      canonical: "Project.deadline",
      external: "deadline",
      readable: true,
      writable: provider !== "primary",
    }],
  };
}

function provider(id: string, deadline: string): InMemoryStateProvider {
  return new InMemoryStateProvider(
    id,
    [{ externalId: `${id}-atlas`, values: { deadline } }],
    now,
  );
}

function authority() {
  return [{
    property: "Project.deadline",
    strategy: { kind: "provider" as const, provider: "primary" },
  }];
}

async function events(journal: RuntimeEventJournal): Promise<readonly RuntimeJournalEvent[]> {
  return journal.eventsForEntity(entityId);
}

describe("reconciliation journal integration", () => {
  it("durably records mutation intent before invoking the external provider", async () => {
    const journal = new InMemoryEventJournal();
    const primary = provider("primary", "2026-11-20");
    const replicaState = provider("replica", "2026-11-15");

    const replica: StateProvider = {
      id: replicaState.id,
      observe: (externalBinding) => replicaState.observe(externalBinding),
      async apply(mutation) {
        const current = await events(journal);
        expect(current.at(-1)?.type).toBe("mutation.requested");
        await replicaState.apply(mutation);
      },
    };

    const result = await reconcileOnce({
      entityId,
      bindings: [binding("primary"), binding("replica")],
      authority: authority(),
      registry: {
        providers: new Map<string, StateProvider>([
          [primary.id, primary],
          [replica.id, replica],
        ]),
      },
      journal,
      now,
    });

    expect(result.journalRunId).toBeDefined();
    expect((await events(journal)).map((event) => event.type)).toEqual([
      "reconciliation.started",
      "observation.recorded",
      "observation.recorded",
      "reconciliation.planned",
      "mutation.requested",
      "mutation.applied",
      "observation.recorded",
      "observation.recorded",
      "reconciliation.completed",
    ]);
  });

  it("leaves an indeterminate request if outcome journaling fails after provider success", async () => {
    const inner = new InMemoryEventJournal();
    const journal: RuntimeEventJournal = {
      createId: () => inner.createId(),
      eventsForRun: (runId) => inner.eventsForRun(runId),
      eventsForEntity: (id) => inner.eventsForEntity(id),
      async append(nextEvents) {
        if (nextEvents.some((event) => event.type === "mutation.applied")) {
          throw new Error("simulated journal outage after provider apply");
        }
        await inner.append(nextEvents);
      },
    };

    const primary = provider("primary", "2026-11-20");
    const replica = provider("replica", "2026-11-15");

    await expect(reconcileOnce({
      entityId,
      bindings: [binding("primary"), binding("replica")],
      authority: authority(),
      registry: {
        providers: new Map<string, StateProvider>([
          [primary.id, primary],
          [replica.id, replica],
        ]),
      },
      journal,
      now,
    })).rejects.toThrow("simulated journal outage");

    expect(replica.read("replica-atlas").deadline).toBe("2026-11-20");
    expect(indeterminateMutations(await events(inner))).toHaveLength(1);
  });

  it("records partial success and a terminal provider failure", async () => {
    const journal = new InMemoryEventJournal();
    const primary = provider("primary", "canonical");
    const replicaA = provider("replica-a", "old-a");
    const replicaBState = provider("replica-b", "old-b");

    class ProviderWriteError extends Error {
      constructor() {
        super("simulated provider rejection");
        this.name = "ProviderWriteError";
      }
    }

    const replicaB: StateProvider = {
      id: replicaBState.id,
      observe: (externalBinding) => replicaBState.observe(externalBinding),
      async apply() {
        throw new ProviderWriteError();
      },
    };

    await expect(reconcileOnce({
      entityId,
      bindings: [
        binding("primary"),
        binding("replica-a"),
        binding("replica-b"),
      ],
      authority: authority(),
      registry: {
        providers: new Map<string, StateProvider>([
          [primary.id, primary],
          [replicaA.id, replicaA],
          [replicaB.id, replicaB],
        ]),
      },
      journal,
      now,
    })).rejects.toBeInstanceOf(ReconciliationApplyError);

    const recorded = await events(journal);
    const failure = recorded.find((event) => event.type === "reconciliation.failed");
    expect(replicaA.read("replica-a-atlas").deadline).toBe("canonical");
    expect(replicaBState.read("replica-b-atlas").deadline).toBe("old-b");
    expect(failure?.type === "reconciliation.failed" ? failure.payload.applied : [])
      .toHaveLength(1);
    expect(failure?.type === "reconciliation.failed" ? failure.payload.error.name : undefined)
      .toBe("ProviderWriteError");
    expect(indeterminateMutations(recorded)).toHaveLength(0);
  });
});
