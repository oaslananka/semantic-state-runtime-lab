import { describe, expect, it } from "vitest";
import {
  artifactBlobUri,
  artifactDigest,
  artifactMutationJson,
  artifactResourceUri,
  artifactVersionUri,
  normalizeArtifactBlobDescriptor,
  resolveArtifact,
  type ArtifactMutation,
  type ArtifactResourceIdentity,
} from "../src/index.js";

const digest = artifactDigest(`sha256:${"a".repeat(64)}`);
const resource: ArtifactResourceIdentity = {
  sourceKey: "gmail/account-a/all-mail",
  externalType: "message",
  externalId: "msg-1",
};

function upsert(
  id: string,
  effectiveAt: string,
  recordedAt: string,
  revision = id,
): ArtifactMutation {
  return {
    id,
    resource,
    kind: "upsert",
    effectiveAt,
    recordedAt,
    revision,
    blob: { digest, size: 4, mediaType: "Text/Plain" },
  };
}

describe("artifact-store contract", () => {
  it("normalizes media type and timestamps for stable mutation identity", () => {
    const first = artifactMutationJson(upsert(
      "v1",
      "2026-09-24T03:00:00+03:00",
      "2026-09-24T04:00:00+03:00",
    ));
    const second = artifactMutationJson(upsert(
      "v1",
      "2026-09-24T00:00:00Z",
      "2026-09-24T01:00:00Z",
    ));
    expect(second).toBe(first);
    expect(normalizeArtifactBlobDescriptor({ digest, size: 4, mediaType: "Text/Plain" }).mediaType)
      .toBe("text/plain");
  });

  it("resolves update delete restore history bitemporally", () => {
    const history: ArtifactMutation[] = [
      upsert("v1", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"),
      upsert("v2", "2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z"),
      {
        id: "delete",
        resource,
        kind: "delete",
        effectiveAt: "2026-05-01T00:00:00Z",
        recordedAt: "2026-05-02T00:00:00Z",
      },
      upsert("restore", "2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z"),
    ];

    expect(resolveArtifact({
      resource,
      mutations: history,
      validAt: "2026-02-01T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
    })).toEqual(expect.objectContaining({ status: "present", mutation: expect.objectContaining({ id: "v1" }) }));
    expect(resolveArtifact({
      resource,
      mutations: history,
      validAt: "2026-05-15T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
    })).toEqual(expect.objectContaining({ status: "deleted", mutation: expect.objectContaining({ id: "delete" }) }));
    expect(resolveArtifact({
      resource,
      mutations: history,
      validAt: "2026-07-01T00:00:00Z",
      knownAt: "2026-09-24T00:00:00Z",
    })).toEqual(expect.objectContaining({ status: "present", mutation: expect.objectContaining({ id: "restore" }) }));
  });

  it("preserves what was known before a late historical deletion", () => {
    const history: ArtifactMutation[] = [
      upsert("v1", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"),
      {
        id: "late-delete",
        resource,
        kind: "delete",
        effectiveAt: "2026-04-01T00:00:00Z",
        recordedAt: "2026-05-10T00:00:00Z",
      },
    ];
    expect(resolveArtifact({
      resource,
      mutations: history,
      validAt: "2026-04-15T00:00:00Z",
      knownAt: "2026-05-01T00:00:00Z",
    }).status).toBe("present");
    expect(resolveArtifact({
      resource,
      mutations: history,
      validAt: "2026-04-15T00:00:00Z",
      knownAt: "2026-05-10T00:00:00Z",
    }).status).toBe("deleted");
  });

  it("uses deterministic tie-breaking for equal effective time", () => {
    const history: ArtifactMutation[] = [
      upsert("first", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"),
      upsert("later-knowledge", "2026-01-01T00:00:00Z", "2026-01-03T00:00:00Z"),
    ];
    const result = resolveArtifact({
      resource,
      mutations: history.reverse(),
      validAt: "2026-02-01T00:00:00Z",
      knownAt: "2026-02-01T00:00:00Z",
    });
    expect(result).toEqual(expect.objectContaining({
      status: "present",
      mutation: expect.objectContaining({ id: "later-knowledge" }),
    }));
  });

  it("uses stable mutation id as the final tie-break when both clocks match", () => {
    const history: ArtifactMutation[] = [
      upsert("a-version", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"),
      upsert("z-version", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"),
    ];
    const result = resolveArtifact({
      resource,
      mutations: history,
      validAt: "2026-02-01T00:00:00Z",
      knownAt: "2026-02-01T00:00:00Z",
    });
    expect(result).toEqual(expect.objectContaining({
      status: "present",
      mutation: expect.objectContaining({ id: "z-version" }),
    }));
  });

  it("builds a content URI that contains no source resource identity", () => {
    const uri = artifactBlobUri(digest);
    expect(uri).toBe(`ssrl://artifact/blob/sha256/${"a".repeat(64)}`);
    expect(uri).not.toContain("gmail");
    expect(uri).not.toContain("msg-1");
  });

  it("builds stable opaque resource/version URIs without embedding source identity", async () => {
    const sensitive: ArtifactResourceIdentity = {
      sourceKey: "gmail/account-a/token-DO-NOT-LEAK",
      externalType: "message/thread",
      externalId: "id with spaces/?#and-unicode-İ",
    };
    const mutation: ArtifactMutation = {
      ...upsert("secret-version-id", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"),
      resource: sensitive,
      sourceUri: "https://mail.example.invalid/private?id=credential-like-value",
    };
    const resourceUri = await artifactResourceUri(sensitive);
    const versionUri = await artifactVersionUri(mutation);

    expect(resourceUri).toMatch(/^ssrl:\/\/artifact\/resource\/sha256\/[a-f0-9]{64}$/);
    expect(versionUri).toMatch(/^ssrl:\/\/artifact\/version\/sha256\/[a-f0-9]{64}$/);
    expect(await artifactResourceUri({ ...sensitive })).toBe(resourceUri);
    expect(await artifactVersionUri({ ...mutation })).toBe(versionUri);
    for (const secret of [sensitive.sourceKey, sensitive.externalId, mutation.id, mutation.sourceUri!]) {
      expect(resourceUri).not.toContain(secret);
      expect(versionUri).not.toContain(secret);
    }
  });

  it("rejects malformed SHA-256 and media types", () => {
    expect(() => artifactDigest("sha256:ABC")).toThrow(/Invalid SHA-256/);
    expect(() => normalizeArtifactBlobDescriptor({
      digest,
      size: 1,
      mediaType: "text/plain; charset=utf-8",
    })).toThrow(/mediaType/);
    expect(() => normalizeArtifactBlobDescriptor({
      digest,
      size: 1,
      mediaType: "-invalid/plain",
    })).toThrow(/mediaType/);
    expect(() => normalizeArtifactBlobDescriptor({
      digest,
      size: 1,
      mediaType: `${"a".repeat(128)}/plain`,
    })).toThrow(/mediaType/);
  });
});
