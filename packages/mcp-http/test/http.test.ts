import { afterEach, describe, expect, it } from "vitest";
import {
  Client,
  InsufficientScopeError,
  StreamableHTTPClientTransport,
  type FetchLike,
} from "@modelcontextprotocol/client";
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactAccessGateway } from "@ssrl/artifact-access";
import {
  artifactResourceUri,
  type ArtifactResourceIdentity,
} from "@ssrl/artifact-store";
import type { ExternalBinding, StateValue } from "@ssrl/core";
import { ContextAccessDeniedError } from "@ssrl/context-access";
import {
  MCP_TOOL_NAMES,
  mcpContextCompileOutputSchema,
  mcpPlanOutputSchema,
  type RuntimeMcpContextGateway,
} from "@ssrl/mcp-server";
import {
  InMemoryStateProvider,
  type StateProvider,
} from "@ssrl/runtime";
import {
  InMemoryEntityRuntimeCatalog,
  RuntimeHost,
  type RuntimeAccessPolicy,
} from "@ssrl/runtime-host";
import { LocalArtifactStore } from "@ssrl/storage-local-artifacts";
import {
  McpPrincipalMappingError,
  createAuthenticatedRuntimeMcpHttpHandler,
  subjectClaimPrincipalMapper,
  type AuthenticatedRuntimeMcpHttpHandler,
  type McpAuthPrincipalMapper,
  type VerifiedMcpAuthContext,
} from "../src/index.js";

const entityId = "entity://project/atlas" as const;
const endpointUrl = new URL("http://localhost/mcp");
const roots: string[] = [];
const clients: Client[] = [];
const handlers: AuthenticatedRuntimeMcpHttpHandler[] = [];

interface TokenRecord {
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
  readonly sub?: string;
}

class FakeVerifier implements OAuthTokenVerifier {
  calls = 0;

  constructor(readonly tokens: ReadonlyMap<string, TokenRecord>) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    this.calls += 1;
    const record = this.tokens.get(token);
    if (record === undefined) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "test token is invalid");
    }
    return {
      token,
      clientId: record.clientId,
      scopes: [...record.scopes],
      expiresAt: record.expiresAt,
      extra: record.sub === undefined
        ? { rawClaim: "mapper-private-claim" }
        : { sub: record.sub, rawClaim: "mapper-private-claim" },
    };
  }
}

function authRecords(nowSeconds: number): Map<string, TokenRecord> {
  return new Map([
    ["alice-read-token", {
      clientId: "client:desktop",
      scopes: ["mcp", "state:read", "artifact:read"],
      expiresAt: nowSeconds + 3_600,
      sub: "alice",
    }],
    ["alice-write-token", {
      clientId: "client:desktop",
      scopes: ["mcp", "state:read", "state:write", "artifact:read"],
      expiresAt: nowSeconds + 3_600,
      sub: "alice",
    }],
    ["alice-context-token", {
      clientId: "client:desktop",
      scopes: ["mcp", "context:read"],
      expiresAt: nowSeconds + 3_600,
      sub: "alice",
    }],
    ["bob-read-token", {
      clientId: "client:desktop",
      scopes: ["mcp", "state:read"],
      expiresAt: nowSeconds + 3_600,
      sub: "bob",
    }],
    ["bob-artifact-token", {
      clientId: "client:desktop",
      scopes: ["mcp", "state:read", "artifact:read"],
      expiresAt: nowSeconds + 3_600,
      sub: "bob",
    }],
    ["no-mcp-scope-token", {
      clientId: "client:desktop",
      scopes: ["state:read"],
      expiresAt: nowSeconds + 3_600,
      sub: "alice",
    }],
    ["expired-token", {
      clientId: "client:desktop",
      scopes: ["mcp", "state:read"],
      expiresAt: nowSeconds - 10,
      sub: "alice",
    }],
    ["no-sub-token", {
      clientId: "client:desktop",
      scopes: ["mcp", "state:read"],
      expiresAt: nowSeconds + 3_600,
    }],
  ]);
}

function field(canonical: string, external: string, writable: boolean): ExternalBinding["fields"][number] {
  return { canonical, external, readable: true, writable };
}

function binding(provider: string, writable: boolean): ExternalBinding {
  return {
    entityId,
    provider,
    externalId: `${provider}-atlas`,
    fields: [field("Project.deadline", "deadline", writable)],
  };
}

function stateFixture(
  subjects: string[] = [],
  principals: string[] = [],
  operations: string[] = [],
) {
  const now = () => "2026-09-24T00:00:00Z";
  const primary = new InMemoryStateProvider(
    "primary",
    [{ externalId: "primary-atlas", values: { deadline: "2026-11-20" } }],
    now,
  );
  const replica = new InMemoryStateProvider(
    "replica",
    [{ externalId: "replica-atlas", values: { deadline: "2026-11-15" } }],
    now,
  );
  const policy: RuntimeAccessPolicy = {
    evaluate(request) {
      subjects.push(request.principal.subject);
      principals.push(JSON.stringify(request.principal));
      if (request.principal.subject === "user:bob") {
        return { effect: "deny", code: "bob-not-delegated" };
      }
      if (request.kind === "operation") {
        operations.push(request.operation);
        const scope = request.operation === "plan" ? "state:read" : "state:write";
        return request.principal.scopes.includes(scope)
          ? { effect: "allow" }
          : { effect: "deny", code: `missing-${scope}` };
      }
      if (request.kind === "field") {
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
  const catalog = new InMemoryEntityRuntimeCatalog([{
    entityId,
    bindings: [binding("primary", false), binding("replica", true)],
    authority: [{
      property: "Project.deadline",
      strategy: { kind: "provider" as const, provider: "primary" },
    }],
  }]);
  const registry = {
    providers: new Map<string, StateProvider>([
      [primary.id, primary],
      [replica.id, replica],
    ]),
  };
  return {
    primary,
    replica,
    host: new RuntimeHost({ catalog, registry, accessPolicy: policy }),
  };
}

async function artifactFixture() {
  const root = await mkdtemp(join(tmpdir(), "ssrl-mcp-http-artifact-"));
  roots.push(root);
  const store = new LocalArtifactStore({ root });
  const resource: ArtifactResourceIdentity = {
    sourceKey: "markdown/personal",
    externalType: "markdown-note",
    externalId: "Projects/Atlas.md",
  };
  const blob = await store.putBlob(new TextEncoder().encode("# Atlas\nprivate body\n"), "text/markdown");
  await store.append([{
    id: "atlas-v1",
    resource,
    kind: "upsert",
    effectiveAt: "2026-09-01T00:00:00Z",
    recordedAt: "2026-09-01T00:01:00Z",
    title: "Atlas",
    blob,
  }]);
  const gateway = new ArtifactAccessGateway({
    store,
    policy: {
      evaluate(request) {
        return request.principal.subject === "user:alice"
          && request.principal.scopes.includes("artifact:read")
          ? { effect: "allow" }
          : { effect: "deny", code: "artifact-not-delegated" };
      },
    },
    now: () => "2026-09-24T00:00:00Z",
  });
  return { store, resource, gateway };
}

interface HttpContextGatewayCall {
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly task: string;
  readonly budgetTokens: number;
}

function contextGateway(
  calls: HttpContextGatewayCall[] = [],
): RuntimeMcpContextGateway {
  return {
    async compile(request) {
      if (request.principal === undefined) throw new Error("expected authenticated principal");
      calls.push({
        subject: request.principal.subject,
        scopes: request.principal.scopes,
        task: request.task,
        budgetTokens: request.budgetTokens,
      });
      return {
        resolution: { status: "resolved", entityId, entityType: "Project" },
        context: {
          records: [{
            id: "http-context-deadline",
            entityId,
            kind: "state",
            text: "Project deadline: 2026-11-20.",
          }],
          resolvedEntityIds: [entityId],
          estimatedTokens: 16,
          consideredRecords: 1,
        },
        relatedEntityIds: [],
      };
    },
  };
}

function webFetch(handler: AuthenticatedRuntimeMcpHttpHandler): FetchLike {
  return async (input, init) => {
    const request = input instanceof Request
      ? new Request(input, init)
      : new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set("host", new URL(request.url).host);
    return handler.fetch(new Request(request, { headers }));
  };
}

function buildHandler(options: {
  readonly host: RuntimeHost;
  readonly verifier: OAuthTokenVerifier;
  readonly mapper?: McpAuthPrincipalMapper;
  readonly artifacts?: Awaited<ReturnType<typeof artifactFixture>>["gateway"];
  readonly context?: RuntimeMcpContextGateway;
  readonly maxRequestBodySize?: number;
}) {
  const handler = createAuthenticatedRuntimeMcpHttpHandler({
    host: options.host,
    verifier: options.verifier,
    principalMapper: options.mapper ?? subjectClaimPrincipalMapper({ prefix: "user:" }),
    allowedHostnames: ["localhost"],
    allowedOriginHostnames: ["localhost"],
    endpointScopes: ["mcp"],
    ...(options.artifacts === undefined ? {} : { artifacts: { gateway: options.artifacts } }),
    ...(options.context === undefined ? {} : { context: { gateway: options.context } }),
    ...(options.maxRequestBodySize === undefined
      ? {}
      : { maxRequestBodySize: options.maxRequestBodySize }),
    resourceMetadataUrl: "https://example.test/.well-known/oauth-protected-resource/mcp",
    name: "ssrl-http-test",
    version: "1.0.0",
  });
  handlers.push(handler);
  return handler;
}

function httpRuntime(options: {
  readonly subjects?: string[];
  readonly principals?: string[];
  readonly operations?: string[];
  readonly mapper?: McpAuthPrincipalMapper;
  readonly artifacts?: Awaited<ReturnType<typeof artifactFixture>>["gateway"];
  readonly context?: RuntimeMcpContextGateway;
  readonly maxRequestBodySize?: number;
} = {}) {
  const verifier = new FakeVerifier(authRecords(Math.floor(Date.now() / 1000)));
  const runtime = stateFixture(
    options.subjects ?? [],
    options.principals ?? [],
    options.operations ?? [],
  );
  const handler = buildHandler({
    host: runtime.host,
    verifier,
    ...(options.mapper === undefined ? {} : { mapper: options.mapper }),
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    ...(options.context === undefined ? {} : { context: options.context }),
    ...(options.maxRequestBodySize === undefined
      ? {}
      : { maxRequestBodySize: options.maxRequestBodySize }),
  });
  return { verifier, runtime, handler };
}

async function modernClient(
  handler: AuthenticatedRuntimeMcpHttpHandler,
  token: string,
  clientName = "ssrl-http-test-client",
) {
  const transport = new StreamableHTTPClientTransport(endpointUrl, {
    authProvider: { token: async () => token },
    fetch: webFetch(handler),
    onInsufficientScope: "throw",
  });
  const client = new Client(
    { name: clientName, version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(transport);
  clients.push(client);
  return { client, transport };
}

function rawRequest(
  token: string | undefined,
  options: {
    readonly host?: string;
    readonly origin?: string;
    readonly body?: string;
    readonly method?: string;
    readonly url?: URL;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): Request {
  const headers = new Headers({
    host: options.host ?? "localhost",
    "content-type": "application/json",
    accept: "application/json",
    ...options.headers,
  });
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  if (options.origin !== undefined) headers.set("origin", options.origin);
  const method = options.method ?? "POST";
  return new Request(options.url ?? endpointUrl, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD"
      ? {}
      : {
          body: options.body ?? JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "server/discover",
            params: {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": {
                  name: "raw-test",
                  version: "1.0.0",
                },
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        }),
  });
}

function modernRawRequest(
  token: string | undefined,
  options: {
    readonly protocolVersion?: string;
    readonly mcpMethod?: string;
    readonly includeProtocolVersion?: boolean;
    readonly includeMcpMethod?: boolean;
  } = {},
): Request {
  const headers: Record<string, string> = {};
  if (options.includeProtocolVersion !== false) {
    headers["MCP-Protocol-Version"] = options.protocolVersion ?? "2026-07-28";
  }
  if (options.includeMcpMethod !== false) {
    headers["Mcp-Method"] = options.mcpMethod ?? "server/discover";
  }
  return rawRequest(token, { headers });
}

function modernToolCallRequest(
  token: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Request {
  return rawRequest(token, {
    headers: {
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "raw-modern-tool-client",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(handlers.splice(0).map((handler) => handler.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("authenticated modern MCP HTTP", () => {
  it("connects a pinned 2026-07-28 client without creating a protocol session", async () => {
    const { verifier, runtime, handler } = httpRuntime();
    const { client, transport } = await modernClient(handler, "alice-read-token");

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).toSorted()).toEqual([
      MCP_TOOL_NAMES.apply,
      MCP_TOOL_NAMES.plan,
    ].toSorted());
    expect(client.getProtocolEra()).toBe("modern");
    expect(transport.sessionId).toBeUndefined();
    expect(verifier.calls).toBeGreaterThanOrEqual(2);
  });

  it("maps different bearer tokens to isolated request principals without clientInfo influence", async () => {
    const subjects: string[] = [];
    const { handler } = httpRuntime({ subjects });
    const alice = await modernClient(handler, "alice-read-token", "self-reported-bob");
    const bob = await modernClient(handler, "bob-read-token", "self-reported-admin-root");

    const [alicePlan, bobPlan] = await Promise.all([
      alice.client.callTool({
        name: MCP_TOOL_NAMES.plan,
        arguments: { entityId },
      }),
      bob.client.callTool({
        name: MCP_TOOL_NAMES.plan,
        arguments: { entityId },
      }),
    ]);

    expect(alicePlan.isError).not.toBe(true);
    expect(mcpPlanOutputSchema.parse(alicePlan.structuredContent).entityId).toBe(entityId);
    expect(bobPlan.isError).toBe(true);
    expect(JSON.stringify(bobPlan)).toContain("access_denied:");
    expect(subjects).toContain("user:alice");
    expect(subjects).toContain("user:bob");
    expect(subjects).not.toContain("self-reported-bob");
    expect(subjects).not.toContain("self-reported-admin-root");
  });

  it("plans and applies the exact proposal digest over modern HTTP for a writer token", async () => {
    const { verifier, runtime, handler } = httpRuntime();
    const { client } = await modernClient(handler, "alice-write-token");

    const planned = await client.callTool({
      name: MCP_TOOL_NAMES.plan,
      arguments: { entityId },
    });
    const digest = mcpPlanOutputSchema.parse(planned.structuredContent).proposalDigest;
    const applied = await client.callTool({
      name: MCP_TOOL_NAMES.apply,
      arguments: { entityId, proposalDigest: digest },
    });

    expect(applied.isError).not.toBe(true);
    expect(runtime.replica.read("replica-atlas").deadline).toBe("2026-11-20");
  });

  it("maps the authenticated bearer principal into context.compile over modern HTTP", async () => {
    const calls: HttpContextGatewayCall[] = [];
    const { handler } = httpRuntime({ context: contextGateway(calls) });
    const { client } = await modernClient(handler, "alice-context-token");

    const result = await client.callTool({
      name: MCP_TOOL_NAMES.context,
      arguments: { task: "Project Atlas deadline", budgetTokens: 120 },
    });
    const output = mcpContextCompileOutputSchema.parse(result.structuredContent);

    expect(result.isError).not.toBe(true);
    expect(output.resolution).toEqual({ status: "resolved", entityId, entityType: "Project" });
    expect(output.records).toEqual([
      expect.objectContaining({ id: "http-context-deadline", entityId }),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      subject: "user:alice",
      task: "Project Atlas deadline",
      budgetTokens: 120,
    });
    expect(calls[0]?.scopes).toEqual(expect.arrayContaining(["context:read", "mcp"]));
  });

  it("keeps gateway policy authoritative after the HTTP context scope passes", async () => {
    const gateway: RuntimeMcpContextGateway = {
      async compile() {
        throw new ContextAccessDeniedError("private-context-policy-code");
      },
    };
    const { handler } = httpRuntime({ context: gateway });
    const { client } = await modernClient(handler, "alice-context-token");

    const result = await client.callTool({
      name: MCP_TOOL_NAMES.context,
      arguments: { task: "private project task", budgetTokens: 120 },
    });
    const serialized = JSON.stringify(result);

    expect(result.isError).toBe(true);
    expect(serialized).toContain("access_denied: Access denied.");
    expect(serialized).not.toContain("private-context-policy-code");
    expect(serialized).not.toContain("private project task");
  });

  it("returns a wire-level context:read challenge before the context gateway runs", async () => {
    const calls: HttpContextGatewayCall[] = [];
    const { handler } = httpRuntime({ context: contextGateway(calls) });
    const response = await handler.fetch(modernToolCallRequest(
      "alice-read-token",
      MCP_TOOL_NAMES.context,
      { task: "Project Atlas deadline", budgetTokens: 120 },
    ));
    const challenge = response.headers.get("www-authenticate") ?? "";

    expect(response.status).toBe(403);
    expect(challenge).toContain("insufficient_scope");
    expect(challenge).toContain("context:read");
    expect(challenge).toContain("resource_metadata");
    expect(calls).toEqual([]);
  });

  it("returns a request-time insufficient_scope challenge before state.apply executes", async () => {
    const { verifier, runtime, handler } = httpRuntime();
    const { client } = await modernClient(handler, "alice-read-token");
    const planned = await client.callTool({
      name: MCP_TOOL_NAMES.plan,
      arguments: { entityId },
    });
    const digest = mcpPlanOutputSchema.parse(planned.structuredContent).proposalDigest;

    await expect(client.callTool({
      name: MCP_TOOL_NAMES.apply,
      arguments: { entityId, proposalDigest: digest },
    })).rejects.toBeInstanceOf(InsufficientScopeError);
    expect(runtime.replica.read("replica-atlas").deadline).toBe("2026-11-15");
  });

  it("returns a wire-level state:write scope challenge before the apply callback or policy runs", async () => {
    const operations: string[] = [];
    const { runtime, handler } = httpRuntime({ operations });
    const response = await handler.fetch(modernToolCallRequest(
      "alice-read-token",
      MCP_TOOL_NAMES.apply,
      { entityId, proposalDigest: "not-used-before-scope-preflight" },
    ));
    const challenge = response.headers.get("www-authenticate") ?? "";

    expect(response.status).toBe(403);
    expect(challenge).toContain("insufficient_scope");
    expect(challenge).toContain("state:write");
    expect(challenge).toContain("resource_metadata");
    expect(operations).not.toContain("apply");
    expect(runtime.replica.read("replica-atlas").deadline).toBe("2026-11-15");
  });

  it("serves policy-approved artifact resources with 2026-07-28 private no-cache hints on the wire", async () => {
    const artifact = await artifactFixture();
    const { handler } = httpRuntime({ artifacts: artifact.gateway });
    const { client } = await modernClient(handler, "alice-read-token");
    const uri = await artifactResourceUri(artifact.resource);

    const listed = await client.listResources();
    const read = await client.readResource({ uri });
    expect(listed.resources).toEqual([
      expect.objectContaining({ uri, title: "Atlas", mimeType: "text/markdown" }),
    ]);
    expect(read.contents).toEqual([
      expect.objectContaining({ uri, text: "# Atlas\nprivate body\n" }),
    ]);
    expect((listed as unknown as { ttlMs?: number }).ttlMs).toBe(0);
    expect((listed as unknown as { cacheScope?: string }).cacheScope).toBe("private");
    expect((read as unknown as { ttlMs?: number }).ttlMs).toBe(0);
    expect((read as unknown as { cacheScope?: string }).cacheScope).toBe("private");
    artifact.store.close();
  });

  it("still enforces ArtifactAccessGateway policy after bearer and artifact scope checks pass", async () => {
    const artifact = await artifactFixture();
    const { handler } = httpRuntime({ artifacts: artifact.gateway });
    const { client } = await modernClient(handler, "bob-artifact-token");
    const uri = await artifactResourceUri(artifact.resource);

    expect((await client.listResources()).resources).toEqual([]);
    await expect(client.readResource({ uri })).rejects.toThrow(/not found/i);
    artifact.store.close();
  });

  it("rejects legacy-era remote MCP traffic by default", async () => {
    const { verifier, runtime, handler } = httpRuntime();
    const request = rawRequest("alice-read-token", {
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-client", version: "1.0.0" },
        },
      }),
    });
    const response = await handler.fetch(request);
    const body = await response.text();

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(body).toMatch(/unsupported|protocol/i);
  });

  it("rejects missing, invalid, expired, and base-scope-deficient bearer credentials before MCP dispatch", async () => {
    const { verifier, runtime, handler } = httpRuntime();

    const missing = await handler.fetch(rawRequest(undefined));
    const invalid = await handler.fetch(rawRequest("not-a-token"));
    const expired = await handler.fetch(rawRequest("expired-token"));
    const missingScope = await handler.fetch(rawRequest("no-mcp-scope-token"));

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(expired.status).toBe(401);
    expect(missingScope.status).toBe(403);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");
    expect(invalid.headers.get("www-authenticate")).toContain("invalid_token");
    expect(missingScope.headers.get("www-authenticate")).toContain("insufficient_scope");
    expect(missingScope.headers.get("www-authenticate"))
      .toContain("resource_metadata");
  });

  it("rejects invalid host/origin before token verification", async () => {
    const { verifier, runtime, handler } = httpRuntime();

    const host = await handler.fetch(rawRequest("alice-read-token", { host: "evil.example" }));
    const origin = await handler.fetch(rawRequest("alice-read-token", {
      origin: "https://evil.example",
    }));

    expect(host.status).toBe(403);
    expect(origin.status).toBe(403);
    expect(verifier.calls).toBe(0);
  });

  it("enforces the SDK request-body limit before server factory/principal mapping", async () => {
    let mapperCalls = 0;
    const mapper: McpAuthPrincipalMapper = {
      map(auth) {
        mapperCalls += 1;
        return { subject: `user:${String(auth.extra?.sub)}`, scopes: auth.scopes };
      },
    };
    const { verifier, handler } = httpRuntime({ mapper, maxRequestBodySize: 128 });
    const response = await handler.fetch(rawRequest("alice-read-token", {
      body: JSON.stringify({ padding: "x".repeat(1_000) }),
    }));

    expect(response.status).toBe(413);
    expect(mapperCalls).toBe(0);
    expect(verifier.calls).toBe(1);
  });

  it("fails closed when verified auth cannot be mapped to an explicit subject", async () => {
    const { verifier, runtime, handler } = httpRuntime();
    const response = await handler.fetch(modernRawRequest("no-sub-token"));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain("no-sub-token");
    expect(body).not.toContain("mapper-private-claim");
  });

  it("sanitizes principal-mapper failures and never returns token or extra-claim contents", async () => {
    let mapperCalls = 0;
    const mapper: McpAuthPrincipalMapper = {
      map(_auth: VerifiedMcpAuthContext) {
        mapperCalls += 1;
        throw new Error("mapper-secret rawClaim mapper-private-claim");
      },
    };
    const { handler } = httpRuntime({ mapper });
    const response = await handler.fetch(modernRawRequest("alice-read-token"));
    const text = await response.text();

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mapperCalls).toBe(1);
    expect(text).not.toContain("alice-read-token");
    expect(text).not.toContain("mapper-private-claim");
    expect(text).not.toContain("mapper-secret");
  });

  it("runs principal mapping independently for each modern request and produces the same normalized principal", async () => {
    const observedPrincipals: string[] = [];
    let mapperCalls = 0;
    const mapper: McpAuthPrincipalMapper = {
      map(_auth) {
        mapperCalls += 1;
        return {
          subject: "  user:alice  ",
          scopes: ["state:read", "mcp", "state:read"],
        };
      },
    };
    const { handler } = httpRuntime({ principals: observedPrincipals, mapper });
    const { client } = await modernClient(handler, "alice-read-token");

    await client.listTools();
    await client.callTool({ name: MCP_TOOL_NAMES.plan, arguments: { entityId } });

    expect(mapperCalls).toBeGreaterThanOrEqual(3);
    expect(observedPrincipals.length).toBeGreaterThan(0);
    const canonical = JSON.stringify({
      subject: "user:alice",
      scopes: ["mcp", "state:read"],
    });
    expect(observedPrincipals.every((principal) => principal === canonical)).toBe(true);
  });

  it("rejects modern requests with missing or mismatched SDK standard headers", async () => {
    const { verifier, runtime, handler } = httpRuntime();

    const missingVersion = await handler.fetch(modernRawRequest("alice-read-token", {
      includeProtocolVersion: false,
    }));
    const mismatchedMethod = await handler.fetch(modernRawRequest("alice-read-token", {
      mcpMethod: "tools/list",
    }));
    const mismatchedVersion = await handler.fetch(modernRawRequest("alice-read-token", {
      protocolVersion: "2025-11-25",
    }));

    for (const response of [missingVersion, mismatchedMethod, mismatchedVersion]) {
      expect(response.status).toBe(400);
      const payload = await response.json() as { error?: { code?: number } };
      expect(payload.error?.code).toBe(-32020);
    }
  });

  it("rejects a malformed modern per-request envelope through the SDK classifier", async () => {
    const { verifier, runtime, handler } = httpRuntime();
    const response = await handler.fetch(rawRequest("alice-read-token", {
      headers: {
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "server/discover",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "malformed-envelope-test",
              version: "1.0.0",
            },
          },
        },
      }),
    }));
    const payload = await response.json() as { error?: { code?: number; message?: string } };

    expect(response.status).toBe(400);
    expect(payload.error?.code).toBe(-32602);
    expect(payload.error?.message).toMatch(/clientCapabilities|envelope/i);
  });

  it("does not accept query-string credentials and rejects GET on the modern-only endpoint", async () => {
    let mapperCalls = 0;
    const mapper: McpAuthPrincipalMapper = {
      map(auth) {
        mapperCalls += 1;
        return { subject: `user:${String(auth.extra?.sub)}`, scopes: auth.scopes };
      },
    };
    const { verifier, handler } = httpRuntime({ mapper });
    const queryUrl = new URL(endpointUrl);
    queryUrl.searchParams.set("access_token", "alice-read-token");

    const queryAuth = await handler.fetch(rawRequest(undefined, { url: queryUrl }));
    expect(queryAuth.status).toBe(401);
    expect(verifier.calls).toBe(0);

    const getRequest = rawRequest("alice-read-token", { method: "GET" });
    const getResponse = await handler.fetch(getRequest);
    expect(getResponse.status).toBeGreaterThanOrEqual(400);
    expect(mapperCalls).toBe(0);
  });

  it("never echoes bearer contents in bearer-auth error responses", async () => {
    const { verifier, runtime, handler } = httpRuntime();
    const response = await handler.fetch(rawRequest("definitely-secret-invalid-token"));
    const body = await response.text();
    const challenge = response.headers.get("www-authenticate") ?? "";

    expect(response.status).toBe(401);
    expect(body).not.toContain("definitely-secret-invalid-token");
    expect(challenge).not.toContain("definitely-secret-invalid-token");
  });

  it("does not expose raw bearer token to the principal mapper", async () => {
    let observed: VerifiedMcpAuthContext | undefined;
    const mapper: McpAuthPrincipalMapper = {
      map(auth) {
        observed = auth;
        return { subject: `user:${String(auth.extra?.sub)}`, scopes: auth.scopes };
      },
    };
    const { handler } = httpRuntime({ mapper });
    const { client } = await modernClient(handler, "alice-read-token");
    await client.listTools();

    expect(observed).toBeDefined();
    expect(JSON.stringify(observed)).not.toContain("alice-read-token");
    expect(Object.prototype.hasOwnProperty.call(observed, "token")).toBe(false);
  });
});
