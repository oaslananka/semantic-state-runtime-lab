import { afterEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  IngestionEngine,
  ingestionSourceKey,
  resolveSourceChange,
  sourceContinuation,
  type IncrementalSource,
  type SourceChangeDraft,
  type SourceReadRequest,
  type SourceReadResult,
} from "@ssrl/ingestion";
import type { ConnectorManifest } from "@ssrl/connector-sdk";
import {
  SQLiteIngestionStateStore,
  SQLiteSemanticStateStore,
} from "@ssrl/storage-sqlite";
import { LocalArtifactStore } from "@ssrl/storage-local-artifacts";
import {
  ContextCapsuleMaterializer,
  IncrementalContextCapsuleWorker,
  InMemoryContextCapsuleStore,
} from "@ssrl/materializer";
import {
  InvalidMarkdownContinuationError,
  InvalidMarkdownEncodingError,
  MarkdownAuthoritativeIngestionAdapter,
  MarkdownScanLimitError,
  type MarkdownIngestionPayload,
  StaleMarkdownIngestionSourceError,
} from "../src/index.js";

const roots: string[] = [];
const atlas = "entity://project/atlas" as const;
const beta = "entity://project/beta" as const;
const markdownSourceKey = ingestionSourceKey("markdown-authoritative-test");

async function vault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ssrl-markdown-ingestion-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function manifest(): ConnectorManifest {
  return {
    schemaVersion: "0.1",
    id: "markdown-ingestion",
    displayName: "Markdown ingestion",
    capabilities: {
      read: true,
      write: false,
      observe: true,
      subscribe: false,
      revisions: "opaque",
      idempotency: "none",
    },
    entities: [{
      canonicalType: "Project",
      externalType: "markdown-note",
      fields: [
        { canonical: "Project.status", external: "status", access: ["read"] },
        { canonical: "Project.deadline", external: "deadline", access: ["read"] },
      ],
    }],
  };
}

function adapter(root: string, overrides: Partial<ConstructorParameters<typeof MarkdownAuthoritativeIngestionAdapter>[0]> = {}) {
  return new MarkdownAuthoritativeIngestionAdapter({
    root,
    manifest: manifest(),
    externalType: "markdown-note",
    entityIdForExternalId: () => atlas,
    ...overrides,
  });
}

function entityForPath(externalId: string) {
  if (externalId.endsWith("Atlas.md")) return atlas;
  if (externalId.endsWith("Beta.md")) return beta;
  if (externalId.endsWith("Atlas-Renamed.md")) return "entity://project/atlas-renamed" as const;
  throw new Error(`unexpected Markdown identity ${externalId}`);
}

async function note(
  root: string,
  externalId: string,
  status: string,
  options: { readonly deadline?: string; readonly body?: string; readonly eol?: "\n" | "\r\n"; readonly bom?: boolean } = {},
): Promise<Uint8Array> {
  const eol = options.eol ?? "\n";
  const file = join(root, ...externalId.split("/"));
  await mkdir(dirname(file), { recursive: true });
  const text = [
    "---",
    `status: ${status}`,
    ...(options.deadline === undefined ? [] : [`deadline: ${options.deadline}`]),
    "unmapped: should-not-enter-payload",
    "---",
    options.body ?? "PRIVATE BODY MARKER",
    "",
  ].join(eol);
  const bytes = new TextEncoder().encode(`${options.bom === true ? "\uFEFF" : ""}${text}`);
  await writeFile(file, bytes);
  return bytes;
}

async function fullPage(source: MarkdownAuthoritativeIngestionAdapter) {
  const reset = await source.read({ mode: "incremental" });
  expect(reset).toEqual({
    kind: "reset-required",
    reason: "portable-markdown-filesystem-requires-authoritative-full-scan",
  });
  const page = await source.read({ mode: "full" });
  if (page.kind !== "page") throw new Error("expected Markdown full page");
  return page;
}

function resolved(change: SourceChangeDraft<MarkdownIngestionPayload>) {
  return resolveSourceChange(change, "2026-09-24T12:00:00Z");
}

function e2eAdapter(root: string) {
  return adapter(root, { entityIdForExternalId: entityForPath });
}

function openPersistentRuntime(paths: {
  readonly semantic: string;
  readonly ingestion: string;
  readonly artifacts: string;
}, now: string) {
  const semantic = new SQLiteSemanticStateStore({ path: paths.semantic });
  const ingestion = new SQLiteIngestionStateStore({ path: paths.ingestion });
  const artifacts = new LocalArtifactStore({ root: paths.artifacts });
  const engine = new IngestionEngine({
    semanticState: semantic,
    ingestionState: ingestion,
    artifactStore: artifacts,
    now: () => now,
  });
  return { semantic, ingestion, artifacts, engine };
}

function closePersistentRuntime(runtime: ReturnType<typeof openPersistentRuntime>): void {
  runtime.artifacts.close();
  runtime.ingestion.close();
  runtime.semantic.close();
}


function persistentPaths(storageRoot: string) {
  return {
    semantic: join(storageRoot, "semantic.sqlite"),
    ingestion: join(storageRoot, "ingestion.sqlite"),
    artifacts: join(storageRoot, "artifacts"),
  };
}

async function syncMarkdown(
  runtime: ReturnType<typeof openPersistentRuntime>,
  sourceRoot: string,
) {
  const source = e2eAdapter(sourceRoot);
  const result = await runtime.engine.sync({
    sourceKey: markdownSourceKey,
    source,
    mapper: source,
    artifactMapper: source,
  });
  return { result, source };
}

function capsuleWorker(
  runtime: ReturnType<typeof openPersistentRuntime>,
  cache: InMemoryContextCapsuleStore,
) {
  return new IncrementalContextCapsuleWorker({
    stateStore: runtime.semantic,
    capsuleStore: cache,
    materializer: new ContextCapsuleMaterializer({
      stateStore: runtime.semantic,
      configurationVersion: "markdown-e2e-v1",
    }),
  });
}

function artifactMutations(
  runtime: ReturnType<typeof openPersistentRuntime>,
  externalId: string,
) {
  return runtime.artifacts.mutationsForResource({
    sourceKey: markdownSourceKey,
    externalType: "markdown-note",
    externalId,
  });
}

class MutateAfterFullScanSource implements IncrementalSource<MarkdownIngestionPayload> {
  #mutated = false;

  constructor(
    readonly inner: MarkdownAuthoritativeIngestionAdapter,
    readonly mutate: () => Promise<void>,
  ) {}

  async read(request: SourceReadRequest): Promise<SourceReadResult<MarkdownIngestionPayload>> {
    const result = await this.inner.read(request);
    if (!this.#mutated && request.mode === "full" && result.kind === "page") {
      this.#mutated = true;
      await this.mutate();
    }
    return result;
  }
}

describe("MarkdownAuthoritativeIngestionAdapter", () => {
  it("performs deterministic authoritative scans and fingerprints the exact inventory", async () => {
    const root = await vault();
    await note(root, "Zeta.md", "paused");
    await note(root, "Projects/Atlas.md", "active", { deadline: "2026-11-20" });
    await writeFile(join(root, "ignore.txt"), "not markdown", "utf8");

    const first = await fullPage(adapter(root));
    expect(first.changes.map((change) => change.externalId)).toEqual([
      "Projects/Atlas.md",
      "Zeta.md",
    ]);
    expect(first.changes.every((change) => change.revision?.startsWith("sha256:"))).toBe(true);
    expect(first.next.kind).toBe("complete");
    const firstCheckpoint = first.next.kind === "complete" ? first.next.checkpoint : undefined;

    const second = await fullPage(adapter(root));
    expect(second.next).toEqual({ kind: "complete", checkpoint: firstCheckpoint });
    expect(second.changes.map((change) => change.changeId))
      .toEqual(first.changes.map((change) => change.changeId));

    await note(root, "Projects/Atlas.md", "done", { deadline: "2026-11-20" });
    const third = await fullPage(adapter(root));
    expect(third.next).not.toEqual(first.next);
    expect(third.changes[0]?.changeId).not.toBe(first.changes[0]?.changeId);
  });

  it("keeps raw body and unmapped frontmatter out of SourceChange payload", async () => {
    const root = await vault();
    await note(root, "Projects/Atlas.md", "active", {
      deadline: "2026-11-20",
      body: "SECRET BODY THAT MUST NOT ENTER RECEIPTS",
    });

    const page = await fullPage(adapter(root));
    const change = page.changes[0];
    expect(change?.payload).toEqual({
      values: { deadline: "2026-11-20", status: "active" },
    });
    const payloadJson = JSON.stringify(change?.payload);
    expect(payloadJson).not.toContain("SECRET BODY");
    expect(payloadJson).not.toContain("unmapped");
  });

  it("freezes structured pagination in one scan session and revalidates bytes before artifact mapping", async () => {
    const root = await vault();
    await note(root, "A.md", "active");
    await note(root, "B.md", "active");
    const source = adapter(root, { pageSize: 1 });

    const first = await source.read({ mode: "full" });
    if (first.kind !== "page" || first.next.kind !== "continue") {
      throw new Error("expected first paginated Markdown page");
    }
    expect(first.changes[0]?.externalId).toBe("A.md");
    await note(root, "B.md", "changed-after-scan");

    const second = await source.read({ mode: "full", continuation: first.next.cursor });
    if (second.kind !== "page") throw new Error("expected second Markdown page");
    expect(second.changes[0]?.externalId).toBe("B.md");
    expect(second.changes[0]?.payload).toEqual({ values: { status: "active" } });

    await expect(source.projectArtifact(resolved(second.changes[0]!)))
      .rejects.toBeInstanceOf(StaleMarkdownIngestionSourceError);
  });

  it("round-trips BOM, CRLF, and arbitrary Markdown body bytes exactly through artifact projection", async () => {
    const root = await vault();
    const original = await note(root, "Windows.md", "active", {
      body: "Body stays byte exact: π 🚀",
      eol: "\r\n",
      bom: true,
    });
    const source = adapter(root);
    const page = await fullPage(source);
    const projection = await source.projectArtifact(resolved(page.changes[0]!));

    expect(projection?.mediaType).toBe("text/markdown");
    expect(projection?.title).toBe("Windows.md");
    expect([...projection!.bytes]).toEqual([...original]);
  });

  it("produces deterministic semantic observations using explicit entity identity", async () => {
    const root = await vault();
    await note(root, "Projects/Atlas.md", "active", { deadline: "2026-11-20" });
    const source = adapter(root);
    const page = await fullPage(source);
    const change = resolved(page.changes[0]!);

    const first = source.project(change);
    const second = source.project(change);
    expect(second).toEqual(first);
    expect(first.additiveEntities).toEqual([{ entityId: atlas, entityType: "Project" }]);
    expect(first.slots.map((slot) => {
      if (slot.kind !== "observation") throw new Error("expected observation slot");
      return [slot.key, slot.record.entityId, slot.record.source.revision];
    })).toEqual([
      ["Project.status", atlas, change.revision],
      ["Project.deadline", atlas, change.revision],
    ]);
  });

  it("omits a missing mapped field so generic ingestion can retract the previous slot", async () => {
    const root = await vault();
    await note(root, "Atlas.md", "active");
    const source = adapter(root);
    const page = await fullPage(source);
    const projection = source.project(resolved(page.changes[0]!));

    expect(projection.slots.map((slot) => slot.key)).toEqual(["Project.status"]);
  });

  it("excludes symlinked Markdown entries from authoritative inventory", async () => {
    if (process.platform === "win32") return;
    const root = await vault();
    const outside = await vault();
    await note(root, "Real.md", "active");
    const outsideFile = join(outside, "Outside.md");
    await writeFile(outsideFile, "---\nstatus: secret\n---\n", "utf8");
    await symlink(outsideFile, join(root, "OutsideLink.md"));
    await symlink(join(root, "Real.md"), join(root, "InsideLink.md"));

    const page = await fullPage(adapter(root));
    expect(page.changes.map((change) => change.externalId)).toEqual(["Real.md"]);
  });

  it("fails closed on invalid UTF-8 Markdown", async () => {
    const root = await vault();
    await writeFile(join(root, "Invalid.md"), new Uint8Array([0xff, 0xfe, 0xfd]));

    await expect(adapter(root).read({ mode: "full" }))
      .rejects.toBeInstanceOf(InvalidMarkdownEncodingError);
  });

  it("fails closed when maxFiles or maxRawBytes is exceeded", async () => {
    const root = await vault();
    await note(root, "A.md", "active");
    await note(root, "B.md", "active");

    await expect(adapter(root, { maxFiles: 1 }).read({ mode: "full" }))
      .rejects.toBeInstanceOf(MarkdownScanLimitError);
    await expect(adapter(root, { maxRawBytes: 1 }).read({ mode: "full" }))
      .rejects.toBeInstanceOf(MarkdownScanLimitError);
  });

  it("rejects foreign or expired full-scan continuations", async () => {
    const root = await vault();
    await note(root, "A.md", "active");
    await note(root, "B.md", "active");
    const source = adapter(root, { pageSize: 1 });

    await expect(source.read({
      mode: "full",
      continuation: sourceContinuation("markdown-full-v1:00000000-0000-0000-0000-000000000000:1"),
    })).rejects.toBeInstanceOf(InvalidMarkdownContinuationError);

    const first = await source.read({ mode: "full" });
    if (first.kind !== "page" || first.next.kind !== "continue") throw new Error("expected continuation");
    await source.read({ mode: "full", continuation: first.next.cursor });
    await expect(source.read({ mode: "full", continuation: first.next.cursor }))
      .rejects.toBeInstanceOf(InvalidMarkdownContinuationError);
  });

  it("fails artifact mapping if a scanned file is deleted before raw-byte projection", async () => {
    const root = await vault();
    const file = join(root, "Atlas.md");
    await note(root, "Atlas.md", "active");
    const source = adapter(root);
    const page = await fullPage(source);
    const change = resolved(page.changes[0]!);
    await unlink(file);

    await expect(source.projectArtifact(change))
      .rejects.toBeInstanceOf(StaleMarkdownIngestionSourceError);
  });

  it("does not alter exact bytes during a source scan", async () => {
    const root = await vault();
    const original = await note(root, "Atlas.md", "active", { body: "read only scan" });
    await fullPage(adapter(root));
    expect([...await readFile(join(root, "Atlas.md"))]).toEqual([...original]);
  });

  it("runs raw Markdown -> durable ingestion -> CAS -> semantic feed -> capsule across restarts", async () => {
    const sourceRoot = await vault();
    const storageRoot = await vault();
    const paths = persistentPaths(storageRoot);
    const atlasBytesV1 = await note(sourceRoot, "Projects/Atlas.md", "active", {
      deadline: "2026-11-20",
      body: "ATLAS PRIVATE BODY V1",
      eol: "\r\n",
      bom: true,
    });
    const betaBytes = await note(sourceRoot, "Projects/Beta.md", "planning", {
      body: "BETA PRIVATE BODY",
    });
    const cache = new InMemoryContextCapsuleStore();

    let runtime = openPersistentRuntime(paths, "2026-09-24T10:00:00Z");
    const first = (await syncMarkdown(runtime, sourceRoot)).result;
    expect(first.mode).toBe("full");
    expect(first.resetPerformed).toBe(true);
    expect(first.changesProcessed).toBe(2);
    expect(first.sweptResources).toBe(0);
    expect(first.artifactMutationsAppended).toBe(2);
    expect(first.semanticAppends).toEqual({
      entities: 2,
      aliases: 0,
      observations: 3,
      relations: 0,
      retractions: 0,
    });

    const atlasArtifactsV1 = await artifactMutations(runtime, "Projects/Atlas.md");
    const betaArtifactsV1 = await artifactMutations(runtime, "Projects/Beta.md");
    expect(atlasArtifactsV1).toHaveLength(1);
    expect(betaArtifactsV1).toHaveLength(1);
    const atlasUpsertV1 = atlasArtifactsV1[0];
    const betaUpsertV1 = betaArtifactsV1[0];
    if (atlasUpsertV1?.kind !== "upsert" || betaUpsertV1?.kind !== "upsert") {
      throw new Error("expected initial Markdown artifact upserts");
    }
    expect([...(await runtime.artifacts.readBlobRange(atlasUpsertV1.blob.digest, {
      maxBytes: atlasBytesV1.byteLength,
    })).bytes]).toEqual([...atlasBytesV1]);
    expect([...(await runtime.artifacts.readBlobRange(betaUpsertV1.blob.digest, {
      maxBytes: betaBytes.byteLength,
    })).bytes]).toEqual([...betaBytes]);

    const probe = await fullPage(e2eAdapter(sourceRoot));
    const atlasDraft = probe.changes.find((change) => change.externalId === "Projects/Atlas.md");
    if (atlasDraft === undefined) throw new Error("expected Atlas source draft");
    const receipt = await runtime.ingestion.changeReceipt(markdownSourceKey, atlasDraft);
    const mapped = await runtime.ingestion.mappedPlan(markdownSourceKey, atlasDraft.changeId);
    expect(JSON.stringify(receipt)).not.toContain("ATLAS PRIVATE BODY V1");
    expect(JSON.stringify(mapped)).not.toContain("ATLAS PRIVATE BODY V1");
    expect(JSON.stringify(receipt)).not.toContain("unmapped");

    let worker = capsuleWorker(runtime, cache);
    await worker.runOnce({ at: "2026-09-24T10:01:00Z" });
    expect((await cache.get(atlas))?.material.state.canonical.properties["Project.status"]?.value)
      .toBe("active");
    expect((await cache.get(atlas))?.material.state.canonical.properties["Project.deadline"]?.value)
      .toBe("2026-11-20");
    closePersistentRuntime(runtime);

    const atlasBytesV2 = await note(sourceRoot, "Projects/Atlas.md", "done", {
      body: "ATLAS PRIVATE BODY V2",
      eol: "\r\n",
      bom: true,
    });
    runtime = openPersistentRuntime(paths, "2026-09-25T10:00:00Z");
    const second = (await syncMarkdown(runtime, sourceRoot)).result;
    expect(second.artifactMutationsAppended).toBe(1);
    expect(second.semanticAppends.entities).toBe(0);
    expect(second.semanticAppends.observations).toBe(1);
    expect(second.semanticAppends.retractions).toBe(2);
    const atlasArtifactsV2 = await artifactMutations(runtime, "Projects/Atlas.md");
    const betaArtifactsV2 = await artifactMutations(runtime, "Projects/Beta.md");
    expect(atlasArtifactsV2).toHaveLength(2);
    expect(betaArtifactsV2).toHaveLength(1);
    const atlasLatest = atlasArtifactsV2.at(-1);
    if (atlasLatest?.kind !== "upsert") throw new Error("expected edited Atlas artifact upsert");
    expect([...(await runtime.artifacts.readBlobRange(atlasLatest.blob.digest, {
      maxBytes: atlasBytesV2.byteLength,
    })).bytes]).toEqual([...atlasBytesV2]);
    worker = new IncrementalContextCapsuleWorker({
      stateStore: runtime.semantic,
      capsuleStore: cache,
      materializer: new ContextCapsuleMaterializer({
        stateStore: runtime.semantic,
        configurationVersion: "markdown-e2e-v1",
      }),
    });
    const update = await worker.runOnce({ at: "2026-09-25T10:01:00Z" });
    expect(update.changedEntityIds).toEqual([atlas]);
    expect((await cache.get(atlas))?.material.state.canonical.properties["Project.status"]?.value)
      .toBe("done");
    expect((await cache.get(atlas))?.material.state.canonical.properties["Project.deadline"])
      .toBeUndefined();
    closePersistentRuntime(runtime);

    await unlink(join(sourceRoot, "Projects", "Beta.md"));
    runtime = openPersistentRuntime(paths, "2026-09-26T10:00:00Z");
    const third = (await syncMarkdown(runtime, sourceRoot)).result;
    expect(third.sweptResources).toBe(1);
    expect(third.artifactMutationsAppended).toBe(1);
    expect(third.semanticAppends.retractions).toBe(1);
    const betaArtifactsV3 = await artifactMutations(runtime, "Projects/Beta.md");
    expect(betaArtifactsV3.map((mutation) => mutation.kind)).toEqual(["upsert", "delete"]);
    worker = new IncrementalContextCapsuleWorker({
      stateStore: runtime.semantic,
      capsuleStore: cache,
      materializer: new ContextCapsuleMaterializer({
        stateStore: runtime.semantic,
        configurationVersion: "markdown-e2e-v1",
      }),
    });
    const deletion = await worker.runOnce({ at: "2026-09-26T10:01:00Z" });
    expect(deletion.changedEntityIds).toEqual([beta]);
    expect((await cache.get(beta))?.material.state.canonical.properties["Project.status"])
      .toBeUndefined();
    closePersistentRuntime(runtime);
  });

  it("treats a Markdown rename as delete(old path) plus upsert(new path)", async () => {
    const sourceRoot = await vault();
    const storageRoot = await vault();
    const paths = persistentPaths(storageRoot);
    await note(sourceRoot, "Projects/Atlas.md", "active");
    let runtime = openPersistentRuntime(paths, "2026-09-24T11:00:00Z");
    await syncMarkdown(runtime, sourceRoot);
    closePersistentRuntime(runtime);

    await mkdir(join(sourceRoot, "Archive"), { recursive: true });
    await rename(
      join(sourceRoot, "Projects", "Atlas.md"),
      join(sourceRoot, "Archive", "Atlas-Renamed.md"),
    );
    runtime = openPersistentRuntime(paths, "2026-09-25T11:00:00Z");
    const result = (await syncMarkdown(runtime, sourceRoot)).result;
    expect(result.sweptResources).toBe(1);
    expect(result.artifactMutationsAppended).toBe(2);
    expect((await artifactMutations(runtime, "Projects/Atlas.md")).map((mutation) => mutation.kind))
      .toEqual(["upsert", "delete"]);
    expect((await artifactMutations(runtime, "Archive/Atlas-Renamed.md")).map((mutation) => mutation.kind))
      .toEqual(["upsert"]);
    closePersistentRuntime(runtime);
  });

  it("aborts a scan-to-artifact race without artifact, semantic, projection, or checkpoint advancement", async () => {
    const sourceRoot = await vault();
    const storageRoot = await vault();
    await note(sourceRoot, "Projects/Atlas.md", "active", { body: "before scan race" });
    const source = e2eAdapter(sourceRoot);
    const racingSource = new MutateAfterFullScanSource(source, async () => {
      await note(sourceRoot, "Projects/Atlas.md", "changed", { body: "after scan race" });
    });
    const runtime = openPersistentRuntime(
      persistentPaths(storageRoot),
      "2026-09-24T12:00:00Z",
    );

    await expect(runtime.engine.sync({
      sourceKey: markdownSourceKey,
      source: racingSource,
      mapper: source,
      artifactMapper: source,
    })).rejects.toBeInstanceOf(StaleMarkdownIngestionSourceError);
    expect((await runtime.artifacts.snapshot()).mutations).toEqual([]);
    expect((await runtime.semantic.snapshot()).observations).toEqual([]);
    expect(await runtime.ingestion.projection(
      markdownSourceKey,
      "markdown-note",
      "Projects/Atlas.md",
    )).toBeUndefined();
    expect(await runtime.ingestion.checkpoint(markdownSourceKey)).toBeUndefined();
    closePersistentRuntime(runtime);
  });

});
