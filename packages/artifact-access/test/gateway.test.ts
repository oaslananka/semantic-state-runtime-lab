import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccessPrincipal } from "@ssrl/access";
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
  ArtifactAccessDeniedError,
  ArtifactAccessGateway,
  ArtifactAccessNotFoundError,
  ArtifactReadTooLargeError,
  type ArtifactAccessEvent,
  type ArtifactAccessPolicy,
} from "../src/index.js";

const roots: string[] = [];
const principal: AccessPrincipal = {
  subject: "user:alice",
  scopes: ["artifact:read"],
};
const allowedResource: ArtifactResourceIdentity = {
  sourceKey: "markdown/personal-vault",
  externalType: "markdown-note",
  externalId: "Projects/Allowed.md",
};
const deniedResource: ArtifactResourceIdentity = {
  sourceKey: "markdown/personal-vault",
  externalType: "markdown-note",
  externalId: "Private/Denied.md",
};

async function storeRoot(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "ssrl-access-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function upsert(
  id: string,
  resource: ArtifactResourceIdentity,
  blob: ArtifactBlobDescriptor,
  options: {
    readonly effectiveAt?: string;
    readonly recordedAt?: string;
    readonly title?: string;
  } = {},
): ArtifactMutation {
  return {
    id,
    resource,
    kind: "upsert",
    effectiveAt: options.effectiveAt ?? "2026-09-01T00:00:00Z",
    recordedAt: options.recordedAt ?? "2026-09-01T00:01:00Z",
    blob,
    ...(options.title === undefined ? {} : { title: options.title }),
  };
}

function allowOnly(externalId: string): ArtifactAccessPolicy {
  return {
    evaluate(request) {
      return request.resource.externalId === externalId
        ? { effect: "allow" }
        : { effect: "deny", code: "resource-not-delegated" };
    },
  };
}

async function seededStore() {
  const store = new LocalArtifactStore({ root: await storeRoot() });
  const bytes = new TextEncoder().encode("shared raw bytes");
  const blob = await store.putBlob(bytes, "text/plain");
  const allowed = upsert("allowed-v1", allowedResource, blob, { title: "Allowed note" });
  const denied = upsert("denied-v1", deniedResource, blob, { title: "Denied note" });
  await store.append([allowed, denied]);
  return { store, bytes, blob, allowed, denied };
}

describe("ArtifactAccessGateway", () => {
  it("requires a principal and defaults missing policy decisions to deny", async () => {
    const { store } = await seededStore();
    const uri = await artifactResourceUri(allowedResource);
    const gateway = new ArtifactAccessGateway({
      store,
      policy: { evaluate() { return undefined; } },
      now: () => "2026-09-24T00:00:00Z",
    });

    await expect(gateway.list()).rejects.toMatchObject({
      name: "ArtifactAccessDeniedError",
      code: "principal-required",
    });
    await expect(gateway.read({ uri })).rejects.toBeInstanceOf(ArtifactAccessDeniedError);
    await expect(gateway.read({ uri, principal })).rejects.toBeInstanceOf(ArtifactAccessDeniedError);
    store.close();
  });

  it("filters denied resources from listing without returning internal source identity", async () => {
    const { store } = await seededStore();
    const gateway = new ArtifactAccessGateway({
      store,
      policy: allowOnly(allowedResource.externalId),
      now: () => "2026-09-24T00:00:00Z",
    });

    const page = await gateway.list({ principal, limit: 10 });
    expect(page.resources).toHaveLength(1);
    expect(page.resources[0]).toEqual(expect.objectContaining({
      uri: await artifactResourceUri(allowedResource),
      title: "Allowed note",
      mediaType: "text/plain",
      size: 16,
    }));
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain(allowedResource.sourceKey);
    expect(serialized).not.toContain(allowedResource.externalId);
    expect(serialized).not.toContain(deniedResource.externalId);
    expect(serialized).not.toContain("sourceUri");
    store.close();
  });

  it("does not inherit permission across resources that reference the same CAS digest", async () => {
    const { store, bytes, blob } = await seededStore();
    const gateway = new ArtifactAccessGateway({
      store,
      policy: allowOnly(allowedResource.externalId),
      now: () => "2026-09-24T00:00:00Z",
    });
    const allowedUri = await artifactResourceUri(allowedResource);
    const deniedUri = await artifactResourceUri(deniedResource);

    const allowed = await gateway.read({ uri: allowedUri, principal });
    expect([...allowed.bytes]).toEqual([...bytes]);
    await expect(gateway.read({ uri: deniedUri, principal }))
      .rejects.toBeInstanceOf(ArtifactAccessDeniedError);
    await expect(gateway.read({ uri: artifactBlobUri(blob.digest), principal }))
      .rejects.toBeInstanceOf(ArtifactAccessNotFoundError);
    store.close();
  });

  it("treats a deleted current resource and an immutable historical version as separate policy targets", async () => {
    const store = new LocalArtifactStore({ root: await storeRoot() });
    const bytes = new TextEncoder().encode("historical body");
    const blob = await store.putBlob(bytes, "text/plain");
    const version = upsert("history-v1", allowedResource, blob, {
      effectiveAt: "2026-01-01T00:00:00Z",
      recordedAt: "2026-01-02T00:00:00Z",
    });
    await store.append([
      version,
      {
        id: "history-delete",
        resource: allowedResource,
        kind: "delete",
        effectiveAt: "2026-06-01T00:00:00Z",
        recordedAt: "2026-06-02T00:00:00Z",
      },
    ]);
    const currentUri = await artifactResourceUri(allowedResource);
    const versionUri = await artifactVersionUri(version);
    const targetKinds: string[] = [];
    const gateway = new ArtifactAccessGateway({
      store,
      policy: {
        evaluate(request) {
          targetKinds.push(request.target);
          return request.target === "version"
            ? { effect: "allow" }
            : { effect: "deny", code: "current-denied" };
        },
      },
      now: () => "2026-09-24T00:00:00Z",
    });

    await expect(gateway.read({ uri: currentUri, principal }))
      .rejects.toBeInstanceOf(ArtifactAccessNotFoundError);
    const historical = await gateway.read({ uri: versionUri, principal });
    expect(new TextDecoder().decode(historical.bytes)).toBe("historical body");
    expect(historical.target).toBe("version");
    expect(targetKinds).toEqual(["version"]);
    store.close();
  });

  it("re-evaluates independent policy for historical versions", async () => {
    const { store, allowed } = await seededStore();
    const versionUri = await artifactVersionUri(allowed);
    const gateway = new ArtifactAccessGateway({
      store,
      policy: {
        evaluate(request) {
          return request.target === "version"
            ? { effect: "deny", code: "history-not-delegated" }
            : { effect: "allow" };
        },
      },
    });

    await expect(gateway.read({ uri: versionUri, principal })).rejects
      .toBeInstanceOf(ArtifactAccessDeniedError);
    store.close();
  });

  it("does not reveal size/range errors before a denied policy decision", async () => {
    const { store } = await seededStore();
    const gateway = new ArtifactAccessGateway({
      store,
      maxReadBytes: 1,
      policy: allowOnly(allowedResource.externalId),
      now: () => "2026-09-24T00:00:00Z",
    });
    const deniedUri = await artifactResourceUri(deniedResource);

    await expect(gateway.read({ uri: deniedUri, principal }))
      .rejects.toMatchObject({
        name: "ArtifactAccessDeniedError",
        code: "resource-not-delegated",
      });
    await expect(gateway.read({ uri: deniedUri, principal, offset: 999, length: 999 }))
      .rejects.toMatchObject({
        name: "ArtifactAccessDeniedError",
        code: "resource-not-delegated",
      });
    store.close();
  });

  it("enforces the server byte cap and lets caller limits only narrow it", async () => {
    const store = new LocalArtifactStore({ root: await storeRoot() });
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
    const blob = await store.putBlob(bytes, "application/octet-stream");
    await store.append([upsert("large-v1", allowedResource, blob)]);
    const uri = await artifactResourceUri(allowedResource);
    const gateway = new ArtifactAccessGateway({
      store,
      maxReadBytes: 8,
      policy: { evaluate() { return { effect: "allow" }; } },
      now: () => "2026-09-24T00:00:00Z",
    });

    await expect(gateway.read({ uri, principal }))
      .rejects.toMatchObject({ name: "ArtifactReadTooLargeError", maxBytes: 8 });
    await expect(gateway.read({ uri, principal, offset: 0, length: 8, maxBytes: 1000 }))
      .resolves.toMatchObject({ offset: 0, complete: false });
    await expect(gateway.read({ uri, principal, offset: 4, length: 5, maxBytes: 4 }))
      .rejects.toBeInstanceOf(ArtifactReadTooLargeError);
    const slice = await gateway.read({ uri, principal, offset: 7, length: 4 });
    expect([...slice.bytes]).toEqual([7, 8, 9, 10]);
    store.close();
  });

  it("emits audit events without bytes or internal source identifiers", async () => {
    const { store } = await seededStore();
    const events: ArtifactAccessEvent[] = [];
    const gateway = new ArtifactAccessGateway({
      store,
      policy: allowOnly(allowedResource.externalId),
      events: { emit(event) { events.push(event); } },
      now: () => "2026-09-24T12:00:00Z",
    });
    const allowedUri = await artifactResourceUri(allowedResource);
    const deniedUri = await artifactResourceUri(deniedResource);

    await gateway.read({ uri: allowedUri, principal, offset: 1, length: 3 });
    await expect(gateway.read({ uri: deniedUri, principal, offset: 0, length: 2 }))
      .rejects.toBeInstanceOf(ArtifactAccessDeniedError);

    expect(events).toEqual([
      expect.objectContaining({
        operation: "read",
        publicUri: allowedUri,
        target: "current",
        outcome: "allow",
        subject: "user:alice",
        offset: 1,
        byteCount: 3,
      }),
      expect.objectContaining({
        operation: "read",
        publicUri: deniedUri,
        target: "current",
        outcome: "deny",
        subject: "user:alice",
        code: "resource-not-delegated",
      }),
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(allowedResource.sourceKey);
    expect(serialized).not.toContain(allowedResource.externalId);
    expect(serialized).not.toContain(deniedResource.externalId);
    expect(serialized).not.toContain("shared raw bytes");
    store.close();
  });

  it("supports an explicitly trusted in-process gateway without policy", async () => {
    const { store, bytes } = await seededStore();
    const gateway = new ArtifactAccessGateway({
      store,
      now: () => "2026-09-24T00:00:00Z",
    });
    const result = await gateway.read({ uri: await artifactResourceUri(allowedResource) });
    expect([...result.bytes]).toEqual([...bytes]);
    store.close();
  });
});
