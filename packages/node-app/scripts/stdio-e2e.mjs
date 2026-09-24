import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const entityId = "entity://project/atlas";
const root = await mkdtemp(join(tmpdir(), "ssrl-stdio-e2e-"));
const primary = join(root, "primary");
const replica = join(root, "replica");
const configPath = join(root, "config.json");
const journalPath = join(root, "journal", "runtime.sqlite");
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const connector = (id, writable) => ({
  schemaVersion: "0.1",
  id,
  displayName: id,
  capabilities: { read: true, write: writable, observe: true, subscribe: false, revisions: "opaque", idempotency: "none" },
  entities: [{ canonicalType: "Project", externalType: "markdown", fields: [
    { canonical: "Project.deadline", external: "deadline", access: writable ? ["read", "write"] : ["read"] },
    { canonical: "Project.secret", external: "secret", access: writable ? ["read", "write"] : ["read"] },
  ] }],
});

const config = {
  schemaVersion: "1",
  journalPath: "./journal/runtime.sqlite",
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
  principal: { subject: "user:local", scopes: ["state:read", "state:write", "context:read"] },
  providers: [
    { id: "primary", root: "./primary", manifest: connector("primary", false) },
    { id: "replica", root: "./replica", manifest: connector("replica", true) },
  ],
  entities: [{
    entityId,
    aliases: ["Project Atlas", "Atlas"],
    bindings: [
      { provider: "primary", externalId: "project.md", canonicalType: "Project" },
      { provider: "replica", externalId: "project.md", canonicalType: "Project" },
    ],
    authority: [
      { property: "Project.deadline", provider: "primary" },
      { property: "Project.secret", provider: "primary" },
    ],
  }],
  policy: {
    operations: { plan: true, apply: true },
    fields: [{ entityId, property: "Project.deadline", read: true, write: true }],
  },
};

async function connectClient() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, configPath],
    cwd: root,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "ssrl-stdio-e2e", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

async function runInvalidConfigCheck() {
  const badPath = join(root, "invalid.json");
  await writeFile(badPath, JSON.stringify({ schemaVersion: "0" }), { encoding: "utf8", mode: 0o600 });
  const child = spawn(process.execPath, [cliPath, badPath], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const [code] = await once(child, "exit");
  assert.notEqual(code, 0);
  assert.equal(stdout, "");
  assert.match(stderr, /Invalid SSRL configuration/);
}

try {
  await Promise.all([mkdir(primary), mkdir(replica)]);
  await writeFile(join(primary, "project.md"), '---\ndeadline: "2026-11-20"\nsecret: "PRIMARY-SECRET"\n---\n# Primary\n', "utf8");
  await writeFile(join(replica, "project.md"), '---\ndeadline: "2026-11-15"\nsecret: "REPLICA-SECRET"\nunrelated: keep\n---\n# Replica body\n', "utf8");
  await writeFile(configPath, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });

  await access(cliPath);
  const first = await connectClient();
  try {
    const tools = await first.client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "context.compile",
      "state.apply",
      "state.plan",
    ]);

    const context = await first.client.callTool({
      name: "context.compile",
      arguments: { task: "Project Atlas deadline", budgetTokens: 180 },
    });
    assert.notEqual(context.isError, true);
    assert.equal(context.structuredContent?.resolution?.status, "resolved");
    assert.equal(context.structuredContent?.resolution?.entityId, entityId);
    const contextJson = JSON.stringify(context);
    assert.match(contextJson, /2026-11-20/);
    assert.equal(contextJson.includes("PRIMARY-SECRET"), false);
    assert.equal(contextJson.includes("Primary body"), false);
    assert.equal(contextJson.includes("evidenceRefs"), false);

    const planned = await first.client.callTool({ name: "state.plan", arguments: { entityId } });
    assert.notEqual(planned.isError, true);
    const digest = planned.structuredContent?.proposalDigest;
    assert.equal(typeof digest, "string");
    assert.match(digest, /^sha256:[a-f0-9]{64}$/);
    const planJson = JSON.stringify(planned);
    assert.equal(planJson.includes("PRIMARY-SECRET"), false);
    assert.equal(planJson.includes("REPLICA-SECRET"), false);
    assert.equal(planJson.includes("Project.secret"), false);

    const applied = await first.client.callTool({ name: "state.apply", arguments: { entityId, proposalDigest: digest } });
    assert.notEqual(applied.isError, true);
    let replicaText = await readFile(join(replica, "project.md"), "utf8");
    assert.match(replicaText, /deadline: "2026-11-20"/);
    assert.match(replicaText, /secret: "REPLICA-SECRET"/);
    assert.match(replicaText, /unrelated: keep/);
    assert.match(replicaText, /# Replica body/);

    replicaText = replicaText.replace('deadline: "2026-11-20"', 'deadline: "2026-11-15"');
    await writeFile(join(replica, "project.md"), replicaText, "utf8");
    const stalePlan = await first.client.callTool({ name: "state.plan", arguments: { entityId } });
    const staleDigest = stalePlan.structuredContent?.proposalDigest;
    assert.equal(typeof staleDigest, "string");

    const externalEdit = replicaText.replace('deadline: "2026-11-15"', 'deadline: "2026-11-19"');
    await writeFile(join(replica, "project.md"), externalEdit, "utf8");
    const staleApply = await first.client.callTool({ name: "state.apply", arguments: { entityId, proposalDigest: staleDigest } });
    assert.equal(staleApply.isError, true);
    assert.match(JSON.stringify(staleApply), /proposal_drifted:/);
    assert.match(await readFile(join(replica, "project.md"), "utf8"), /deadline: "2026-11-19"/);
    assert.equal(first.stderr().includes("PRIMARY-SECRET"), false);
    assert.equal(first.stderr().includes("REPLICA-SECRET"), false);
  } finally {
    await first.client.close();
  }

  const journalInfo = await stat(journalPath);
  assert.ok(journalInfo.size > 0);

  const restarted = await connectClient();
  try {
    const result = await restarted.client.callTool({ name: "state.plan", arguments: { entityId } });
    assert.notEqual(result.isError, true);
    const context = await restarted.client.callTool({
      name: "context.compile",
      arguments: { task: "Project Atlas deadline", budgetTokens: 180 },
    });
    assert.notEqual(context.isError, true);
    assert.match(JSON.stringify(context), /2026-11-20/);
  } finally {
    await restarted.client.close();
  }

  await runInvalidConfigCheck();
} finally {
  await rm(root, { recursive: true, force: true });
}
