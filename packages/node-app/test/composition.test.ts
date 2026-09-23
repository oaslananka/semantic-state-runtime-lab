import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  MCP_TOOL_NAMES,
  mcpPlanOutputSchema,
} from "@ssrl/mcp-server";
import type { LocalRuntimeApp } from "../src/index.js";
import {
  InvalidLocalAppConfigError,
  loadAndCreateLocalRuntimeApp,
  loadLocalAppConfig,
} from "../src/index.js";
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
      entityId,
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
