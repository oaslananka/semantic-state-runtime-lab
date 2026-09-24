import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { ConnectorManifest } from "../packages/connector-sdk/dist/index.js";
import { MarkdownAuthoritativeIngestionAdapter } from "../packages/connector-markdown-fs/dist/index.js";
import type { EntityId } from "../packages/core/dist/index.js";
import type { SourceContinuation } from "../packages/ingestion/dist/index.js";
import {
  CoalescedVerifiedSourceSync,
  SourceVerificationGate,
} from "../packages/node-app/dist/source-verification.js";

interface CaseResult {
  readonly notes: number;
  readonly bytes: number;
  readonly pages: number;
  readonly changes: number;
  readonly authoritativeScanMs: number;
  readonly dirtyHintVerifyMs: number;
  readonly cleanHintBurstRequests: number;
  readonly cleanHintBurstElapsedMs: number;
  readonly cleanHintMeanMs: number;
  readonly verificationScans: number;
  readonly mibPerSecond: number;
  readonly checkpointStable: boolean;
}

const benchmarkFields = [
  ["Project.status", "status"],
  ["Project.deadline", "deadline"],
  ["Project.priority", "priority"],
] as const;

const manifest: ConnectorManifest = {
  id: "markdown-benchmark",
  schemaVersion: "0.1",
  displayName: "Markdown benchmark",
  capabilities: {
    observe: true,
    read: true,
    revisions: "opaque",
    subscribe: false,
    write: false,
    idempotency: "none",
  },
  entities: [{
    externalType: "markdown-note",
    canonicalType: "Project",
    fields: benchmarkFields.map(([canonical, external]) => ({
      canonical, external, access: ["read"] as const,
    })),
  }],
};

function entityIdForExternalId(externalId: string): EntityId {
  return `entity://benchmark/${encodeURIComponent(externalId)}` as EntityId;
}

function noteText(index: number): string {
  return [
    "---",
    `status: ${index % 3 === 0 ? "active" : "planning"}`,
    `deadline: 2026-11-${String((index % 28) + 1).padStart(2, "0")}`,
    `priority: ${index % 5}`,
    "ignored: not-projected",
    "---",
    `# Project ${index}`,
    "",
    `Deterministic benchmark body ${index}. This text participates in hashing but not semantic payload projection.`,
    "",
  ].join("\n");
}

async function seed(root: string, count: number): Promise<number> {
  let bytes = 0;
  for (let index = 0; index < count; index += 1) {
    const folder = join(root, `bucket-${String(index % 20).padStart(2, "0")}`);
    await mkdir(folder, { recursive: true });
    const text = noteText(index);
    bytes += Buffer.byteLength(text, "utf8");
    await writeFile(join(folder, `note-${String(index).padStart(5, "0")}.md`), text, "utf8");
  }
  return bytes;
}

async function fullScan(adapter: MarkdownAuthoritativeIngestionAdapter) {
  let continuation: SourceContinuation | undefined;
  let pages = 0;
  let changes = 0;
  let checkpoint: string | undefined;
  do {
    const result = await adapter.read({
      mode: "full",
      ...(continuation === undefined ? {} : { continuation }),
    });
    if (result.kind !== "page") throw new Error("Markdown full scan returned reset-required");
    pages += 1;
    changes += result.changes.length;
    if (result.next.kind === "continue") {
      continuation = result.next.cursor;
    } else {
      checkpoint = result.next.checkpoint;
      continuation = undefined;
    }
  } while (continuation !== undefined);
  return { pages, changes, checkpoint };
}

async function runCase(notes: number): Promise<CaseResult> {
  const root = await mkdtemp(join(tmpdir(), `ssrl-markdown-bench-${notes}-`));
  try {
    const bytes = await seed(root, notes);
    const adapter = new MarkdownAuthoritativeIngestionAdapter({
      root,
      manifest,
      externalType: "markdown-note",
      entityIdForExternalId,
      pageSize: 128,
      maxFiles: notes + 10,
      maxRawBytes: bytes + 1024,
    });
    const start = performance.now();
    const first = await fullScan(adapter);
    const authoritativeScanMs = performance.now() - start;

    const gate = new SourceVerificationGate({ maxVerificationAgeMs: 60_000 });
    let verificationScans = 0;
    let latestCheckpoint: string | undefined;
    const sync = new CoalescedVerifiedSourceSync([{
      id: "markdown",
      gate,
      async verify() {
        verificationScans += 1;
        latestCheckpoint = (await fullScan(adapter)).checkpoint;
      },
    }]);
    const dirtyStart = performance.now();
    await sync.run();
    const dirtyHintVerifyMs = performance.now() - dirtyStart;

    const cleanHintBurstRequests = 25;
    const scansBeforeCleanBurst = verificationScans;
    const cleanStart = performance.now();
    for (let index = 0; index < cleanHintBurstRequests; index += 1) await sync.run();
    const cleanHintBurstElapsedMs = performance.now() - cleanStart;
    if (verificationScans !== scansBeforeCleanBurst) {
      throw new Error(`Clean dirty-hint burst unexpectedly scanned at ${notes} files`);
    }

    gate.markDirty();
    await sync.run();
    if (verificationScans !== 2) {
      throw new Error(`Dirty hint did not trigger exactly one verification at ${notes} files`);
    }
    const mib = bytes / (1024 * 1024);
    return {
      notes,
      bytes,
      pages: first.pages,
      changes: first.changes,
      authoritativeScanMs: Number(authoritativeScanMs.toFixed(2)),
      dirtyHintVerifyMs: Number(dirtyHintVerifyMs.toFixed(2)),
      cleanHintBurstRequests,
      cleanHintBurstElapsedMs: Number(cleanHintBurstElapsedMs.toFixed(3)),
      cleanHintMeanMs: Number((cleanHintBurstElapsedMs / cleanHintBurstRequests).toFixed(4)),
      verificationScans,
      mibPerSecond: Number((mib / Math.max(authoritativeScanMs / 1000, Number.EPSILON)).toFixed(2)),
      checkpointStable: first.checkpoint === latestCheckpoint,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const results = [];
for (const notes of [100, 1_000, 10_000]) results.push(await runCase(notes));
console.log(JSON.stringify({
  benchmark: "markdown-authoritative-ingestion-v1",
  scope: "recursive enumerate + exact byte read + SHA-256 + strict UTF-8 + frontmatter parse/projected-field extraction",
  note: "Timing is observational. Dirty hints never replace authoritative scans; clean bursts measure only the verification gate. No production SLA is implied.",
  results,
}, null, 2));
