import { afterEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type {
  ExternalBinding,
  Mutation,
} from "@ssrl/core";
import {
  InMemoryStateProvider,
  ReconciliationApplyError,
  reconcileOnce,
} from "@ssrl/runtime";
import type { ConnectorManifest } from "@ssrl/connector-sdk";
import {
  MarkdownFilesystemConnector,
  StaleMarkdownFileError,
  UnsafeMarkdownPathError,
} from "../src/index.js";

const roots: string[] = [];

async function vault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ssrl-markdown-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function manifest(id = "markdown"): ConnectorManifest {
  return {
    schemaVersion: "0.1",
    id,
    displayName: "Markdown filesystem",
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
      externalType: "markdown-note",
      fields: [
        {
          canonical: "Project.deadline",
          external: "deadline",
          access: ["read", "write"],
          authorityHint: "replica",
        },
        {
          canonical: "Project.status",
          external: "status",
          access: ["read", "write"],
        },
        {
          canonical: "Project.owner",
          external: "/project/owner",
          access: ["read", "write"],
        },
      ],
    }],
  };
}

function binding(provider = "markdown", externalId = "Projects/Atlas.md"): ExternalBinding {
  return {
    entityId: "entity://project/atlas",
    provider,
    externalId,
    fields: [
      {
        canonical: "Project.deadline",
        external: "deadline",
        readable: true,
        writable: true,
      },
      {
        canonical: "Project.status",
        external: "status",
        readable: true,
        writable: true,
      },
      {
        canonical: "Project.owner",
        external: "/project/owner",
        readable: true,
        writable: true,
      },
    ],
  };
}

async function seed(root: string, relativePath = "Projects/Atlas.md"): Promise<string> {
  const file = join(root, ...relativePath.split("/"));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    [
      "---",
      "# keep this comment",
      "deadline: 2026-11-15",
      "status: active",
      "unrelated: keep-me",
      "project:",
      "  owner: Alice",
      "---",
      "# Atlas",
      "",
      "Body text must remain byte-for-byte unchanged.",
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

describe("MarkdownFilesystemConnector", () => {
  it("observes mapped YAML properties with an opaque content revision", async () => {
    const root = await vault();
    await seed(root);
    const connector = new MarkdownFilesystemConnector({
      root,
      manifest: manifest(),
      now: () => "2026-09-23T21:00:00Z",
    });

    const snapshot = await connector.observe(binding());

    expect(snapshot.observedAt).toBe("2026-09-23T21:00:00Z");
    expect(snapshot.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(snapshot.values).toEqual({
      deadline: "2026-11-15",
      status: "active",
      "/project/owner": "Alice",
    });
  });

  it("updates frontmatter while preserving body, unrelated properties, and comments", async () => {
    const root = await vault();
    const file = await seed(root);
    const connector = new MarkdownFilesystemConnector({ root, manifest: manifest() });
    const snapshot = await connector.observe(binding());

    await connector.apply({
      provider: "markdown",
      externalId: "Projects/Atlas.md",
      externalPath: "deadline",
      canonicalProperty: "Project.deadline",
      nextValue: "2026-11-20",
      previousValue: "2026-11-15",
      baseRevision: snapshot.revision,
    });

    const after = await readFile(file, "utf8");
    const [, body] = after.split("---\n# Atlas\n", 2);
    expect(after).toContain("deadline: 2026-11-20");
    expect(after).toContain("unrelated: keep-me");
    expect(after).toContain("# keep this comment");
    expect(body).toBe("\nBody text must remain byte-for-byte unchanged.\n");
  });

  it("supports nested frontmatter fields through JSON Pointer paths", async () => {
    const root = await vault();
    await seed(root);
    const connector = new MarkdownFilesystemConnector({ root, manifest: manifest() });
    const snapshot = await connector.observe(binding());

    await connector.apply({
      provider: "markdown",
      externalId: "Projects/Atlas.md",
      externalPath: "/project/owner",
      canonicalProperty: "Project.owner",
      nextValue: "Bob",
      previousValue: "Alice",
      baseRevision: snapshot.revision,
    });

    const observed = await connector.observe(binding());
    expect(observed.values["/project/owner"]).toBe("Bob");
  });

  it("rejects a write when the file changed after observation", async () => {
    const root = await vault();
    const file = await seed(root);
    const connector = new MarkdownFilesystemConnector({ root, manifest: manifest() });
    const snapshot = await connector.observe(binding());

    await writeFile(
      file,
      (await readFile(file, "utf8")).replace("status: active", "status: paused"),
      "utf8",
    );

    await expect(connector.apply({
      provider: "markdown",
      externalId: "Projects/Atlas.md",
      externalPath: "deadline",
      canonicalProperty: "Project.deadline",
      nextValue: "2026-11-20",
      previousValue: "2026-11-15",
      baseRevision: snapshot.revision,
    })).rejects.toBeInstanceOf(StaleMarkdownFileError);

    expect(await readFile(file, "utf8")).toContain("deadline: 2026-11-15");
  });

  it("rejects traversal, absolute paths, and symlink escapes", async () => {
    const root = await vault();
    await seed(root);
    const connector = new MarkdownFilesystemConnector({ root, manifest: manifest() });

    await expect(connector.observe(binding("markdown", "../outside.md")))
      .rejects.toBeInstanceOf(UnsafeMarkdownPathError);
    await expect(connector.observe(binding("markdown", "/tmp/outside.md")))
      .rejects.toBeInstanceOf(UnsafeMarkdownPathError);

    if (process.platform !== "win32") {
      const outsideRoot = await vault();
      const outsideFile = await seed(outsideRoot, "outside.md");
      const link = join(root, "escape.md");
      await symlink(outsideFile, link);
      await expect(connector.observe(binding("markdown", "escape.md")))
        .rejects.toBeInstanceOf(UnsafeMarkdownPathError);
    }
  });

  it("reconciles a canonical value into a real Markdown file and converges", async () => {
    const root = await vault();
    const file = await seed(root);
    const markdown = new MarkdownFilesystemConnector({
      root,
      manifest: manifest(),
      now: () => "2026-09-23T21:00:00Z",
    });
    const primary = new InMemoryStateProvider(
      "primary",
      [{
        externalId: "atlas",
        values: { deadline: "2026-11-20" },
      }],
      () => "2026-09-23T21:00:00Z",
    );

    const result = await reconcileOnce({
      entityId: "entity://project/atlas",
      bindings: [
        {
          entityId: "entity://project/atlas",
          provider: "primary",
          externalId: "atlas",
          fields: [{
            canonical: "Project.deadline",
            external: "deadline",
            readable: true,
            writable: false,
          }],
        },
        {
          entityId: "entity://project/atlas",
          provider: "markdown",
          externalId: "Projects/Atlas.md",
          fields: [{
            canonical: "Project.deadline",
            external: "deadline",
            readable: true,
            writable: true,
          }],
        },
      ],
      authority: [{
        property: "Project.deadline",
        strategy: { kind: "provider", provider: "primary" },
      }],
      registry: {
        providers: new Map([
          [primary.id, primary],
          [markdown.id, markdown],
        ]),
      },
    });

    expect(result.applied).toHaveLength(1);
    expect(result.after?.mutations).toHaveLength(0);
    expect(result.after?.conflicts).toHaveLength(0);
    expect(await readFile(file, "utf8")).toContain("deadline: 2026-11-20");
  });

  it("surfaces a stale filesystem write through the runtime apply error", async () => {
    const root = await vault();
    const file = await seed(root);
    const markdown = new MarkdownFilesystemConnector({ root, manifest: manifest() });
    const markdownBinding: ExternalBinding = {
      ...binding(),
      fields: [binding().fields[0]!],
    };
    const snapshot = await markdown.observe(markdownBinding);

    await writeFile(
      file,
      (await readFile(file, "utf8")).replace("status: active", "status: changed-elsewhere"),
      "utf8",
    );

    const mutation: Mutation = {
      provider: "markdown",
      externalId: "Projects/Atlas.md",
      externalPath: "deadline",
      canonicalProperty: "Project.deadline",
      nextValue: "2026-11-20",
      previousValue: "2026-11-15",
      baseRevision: snapshot.revision,
    };

    const primary = new InMemoryStateProvider("unused", []);
    const runtimeError = new ReconciliationApplyError(mutation, [], {
      cause: new StaleMarkdownFileError(snapshot.revision, "sha256:changed"),
    });

    expect(runtimeError.cause).toBeInstanceOf(StaleMarkdownFileError);
    expect(primary.id).toBe("unused");
  });
});
