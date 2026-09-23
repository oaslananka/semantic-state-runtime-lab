import { describe, expect, it } from "vitest";
import type { ExternalBinding, Mutation } from "@ssrl/core";
import {
  InMemoryStateProvider,
  reconcileOnce,
  type StateProvider,
} from "@ssrl/runtime";
import {
  validateConnectorManifest,
  type ConnectorManifest,
  type ManifestedStateProvider,
} from "../src/index.js";

function manifest(id: string): ConnectorManifest {
  return {
    schemaVersion: "0.1",
    id,
    displayName: `Test connector ${id}`,
    capabilities: {
      read: true,
      write: true,
      observe: true,
      subscribe: false,
      revisions: "opaque",
      idempotency: "none",
    },
    entities: [{
      canonicalType: "Project",
      externalType: "project",
      fields: [{
        canonical: "Project.deadline",
        external: "deadline",
        access: ["read", "write"],
        authorityHint: "replica",
      }],
    }],
  };
}

class TestConnector implements ManifestedStateProvider {
  readonly id: string;
  readonly manifest: ConnectorManifest;
  readonly #inner: StateProvider;

  constructor(id: string, deadline: string) {
    this.id = id;
    this.manifest = manifest(id);
    this.#inner = new InMemoryStateProvider(id, [{
      externalId: `${id}-atlas`,
      values: { deadline },
    }], () => "2026-09-23T12:00:00Z");
  }

  observe(binding: ExternalBinding) {
    return this.#inner.observe(binding);
  }

  apply(mutation: Mutation) {
    return this.#inner.apply(mutation);
  }
}

function binding(provider: string): ExternalBinding {
  return {
    entityId: "entity://project/atlas",
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

describe("connector manifest", () => {
  it("accepts a coherent manifest", () => {
    expect(() => validateConnectorManifest(manifest("primary"))).not.toThrow();
  });

  it("rejects field capabilities the connector does not expose", () => {
    const invalid: ConnectorManifest = {
      ...manifest("readonly"),
      capabilities: {
        ...manifest("readonly").capabilities,
        write: false,
      },
    };
    expect(() => validateConnectorManifest(invalid)).toThrow(/write capability/);
  });

  it("rejects duplicate semantic field mappings", () => {
    const base = manifest("duplicate");
    const invalid: ConnectorManifest = {
      ...base,
      entities: [{
        ...base.entities[0]!,
        fields: [
          ...base.entities[0]!.fields,
          {
            canonical: "Project.deadline",
            external: "otherDeadline",
            access: ["read"],
          },
        ],
      }],
    };
    expect(() => validateConnectorManifest(invalid)).toThrow(/Duplicate canonical field/);
  });

  it("plugs a manifested connector into reconciliation without core changes", async () => {
    const primary = new TestConnector("primary", "2026-11-20");
    const replica = new TestConnector("replica", "2026-11-15");

    const result = await reconcileOnce({
      entityId: "entity://project/atlas",
      bindings: [binding("primary"), binding("replica")],
      authority: [{
        property: "Project.deadline",
        strategy: { kind: "provider", provider: "primary" },
      }],
      registry: {
        providers: new Map([
          [primary.id, primary],
          [replica.id, replica],
        ]),
      },
    });

    expect(result.applied).toHaveLength(1);
    expect(result.after?.mutations).toHaveLength(0);
    expect(result.after?.conflicts).toHaveLength(0);
  });
});
