import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IngestionEngine,
  ingestionSourceKey,
  sourceCheckpoint,
  type DesiredProjection,
  type IncrementalSource,
  type ProjectionMapper,
  type SourceChange,
  type SourceReadRequest,
  type SourceReadResult,
} from "@ssrl/ingestion";
import {
  SQLiteIngestionStateStore,
  SQLiteSemanticStateStore,
} from "@ssrl/storage-sqlite";
import {
  ContextCapsuleMaterializer,
  IncrementalContextCapsuleWorker,
  InMemoryContextCapsuleStore,
} from "../src/index.js";

const roots: string[] = [];
const project = "entity://project/atlas" as const;
const sourceKey = ingestionSourceKey("synthetic/account-1/projects:all");

async function paths(): Promise<{ semantic: string; ingestion: string }> {
  const root = await mkdtemp(join(tmpdir(), "ssrl-ingestion-capsule-"));
  roots.push(root);
  return {
    semantic: join(root, "semantic.sqlite"),
    ingestion: join(root, "ingestion.sqlite"),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Payload {
  readonly apiStyle: string;
}

function sourceChange(
  changeId: string,
  revision: string,
  apiStyle: string,
  effectiveAt: string,
  recordedAt: string,
): SourceChange<Payload> {
  return {
    changeId,
    externalType: "project",
    externalId: "atlas",
    kind: "upsert",
    effectiveAt,
    recordedAt,
    revision,
    payload: { apiStyle },
  };
}

class OnePageSource implements IncrementalSource<Payload> {
  constructor(
    readonly item: SourceChange<Payload>,
    readonly checkpointValue: string,
  ) {}

  async read(_request: SourceReadRequest): Promise<SourceReadResult<Payload>> {
    return {
      kind: "page",
      changes: [this.item],
      next: { kind: "complete", checkpoint: sourceCheckpoint(this.checkpointValue) },
    };
  }
}

const mapper: ProjectionMapper<Payload> = {
  project(change): DesiredProjection {
    if (change.payload === undefined || change.revision === undefined) {
      throw new Error("payload and revision required");
    }
    return {
      additiveEntities: [{ entityId: project, entityType: "Project" }],
      additiveAliases: [{
        id: "alias-project-atlas",
        entityId: project,
        value: "Project Atlas",
        recordedAt: "2026-01-01T00:00:00Z",
        evidenceRefs: ["synthetic:atlas"],
      }],
      slots: [{
        key: "api-style",
        kind: "observation",
        record: {
          id: `api:${change.revision}`,
          entityId: project,
          property: "Project.apiStyle",
          value: change.payload.apiStyle,
          source: { provider: "synthetic", externalId: "atlas", revision: change.revision },
          validFrom: change.effectiveAt,
          recordedAt: change.recordedAt,
        },
      }],
    };
  },
};

describe("ingestion -> semantic feed -> capsule", () => {
  it("refreshes the existing capsule worker directly from ingestion-generated semantic changes", async () => {
    const db = await paths();
    const semantic = new SQLiteSemanticStateStore({ path: db.semantic });
    const ingestionState = new SQLiteIngestionStateStore({ path: db.ingestion });
    const engine = new IngestionEngine({ semanticState: semantic, ingestionState });
    const cache = new InMemoryContextCapsuleStore();
    const materializer = new ContextCapsuleMaterializer({
      stateStore: semantic,
      configurationVersion: "ingestion-test-v1",
    });
    const worker = new IncrementalContextCapsuleWorker({
      stateStore: semantic,
      capsuleStore: cache,
      materializer,
    });

    await engine.sync({
      sourceKey,
      source: new OnePageSource(
        sourceChange(
          "change-r1",
          "r1",
          "GraphQL",
          "2026-09-24T00:00:00Z",
          "2026-09-24T00:01:00Z",
        ),
        "cp-1",
      ),
      mapper,
    });
    const initial = await worker.runOnce({ at: "2026-09-24T01:00:00Z" });
    expect(initial.changesRead).toBe(3);
    expect(initial.changedEntityIds).toEqual([project]);
    expect((await cache.get(project))?.material.state.canonical.properties["Project.apiStyle"]?.value)
      .toBe("GraphQL");

    await engine.sync({
      sourceKey,
      source: new OnePageSource(
        sourceChange(
          "change-r2",
          "r2",
          "gRPC",
          "2026-09-25T00:00:00Z",
          "2026-09-25T00:01:00Z",
        ),
        "cp-2",
      ),
      mapper,
    });
    const update = await worker.runOnce({ at: "2026-09-25T01:00:00Z" });
    const capsule = await cache.get(project);
    expect(update.changesRead).toBe(2);
    expect(update.changedEntityIds).toEqual([project]);
    expect(capsule?.material.state.canonical.properties["Project.apiStyle"]?.value).toBe("gRPC");
    expect(capsule?.material.appliedRetractions).toEqual([
      expect.objectContaining({ targetId: "api:r1" }),
    ]);

    ingestionState.close();
    semantic.close();
  });
});
