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
  ExternalSnapshot,
  Mutation,
  StateValue,
} from "@ssrl/core";
import {
  InMemoryStateProvider,
  ReconciliationApplyError,
  reconcileOnce,
  type StateProvider,
} from "@ssrl/runtime";
import type { ConnectorManifest } from "@ssrl/connector-sdk";
import {
  MarkdownFilesystemConnector,
  StaleMarkdownFileError,
  UnsafeMarkdownPathError,
} from "../src/index.js";

const roots: string[] = [];
const entityId = "entity://project/atlas" as const;
const markdownId = "markdown";
const atlasNote = "Projects/Atlas.md";
const fixedNow = "2026-09-23T21:00:00Z";

async function vault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ssrl-markdown-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function manifest(id = markdownId): ConnectorManifest {
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

function connector(root: string, withFixedClock = false): MarkdownFilesystemConnector {
  return new MarkdownFilesystemConnector({
    root,
    manifest: manifest(),
    ...(withFixedClock ? { now: () => fixedNow } : {}),
  });
}

function field(
  canonical: string,
  external: string,
  writable = true,
): ExternalBinding["fields"][number] {
  return { canonical, external, readable: true, writable };
}

function binding(
  provider = markdownId,
  externalId = atlasNote,
): ExternalBinding {
  return {
    entityId,
    provider,
    externalId,
    fields: [
      field("Project.deadline", "deadline"),
      field("Project.status", "status"),
      field("Project.owner", "/project/owner"),
    ],
  };
}

function singleFieldBinding(
  provider: string,
  externalId: string,
  canonical: string,
  external: string,
  writable: boolean,
): ExternalBinding {
  return {
    entityId,
    provider,
    externalId,
    fields: [field(canonical, external, writable)],
  };
}

function requiredRevision(snapshot: ExternalSnapshot): string {
  if (snapshot.revision === undefined) throw new Error("Expected connector revision");
  return snapshot.revision;
}

function mutation(
  snapshot: ExternalSnapshot,
  input: {
    readonly externalPath: string;
    readonly canonicalProperty: string;
    readonly nextValue: StateValue;
    readonly previousValue?: StateValue;
    readonly externalId?: string;
  },
): Mutation {
  const base = {
    provider: markdownId,
    externalId: input.externalId ?? atlasNote,
    externalPath: input.externalPath,
    canonicalProperty: input.canonicalProperty,
    nextValue: input.nextValue,
    baseRevision: requiredRevision(snapshot),
  };
  return input.previousValue === undefined
    ? base
    : { ...base, previousValue: input.previousValue };
}

async function seed(root: string, relativePath = atlasNote): Promise<string> {
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

async function changeStatusExternally(file: string, nextStatus: string): Promise<void> {
  const current = await readFile(file, "utf8");
  await writeFile(file, current.replace("status: active", `status: ${nextStatus}`), "utf8");
}

function primaryDeadlineProvider(): InMemoryStateProvider {
  return new InMemoryStateProvider(
    "primary",
    [{ externalId: "atlas", values: { deadline: "2026-11-20" } }],
    () => fixedNow,
  );
}

function reconcileDeadline(primary: StateProvider, replica: StateProvider) {
  return reconcileOnce({
    entityId,
    bindings: [
      singleFieldBinding(primary.id, "atlas", "Project.deadline", "deadline", false),
      singleFieldBinding(replica.id, atlasNote, "Project.deadline", "deadline", true),
    ],
    authority: [{
      property: "Project.deadline",
      strategy: { kind: "provider", provider: primary.id },
    }],
    registry: {
      providers: new Map<string, StateProvider>([
        [primary.id, primary],
        [replica.id, replica],
      ]),
    },
  });
}

describe("MarkdownFilesystemConnector", () => {
  it("observes mapped YAML properties with an opaque content revision", async () => {
    const root = await vault();
    await seed(root);
    const markdown = connector(root, true);

    const snapshot = await markdown.observe(binding());

    expect(snapshot.observedAt).toBe(fixedNow);
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
    const markdown = connector(root);
    const snapshot = await markdown.observe(binding());

    await markdown.apply(mutation(snapshot, {
      externalPath: "deadline",
      canonicalProperty: "Project.deadline",
      nextValue: "2026-11-20",
      previousValue: "2026-11-15",
    }));

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
    const markdown = connector(root);
    const snapshot = await markdown.observe(binding());

    await markdown.apply(mutation(snapshot, {
      externalPath: "/project/owner",
      canonicalProperty: "Project.owner",
      nextValue: "Bob",
      previousValue: "Alice",
    }));

    const observed = await markdown.observe(binding());
    expect(observed.values["/project/owner"]).toBe("Bob");
  });

  it("creates frontmatter for an existing Markdown body without one", async () => {
    const root = await vault();
    const file = join(root, "Inbox.md");
    await writeFile(file, "# Inbox\n\nKeep this body.\n", "utf8");

    const markdown = connector(root);
    const inboxBinding = singleFieldBinding(
      markdownId,
      "Inbox.md",
      "Project.status",
      "status",
      true,
    );
    const snapshot = await markdown.observe(inboxBinding);

    expect(snapshot.values.status).toBeUndefined();

    await markdown.apply(mutation(snapshot, {
      externalId: "Inbox.md",
      externalPath: "status",
      canonicalProperty: "Project.status",
      nextValue: "active",
    }));

    expect(await readFile(file, "utf8")).toBe(
      "---\nstatus: active\n---\n# Inbox\n\nKeep this body.\n",
    );
  });

  it("preserves CRLF body line endings while updating frontmatter", async () => {
    const root = await vault();
    const file = join(root, "Windows.md");
    await writeFile(
      file,
      "---\r\ndeadline: 2026-11-15\r\nstatus: active\r\nproject:\r\n  owner: Alice\r\n---\r\n# Windows\r\n\r\nBody stays CRLF.\r\n",
      "utf8",
    );

    const markdown = connector(root);
    const windowsBinding = binding(markdownId, "Windows.md");
    const snapshot = await markdown.observe(windowsBinding);

    await markdown.apply(mutation(snapshot, {
      externalId: "Windows.md",
      externalPath: "deadline",
      canonicalProperty: "Project.deadline",
      nextValue: "2026-11-20",
      previousValue: "2026-11-15",
    }));

    const after = await readFile(file, "utf8");
    expect(after).toContain("deadline: 2026-11-20\r\n");
    expect(after.endsWith("# Windows\r\n\r\nBody stays CRLF.\r\n")).toBe(true);
    expect(after.replaceAll("\r\n", "").includes("\n")).toBe(false);
  });

  it("rejects a write when the file changed after observation", async () => {
    const root = await vault();
    const file = await seed(root);
    const markdown = connector(root);
    const snapshot = await markdown.observe(binding());

    await changeStatusExternally(file, "paused");

    await expect(markdown.apply(mutation(snapshot, {
      externalPath: "deadline",
      canonicalProperty: "Project.deadline",
      nextValue: "2026-11-20",
      previousValue: "2026-11-15",
    }))).rejects.toBeInstanceOf(StaleMarkdownFileError);

    expect(await readFile(file, "utf8")).toContain("deadline: 2026-11-15");
  });

  it("rejects traversal, absolute paths, and symlink escapes", async () => {
    const root = await vault();
    await seed(root);
    const markdown = connector(root);

    await expect(markdown.observe(binding(markdownId, "../outside.md")))
      .rejects.toBeInstanceOf(UnsafeMarkdownPathError);
    await expect(markdown.observe(binding(markdownId, "/tmp/outside.md")))
      .rejects.toBeInstanceOf(UnsafeMarkdownPathError);

    if (process.platform !== "win32") {
      const outsideRoot = await vault();
      const outsideFile = await seed(outsideRoot, "outside.md");
      await symlink(outsideFile, join(root, "escape.md"));
      await expect(markdown.observe(binding(markdownId, "escape.md")))
        .rejects.toBeInstanceOf(UnsafeMarkdownPathError);
    }
  });

  it("reconciles a canonical value into a real Markdown file and converges", async () => {
    const root = await vault();
    const file = await seed(root);
    const markdown = connector(root, true);

    const result = await reconcileDeadline(primaryDeadlineProvider(), markdown);

    expect(result.applied).toHaveLength(1);
    expect(result.after?.mutations).toHaveLength(0);
    expect(result.after?.conflicts).toHaveLength(0);
    expect(await readFile(file, "utf8")).toContain("deadline: 2026-11-20");
  });

  it("surfaces a stale filesystem write through the runtime apply error", async () => {
    const root = await vault();
    const file = await seed(root);
    const markdown = connector(root);
    let raced = false;

    const racingProvider: StateProvider = {
      id: markdown.id,
      async observe(externalBinding) {
        const snapshot = await markdown.observe(externalBinding);
        if (!raced) {
          raced = true;
          await changeStatusExternally(file, "changed-elsewhere");
        }
        return snapshot;
      },
      apply(nextMutation) {
        return markdown.apply(nextMutation);
      },
    };

    await expect(reconcileDeadline(primaryDeadlineProvider(), racingProvider))
      .rejects.toMatchObject({
        name: "ReconciliationApplyError",
        cause: expect.any(StaleMarkdownFileError),
      } satisfies Partial<ReconciliationApplyError>);
  });
});
