import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  MCP_TOOL_NAMES,
  mcpContextCompileOutputSchema,
  mcpPlanOutputSchema,
} from "@ssrl/mcp-server";
import type { LocalRuntimeApp } from "../src/index.js";
import {
  InvalidLocalAppConfigError,
  LocalContextAliasRemovalUnsupportedError,
  LocalContextConfigurationDriftError,
  loadAndCreateLocalRuntimeApp,
  loadLocalAppConfig,
} from "../src/index.js";
import { FreshLocalContextGateway } from "../src/local-context.js";
import type { RuntimeMcpContextGateway } from "@ssrl/mcp-server";
import { describe, expect, it } from "vitest";

const entityId = "entity://project/atlas" as const;

function manifest(
  id: string,
  writable: boolean,
) {
  return {
    schemaVersion: "0.1" as const,
    id,
    displayName: id,
    capabilities: {
      read: true,
      write: writable,
      observe: true,
      subscribe: false,
      revisions: "opaque" as const,
      idempotency: "none" as const,
    },
    entities: [{
      canonicalType: "Project",
      externalType: "markdown",
      fields: [
        {
          canonical: "Project.deadline",
          external: "deadline",
          access: writable ? ["read", "write"] : ["read"],
        },
        {
          canonical: "Project.secret",
          external: "secret",
          access: writable ? ["read", "write"] : ["read"],
        },
      ],
    }],
  };
}

function configObject(
  primaryRoot = "./primary",
  replicaRoot = "./replica",
  replicaExternalId = "project.md",
) {
  return {
    schemaVersion: "1",
    journalPath: "./journal/runtime.sqlite",
    principal: {
      subject: "user:local",
      scopes: ["state:read", "state:write"],
    },
    providers: [
      {
        id: "primary",
        root: primaryRoot,
        manifest: manifest("primary", false),
      },
      {
        id: "replica",
        root: replicaRoot,
        manifest: manifest("replica", true),
      },
    ],
    entities: [{
      entityId: String(entityId),
      bindings: [
        {
          provider: "primary",
          externalId: "project.md",
          canonicalType: "Project",
        },
        {
          provider: "replica",
          externalId: replicaExternalId,
          canonicalType: "Project",
        },
      ],
      authority: [
        {
          property: "Project.deadline",
          provider: "primary",
        },
        {
          property: "Project.secret",
          provider: "primary",
        },
      ],
    }],
    policy: {
      operations: {
        plan: true,
        apply: true,
      },
      fields: [{
        entityId,
        property: "Project.deadline",
        read: true,
        write: true,
      }],
    },
  };
}

function contextConfigObject() {
  const config = configObject();
  return {
    ...config,
    context: {
      semanticStatePath: "./context/semantic.sqlite",
      ingestionStatePath: "./context/ingestion.sqlite",
      artifactStoreRoot: "./context/artifacts",
      sources: [
        { provider: "primary", externalType: "markdown" },
        { provider: "replica", externalType: "markdown" },
      ],
      maxBudgetTokens: 512,
    },
    principal: {
      ...config.principal,
      scopes: [...config.principal.scopes, "context:read"],
    },
    entities: config.entities.map((entity) => ({
      ...entity,
      aliases: ["Project Atlas", "Atlas"],
    })),
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ssrl-node-app-"));
  const primary = join(root, "primary");
  const replica = join(root, "replica");
  await Promise.all([
    mkdir(primary, { recursive: true }),
    mkdir(replica, { recursive: true }),
  ]);

  await writeFile(
    join(primary, "project.md"),
    [
      "---",
      'deadline: "2026-11-20"',
      'secret: "PRIMARY-SECRET"',
      'unrelated: "primary-keep"',
      "---",
      "# Primary",
      "",
      "Primary body.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(replica, "project.md"),
    [
      "---",
      'deadline: "2026-11-15"',
      'secret: "REPLICA-SECRET"',
      'unrelated: "replica-keep"',
      "---",
      "# Replica",
      "",
      "Replica body must survive.",
      "",
    ].join("\n"),
    "utf8",
  );

  const configPath = join(root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify(configObject(), null, 2),
    { encoding: "utf8", mode: 0o600 },
  );

  return {
    root,
    primary,
    replica,
    configPath,
    journalPath: join(root, "journal", "runtime.sqlite"),
    semanticStatePath: join(root, "context", "semantic.sqlite"),
    ingestionStatePath: join(root, "context", "ingestion.sqlite"),
    artifactStoreRoot: join(root, "context", "artifacts"),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function connect(app: LocalRuntimeApp) {
  const server = app.createMcpServer();
  const client = new Client({
    name: "node-app-test-client",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

describe("local Node composition", () => {
  it("rejects path-escape config before creating persistent journal state", async () => {
    const fx = await fixture();
    try {
      const invalid = configObject("./primary", "./replica", "../escape.md");
      await writeFile(fx.configPath, JSON.stringify(invalid), "utf8");

      await expect(loadLocalAppConfig(fx.configPath))
        .rejects.toBeInstanceOf(InvalidLocalAppConfigError);
      expect(await exists(fx.journalPath)).toBe(false);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("rejects context config without context:read, aliases, or dedicated storage", async () => {
    const fx = await fixture();
    try {
      const missingScope = contextConfigObject();
      missingScope.principal.scopes = missingScope.principal.scopes.filter(
        (scope) => scope !== "context:read",
      );
      await writeFile(fx.configPath, JSON.stringify(missingScope), "utf8");
      await expect(loadLocalAppConfig(fx.configPath)).rejects.toMatchObject({
        issues: expect.arrayContaining([
          expect.stringContaining("context:read"),
        ]),
      });

      const missingAliases = contextConfigObject();
      missingAliases.entities[0]!.aliases = [];
      await writeFile(fx.configPath, JSON.stringify(missingAliases), "utf8");
      await expect(loadLocalAppConfig(fx.configPath)).rejects.toMatchObject({
        issues: expect.arrayContaining([
          expect.stringContaining("at least one explicit alias"),
        ]),
      });

      const mixedType = contextConfigObject();
      (mixedType.entities[0]!.bindings[1]! as { canonicalType: string }).canonicalType = "Person";
      await writeFile(fx.configPath, JSON.stringify(mixedType), "utf8");
      await expect(loadLocalAppConfig(fx.configPath)).rejects.toMatchObject({
        issues: expect.arrayContaining([
          expect.stringContaining("no configured entity bindings"),
        ]),
      });

      const duplicateBinding = contextConfigObject();
      duplicateBinding.entities.push({
        ...duplicateBinding.entities[0]!,
        entityId: "entity://project/atlas-copy",
        aliases: ["Atlas Copy"],
      });
      await writeFile(fx.configPath, JSON.stringify(duplicateBinding), "utf8");
      await expect(loadLocalAppConfig(fx.configPath)).rejects.toMatchObject({
        issues: expect.arrayContaining([
          expect.stringContaining("is duplicated"),
        ]),
      });

      const duplicateSource = contextConfigObject();
      duplicateSource.context.sources.push({ provider: "primary", externalType: "markdown" });
      await writeFile(fx.configPath, JSON.stringify(duplicateSource), "utf8");
      await expect(loadLocalAppConfig(fx.configPath)).rejects.toMatchObject({
        issues: expect.arrayContaining([
          expect.stringContaining("duplicate source primary/markdown"),
        ]),
      });

      const unknownSource = contextConfigObject();
      unknownSource.context.sources[0] = { provider: "missing", externalType: "markdown" };
      await writeFile(fx.configPath, JSON.stringify(unknownSource), "utf8");
      await expect(loadLocalAppConfig(fx.configPath)).rejects.toMatchObject({
        issues: expect.arrayContaining([
          expect.stringContaining("unknown provider"),
        ]),
      });

      const wrongExternalType = contextConfigObject();
      wrongExternalType.context.sources[0] = { provider: "primary", externalType: "unknown-type" };
      await writeFile(fx.configPath, JSON.stringify(wrongExternalType), "utf8");
      await expect(loadLocalAppConfig(fx.configPath)).rejects.toMatchObject({
        issues: expect.arrayContaining([
          expect.stringContaining("must match exactly one manifest entity mapping"),
        ]),
      });

      const noBindingSource = contextConfigObject();
      noBindingSource.context.sources = [{ provider: "primary", externalType: "markdown" }];
      noBindingSource.entities[0]!.bindings = noBindingSource.entities[0]!.bindings.filter(
        (binding) => binding.provider !== "primary",
      );
      await writeFile(fx.configPath, JSON.stringify(noBindingSource), "utf8");
      await expect(loadLocalAppConfig(fx.configPath)).rejects.toMatchObject({
        issues: expect.arrayContaining([
          expect.stringContaining("no configured entity bindings"),
        ]),
      });

      const sharedStorage = contextConfigObject();
      sharedStorage.context.semanticStatePath = sharedStorage.journalPath;
      await writeFile(fx.configPath, JSON.stringify(sharedStorage), "utf8");
      await expect(loadLocalAppConfig(fx.configPath)).rejects.toMatchObject({
        issues: expect.arrayContaining([
          expect.stringContaining("dedicated storage"),
        ]),
      });
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("fails invalid context startup before creating journal or context stores", async () => {
    const fx = await fixture();
    try {
      const invalid = contextConfigObject();
      invalid.context.sources.push({ provider: "primary", externalType: "markdown" });
      await writeFile(fx.configPath, JSON.stringify(invalid, null, 2), "utf8");

      await expect(loadAndCreateLocalRuntimeApp(fx.configPath))
        .rejects.toBeInstanceOf(InvalidLocalAppConfigError);
      expect(await exists(fx.journalPath)).toBe(false);
      expect(await exists(fx.semanticStatePath)).toBe(false);
      expect(await exists(fx.ingestionStatePath)).toBe(false);
      expect(await exists(join(fx.artifactStoreRoot, "artifacts.sqlite"))).toBe(false);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("keeps context.compile absent for backward-compatible config without context", async () => {
    const fx = await fixture();
    let app: LocalRuntimeApp | undefined;
    let connection: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      ({ app } = await loadAndCreateLocalRuntimeApp(fx.configPath));
      connection = await connect(app);
      const tools = await connection.client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        MCP_TOOL_NAMES.apply,
        MCP_TOOL_NAMES.plan,
      ].sort());
    } finally {
      if (connection !== undefined) await connection.close();
      app?.close();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("runs durable Markdown context through real local MCP and refreshes after source edits/restart", async () => {
    const fx = await fixture();
    await writeFile(fx.configPath, JSON.stringify(contextConfigObject(), null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    let first: LocalRuntimeApp | undefined;
    let second: LocalRuntimeApp | undefined;
    let connection: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      ({ app: first } = await loadAndCreateLocalRuntimeApp(fx.configPath));
      connection = await connect(first);
      const tools = await connection.client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        MCP_TOOL_NAMES.apply,
        MCP_TOOL_NAMES.context,
        MCP_TOOL_NAMES.plan,
      ].sort());

      const initial = await connection.client.callTool({
        name: MCP_TOOL_NAMES.context,
        arguments: { task: "Project Atlas deadline", budgetTokens: 180 },
      });
      const initialOutput = mcpContextCompileOutputSchema.parse(initial.structuredContent);
      const initialJson = JSON.stringify(initial);
      expect(initial.isError).not.toBe(true);
      expect(initialOutput.resolution).toEqual({
        status: "resolved",
        entityId,
        entityType: "Project",
      });
      expect(initialOutput.records.some((record) => record.text.includes("2026-11-20"))).toBe(true);
      expect(initialOutput.estimatedTokens).toBeLessThanOrEqual(180);
      expect(initialOutput.records.every((record) => record.evidenceRefs === undefined)).toBe(true);
      expect(initialJson).not.toContain("PRIMARY-SECRET");
      expect(initialJson).not.toContain("Primary body");


      const semanticPrimary = (await first.context!.semanticState.observationsForEntity(entityId))
        .filter((observation) => observation.source.provider === "primary");
      const artifactRevisions = new Set(
        (await first.context!.artifactStore.snapshot()).mutations
          .map((mutation) => mutation.revision)
          .filter((revision): revision is string => revision !== undefined),
      );
      expect(semanticPrimary).not.toHaveLength(0);
      expect(semanticPrimary.every((observation) => (
        observation.source.revision !== undefined
        && artifactRevisions.has(observation.source.revision)
      ))).toBe(true);

      const primaryPath = join(fx.primary, "project.md");
      const before = await readFile(primaryPath, "utf8");
      await writeFile(
        primaryPath,
        before.replace('deadline: "2026-11-20"', 'deadline: "2026-12-01"'),
        "utf8",
      );
      const refreshed = await connection.client.callTool({
        name: MCP_TOOL_NAMES.context,
        arguments: { task: "Project Atlas deadline", budgetTokens: 180 },
      });
      const refreshedOutput = mcpContextCompileOutputSchema.parse(refreshed.structuredContent);
      expect(refreshedOutput.records.some((record) => record.text.includes("2026-12-01"))).toBe(true);
      expect(refreshedOutput.records.every((record) => !record.text.includes("2026-11-20"))).toBe(true);

      await connection.close();
      connection = undefined;
      first.close();
      first = undefined;
      expect(await exists(fx.semanticStatePath)).toBe(true);
      expect(await exists(fx.ingestionStatePath)).toBe(true);
      expect(await exists(join(fx.artifactStoreRoot, "artifacts.sqlite"))).toBe(true);

      ({ app: second } = await loadAndCreateLocalRuntimeApp(fx.configPath));
      connection = await connect(second);
      const restarted = await connection.client.callTool({
        name: MCP_TOOL_NAMES.context,
        arguments: { task: "Project Atlas deadline", budgetTokens: 180 },
      });
      const restartedOutput = mcpContextCompileOutputSchema.parse(restarted.structuredContent);
      expect(restartedOutput.records.some((record) => record.text.includes("2026-12-01"))).toBe(true);
    } finally {
      if (connection !== undefined) await connection.close();
      first?.close();
      second?.close();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("fails closed when an authoritative context root contains an unconfigured Markdown file", async () => {
    const fx = await fixture();
    await writeFile(fx.configPath, JSON.stringify(contextConfigObject(), null, 2), "utf8");
    let app: LocalRuntimeApp | undefined;
    let connection: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      ({ app } = await loadAndCreateLocalRuntimeApp(fx.configPath));
      connection = await connect(app);
      const before = await connection.client.callTool({
        name: MCP_TOOL_NAMES.context,
        arguments: { task: "Project Atlas deadline", budgetTokens: 180 },
      });
      expect(before.isError).not.toBe(true);
      expect(JSON.stringify(before)).toContain("2026-11-20");

      await writeFile(
        join(fx.primary, "unconfigured.md"),
        "---\ndeadline: 2099-01-01\nsecret: UNCONFIGURED-SECRET\n---\n# Unknown\n",
        "utf8",
      );
      const result = await connection.client.callTool({
        name: MCP_TOOL_NAMES.context,
        arguments: { task: "Project Atlas deadline", budgetTokens: 180 },
      });
      expect(result.isError).toBe(true);
      const errorJson = JSON.stringify(result);
      expect(errorJson).toContain("internal_error");
      expect(errorJson).not.toContain("2026-11-20");
      expect(errorJson).not.toContain("2099-01-01");
      expect(errorJson).not.toContain("UNCONFIGURED-SECRET");
      expect(errorJson).not.toContain("unconfigured.md");
    } finally {
      if (connection !== undefined) await connection.close();
      app?.close();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("retracts a removed authoritative frontmatter field instead of falling back to stale replica state", async () => {
    const fx = await fixture();
    await writeFile(fx.configPath, JSON.stringify(contextConfigObject(), null, 2), "utf8");
    let app: LocalRuntimeApp | undefined;
    let connection: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      ({ app } = await loadAndCreateLocalRuntimeApp(fx.configPath));
      connection = await connect(app);
      const before = await connection.client.callTool({
        name: MCP_TOOL_NAMES.context,
        arguments: { task: "Project Atlas deadline", budgetTokens: 180 },
      });
      expect(JSON.stringify(before)).toContain("2026-11-20");

      const primaryPath = join(fx.primary, "project.md");
      const current = await readFile(primaryPath, "utf8");
      await writeFile(
        primaryPath,
        current.replace('deadline: "2026-11-20"\n', ""),
        "utf8",
      );
      const after = await connection.client.callTool({
        name: MCP_TOOL_NAMES.context,
        arguments: { task: "Project Atlas deadline", budgetTokens: 180 },
      });
      const output = mcpContextCompileOutputSchema.parse(after.structuredContent);
      expect(output.records.every((record) => !record.text.includes("2026-11-20"))).toBe(true);
      expect(output.records.every((record) => !record.text.includes("2026-11-15"))).toBe(true);
    } finally {
      if (connection !== undefined) await connection.close();
      app?.close();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("retracts deleted configured Markdown state instead of serving ghost context", async () => {
    const fx = await fixture();
    await writeFile(fx.configPath, JSON.stringify(contextConfigObject(), null, 2), "utf8");
    let app: LocalRuntimeApp | undefined;
    let connection: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      ({ app } = await loadAndCreateLocalRuntimeApp(fx.configPath));
      connection = await connect(app);
      const before = await connection.client.callTool({
        name: MCP_TOOL_NAMES.context,
        arguments: { task: "Project Atlas deadline", budgetTokens: 180 },
      });
      expect(JSON.stringify(before)).toContain("2026-11-20");

      await rm(join(fx.primary, "project.md"));
      const after = await connection.client.callTool({
        name: MCP_TOOL_NAMES.context,
        arguments: { task: "Project Atlas deadline", budgetTokens: 180 },
      });
      expect(JSON.stringify(after)).not.toContain("2026-11-20");
      expect(JSON.stringify(after)).not.toContain("PRIMARY-SECRET");
    } finally {
      if (connection !== undefined) await connection.close();
      app?.close();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("allows append-only configured aliases and resolves them after restart", async () => {
    const fx = await fixture();
    const initial = contextConfigObject();
    await writeFile(fx.configPath, JSON.stringify(initial, null, 2), "utf8");
    let first: LocalRuntimeApp | undefined;
    let second: LocalRuntimeApp | undefined;
    let connection: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      ({ app: first } = await loadAndCreateLocalRuntimeApp(fx.configPath));
      first.close();
      first = undefined;

      const extended = contextConfigObject();
      extended.entities[0]!.aliases.push("Atlas Initiative");
      await writeFile(fx.configPath, JSON.stringify(extended, null, 2), "utf8");
      ({ app: second } = await loadAndCreateLocalRuntimeApp(fx.configPath));
      connection = await connect(second);
      const result = await connection.client.callTool({
        name: MCP_TOOL_NAMES.context,
        arguments: { task: "Atlas Initiative deadline", budgetTokens: 180 },
      });
      const output = mcpContextCompileOutputSchema.parse(result.structuredContent);
      expect(output.resolution).toEqual({
        status: "resolved",
        entityId,
        entityType: "Project",
      });
      expect(output.records.some((record) => record.text.includes("2026-11-20"))).toBe(true);
    } finally {
      if (connection !== undefined) await connection.close();
      first?.close();
      second?.close();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("fails closed when a previously persisted config alias is removed or changed", async () => {
    const fx = await fixture();
    const initial = contextConfigObject();
    await writeFile(fx.configPath, JSON.stringify(initial, null, 2), "utf8");
    let app: LocalRuntimeApp | undefined;
    try {
      ({ app } = await loadAndCreateLocalRuntimeApp(fx.configPath));
      app.close();
      app = undefined;

      const changed = contextConfigObject();
      changed.entities[0]!.aliases = ["Renamed Atlas"];
      await writeFile(fx.configPath, JSON.stringify(changed, null, 2), "utf8");
      await expect(loadAndCreateLocalRuntimeApp(fx.configPath))
        .rejects.toBeInstanceOf(LocalContextAliasRemovalUnsupportedError);
    } finally {
      app?.close();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("fails closed when persistent context storage is reused with changed source/storage topology", async () => {
    const fx = await fixture();
    const initial = contextConfigObject();
    await writeFile(fx.configPath, JSON.stringify(initial, null, 2), "utf8");
    let app: LocalRuntimeApp | undefined;
    try {
      ({ app } = await loadAndCreateLocalRuntimeApp(fx.configPath));
      app.close();
      app.close();
      app = undefined;

      const changed = contextConfigObject();
      changed.context.semanticStatePath = "./context/semantic-v2.sqlite";
      await writeFile(fx.configPath, JSON.stringify(changed, null, 2), "utf8");
      await expect(loadAndCreateLocalRuntimeApp(fx.configPath))
        .rejects.toBeInstanceOf(LocalContextConfigurationDriftError);
    } finally {
      app?.close();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("keeps raw artifacts hidden without artifact:read and fresh when explicitly granted", async () => {
    const fx = await fixture();
    const deniedConfig = contextConfigObject();
    await writeFile(fx.configPath, JSON.stringify(deniedConfig, null, 2), "utf8");
    let app: LocalRuntimeApp | undefined;
    let connection: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      ({ app } = await loadAndCreateLocalRuntimeApp(fx.configPath));
      connection = await connect(app);
      expect((await connection.client.listResources()).resources).toEqual([]);
      await connection.close();
      connection = undefined;
      app.close();
      app = undefined;

      const allowedConfig = contextConfigObject();
      allowedConfig.principal.scopes.push("artifact:read");
      await writeFile(fx.configPath, JSON.stringify(allowedConfig, null, 2), "utf8");
      ({ app } = await loadAndCreateLocalRuntimeApp(fx.configPath));
      connection = await connect(app);

      const listed = await connection.client.listResources();
      expect(listed.resources).toHaveLength(2);
      const texts = await Promise.all(listed.resources.map(async (resource) => {
        const read = await connection!.client.readResource({ uri: resource.uri });
        return read.contents.map((content) => "text" in content ? content.text : "").join("\n");
      }));
      const raw = texts.join("\n---\n");
      expect(raw).toContain("PRIMARY-SECRET");
      expect(raw).toContain("REPLICA-SECRET");
      expect(raw).not.toContain("UNCONFIGURED PRIVATE BODY");

      const primaryPath = join(fx.primary, "project.md");
      const before = await readFile(primaryPath, "utf8");
      await writeFile(
        primaryPath,
        before.replace('deadline: "2026-11-20"', 'deadline: "2026-12-09"'),
        "utf8",
      );
      const refreshed = await connection.client.listResources();
      const refreshedTexts = await Promise.all(refreshed.resources.map(async (resource) => {
        const read = await connection!.client.readResource({ uri: resource.uri });
        return read.contents.map((content) => "text" in content ? content.text : "").join("\n");
      }));
      expect(refreshedTexts.join("\n")).toContain('deadline: "2026-12-09"');
    } finally {
      if (connection !== undefined) await connection.close();
      app?.close();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("coalesces concurrent context freshening before delegating compile calls", async () => {
    let syncCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delegate: RuntimeMcpContextGateway = {
      async compile() {
        return {
          resolution: { status: "none" },
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
    const gateway = new FreshLocalContextGateway({
      delegate,
      async synchronize() {
        syncCalls += 1;
        await gate;
      },
    });

    const first = gateway.compile({ task: "one", budgetTokens: 10 });
    const second = gateway.compile({ task: "two", budgetTokens: 10 });
    await Promise.resolve();
    expect(syncCalls).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(syncCalls).toBe(1);
  });

  it("honors provider-scoped field grants only when they cover canonical authority", async () => {
    const fx = await fixture();
    let app: LocalRuntimeApp | undefined;
    let connection: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      const primaryGranted = contextConfigObject();
      Object.assign(primaryGranted.policy.fields[0]!, { providers: ["primary"] });
      await writeFile(fx.configPath, JSON.stringify(primaryGranted, null, 2), "utf8");
      ({ app } = await loadAndCreateLocalRuntimeApp(fx.configPath));
      connection = await connect(app);
      const allowed = await connection.client.callTool({
        name: MCP_TOOL_NAMES.context,
        arguments: { task: "Project Atlas deadline", budgetTokens: 180 },
      });
      const allowedOutput = mcpContextCompileOutputSchema.parse(allowed.structuredContent);
      expect(allowedOutput.resolution).toEqual({
        status: "resolved",
        entityId,
        entityType: "Project",
      });
      expect(allowedOutput.records.some((record) => record.text.includes("2026-11-20"))).toBe(true);

      await connection.close();
      connection = undefined;
      app.close();
      app = undefined;

      const replicaOnly = contextConfigObject();
      Object.assign(replicaOnly.policy.fields[0]!, { providers: ["replica"] });
      await writeFile(fx.configPath, JSON.stringify(replicaOnly, null, 2), "utf8");
      ({ app } = await loadAndCreateLocalRuntimeApp(fx.configPath));
      connection = await connect(app);
      const denied = await connection.client.callTool({
        name: MCP_TOOL_NAMES.context,
        arguments: { task: "Project Atlas deadline", budgetTokens: 180 },
      });
      const deniedOutput = mcpContextCompileOutputSchema.parse(denied.structuredContent);
      expect(deniedOutput.resolution).toEqual({ status: "none" });
      expect(deniedOutput.records).toEqual([]);
    } finally {
      if (connection !== undefined) await connection.close();
      app?.close();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("reconciles real Markdown, preserves unrelated content, filters denied fields, and journals evidence", async () => {
    const fx = await fixture();
    let app: LocalRuntimeApp | undefined;
    let connection: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      ({ app } = await loadAndCreateLocalRuntimeApp(fx.configPath));
      connection = await connect(app);

      const planned = await connection.client.callTool({
        name: MCP_TOOL_NAMES.plan,
        arguments: { entityId },
      });
      const output = mcpPlanOutputSchema.parse(planned.structuredContent);
      const serializedPlan = JSON.stringify(planned);

      expect(output.status).toBe("ready");
      expect(output.mutations).toHaveLength(1);
      expect(output.mutations[0]).toMatchObject({
        provider: "replica",
        canonicalProperty: "Project.deadline",
        nextValue: "2026-11-20",
      });
      expect(serializedPlan).not.toContain("PRIMARY-SECRET");
      expect(serializedPlan).not.toContain("REPLICA-SECRET");
      expect(serializedPlan).not.toContain("Project.secret");

      const applied = await connection.client.callTool({
        name: MCP_TOOL_NAMES.apply,
        arguments: {
          entityId,
          proposalDigest: output.proposalDigest,
        },
      });
      expect(applied.isError).not.toBe(true);

      const replica = await readFile(join(fx.replica, "project.md"), "utf8");
      expect(replica).toContain('deadline: "2026-11-20"');
      expect(replica).toContain('secret: "REPLICA-SECRET"');
      expect(replica).toContain('unrelated: "replica-keep"');
      expect(replica).toContain("Replica body must survive.");

      const events = await app.journal.eventsForEntity(entityId);
      const serializedEvents = JSON.stringify(events);
      expect(events.some((event) => event.type === "mutation.requested")).toBe(true);
      expect(events.some((event) => event.type === "mutation.applied")).toBe(true);
      expect(serializedEvents).not.toContain("PRIMARY-SECRET");
      expect(serializedEvents).not.toContain("REPLICA-SECRET");

      const replanned = await connection.client.callTool({
        name: MCP_TOOL_NAMES.plan,
        arguments: { entityId },
      });
      expect(mcpPlanOutputSchema.parse(replanned.structuredContent).status).toBe("noop");
    } finally {
      if (connection !== undefined) await connection.close();
      app?.close();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("rejects a stale digest after an external Markdown edit and preserves that edit", async () => {
    const fx = await fixture();
    let app: LocalRuntimeApp | undefined;
    let connection: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      ({ app } = await loadAndCreateLocalRuntimeApp(fx.configPath));
      connection = await connect(app);

      const planned = await connection.client.callTool({
        name: MCP_TOOL_NAMES.plan,
        arguments: { entityId },
      });
      const digest = mcpPlanOutputSchema.parse(planned.structuredContent).proposalDigest;

      const path = join(fx.replica, "project.md");
      const before = await readFile(path, "utf8");
      await writeFile(
        path,
        before.replace('deadline: "2026-11-15"', 'deadline: "2026-11-19"'),
        "utf8",
      );

      const applied = await connection.client.callTool({
        name: MCP_TOOL_NAMES.apply,
        arguments: {
          entityId,
          proposalDigest: digest,
        },
      });

      expect(applied.isError).toBe(true);
      expect(JSON.stringify(applied)).toContain("proposal_drifted:");
      const after = await readFile(path, "utf8");
      expect(after).toContain('deadline: "2026-11-19"');
      expect(after).not.toContain('deadline: "2026-11-20"');
    } finally {
      if (connection !== undefined) await connection.close();
      app?.close();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("preserves SQLite journal evidence across local runtime restarts", async () => {
    const fx = await fixture();
    let first: LocalRuntimeApp | undefined;
    let second: LocalRuntimeApp | undefined;
    try {
      ({ app: first } = await loadAndCreateLocalRuntimeApp(fx.configPath));
      const firstConnection = await connect(first);
      const planned = await firstConnection.client.callTool({
        name: MCP_TOOL_NAMES.plan,
        arguments: { entityId },
      });
      expect(planned.isError).not.toBe(true);
      await firstConnection.close();

      const beforeRestart = await first.journal.eventsForEntity(entityId);
      expect(beforeRestart.length).toBeGreaterThan(0);
      first.close();
      first = undefined;

      ({ app: second } = await loadAndCreateLocalRuntimeApp(fx.configPath));
      const afterRestart = await second.journal.eventsForEntity(entityId);
      expect(afterRestart).toEqual(beforeRestart);
    } finally {
      first?.close();
      second?.close();
      await rm(fx.root, { recursive: true, force: true });
    }
  });
});
