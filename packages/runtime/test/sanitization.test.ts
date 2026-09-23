import { describe, expect, it } from "vitest";
import type { ExternalBinding } from "@ssrl/core";
import { InMemoryEventJournal } from "@ssrl/journal";
import {
  reconcileOnce,
  type StateProvider,
} from "../src/index.js";

const entityId = "entity://project/atlas" as const;

describe("runtime observation sanitization", () => {
  it("drops provider-returned values that are not declared readable before planning or journaling", async () => {
    const binding: ExternalBinding = {
      entityId,
      provider: "leaky",
      externalId: "atlas",
      fields: [{
        canonical: "Project.deadline",
        external: "deadline",
        readable: true,
        writable: false,
      }],
    };
    const provider: StateProvider = {
      id: "leaky",
      async observe() {
        return {
          binding,
          revision: "leaky:1",
          observedAt: "2026-09-24T00:00:00Z",
          values: {
            deadline: "2026-11-20",
            secret: "TOP-SECRET",
          },
        };
      },
      async apply() {
        throw new Error("apply should not be called");
      },
    };
    const journal = new InMemoryEventJournal();

    const result = await reconcileOnce({
      entityId,
      bindings: [binding],
      registry: {
        providers: new Map([[provider.id, provider]]),
      },
      dryRun: true,
      journal,
      now: () => "2026-09-24T00:01:00Z",
    });

    expect(result.before.canonical.properties["Project.deadline"]?.value)
      .toBe("2026-11-20");

    const events = await journal.eventsForEntity(entityId);
    const observation = events.find((event) => event.type === "observation.recorded");
    expect(observation?.type === "observation.recorded"
      ? observation.payload.snapshot.values
      : undefined).toEqual({ deadline: "2026-11-20" });
    expect(JSON.stringify(events)).not.toContain("TOP-SECRET");
  });
});
