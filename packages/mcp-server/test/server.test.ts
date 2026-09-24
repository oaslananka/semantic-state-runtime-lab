import { afterEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type {
  EntityId,
  ExternalBinding,
  StateValue,
} from "@ssrl/core";
import {
  ContextAccessDeniedError,
  ContextAccessSynchronizationLimitError,
  ContextIdentityCandidateLimitError,
  ContextRelationCandidateLimitError,
} from "@ssrl/context-access";
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
  mcpContextCompileOutputSchema,
  mcpPlanOutputSchema,
  type RuntimeMcpContextGateway,
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
  context?: RuntimeMcpContextGateway,
) {
  const server = createRuntimeMcpServer({
    host: runtimeHost,
    principal,
    ...(context === undefined ? {} : { context: { gateway: context } }),
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

function contextOutput(result: { readonly structuredContent?: unknown }) {
  return mcpContextCompileOutputSchema.parse(result.structuredContent);
}

interface ContextGatewayCall {
  readonly principal?: RuntimePrincipal;
  readonly task: string;
  readonly budgetTokens: number;
}

function contextGateway(
  calls: ContextGatewayCall[] = [],
): RuntimeMcpContextGateway {
  return {
    async compile(request) {
      calls.push({
        ...(request.principal === undefined ? {} : { principal: request.principal }),
        task: request.task,
        budgetTokens: request.budgetTokens,
      });
      return {
        resolution: {
          status: "resolved",
          entityId,
          entityType: "Project",
        },
        context: {
          records: [
            {
              id: "capsule-state:atlas:deadline",
              entityId,
              kind: "state",
              text: "Project deadline: 2026-11-20.",
              evidenceRefs: ["artifact:visible"],
            },
            {
              id: "capsule-state:alice:timezone",
              entityId: "entity://person/alice" as EntityId,
              kind: "state",
              text: "Timezone: Europe/Istanbul.",
            },
          ],
          resolvedEntityIds: [entityId],
          estimatedTokens: 29,
          consideredRecords: 2,
        },
        relatedEntityIds: ["entity://person/alice" as EntityId],
      };
    },
  };
}

function throwingContextGateway(error: unknown): RuntimeMcpContextGateway {
  return { async compile() { throw error; } };
}

async function callContext(
  client: Client,
  task = "Atlas",
  budgetTokens = 100,
) {
  return client.callTool({
    name: MCP_TOOL_NAMES.context,
    arguments: { task, budgetTokens },
  });
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

  it("registers context.compile only when a context gateway is configured", async () => {
    const providers = stateProviders();
    const client = await connect(host(providers), alice, contextGateway());

    const listed = await client.listTools();
    const contextTool = listed.tools.find((tool) => tool.name === MCP_TOOL_NAMES.context);

    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      MCP_TOOL_NAMES.apply,
      MCP_TOOL_NAMES.context,
      MCP_TOOL_NAMES.plan,
    ].sort());
    expect(contextTool?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("delegates context.compile to the configured gateway with the server principal", async () => {
    const providers = stateProviders();
    const calls: ContextGatewayCall[] = [];
    const client = await connect(host(providers), alice, contextGateway(calls));

    const result = await callContext(client, "Project Atlas deadline", 200);
    const output = contextOutput(result);

    expect(result.isError).not.toBe(true);
    expect(calls).toEqual([{
      principal: alice,
      task: "Project Atlas deadline",
      budgetTokens: 200,
    }]);
    expect(output).toEqual({
      schemaVersion: "1",
      resolution: { status: "resolved", entityId, entityType: "Project" },
      records: [
        {
          id: "capsule-state:atlas:deadline",
          entityId,
          kind: "state",
          text: "Project deadline: 2026-11-20.",
          evidenceRefs: ["artifact:visible"],
        },
        {
          id: "capsule-state:alice:timezone",
          entityId: "entity://person/alice",
          kind: "state",
          text: "Timezone: Europe/Istanbul.",
        },
      ],
      resolvedEntityIds: [entityId],
      relatedEntityIds: ["entity://person/alice"],
      estimatedTokens: 29,
      consideredRecords: 2,
    });
    expect(output.estimatedTokens).toBeLessThanOrEqual(200);
    expect(JSON.stringify(result.content)).not.toContain("Project Atlas deadline");
    expect(JSON.stringify(result.content)).not.toContain("2026-11-20");
    expect(JSON.stringify(result.content)).not.toContain("Europe/Istanbul");
  });

  it("returns sanitized visible ambiguity from the context gateway", async () => {
    const providers = stateProviders();
    const gateway: RuntimeMcpContextGateway = {
      async compile() {
        return {
          resolution: {
            status: "ambiguous",
            candidates: [
              { entityId, entityType: "Project" },
              { entityId: "entity://person/atlas", entityType: "Person" },
            ],
          },
          context: {
            records: [],
            resolvedEntityIds: [],
            estimatedTokens: 0,
            consideredRecords: 0,
          },
          relatedEntityIds: [],
        };
      },
    };
    const client = await connect(host(providers), alice, gateway);

    const result = await callContext(client, "Atlas", 80);

    expect(contextOutput(result).resolution).toEqual({
      status: "ambiguous",
      candidates: [
        { entityId, entityType: "Project" },
        { entityId: "entity://person/atlas", entityType: "Person" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("evidenceRefs");
  });

  it("rejects malformed context input before invoking the gateway", async () => {
    const providers = stateProviders();
    const calls: ContextGatewayCall[] = [];
    const client = await connect(host(providers), alice, contextGateway(calls));

    const result = await client.callTool({
      name: MCP_TOOL_NAMES.context,
      arguments: { task: "   ", budgetTokens: 0 },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Input validation error");
    expect(calls).toEqual([]);
  });

  it("strips unknown gateway fields from successful context output", async () => {
    const providers = stateProviders();
    const gateway: RuntimeMcpContextGateway = {
      async compile() {
        return {
          resolution: {
            status: "resolved",
            entityId,
            entityType: "Project",
            privateAliasEvidence: "must-not-leak",
          },
          context: {
            records: [{
              id: "safe-record",
              entityId,
              kind: "state",
              text: "Safe context.",
              privatePolicyCode: "must-not-leak",
            }],
            resolvedEntityIds: [entityId],
            estimatedTokens: 8,
            consideredRecords: 1,
            privateDebug: "must-not-leak",
          },
          relatedEntityIds: [],
          privateGatewayTrace: "must-not-leak",
        } as never;
      },
    };
    const client = await connect(host(providers), alice, gateway);

    const result = await client.callTool({
      name: MCP_TOOL_NAMES.context,
      arguments: { task: "Project Atlas", budgetTokens: 100 },
    });
    const serialized = JSON.stringify(result.structuredContent);

    expect(result.isError).not.toBe(true);
    expect(mcpContextCompileOutputSchema.parse(result.structuredContent).records)
      .toEqual([expect.objectContaining({ id: "safe-record" })]);
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("privatePolicyCode");
    expect(serialized).not.toContain("privateGatewayTrace");
  });

  it("rejects a gateway result that exceeds the caller's requested token budget", async () => {
    const providers = stateProviders();
    const gateway: RuntimeMcpContextGateway = {
      async compile() {
        return {
          resolution: { status: "resolved", entityId, entityType: "Project" },
          context: {
            records: [],
            resolvedEntityIds: [entityId],
            estimatedTokens: 101,
            consideredRecords: 0,
          },
          relatedEntityIds: [],
        };
      },
    };
    const client = await connect(host(providers), alice, gateway);

    const result = await client.callTool({
      name: MCP_TOOL_NAMES.context,
      arguments: { task: "Project Atlas", budgetTokens: 100 },
    });
    const serialized = JSON.stringify(result);

    expect(result.isError).toBe(true);
    expect(serialized).toContain(
      "context_request_rejected: Context request was rejected by server limits.",
    );
    expect(serialized).not.toContain("exceeded requested token budget");
  });

  it("rejects caller-supplied principal or historical fields before the gateway", async () => {
    const providers = stateProviders();
    const calls: ContextGatewayCall[] = [];
    const client = await connect(host(providers), alice, contextGateway(calls));

    for (const argumentsValue of [
      {
        task: "Project Atlas",
        budgetTokens: 100,
        principal: { subject: "user:mallory", scopes: ["context:read"] },
      },
      {
        task: "Project Atlas",
        budgetTokens: 100,
        validAt: "2025-01-01T00:00:00Z",
      },
      {
        task: "Project Atlas",
        budgetTokens: 100,
        knownAt: "2025-01-01T00:00:00Z",
      },
    ]) {
      const result = await client.callTool({
        name: MCP_TOOL_NAMES.context,
        arguments: argumentsValue,
      });
      expect(result.isError).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  it("sanitizes context access denials without exposing policy codes or task text", async () => {
    const providers = stateProviders();
    const gateway = throwingContextGateway(
      new ContextAccessDeniedError("private-policy-code-project-atlas"),
    );
    const client = await connect(host(providers), alice, gateway);

    const result = await callContext(client, "private task text");
    const serialized = JSON.stringify(result);

    expect(result.isError).toBe(true);
    expect(serialized).toContain("access_denied: Access denied.");
    expect(serialized).not.toContain("private-policy-code-project-atlas");
    expect(serialized).not.toContain("private task text");
  });

  it("sanitizes context candidate and synchronization limits", async () => {
    const providers = stateProviders();
    const errors = [
      new ContextIdentityCandidateLimitError(7),
      new ContextRelationCandidateLimitError(5),
      new ContextAccessSynchronizationLimitError(),
    ];
    for (const error of errors) {
      const client = await connect(host(providers), alice, throwingContextGateway(error));
      const result = await callContext(client);
      const serialized = JSON.stringify(result);

      expect(result.isError).toBe(true);
      expect(serialized).not.toContain(error.message);
      expect(serialized).not.toContain(error.name);
    }
  });

  it("maps context request-limit and unexpected failures to fixed safe messages", async () => {
    const providers = stateProviders();
    const cases = [
      {
        error: new RangeError("private configured max=41"),
        expected: "context_request_rejected: Context request was rejected by server limits.",
      },
      {
        error: Object.assign(new Error("private context backend secret"), {
          stack: "STACK private context backend secret bearer-token-like-value",
        }),
        expected: "internal_error: Internal server error.",
      },
    ];

    for (const testCase of cases) {
      const client = await connect(
        host(providers),
        alice,
        throwingContextGateway(testCase.error),
      );
      const result = await callContext(client, "private context task");
      const serialized = JSON.stringify(result);

      expect(result.isError).toBe(true);
      expect(serialized).toContain(testCase.expected);
      expect(serialized).not.toContain(testCase.error.message);
      expect(serialized).not.toContain("private context task");
      expect(serialized).not.toContain("STACK");
      expect(serialized).not.toContain("bearer-token-like-value");
    }
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

    const result = await client.callTool({
      name: MCP_TOOL_NAMES.plan,
      arguments: { entityId: "not-an-entity-id" },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Input validation error");
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
