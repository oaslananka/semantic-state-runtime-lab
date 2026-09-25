import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccessPrincipal } from "../packages/access/dist/index.js";
import type { ArtifactStore } from "../packages/artifact-store/dist/index.js";
import {
  exportArtifactReplicationRecords,
  exportSemanticReplicationRecords,
  type ReplicationRecord,
} from "../packages/replication/dist/index.js";
import {
  BoundedReconciliationSession,
  type MerkleNodeHashResponse,
  type ReconciliationEndpoint,
  type ReconciliationViewInfo,
  type ReconciliationViewReader,
} from "../packages/replication/dist/sync.js";
import {
  ReplicationAccessGateway,
  type ReplicationAccessPolicy,
  type ReplicationRecordSource,
} from "../packages/replication-access/dist/index.js";
import {
  ReplicationHttpClient,
  createReplicationHttpHandler,
  type ReplicationHttpAuthenticator,
  type ReplicationHttpFetch,
} from "../packages/replication-http/dist/index.js";
import { startNodeReplicationHttpServer } from "../packages/replication-http/dist/node.js";
import { LocalArtifactStore } from "../packages/storage-local-artifacts/dist/index.js";
import { SQLiteSemanticStateStore } from "../packages/storage-sqlite/dist/index.js";

const project = "entity://project/http-benchmark" as const;
const observationCount = 64;
const sharedObservationCount = 32;
const blobBytes = new TextEncoder().encode("replication-blob-access-benchmark-payload");
const principal: AccessPrincipal = {
  subject: "benchmark:http-sync",
  scopes: ["replication"],
};

interface WireMetrics {
  requests: number;
  requestBytes: number;
  jsonRequestBytes: number;
  binaryRequestBytes: number;
  responseBytes: number;
  jsonResponseBytes: number;
  binaryResponseBytes: number;
}

function emptyMetrics(): WireMetrics {
  return {
    requests: 0,
    requestBytes: 0,
    jsonRequestBytes: 0,
    binaryRequestBytes: 0,
    responseBytes: 0,
    jsonResponseBytes: 0,
    binaryResponseBytes: 0,
  };
}

function isJson(contentType: string | null): boolean {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function measuredFetch(metrics: WireMetrics): ReplicationHttpFetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const requestCopy = request.clone();
    const requestBytes = new Uint8Array(await requestCopy.arrayBuffer()).byteLength;
    metrics.requests += 1;
    metrics.requestBytes += requestBytes;
    if (isJson(request.headers.get("content-type"))) metrics.jsonRequestBytes += requestBytes;
    else metrics.binaryRequestBytes += requestBytes;

    const response = await fetch(request);
    const responseBytes = new Uint8Array(await response.clone().arrayBuffer()).byteLength;
    metrics.responseBytes += responseBytes;
    if (isJson(response.headers.get("content-type"))) metrics.jsonResponseBytes += responseBytes;
    else metrics.binaryResponseBytes += responseBytes;
    return response;
  };
}

class BenchmarkAuthenticator implements ReplicationHttpAuthenticator {
  authenticate(request: Request): AccessPrincipal | Response {
    return request.headers.get("authorization") === "Bearer benchmark-token"
      ? principal
      : new Response("unauthorized", { status: 401 });
  }
}

class CombinedSource implements ReplicationRecordSource {
  readonly semantic: SQLiteSemanticStateStore;
  readonly artifacts: ArtifactStore;

  constructor(semantic: SQLiteSemanticStateStore, artifacts: ArtifactStore) {
    this.semantic = semantic;
    this.artifacts = artifacts;
  }

  async records(): Promise<readonly ReplicationRecord[]> {
    return [
      ...await exportSemanticReplicationRecords(this.semantic),
      ...await exportArtifactReplicationRecords(this.artifacts),
    ];
  }
}

const policy: ReplicationAccessPolicy = {
  evaluate() {
    return { effect: "allow" };
  },
};

function access(source: ReplicationRecordSource): ReplicationAccessGateway {
  return new ReplicationAccessGateway({
    source,
    policy,
    policyVersion: () => "benchmark-http-v1",
    projectionIds: ["benchmark"],
    maxSourceRecords: 256,
    maxProjectionRecords: 256,
    maxPolicyEvaluations: 256,
    maxReadRecords: 128,
    maxReadBytes: 4 * 1024 * 1024,
    maxApplyRecords: 128,
    maxApplyBytes: 4 * 1024 * 1024,
    maxBlobReadBytes: 1024,
    maxBlobApplyBytes: 1024,
    now: () => "2026-09-25T00:00:00Z",
  });
}

async function seed(
  store: SQLiteSemanticStateStore,
  count: number,
): Promise<void> {
  await store.append({
    entities: [{ entityId: project, entityType: "Project" }],
    aliases: [{
      id: "alias-http-benchmark",
      entityId: project,
      value: "HTTP Benchmark",
      recordedAt: "2026-01-01T00:00:00Z",
    }],
    observations: Array.from({ length: count }, (_, index) => ({
      id: `obs-${String(index).padStart(3, "0")}`,
      entityId: project,
      property: `Benchmark.field${String(index).padStart(3, "0")}`,
      value: `value-${index}`,
      source: { provider: "benchmark", externalId: `field-${index}` },
      validFrom: "2026-01-01T00:00:00Z",
      recordedAt: "2026-01-02T00:00:00Z",
    })),
  });
}

function localReader(
  endpoint: ReconciliationEndpoint,
  info: ReconciliationViewInfo,
): ReconciliationViewReader {
  return {
    info: () => info,
    nodeHashes(refs, options): MerkleNodeHashResponse {
      const response = endpoint.nodeHashes(info.viewId, refs, options);
      if (response instanceof Promise) throw new Error("benchmark local endpoint became async");
      return response;
    },
    leafPage: (options) => endpoint.leafPage(info.viewId, options),
  };
}

function client(baseUrl: URL, metrics: WireMetrics): ReplicationHttpClient {
  return new ReplicationHttpClient({
    baseUrl,
    fetch: measuredFetch(metrics),
    headers: () => ({ authorization: "Bearer benchmark-token" }),
  });
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

const root = await mkdtemp(join(tmpdir(), "ssrl-replication-http-benchmark-"));
const sourceSemantic = new SQLiteSemanticStateStore({ path: join(root, "source-state.sqlite") });
const targetSemantic = new SQLiteSemanticStateStore({ path: join(root, "target-state.sqlite") });
const sourceArtifacts = new LocalArtifactStore({ root: join(root, "source-artifacts") });
const targetArtifacts = new LocalArtifactStore({ root: join(root, "target-artifacts") });
let sourceServer: Awaited<ReturnType<typeof startNodeReplicationHttpServer>> | undefined;
let targetServer: Awaited<ReturnType<typeof startNodeReplicationHttpServer>> | undefined;

try {
  await seed(sourceSemantic, observationCount);
  await seed(targetSemantic, sharedObservationCount);
  const blob = await sourceArtifacts.putBlob(blobBytes, "text/plain");
  await sourceArtifacts.append([{
    id: "http-benchmark-artifact-v1",
    resource: {
      sourceKey: "benchmark",
      externalType: "note",
      externalId: "benchmark.txt",
    },
    kind: "upsert",
    effectiveAt: "2026-09-25T00:00:00Z",
    recordedAt: "2026-09-25T00:00:00Z",
    blob,
  }]);

  const sourceAccess = access(new CombinedSource(sourceSemantic, sourceArtifacts));
  const targetAccess = access(new CombinedSource(targetSemantic, targetArtifacts));
  const authenticator = new BenchmarkAuthenticator();
  sourceServer = await startNodeReplicationHttpServer({
    handler: createReplicationHttpHandler({
      gateway: sourceAccess,
      semanticStore: sourceSemantic,
      artifactStore: sourceArtifacts,
      authenticator,
      allowedHostnames: ["127.0.0.1"],
    }),
  });
  targetServer = await startNodeReplicationHttpServer({
    handler: createReplicationHttpHandler({
      gateway: targetAccess,
      semanticStore: targetSemantic,
      artifactStore: targetArtifacts,
      authenticator,
      allowedHostnames: ["127.0.0.1"],
    }),
  });

  const sourceWire = emptyMetrics();
  const targetWire = emptyMetrics();
  const sourceClient = client(sourceServer.baseUrl, sourceWire);
  const targetClient = client(targetServer.baseUrl, targetWire);
  const sourceOpened = await sourceClient.openProjection({ projectionId: "benchmark", prefixBits: 8 });
  const targetOpened = await targetAccess.openProjection({ principal, projectionId: "benchmark", prefixBits: 8 });
  const targetEndpoint = targetAccess.endpoint(principal, "benchmark");
  const reader = localReader(targetEndpoint, targetOpened.view);

  const started = performance.now();
  const session = await BoundedReconciliationSession.start(
    reader,
    sourceClient.endpoint("benchmark"),
    sourceOpened.view.viewId,
    { maxNodeRefsPerStep: 32, maxLeafDescriptors: 32, maxLeafBytes: 128 * 1024 },
  );
  const delta = await session.runToCompletion(reader, sourceClient.endpoint("benchmark"));
  if (delta.collisions.length !== 0 || delta.localOnly.length !== 0 || delta.remoteOnly.length !== 33) {
    throw new Error("replication HTTP benchmark delta invariant failed");
  }

  const incoming = await sourceClient.readRecords({
    projectionId: "benchmark",
    viewId: sourceOpened.view.viewId,
    keys: delta.remoteOnly,
    maxRecords: 64,
  });
  const semantic = incoming.filter((record) => record.kind !== "artifact-mutation");
  const artifact = incoming.filter((record) => record.kind === "artifact-mutation");
  if (semantic.length !== observationCount - sharedObservationCount || artifact.length !== 1) {
    throw new Error("replication HTTP benchmark transfer partition invariant failed");
  }
  await targetClient.applySemantic({ projectionId: "benchmark", records: semantic });

  const artifactRecord = artifact[0]!;
  const readBlob = await sourceClient.readArtifactBlob({
    projectionId: "benchmark",
    viewId: sourceOpened.view.viewId,
    digest: blob.digest,
  });
  await targetClient.installArtifactBlob({
    projectionId: "benchmark",
    record: artifactRecord,
    bytes: readBlob.bytes,
  });
  const insertedArtifacts = await targetClient.applyArtifacts({
    projectionId: "benchmark",
    records: [artifactRecord],
  });
  if (insertedArtifacts !== 1) throw new Error("replication HTTP benchmark artifact apply invariant failed");

  const [sourceFinal, targetFinal] = await Promise.all([
    sourceClient.openProjection({ projectionId: "benchmark", prefixBits: 8 }),
    targetClient.openProjection({ projectionId: "benchmark", prefixBits: 8 }),
  ]);
  if (
    sourceFinal.view.rootDigest !== targetFinal.view.rootDigest
    || sourceFinal.view.recordCount !== targetFinal.view.recordCount
  ) {
    throw new Error("replication HTTP benchmark convergence invariant failed");
  }
  const elapsedMs = performance.now() - started;

  console.log(JSON.stringify({
    benchmark: "replication-http-transport-v1",
    note: "Deterministic local loopback transport accounting. Elapsed time is observational only; no WAN RTT, TLS handshake, OAuth/DPoP verification, proxy, relay, or production throughput claim.",
    fixture: {
      sourceSemanticObservations: observationCount,
      targetSharedSemanticObservations: sharedObservationCount,
      semanticDeltaRecords: semantic.length,
      artifactDeltaRecords: artifact.length,
      blobBytes: blobBytes.byteLength,
      convergedRecords: sourceFinal.view.recordCount,
    },
    reconciliation: {
      ...delta.counters,
      remoteOnly: delta.remoteOnly.length,
      localOnly: delta.localOnly.length,
      collisions: delta.collisions.length,
    },
    sourceHttp: sourceWire,
    targetHttp: targetWire,
    totals: {
      requests: sourceWire.requests + targetWire.requests,
      requestBytes: sourceWire.requestBytes + targetWire.requestBytes,
      jsonRequestBytes: sourceWire.jsonRequestBytes + targetWire.jsonRequestBytes,
      binaryRequestBytes: sourceWire.binaryRequestBytes + targetWire.binaryRequestBytes,
      responseBytes: sourceWire.responseBytes + targetWire.responseBytes,
      jsonResponseBytes: sourceWire.jsonResponseBytes + targetWire.jsonResponseBytes,
      binaryResponseBytes: sourceWire.binaryResponseBytes + targetWire.binaryResponseBytes,
      elapsedMs: round(elapsedMs),
    },
  }, null, 2));
} finally {
  await Promise.all([
    sourceServer?.close(),
    targetServer?.close(),
  ]);
  sourceSemantic.close();
  targetSemantic.close();
  await rm(root, { recursive: true, force: true });
}
