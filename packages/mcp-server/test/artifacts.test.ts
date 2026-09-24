import { afterEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArtifactAccessGateway,
  type ArtifactAccessPolicy,
} from "@ssrl/artifact-access";
import {
  artifactBlobUri,
  artifactResourceUri,
  artifactVersionUri,
  type ArtifactBlobDescriptor,
  type ArtifactMutation,
  type ArtifactResourceIdentity,
} from "@ssrl/artifact-store";
import { LocalArtifactStore } from "@ssrl/storage-local-artifacts";
import {
  InMemoryEntityRuntimeCatalog,
  RuntimeHost,
  type RuntimePrincipal,
} from "@ssrl/runtime-host";
import {
  MCP_ARTIFACT_CACHE_HINT,
  createRuntimeMcpServer,
} from "../src/index.js";

const roots: string[] = [];
const connections: Array<{
  readonly client: Client;
  readonly server: ReturnType<typeof createRuntimeMcpServer>;
}> = [];
const principal: RuntimePrincipal = {
  subject: "user:alice",
  scopes: ["artifact:read"],
};

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "ssrl-mcp-artifact-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(connections.splice(0).map(async ({ client, server }) => {
    await client.close();
    await server.close();
  }));
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

function resource(externalId: string): ArtifactResourceIdentity {
  return {
    sourceKey: "markdown/personal-vault",
    externalType: "markdown-note",
    externalId,
  };
}

function upsert(
  id: string,
  identity: ArtifactResourceIdentity,
  blob: ArtifactBlobDescriptor,
  title?: string,
): ArtifactMutation {
  return {
    id,
    resource: identity,
    kind: "upsert",
    effectiveAt: "2026-09-01T00:00:00Z",
    recordedAt: "2026-09-01T00:01:00Z",
    blob,
    ...(title === undefined ? {} : { title }),
  };
}

function emptyHost(): RuntimeHost {
  return new RuntimeHost({
    catalog: new InMemoryEntityRuntimeCatalog([]),
    registry: { providers: new Map() },
  });
}

function policy(allowedIds: ReadonlySet<string>, seenSubjects: string[] = []): ArtifactAccessPolicy {
  return {
    evaluate(request) {
      seenSubjects.push(request.principal.subject);
      return allowedIds.has(request.resource.externalId)
        ? { effect: "allow" }
        : { effect: "deny", code: "artifact-not-delegated" };
    },
  };
}

async function connect(options: {
  readonly gateway: ArtifactAccessGateway;
  readonly clientName?: string;
  readonly maxResourceBytes?: number;
  readonly maxListedResources?: number;
}) {
  const server = createRuntimeMcpServer({
    host: emptyHost(),
    principal,
    name: "ssrl-artifact-test",
    version: "1.0.0",
    artifacts: {
      gateway: options.gateway,
      maxListedResources: options.maxListedResources ?? 100,
      maxResourceBytes: options.maxResourceBytes ?? 1024,
    },
  });
  const client = new Client({
    name: options.clientName ?? "artifact-test-client",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push({ client, server });
  return client;
}

async function seeded() {
  const store = new LocalArtifactStore({ root: await root() });
  const allowed = resource("Projects/Allowed.md");
  const denied = resource("Private/Denied.md");
  const binary = resource("Data/Binary.md");
  const invalidText = resource("Data/Invalid.md");
  const shared = await store.putBlob(new TextEncoder().encode("allowed text"), "text/plain");
  const binaryBlob = await store.putBlob(Uint8Array.from([0, 255, 1, 2]), "application/octet-stream");
  const invalidBlob = await store.putBlob(Uint8Array.from([0xff, 0xfe, 0xfd]), "text/plain");
  const allowedMutation = upsert("allowed-v1", allowed, shared, "Allowed note");
  const deniedMutation = upsert("denied-v1", denied, shared, "Denied note");
  const binaryMutation = upsert("binary-v1", binary, binaryBlob, "Binary data");
  const invalidMutation = upsert("invalid-v1", invalidText, invalidBlob, "Invalid UTF-8 text");
  await store.append([allowedMutation, deniedMutation, binaryMutation, invalidMutation]);
  return {
    store,
    allowed,
    denied,
    binary,
    invalidText,
    shared,
    allowedMutation,
  };
}

describe("MCP artifact resources", () => {
  it("lists only policy-authorized current resources without source identity leakage", async () => {
    const fixture = await seeded();
    const gateway = new ArtifactAccessGateway({
      store: fixture.store,
      policy: policy(new Set([fixture.allowed.externalId])),
      now: () => "2026-09-24T00:00:00Z",
    });
    const client = await connect({ gateway });

    const listed = await client.listResources();
    expect(listed.resources).toHaveLength(1);
    expect(listed.resources[0]).toEqual(expect.objectContaining({
      uri: await artifactResourceUri(fixture.allowed),
      title: "Allowed note",
      mimeType: "text/plain",
      size: 12,
    }));
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain(fixture.allowed.sourceKey);
    expect(serialized).not.toContain(fixture.allowed.externalId);
    expect(serialized).not.toContain(fixture.denied.externalId);
    fixture.store.close();
  });

  it("fails closed instead of returning a partial MCP resource list", async () => {
    const fixture = await seeded();
    const gateway = new ArtifactAccessGateway({
      store: fixture.store,
      policy: policy(new Set([
        fixture.allowed.externalId,
        fixture.binary.externalId,
      ])),
      now: () => "2026-09-24T00:00:00Z",
    });
    const client = await connect({ gateway, maxListedResources: 1 });

    await expect(client.listResources()).rejects.toThrow(/exceeds the MCP server limit/i);
    fixture.store.close();
  });

  it("reads authorized current and immutable version resources as strict UTF-8 text", async () => {
    const fixture = await seeded();
    const gateway = new ArtifactAccessGateway({
      store: fixture.store,
      policy: policy(new Set([fixture.allowed.externalId])),
      now: () => "2026-09-24T00:00:00Z",
    });
    const client = await connect({ gateway });
    const currentUri = await artifactResourceUri(fixture.allowed);
    const versionUri = await artifactVersionUri(fixture.allowedMutation);

    for (const uri of [currentUri, versionUri]) {
      const result = await client.readResource({ uri });
      expect(result.contents).toEqual([{
        uri,
        mimeType: "text/plain",
        text: "allowed text",
      }]);
    }
    fixture.store.close();
  });

  it("returns binary content and invalid UTF-8 text as exact base64 blobs", async () => {
    const fixture = await seeded();
    const gateway = new ArtifactAccessGateway({
      store: fixture.store,
      policy: policy(new Set([
        fixture.binary.externalId,
        fixture.invalidText.externalId,
      ])),
      now: () => "2026-09-24T00:00:00Z",
    });
    const client = await connect({ gateway });

    const binary = await client.readResource({ uri: await artifactResourceUri(fixture.binary) });
    const invalid = await client.readResource({ uri: await artifactResourceUri(fixture.invalidText) });
    expect(binary.contents).toEqual([expect.objectContaining({
      mimeType: "application/octet-stream",
      blob: Buffer.from([0, 255, 1, 2]).toString("base64"),
    })]);
    expect(invalid.contents).toEqual([expect.objectContaining({
      mimeType: "text/plain",
      blob: Buffer.from([0xff, 0xfe, 0xfd]).toString("base64"),
    })]);
    fixture.store.close();
  });

  it("never exposes denied resources or direct blob URIs and sanitizes errors", async () => {
    const fixture = await seeded();
    const gateway = new ArtifactAccessGateway({
      store: fixture.store,
      policy: policy(new Set([fixture.allowed.externalId])),
      now: () => "2026-09-24T00:00:00Z",
    });
    const client = await connect({ gateway });

    await expect(client.readResource({ uri: await artifactResourceUri(fixture.denied) }))
      .rejects.toThrow(/Resource.*not found/i);
    await expect(client.readResource({ uri: artifactBlobUri(fixture.shared.digest) }))
      .rejects.toThrow(/not found/i);
    try {
      await client.readResource({ uri: await artifactResourceUri(fixture.denied) });
      throw new Error("expected denied resource read to fail");
    } catch (error) {
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain(fixture.denied.externalId);
      expect(serialized).not.toContain(fixture.denied.sourceKey);
      expect(serialized).not.toContain("artifact-not-delegated");
    }
    fixture.store.close();
  });

  it("fails closed on an MCP full read above its own byte budget", async () => {
    const fixture = await seeded();
    const gateway = new ArtifactAccessGateway({
      store: fixture.store,
      policy: policy(new Set([fixture.allowed.externalId])),
      maxReadBytes: 100,
      now: () => "2026-09-24T00:00:00Z",
    });
    const client = await connect({ gateway, maxResourceBytes: 4 });

    await expect(client.readResource({ uri: await artifactResourceUri(fixture.allowed) }))
      .rejects.toThrow(/exceeds the MCP read limit/i);
    fixture.store.close();
  });

  it("uses the composition principal rather than self-reported MCP client identity", async () => {
    const fixture = await seeded();
    const seenSubjects: string[] = [];
    const gateway = new ArtifactAccessGateway({
      store: fixture.store,
      policy: policy(new Set([fixture.allowed.externalId]), seenSubjects),
      now: () => "2026-09-24T00:00:00Z",
    });
    const client = await connect({ gateway, clientName: "admin-root-superuser" });

    await client.readResource({ uri: await artifactResourceUri(fixture.allowed) });
    expect(seenSubjects).toEqual(["user:alice"]);
    expect(seenSubjects).not.toContain("admin-root-superuser");
    fixture.store.close();
  });

  it("declares conservative private/no-cache hints for modern MCP resource reads", () => {
    expect(MCP_ARTIFACT_CACHE_HINT).toEqual({
      ttlMs: 0,
      cacheScope: "private",
    });
  });
});
