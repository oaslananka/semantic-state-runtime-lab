import { afterEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type {
  ExternalBinding,
  StateValue,
} from "@ssrl/core";
import {
  InMemoryStateProvider,
  type StateProvider,
} from "@ssrl/runtime";
import {
  InMemoryEntityRuntimeCatalog,
  RuntimeHost,
  type RuntimeAccessPolicy,
  type RuntimePrincipal,
} from "@ssrl/runtime-host";
import {
  MCP_TOOL_NAMES,
  createRuntimeMcpServer,
  mcpApplyOutputSchema,
  mcpPlanOutputSchema,
} from "../src/index.js";

const entityId = "entity://project/atlas" as const;
const openConnections: Array<{
  readonly client: Client;
  readonly server: ReturnType<typeof createRuntimeMcpServer>;
}> = [];

afterEach(async () => {
  await Promise.all(openConnections.splice(0).map(async ({ client, server }) => {
    await client.close();
    await server.close();
  }));
});

function field(
  canonical: string,
  external: string,
  writable: boolean,
): ExternalBinding["fields"][number] {
  return {
    canonical,
    external,
    readable: true,
    writable,
  };
}

function binding(provider: string, writable: boolean): ExternalBinding {
  return {
    entityId,
    provider,
    externalId: `${provider}-atlas`,
    fields: [
      field("Project.deadline", "deadline", writable),
      field("Project.secret", "secret", writable),
    ],
  };
}

function stateProviders(
  primaryValues: Readonly<Record<string, StateValue>> = {
    deadline: "2026-11-20",
    secret: "TOP-SECRET",
  },
  replicaValues: Readonly<Record<string, StateValue>> = {
    deadline: "2026-11-15",
    secret: "old-secret",
  },
) {
  const now = () => "2026-09-24T00:00:00Z";
  const primary = new InMemoryStateProvider(
    "primary",
    [{ externalId: "primary-atlas", values: primaryValues }],
    now,
  );
  const replica = new InMemoryStateProvider(
    "replica",
    [{ externalId: "replica-atlas", values: replicaValues }],
    now,
  );
  return { primary, replica };
}

function registry(...providers: StateProvider[]) {
  return {
    providers: new Map(providers.map((provider) => [provider.id, provider])),
  };
}

function catalog() {
  return new InMemoryEntityRuntimeCatalog([{
    entityId,
    bindings: [
      binding("primary", false),
      binding("replica", true),
    ],
    authority: [
      {
        property: "Project.deadline",
        strategy: { kind: "provider" as const, provider: "primary" },
      },
      {
        property: "Project.secret",
        strategy: { kind: "provider" as const, provider: "primary" },
      },
    ],
  }]);
}

function policy(counter?: { calls: number }): RuntimeAccessPolicy {
  return {
    evaluate(request) {
      if (counter !== undefined) counter.calls += 1;

      if (request.kind === "operation") {
        const scope = request.operation === "plan" ? "state:read" : "state:write";
        return request.principal.scopes.includes(scope)
          ? { effect: "allow" }
          : { effect: "deny", code: `missing-${scope}` };
      }

      if (request.kind === "field") {
        if (request.canonicalProperty === "Project.secret") {
          return { effect: "deny", code: "secret-denied" };
        }
        const scope = request.operation === "read" ? "state:read" : "state:write";
        return request.principal.scopes.includes(scope)
          ? { effect: "allow" }
          : { effect: "deny", code: `missing-${scope}` };
      }

      return request.principal.scopes.includes("state:write")
        ? { effect: "allow" }
        : { effect: "deny", code: "proposal-write-denied" };
    },
  };
}

function host(
  providers: ReturnType<typeof stateProviders>,
  accessPolicy: RuntimeAccessPolicy = policy(),
  replicaOverride?: StateProvider,
): RuntimeHost {
  return new RuntimeHost({
    catalog: catalog(),
    registry: registry(providers.primary, replicaOverride ?? providers.replica),
    accessPolicy,
  });
}

async function connect(
  runtimeHost: RuntimeHost,
  principal: RuntimePrincipal,
) {
  const server = createRuntimeMcpServer({
    host: runtimeHost,
    principal,
    name: "ssrl-test",
    version: "1.0.0",
  });
  const client = new Client({
    name: "ssrl-test-client",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openConnections.push({ client, server });
  return client;
}

const alice: RuntimePrincipal = {
  subject: "user:alice",
  scopes: ["state:read", "state:write"],
};

const reader: RuntimePrincipal = {
  subject: "user:reader",
  scopes: ["state:read"],
};

function planOutput(result: { readonly structuredContent?: unknown }) {
  return mcpPlanOutputSchema.parse(result.structuredContent);
}

function applyOutput(result: { readonly structuredContent?: unknown }) {
  return mcpApplyOutputSchema.parse(result.structuredContent);
}

describe("MCP runtime adapter", () => {
  it("exposes exactly plan and apply with safety annotations", async () => {
    const providers = stateProviders();
    const client = await connect(host(providers), alice);

    const listed = await client.listTools();
    const tools = [...listed.tools].sort((a, b) => a.name.localeCompare(b.name));

    expect(tools.map((tool) => tool.name)).toEqual([
      MCP_TOOL_NAMES.apply,
      MCP_TOOL_NAMES.plan,
    ]);
    const applyTool = tools.find((tool) => tool.name === MCP_TOOL_NAMES.apply);
    const planTool = tools.find((tool) => tool.name === MCP_TOOL_NAMES.plan);

    expect(planTool?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(applyTool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
  });

  it("plans policy-filtered state and never returns denied secret values", async () => {
    const providers = stateProviders();
    const client = await connect(host(providers), alice);

    const result = await client.callTool({
      name: MCP_TOOL_NAMES.plan,
      arguments: { entityId },
    });
    const serialized = JSON.stringify(result);

    expect(result.isError).not.toBe(true);
    const output = planOutput(result);
    expect(output).toMatchObject({
      schemaVersion: "1",
      entityId,
      status: "ready",
      digestAlgorithm: "sha256",
    });
    expect(output.proposalDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(serialized).not.toContain("TOP-SECRET");
    expect(serialized).not.toContain("old-secret");
    expect(serialized).not.toContain("Project.secret");
  });

  it("applies the exact returned digest and converges allowed state", async () => {
    const providers = stateProviders();
    const client = await connect(host(providers), alice);

    const planned = await client.callTool({
      name: MCP_TOOL_NAMES.plan,
      arguments: { entityId },
    });
    const digest = planOutput(planned).proposalDigest;

    const applied = await client.callTool({
      name: MCP_TOOL_NAMES.apply,
      arguments: {
        entityId,
        proposalDigest: digest,
      },
    });

    expect(applied.isError).not.toBe(true);
    expect(applyOutput(applied)).toMatchObject({
      schemaVersion: "1",
      entityId,
      appliedCount: 1,
      converged: true,
      remainingMutationCount: 0,
      conflictCount: 0,
    });
    expect(providers.replica.read("replica-atlas")).toEqual({
      deadline: "2026-11-20",
      secret: "old-secret",
    });
  });

  it("returns proposal_drifted and performs zero writes for a stale digest", async () => {
    const providers = stateProviders();
    let applyCalls = 0;
    const replica: StateProvider = {
      id: providers.replica.id,
      observe: (externalBinding) => providers.replica.observe(externalBinding),
      async apply(mutation) {
        applyCalls += 1;
        await providers.replica.apply(mutation);
      },
    };
    const client = await connect(host(providers, policy(), replica), alice);

    const planned = await client.callTool({
      name: MCP_TOOL_NAMES.plan,
      arguments: { entityId },
    });
    const digest = planOutput(planned).proposalDigest;

    providers.replica.mutateExternally(
      "replica-atlas",
      "deadline",
      "2026-11-19",
    );

    const applied = await client.callTool({
      name: MCP_TOOL_NAMES.apply,
      arguments: {
        entityId,
        proposalDigest: digest,
      },
    });

    expect(applied.isError).toBe(true);
    expect(JSON.stringify(applied)).toContain("proposal_drifted:");
    expect(JSON.stringify(applied)).not.toMatch(/ReconciliationPlanDriftError|stack|actualDigest/);
    expect(applyCalls).toBe(0);
  });

  it("does not let a read-only principal reuse another principal's valid digest", async () => {
    const providers = stateProviders();
    const aliceClient = await connect(host(providers), alice);
    const readerClient = await connect(host(providers), reader);

    const planned = await aliceClient.callTool({
      name: MCP_TOOL_NAMES.plan,
      arguments: { entityId },
    });
    const digest = planOutput(planned).proposalDigest;

    const result = await readerClient.callTool({
      name: MCP_TOOL_NAMES.apply,
      arguments: {
        entityId,
        proposalDigest: digest,
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("access_denied:");
    expect(providers.replica.read("replica-atlas").deadline).toBe("2026-11-15");
  });

  it("rejects malformed tool input before RuntimeHost policy evaluation", async () => {
    const providers = stateProviders();
    const counter = { calls: 0 };
    const client = await connect(host(providers, policy(counter)), alice);

    await expect(client.callTool({
      name: MCP_TOOL_NAMES.plan,
      arguments: { entityId: "not-an-entity-id" },
    })).rejects.toThrow();

    expect(counter.calls).toBe(0);
  });

  it("never serializes unexpected error stacks, causes, scopes, or secret messages", async () => {
    const providers = stateProviders();
    const explodingPolicy: RuntimeAccessPolicy = {
      evaluate() {
        const error = new Error("oauth-token-like-secret");
        error.stack = "STACK oauth-token-like-secret state:write";
        throw error;
      },
    };
    const client = await connect(host(providers, explodingPolicy), alice);

    const result = await client.callTool({
      name: MCP_TOOL_NAMES.plan,
      arguments: { entityId },
    });
    const serialized = JSON.stringify(result);

    expect(result.isError).toBe(true);
    expect(serialized).toContain("internal_error:");
    expect(serialized).not.toContain("oauth-token-like-secret");
    expect(serialized).not.toContain("state:write");
    expect(serialized).not.toContain("STACK");
  });
});
