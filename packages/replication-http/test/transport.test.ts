import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccessPrincipal } from "@ssrl/access";
import type { ArtifactDigest, ArtifactStore } from "@ssrl/artifact-store";
import {
  exportArtifactReplicationRecords,
  exportSemanticReplicationRecords,
  type ReplicationRecord,
  type ReplicationRecordKey,
} from "@ssrl/replication";
import {
  BoundedReconciliationSession,
  RECONCILIATION_PROTOCOL_SCHEMA,
  type MerkleNodeHashResponse,
  type ReconciliationEndpoint,
  type ReconciliationViewInfo,
  type ReconciliationViewReader,
} from "@ssrl/replication/sync";
import {
  ReplicationAccessGateway,
  type ReplicationAccessPolicy,
  type ReplicationAccessRequest,
  type ReplicationRecordSource,
} from "@ssrl/replication-access";
import { LocalArtifactStore } from "@ssrl/storage-local-artifacts";
import { SQLiteSemanticStateStore } from "@ssrl/storage-sqlite";
import {
  startNodeReplicationHttpServer,
  type NodeReplicationHttpServer,
} from "../src/node.js";
import {
  InvalidReplicationHttpResponseError,
  REPLICATION_BLOB_INSTALL_MEDIA_TYPE,
  REPLICATION_HTTP_ROUTES,
  ReplicationHttpClient,
  ReplicationHttpRemoteError,
  createReplicationHttpHandler,
  type ReplicationHttpAuthenticator,
  type ReplicationHttpFetch,
  type ReplicationHttpHandler,
} from "../src/index.js";

const project = "entity://project/atlas" as const;
const principal: AccessPrincipal = {
  subject: "user:alice",
  scopes: ["replication"],
};
const roots: string[] = [];
const servers: NodeReplicationHttpServer[] = [];

async function tempPath(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ssrl-replication-http-"));
  roots.push(root);
  return join(root, name);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class BearerAuthenticator implements ReplicationHttpAuthenticator {
  calls = 0;

  constructor(readonly token = "alice-token") {}

  authenticate(request: Request): AccessPrincipal | Response {
    this.calls += 1;
    if (request.headers.get("authorization") !== `Bearer ${this.token}`) {
      return new Response("unauthorized", {
        status: 401,
        headers: { "www-authenticate": "Bearer realm=ssrl-replication" },
      });
    }
    return {
      subject: principal.subject,
      scopes: principal.scopes,
      credentialMaterial: "must-not-cross-normalization",
    } as AccessPrincipal;
  }
}

class DynamicSemanticSource implements ReplicationRecordSource {
  calls = 0;

  constructor(readonly store: SQLiteSemanticStateStore) {}

  async records(): Promise<readonly ReplicationRecord[]> {
    this.calls += 1;
    return exportSemanticReplicationRecords(this.store);
  }
}

class CombinedSource implements ReplicationRecordSource {
  constructor(
    readonly semantic: SQLiteSemanticStateStore,
    readonly artifacts: ArtifactStore,
  ) {}

  async records(): Promise<readonly ReplicationRecord[]> {
    return [
      ...await exportSemanticReplicationRecords(this.semantic),
      ...await exportArtifactReplicationRecords(this.artifacts),
    ];
  }
}

function allowAlicePolicy(captured: string[] = []): ReplicationAccessPolicy {
  return {
    evaluate(request) {
      captured.push(JSON.stringify(request.principal));
      return request.principal.subject === principal.subject
        ? { effect: "allow" }
        : { effect: "deny", code: "not-owner" };
    },
  };
}

function gateway(source: ReplicationRecordSource, policy = allowAlicePolicy()): ReplicationAccessGateway {
  return new ReplicationAccessGateway({
    source,
    policy,
    policyVersion: () => "policy-v1",
    projectionIds: ["personal"],
    now: () => "2026-09-25T00:00:00Z",
  });
}

async function seedSemantic(
  store: SQLiteSemanticStateStore,
  observationId: string,
  value: string,
): Promise<void> {
  await store.append({
    entities: [{ entityId: project, entityType: "Project" }],
    aliases: [{
      id: "alias-atlas",
      entityId: project,
      value: "Project Atlas",
      recordedAt: "2026-01-01T00:00:00Z",
    }],
    observations: [{
      id: observationId,
      entityId: project,
      property: `Project.${observationId}`,
      value,
      source: { provider: "test", externalId: observationId },
      validFrom: "2026-01-01T00:00:00Z",
      recordedAt: "2026-01-02T00:00:00Z",
    }],
  });
}

async function semanticRuntime(observationId = "local", value = "A") {
  const semantic = new SQLiteSemanticStateStore({ path: await tempPath("state.sqlite") });
  await seedSemantic(semantic, observationId, value);
  const artifacts = new LocalArtifactStore({ root: await tempPath("artifacts") });
  const source = new DynamicSemanticSource(semantic);
  const access = gateway(source);
  return { semantic, artifacts, source, access };
}

function handlerFetch(handler: ReplicationHttpHandler, token = "alice-token"): ReplicationHttpFetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${token}`);
    return handler.fetch(new Request(request, { headers }));
  };
}

function clientFor(handler: ReplicationHttpHandler, token = "alice-token"): ReplicationHttpClient {
  return new ReplicationHttpClient({
    baseUrl: new URL("http://localhost"),
    fetch: handlerFetch(handler, token),
  });
}

function localViewReader(
  endpoint: ReconciliationEndpoint,
  info: ReconciliationViewInfo,
): ReconciliationViewReader {
  return {
    info: () => info,
    nodeHashes(refs, options): MerkleNodeHashResponse {
      const result = endpoint.nodeHashes(info.viewId, refs, options);
      if (result instanceof Promise) throw new Error("expected synchronous local endpoint");
      return result;
    },
    leafPage(options) {
      return endpoint.leafPage(info.viewId, options);
    },
  };
}



function handler(options: {
  readonly access: ReplicationAccessGateway;
  readonly semantic: SQLiteSemanticStateStore;
  readonly artifacts: ArtifactStore;
  readonly authenticator?: BearerAuthenticator;
}) {
  return createReplicationHttpHandler({
    gateway: options.access,
    semanticStore: options.semantic,
    artifactStore: options.artifacts,
    authenticator: options.authenticator ?? new BearerAuthenticator(),
    allowedHostnames: ["localhost", "127.0.0.1"],
    allowedOriginHostnames: ["localhost", "127.0.0.1"],
  });
}

describe("replication HTTP transport", () => {
  it("authenticates before parsing malformed JSON or scanning replication source", async () => {
    const runtime = await semanticRuntime();
    const authenticator = new BearerAuthenticator();
    const http = handler({ ...runtime, authenticator });
    const response = await http.fetch(new Request(
      `http://localhost${REPLICATION_HTTP_ROUTES.openProjection}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer wrong-token",
        },
        body: "{ definitely not json",
      },
    ));

    expect(response.status).toBe(401);
    expect(authenticator.calls).toBe(1);
    expect(runtime.source.calls).toBe(0);
    runtime.semantic.close();
  });

  it("derives principal only from authenticator and rejects client-supplied identity fields", async () => {
    const runtime = await semanticRuntime();
    const captured: string[] = [];
    const access = gateway(runtime.source, allowAlicePolicy(captured));
    const http = handler({ ...runtime, access });
    const fetch = handlerFetch(http);
    const response = await fetch(
      `http://localhost${REPLICATION_HTTP_ROUTES.openProjection}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectionId: "personal" }),
      },
    );

    expect(response.status).toBe(200);
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.every((value) => value.includes("user:alice"))).toBe(true);
    expect(captured.join("\n")).not.toContain("credentialMaterial");

    const sourceCallsBeforeInjection = runtime.source.calls;
    const injected = await fetch(
      `http://localhost${REPLICATION_HTTP_ROUTES.openProjection}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectionId: "personal",
          principal: { subject: "user:mallory", scopes: ["admin"] },
        }),
      },
    );
    expect(injected.status).toBe(400);
    expect(runtime.source.calls).toBe(sourceCallsBeforeInjection);
    expect(captured.join("\n")).not.toContain("mallory");
    runtime.semantic.close();
  });

  it("runs the existing bounded reconciliation session against an HTTP remote endpoint", async () => {
    const left = await semanticRuntime("left", "L");
    const right = await semanticRuntime("right", "R");
    const remote = clientFor(handler(right));
    const leftOpen = await left.access.openProjection({ principal, projectionId: "personal" });
    const rightOpen = await remote.openProjection({ projectionId: "personal" });
    const localEndpoint = left.access.endpoint(principal, "personal");
    const session = await BoundedReconciliationSession.start(
      localViewReader(localEndpoint, leftOpen.view),
      remote.endpoint("personal"),
      rightOpen.view.viewId,
      { maxNodeRefsPerStep: 8, maxLeafDescriptors: 16, maxLeafBytes: 32 * 1024 },
    );
    const result = await session.runToCompletion(
      localViewReader(localEndpoint, leftOpen.view),
      remote.endpoint("personal"),
    );

    expect(result.collisions).toEqual([]);
    expect(result.localOnly).toHaveLength(1);
    expect(result.remoteOnly).toHaveLength(1);
    expect(result.counters.remoteNodeQueries).toBeGreaterThan(0);
    left.semantic.close();
    right.semantic.close();
  });

  it("converges two independent SQLite semantic stores bidirectionally over real loopback HTTP", async () => {
    const left = await semanticRuntime("left", "L");
    const right = await semanticRuntime("right", "R");
    const rightServer = await startNodeReplicationHttpServer({ handler: handler(right) });
    servers.push(rightServer);
    const remote = new ReplicationHttpClient({
      baseUrl: rightServer.baseUrl,
      headers: () => ({ authorization: "Bearer alice-token" }),
    });

    const leftOpen = await left.access.openProjection({ principal, projectionId: "personal" });
    const rightOpen = await remote.openProjection({ projectionId: "personal" });
    const leftEndpoint = left.access.endpoint(principal, "personal");
    const leftReader = localViewReader(leftEndpoint, leftOpen.view);
    const session = await BoundedReconciliationSession.start(
      leftReader,
      remote.endpoint("personal"),
      rightOpen.view.viewId,
    );
    const delta = await session.runToCompletion(leftReader, remote.endpoint("personal"));
    expect(delta.collisions).toEqual([]);

    const fromRight = await remote.readRecords({
      projectionId: "personal",
      viewId: rightOpen.view.viewId,
      keys: delta.remoteOnly,
    });
    await left.access.applySemantic(left.semantic, {
      principal,
      projectionId: "personal",
      records: fromRight,
    });

    const fromLeft = await left.access.readRecords({
      principal,
      projectionId: "personal",
      viewId: leftOpen.view.viewId,
      keys: delta.localOnly,
    });
    await remote.applySemantic({ projectionId: "personal", records: fromLeft });

    const [leftFinal, rightFinal] = await Promise.all([
      left.access.openProjection({ principal, projectionId: "personal" }),
      remote.openProjection({ projectionId: "personal" }),
    ]);
    expect(leftFinal.view.rootDigest).toBe(rightFinal.view.rootDigest);
    expect(leftFinal.view.recordCount).toBe(rightFinal.view.recordCount);

    const rerun = await BoundedReconciliationSession.start(
      localViewReader(left.access.endpoint(principal, "personal"), leftFinal.view),
      remote.endpoint("personal"),
      rightFinal.view.viewId,
    );
    const rerunResult = await rerun.runToCompletion(
      localViewReader(left.access.endpoint(principal, "personal"), leftFinal.view),
      remote.endpoint("personal"),
    );
    expect(rerunResult).toMatchObject({ localOnly: [], remoteOnly: [], collisions: [] });
    left.semantic.close();
    right.semantic.close();
  });

  it("builds different authorized HTTP projection roots for different authenticated principals", async () => {
    const semantic = new SQLiteSemanticStateStore({ path: await tempPath("projection-state.sqlite") });
    await seedSemantic(semantic, "private-alice", "alice-only");
    await semantic.append({
      observations: [{
        id: "shared-observation",
        entityId: project,
        property: "Project.shared",
        value: "shared",
        source: { provider: "test", externalId: "shared-observation" },
        validFrom: "2026-01-01T00:00:00Z",
        recordedAt: "2026-01-02T00:00:00Z",
      }],
    });
    const artifacts = new LocalArtifactStore({ root: await tempPath("projection-artifacts") });
    const source = new DynamicSemanticSource(semantic);
    const access = gateway(source, {
      evaluate(request) {
        if (request.operation !== "projection:read") return { effect: "allow" };
        if (
          request.principal.subject === "user:bob"
          && request.record.kind === "semantic-observation"
          && request.record.recordId === "private-alice"
        ) {
          return { effect: "deny", code: "alice-private" };
        }
        return { effect: "allow" };
      },
    });
    const authenticator: ReplicationHttpAuthenticator = {
      authenticate(request) {
        const token = request.headers.get("authorization");
        if (token === "Bearer alice-token") return principal;
        if (token === "Bearer bob-token") return { subject: "user:bob", scopes: ["replication"] };
        return new Response("unauthorized", { status: 401 });
      },
    };
    const http = createReplicationHttpHandler({
      gateway: access,
      semanticStore: semantic,
      artifactStore: artifacts,
      authenticator,
      allowedHostnames: ["localhost"],
    });
    const alice = clientFor(http, "alice-token");
    const bob = clientFor(http, "bob-token");
    const [aliceView, bobView] = await Promise.all([
      alice.openProjection({ projectionId: "personal" }),
      bob.openProjection({ projectionId: "personal" }),
    ]);

    expect(aliceView.view.recordCount).toBe(bobView.view.recordCount + 1);
    expect(aliceView.view.rootDigest).not.toBe(bobView.view.rootDigest);
    semantic.close();
  });

  it("preserves view revocation and expiry semantics over HTTP", async () => {
    const semantic = new SQLiteSemanticStateStore({ path: await tempPath("view-state.sqlite") });
    await seedSemantic(semantic, "view", "V");
    const artifacts = new LocalArtifactStore({ root: await tempPath("view-artifacts") });
    const source = new DynamicSemanticSource(semantic);
    let version = "policy-v1";
    let now = "2026-09-25T00:00:00Z";
    const access = new ReplicationAccessGateway({
      source,
      policy: allowAlicePolicy(),
      policyVersion: () => version,
      projectionIds: ["personal"],
      now: () => now,
      maxLeaseMs: 60_000,
    });
    const remote = clientFor(handler({ access, semantic, artifacts }));
    const revoked = await remote.openProjection({ projectionId: "personal", leaseMs: 30_000 });
    version = "policy-v2";
    await expect(remote.viewInfo({ projectionId: "personal", viewId: revoked.view.viewId }))
      .rejects.toMatchObject({ status: 409, code: "view-revoked" });

    version = "policy-v2";
    const expiring = await remote.openProjection({ projectionId: "personal", leaseMs: 1_000 });
    now = "2026-09-25T00:00:02Z";
    await expect(remote.viewInfo({ projectionId: "personal", viewId: expiring.view.viewId }))
      .rejects.toMatchObject({ status: 409, code: "view-expired" });
    semantic.close();
  });

  it("reports immutable record collisions over HTTP reconciliation instead of applying LWW", async () => {
    const left = await semanticRuntime("same-id", "LEFT");
    const right = await semanticRuntime("same-id", "RIGHT");
    const remote = clientFor(handler(right));
    const leftOpen = await left.access.openProjection({ principal, projectionId: "personal" });
    const rightOpen = await remote.openProjection({ projectionId: "personal" });
    const leftReader = localViewReader(
      left.access.endpoint(principal, "personal"),
      leftOpen.view,
    );
    const session = await BoundedReconciliationSession.start(
      leftReader,
      remote.endpoint("personal"),
      rightOpen.view.viewId,
    );
    const result = await session.runToCompletion(leftReader, remote.endpoint("personal"));

    expect(result.localOnly).toEqual([]);
    expect(result.remoteOnly).toEqual([]);
    expect(result.collisions).toHaveLength(1);
    expect((await left.semantic.observationsForEntity(project))[0]?.value).toBe("LEFT");
    expect((await right.semantic.observationsForEntity(project))[0]?.value).toBe("RIGHT");
    left.semantic.close();
    right.semantic.close();
  });

  it("preserves non-enumerating record-unavailable shape over HTTP", async () => {
    const runtime = await semanticRuntime();
    const records = await exportSemanticReplicationRecords(runtime.semantic);
    const hiddenRecord = records.find((record) => record.kind === "semantic-observation")!;
    const policy: ReplicationAccessPolicy = {
      evaluate(request: ReplicationAccessRequest) {
        if (request.operation === "projection:read" && request.record.key === hiddenRecord.key) {
          return { effect: "deny", code: "hidden" };
        }
        return { effect: "allow" };
      },
    };
    const access = gateway(runtime.source, policy);
    const remote = clientFor(handler({ ...runtime, access }));
    const opened = await remote.openProjection({ projectionId: "personal" });
    const missingKey = "semantic-observation:missing" as ReplicationRecordKey;

    for (const key of [hiddenRecord.key, missingKey]) {
      await expect(remote.readRecords({
        projectionId: "personal",
        viewId: opened.view.viewId,
        keys: [key],
      })).rejects.toMatchObject({ status: 404, code: "record-unavailable" });
    }
    runtime.semantic.close();
  });

  it("returns verified artifact blob bytes as a raw binary response and detects client-side tampering", async () => {
    const semantic = new SQLiteSemanticStateStore({ path: await tempPath("blob-state.sqlite") });
    await seedSemantic(semantic, "semantic", "S");
    const artifacts = new LocalArtifactStore({ root: await tempPath("blob-artifacts") });
    const bytes = new TextEncoder().encode("artifact blob payload");
    const blob = await artifacts.putBlob(bytes, "text/plain");
    await artifacts.append([{
      id: "artifact-v1",
      resource: { sourceKey: "markdown/personal", externalType: "markdown-note", externalId: "Atlas.md" },
      kind: "upsert",
      effectiveAt: "2026-09-01T00:00:00Z",
      recordedAt: "2026-09-01T00:01:00Z",
      blob,
    }]);
    const source = new CombinedSource(semantic, artifacts);
    const access = gateway(source);
    const http = handler({ access, semantic, artifacts });
    const remote = clientFor(http);
    const opened = await remote.openProjection({ projectionId: "personal" });
    const read = await remote.readArtifactBlob({
      projectionId: "personal",
      viewId: opened.view.viewId,
      digest: blob.digest,
    });

    expect(read.digest).toBe(blob.digest);
    expect(read.size).toBe(bytes.byteLength);
    expect(read.mediaType).toBe("text/plain");
    expect([...read.bytes]).toEqual([...bytes]);

    const tamperingFetch: ReplicationHttpFetch = async (input, init) => {
      const response = await handlerFetch(http)(input, init);
      if (new URL(input instanceof Request ? input.url : input.toString()).pathname !== REPLICATION_HTTP_ROUTES.readBlob) {
        return response;
      }
      const altered = new Uint8Array(await response.arrayBuffer());
      altered[0] = altered[0]! ^ 0xff;
      return new Response(altered, { status: response.status, headers: response.headers });
    };
    const tampered = new ReplicationHttpClient({
      baseUrl: new URL("http://localhost"),
      fetch: tamperingFetch,
    });
    await expect(tampered.readArtifactBlob({
      projectionId: "personal",
      viewId: opened.view.viewId,
      digest: blob.digest,
    })).rejects.toBeInstanceOf(InvalidReplicationHttpResponseError);
    semantic.close();
  });

  it("transfers an artifact over HTTP as record metadata + raw blob, with install separate from mutation apply", async () => {
    const sourceSemantic = new SQLiteSemanticStateStore({ path: await tempPath("artifact-source-state.sqlite") });
    await seedSemantic(sourceSemantic, "source-semantic", "source");
    const sourceArtifacts = new LocalArtifactStore({ root: await tempPath("artifact-source-cas") });
    const sourceBytes = new TextEncoder().encode("# Atlas\nartifact over replication HTTP\n");
    const sourceBlob = await sourceArtifacts.putBlob(sourceBytes, "text/markdown");
    await sourceArtifacts.append([{
      id: "atlas-artifact-v1",
      resource: {
        sourceKey: "markdown/personal",
        externalType: "markdown-note",
        externalId: "Projects/Atlas.md",
      },
      kind: "upsert",
      effectiveAt: "2026-09-20T00:00:00Z",
      recordedAt: "2026-09-20T00:01:00Z",
      title: "Atlas",
      blob: sourceBlob,
    }]);
    const sourceAccess = gateway(new CombinedSource(sourceSemantic, sourceArtifacts));
    const sourceClient = clientFor(handler({
      access: sourceAccess,
      semantic: sourceSemantic,
      artifacts: sourceArtifacts,
    }));
    const sourceView = await sourceClient.openProjection({ projectionId: "personal" });
    const artifactRecord = (await exportArtifactReplicationRecords(sourceArtifacts))[0]!;
    const transferredRecord = (await sourceClient.readRecords({
      projectionId: "personal",
      viewId: sourceView.view.viewId,
      keys: [artifactRecord.key],
    }))[0]!;
    const transferredBlob = await sourceClient.readArtifactBlob({
      projectionId: "personal",
      viewId: sourceView.view.viewId,
      digest: sourceBlob.digest,
    });

    const targetSemantic = new SQLiteSemanticStateStore({ path: await tempPath("artifact-target-state.sqlite") });
    await seedSemantic(targetSemantic, "target-semantic", "target");
    const targetArtifacts = new LocalArtifactStore({ root: await tempPath("artifact-target-cas") });
    const targetAccess = gateway(new CombinedSource(targetSemantic, targetArtifacts));
    const targetClient = clientFor(handler({
      access: targetAccess,
      semantic: targetSemantic,
      artifacts: targetArtifacts,
    }));

    const installed = await targetClient.installArtifactBlob({
      projectionId: "personal",
      record: transferredRecord,
      bytes: transferredBlob.bytes,
    });
    expect(installed.descriptor).toEqual(sourceBlob);
    expect(installed.accounting.transferredBytes).toBe(sourceBytes.byteLength);
    const afterBlobOnly = await targetArtifacts.snapshot();
    expect(afterBlobOnly.blobs).toEqual([{ digest: sourceBlob.digest, size: sourceBlob.size }]);
    expect(afterBlobOnly.mutations).toEqual([]);

    expect(await targetClient.applyArtifacts({
      projectionId: "personal",
      records: [transferredRecord],
    })).toBe(1);
    expect((await targetArtifacts.snapshot()).mutations.map((mutation) => mutation.id))
      .toEqual(["atlas-artifact-v1"]);

    const installedAgain = await targetClient.installArtifactBlob({
      projectionId: "personal",
      record: transferredRecord,
      bytes: transferredBlob.bytes,
    });
    expect(installedAgain.descriptor).toEqual(sourceBlob);
    expect(await targetClient.applyArtifacts({
      projectionId: "personal",
      records: [transferredRecord],
    })).toBe(0);

    sourceSemantic.close();
    targetSemantic.close();
  });

  it("rejects unauthenticated, truncated and oversized blob-install frames before CAS mutation", async () => {
    const runtime = await semanticRuntime();
    const http = createReplicationHttpHandler({
      gateway: runtime.access,
      semanticStore: runtime.semantic,
      artifactStore: runtime.artifacts,
      authenticator: new BearerAuthenticator(),
      allowedHostnames: ["localhost"],
      maxBlobInstallRequestBytes: 64,
    });
    const url = `http://localhost${REPLICATION_HTTP_ROUTES.installBlob}`;
    const binaryHeaders = {
      "content-type": REPLICATION_BLOB_INSTALL_MEDIA_TYPE,
    };

    const unauthenticated = await http.fetch(new Request(url, {
      method: "POST",
      headers: binaryHeaders,
      body: new Uint8Array([0, 0, 0, 100, 1]),
    }));
    expect(unauthenticated.status).toBe(401);

    const truncated = await http.fetch(new Request(url, {
      method: "POST",
      headers: { ...binaryHeaders, authorization: "Bearer alice-token" },
      body: new Uint8Array([0, 0, 0, 100, 1]),
    }));
    expect(truncated.status).toBe(400);

    const oversized = await http.fetch(new Request(url, {
      method: "POST",
      headers: { ...binaryHeaders, authorization: "Bearer alice-token" },
      body: new Uint8Array(100),
    }));
    expect(oversized.status).toBe(413);

    const snapshot = await runtime.artifacts.snapshot();
    expect(snapshot.blobs).toEqual([]);
    expect(snapshot.mutations).toEqual([]);
    runtime.semantic.close();
  });

  it("rejects wrong host/origin, wrong media type and oversized JSON before domain mutation", async () => {
    const runtime = await semanticRuntime();
    const http = createReplicationHttpHandler({
      gateway: runtime.access,
      semanticStore: runtime.semantic,
      artifactStore: runtime.artifacts,
      authenticator: new BearerAuthenticator(),
      allowedHostnames: ["localhost"],
      allowedOriginHostnames: ["localhost"],
      maxJsonRequestBytes: 64,
    });

    const cases = [
      new Request(`http://evil.test${REPLICATION_HTTP_ROUTES.openProjection}`, {
        method: "POST",
        headers: { authorization: "Bearer alice-token", "content-type": "application/json" },
        body: JSON.stringify({ projectionId: "personal" }),
      }),
      new Request(`http://localhost${REPLICATION_HTTP_ROUTES.openProjection}`, {
        method: "POST",
        headers: {
          authorization: "Bearer alice-token",
          "content-type": "application/json",
          origin: "https://evil.test",
        },
        body: JSON.stringify({ projectionId: "personal" }),
      }),
      new Request(`http://localhost${REPLICATION_HTTP_ROUTES.openProjection}`, {
        method: "POST",
        headers: { authorization: "Bearer alice-token", "content-type": "text/plain" },
        body: "{}",
      }),
      new Request(`http://localhost${REPLICATION_HTTP_ROUTES.openProjection}`, {
        method: "POST",
        headers: { authorization: "Bearer alice-token", "content-type": "application/json" },
        body: JSON.stringify({ projectionId: "personal", padding: "x".repeat(100) }),
      }),
    ];
    const statuses: number[] = [];
    for (const request of cases) statuses.push((await http.fetch(request)).status);
    expect(statuses).toEqual([421, 403, 415, 413]);
    runtime.semantic.close();
  });

  it("rejects malformed host/origin authorities, non-POST methods and unknown versions", async () => {
    const runtime = await semanticRuntime();
    const http = handler({ ...runtime });
    const headers = {
      authorization: "Bearer alice-token",
      "content-type": "application/json",
    };
    const cases = [
      new Request(`http://localhost${REPLICATION_HTTP_ROUTES.openProjection}`, {
        method: "POST",
        headers: { ...headers, host: "evil.test@localhost" },
        body: JSON.stringify({ projectionId: "personal" }),
      }),
      new Request(`http://localhost${REPLICATION_HTTP_ROUTES.openProjection}`, {
        method: "POST",
        headers: { ...headers, origin: "https://evil.test@localhost" },
        body: JSON.stringify({ projectionId: "personal" }),
      }),
      new Request(`http://localhost${REPLICATION_HTTP_ROUTES.openProjection}`, {
        method: "GET",
        headers,
      }),
      new Request("http://localhost/v2/replication/projection/open", {
        method: "POST",
        headers,
        body: JSON.stringify({ projectionId: "personal" }),
      }),
    ];
    const statuses: number[] = [];
    for (const request of cases) statuses.push((await http.fetch(request)).status);
    expect(statuses).toEqual([400, 403, 405, 404]);
    runtime.semantic.close();
  });

  it("rejects unknown fields on every JSON route before domain work", async () => {
    const runtime = await semanticRuntime();
    const http = handler({ ...runtime });
    const fetch = handlerFetch(http);
    const digest = `sha256:${"0".repeat(64)}`;
    const cases: readonly [string, Readonly<Record<string, unknown>>][] = [
      [REPLICATION_HTTP_ROUTES.openProjection, { projectionId: "personal" }],
      [REPLICATION_HTTP_ROUTES.viewInfo, { projectionId: "personal", viewId: "view" }],
      [REPLICATION_HTTP_ROUTES.nodeHashes, {
        projectionId: "personal",
        viewId: "view",
        refs: [],
      }],
      [REPLICATION_HTTP_ROUTES.leafPage, {
        projectionId: "personal",
        viewId: "view",
        leafId: 0,
      }],
      [REPLICATION_HTTP_ROUTES.readRecords, {
        projectionId: "personal",
        viewId: "view",
        keys: [],
      }],
      [REPLICATION_HTTP_ROUTES.applySemantic, { projectionId: "personal", records: [] }],
      [REPLICATION_HTTP_ROUTES.applyArtifacts, { projectionId: "personal", records: [] }],
      [REPLICATION_HTTP_ROUTES.readBlob, {
        projectionId: "personal",
        viewId: "view",
        digest,
      }],
    ];
    const sourceCallsBefore = runtime.source.calls;
    for (const [route, body] of cases) {
      const response = await fetch(`http://localhost${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, unexpected: true }),
      });
      expect(response.status, route).toBe(400);
    }
    expect(runtime.source.calls).toBe(sourceCallsBefore);
    runtime.semantic.close();
  });

  it("refuses cleartext HTTP for non-loopback remotes", () => {
    expect(() => new ReplicationHttpClient({
      baseUrl: new URL("http://sync.example.test"),
      headers: () => ({ authorization: "Bearer secret" }),
    })).toThrow(/requires HTTPS outside loopback/);

    expect(() => new ReplicationHttpClient({
      baseUrl: new URL("https://sync.example.test"),
    })).not.toThrow();
  });

  it("rejects malformed, invalid-envelope and oversized remote responses before consumers use them", async () => {
    const badType = new ReplicationHttpClient({
      baseUrl: new URL("https://remote.test"),
      fetch: async () => new Response("not-json", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    });
    await expect(badType.openProjection({ projectionId: "personal" }))
      .rejects.toBeInstanceOf(InvalidReplicationHttpResponseError);

    const extraField = new ReplicationHttpClient({
      baseUrl: new URL("https://remote.test"),
      fetch: async () => new Response(JSON.stringify({
        view: {
          schema: RECONCILIATION_PROTOCOL_SCHEMA,
          viewId: "view-1",
          prefixBits: 8,
          rootDigest: `sha256:${"0".repeat(64)}`,
          recordCount: 0,
        },
        projectionId: "personal",
        policyVersion: "v1",
        expiresAt: "2026-09-25T01:00:00Z",
        accounting: { sourceRecordsScanned: 0, policyEvaluations: 0, allowedDescriptors: 0 },
        unexpected: true,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    await expect(extraField.openProjection({ projectionId: "personal" }))
      .rejects.toBeInstanceOf(InvalidReplicationHttpResponseError);

    const badView = new ReplicationHttpClient({
      baseUrl: new URL("https://remote.test"),
      fetch: async () => new Response(JSON.stringify({
        view: {
          schema: "wrong-schema",
          viewId: "view-1",
          prefixBits: 8,
          rootDigest: "sha256:not-a-real-digest",
          recordCount: 1,
        },
        projectionId: "personal",
        policyVersion: "v1",
        expiresAt: "2026-09-25T01:00:00Z",
        accounting: { sourceRecordsScanned: 1, policyEvaluations: 1, allowedDescriptors: 1 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    await expect(badView.openProjection({ projectionId: "personal" }))
      .rejects.toBeInstanceOf(InvalidReplicationHttpResponseError);

    const invalidRecord = new ReplicationHttpClient({
      baseUrl: new URL("https://remote.test"),
      fetch: async () => new Response(JSON.stringify([{
        key: "semantic-observation:bad",
        kind: "semantic-observation",
        recordId: "bad",
        payloadDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        payloadBytes: 2,
        payload: "{}",
      }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    await expect(invalidRecord.readRecords({
      projectionId: "personal",
      viewId: "view-1",
      keys: ["semantic-observation:bad" as ReplicationRecordKey],
    })).rejects.toBeInstanceOf(InvalidReplicationHttpResponseError);

    const oversized = new ReplicationHttpClient({
      baseUrl: new URL("https://remote.test"),
      maxJsonResponseBytes: 16,
      fetch: async () => new Response(JSON.stringify({ padding: "x".repeat(100) }), {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "120" },
      }),
    });
    await expect(oversized.openProjection({ projectionId: "personal" }))
      .rejects.toBeInstanceOf(InvalidReplicationHttpResponseError);
  });
});
