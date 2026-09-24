import { performance } from "node:perf_hooks";
import type { AccessPrincipal } from "../packages/access/dist/index.js";
import {
  artifactMutationJson,
  type ArtifactBlobDescriptor,
  type ArtifactDigest,
  type ArtifactStore,
} from "../packages/artifact-store/dist/index.js";
import {
  createReplicationRecord,
  type ReplicationRecord,
} from "../packages/replication/dist/index.js";
import {
  MutableReplicationRecordSource,
  ReplicationAccessGateway,
  type ReplicationAccessOperation,
  type ReplicationAccessPolicy,
} from "../packages/replication-access/dist/index.js";

const referenceCount = 64;
const payloadBytes = new TextEncoder().encode("replication-blob-access-benchmark-payload");
const principal: AccessPrincipal = {
  subject: "benchmark:blob-reader",
  scopes: ["replication:read", "replication:write"],
};

function round(value: number): number {
  return Number(value.toFixed(3));
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function digest(bytes: Uint8Array): Promise<ArtifactDigest> {
  const value = await crypto.subtle.digest("SHA-256", ownedArrayBuffer(bytes));
  const hex = [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}` as ArtifactDigest;
}

class MemoryArtifactStore implements ArtifactStore {
  readonly #blobs = new Map<ArtifactDigest, { bytes: Uint8Array; mediaType: string }>();

  async putBlob(bytes: Uint8Array, mediaType: string): Promise<ArtifactBlobDescriptor> {
    const value = await digest(bytes);
    this.#blobs.set(value, { bytes: new Uint8Array(bytes), mediaType });
    return { digest: value, size: bytes.byteLength, mediaType };
  }

  async headBlob(value: ArtifactDigest) {
    const blob = this.#blobs.get(value);
    return blob === undefined ? undefined : { digest: value, size: blob.bytes.byteLength };
  }

  async readBlobRange(value: ArtifactDigest, request: { offset?: number; length?: number; maxBytes: number }) {
    const blob = this.#blobs.get(value);
    if (blob === undefined) throw new Error("benchmark blob missing");
    const offset = request.offset ?? 0;
    const length = request.length ?? (blob.bytes.byteLength - offset);
    if (length > request.maxBytes) throw new Error("benchmark maxBytes exceeded");
    return {
      digest: value,
      size: blob.bytes.byteLength,
      offset,
      bytes: blob.bytes.slice(offset, offset + length),
      complete: offset + length === blob.bytes.byteLength,
    };
  }

  async append(): Promise<number> { throw new Error("not used by blob benchmark"); }
  async mutation() { return undefined; }
  async mutationsForResource() { return []; }
  async snapshot() { throw new Error("not used by blob benchmark"); }
}

async function artifactRecord(
  index: number,
  blob: ArtifactBlobDescriptor,
): Promise<ReplicationRecord> {
  const id = `blob-reference-${String(index).padStart(3, "0")}`;
  return createReplicationRecord({
    kind: "artifact-mutation",
    recordId: id,
    payload: artifactMutationJson({
      id,
      kind: "upsert",
      resource: {
        sourceKey: "benchmark",
        externalType: "note",
        externalId: id,
      },
      effectiveAt: "2026-09-25T00:00:00Z",
      recordedAt: "2026-09-25T00:00:00Z",
      blob,
    }),
  });
}

const sourceStore = new MemoryArtifactStore();
const targetStore = new MemoryArtifactStore();
const blob = await sourceStore.putBlob(payloadBytes, "text/plain");
const records = await Promise.all(
  Array.from({ length: referenceCount }, (_, index) => artifactRecord(index, blob)),
);
const ordered = records.toSorted((left, right) => left.key.localeCompare(right.key));
const recordReadable = new Set(
  ordered.filter((_, index) => index % 2 === 1).map((record) => record.recordId),
);
const finalRecord = ordered.at(-1);
if (finalRecord === undefined || !recordReadable.has(finalRecord.recordId)) {
  throw new Error("blob benchmark fixture must end on a record-readable reference");
}

const evaluationCounts = new Map<ReplicationAccessOperation, number>();
function countEvaluation(operation: ReplicationAccessOperation): void {
  evaluationCounts.set(operation, (evaluationCounts.get(operation) ?? 0) + 1);
}
function evaluationCount(operation: ReplicationAccessOperation): number {
  return evaluationCounts.get(operation) ?? 0;
}
const policy = {
  evaluate(request) {
    countEvaluation(request.operation);
    switch (request.operation) {
      case "projection:read": return { effect: "allow" };
      case "record:read":
        return recordReadable.has(request.record.recordId)
          ? { effect: "allow" }
          : { effect: "deny", code: "benchmark-record-deny" };
      case "artifact-blob:read":
        return request.record.recordId === finalRecord.recordId
          ? { effect: "allow" }
          : { effect: "deny", code: "benchmark-blob-deny" };
      case "record:apply":
      case "artifact-blob:apply":
        return request.record.recordId === finalRecord.recordId
          ? { effect: "allow" }
          : { effect: "deny", code: "benchmark-apply-deny" };
    }
  },
} satisfies ReplicationAccessPolicy;
const gateway = new ReplicationAccessGateway({
  source: new MutableReplicationRecordSource(records),
  policy,
  policyVersion: () => "benchmark-blob-v1",
  projectionIds: ["benchmark-blob"],
  maxSourceRecords: referenceCount,
  maxProjectionRecords: referenceCount,
  maxPolicyEvaluations: referenceCount,
  maxBlobReadBytes: payloadBytes.byteLength,
  maxBlobApplyBytes: payloadBytes.byteLength,
  now: () => "2026-09-25T00:00:00Z",
});
const opened = await gateway.openProjection({
  principal,
  projectionId: "benchmark-blob",
  prefixBits: 8,
  leaseMs: 60_000,
});

const readStart = performance.now();
const read = await gateway.readArtifactBlob(sourceStore, {
  principal,
  projectionId: "benchmark-blob",
  viewId: opened.view.viewId,
  digest: blob.digest,
});
const readMs = performance.now() - readStart;
const expectedBlobPolicyEvaluations = recordReadable.size;
if (
  read.accounting.referencingRecords !== referenceCount
  || read.accounting.recordPolicyEvaluations !== referenceCount
  || read.accounting.blobPolicyEvaluations !== expectedBlobPolicyEvaluations
  || read.accounting.transferredBytes !== payloadBytes.byteLength
) {
  throw new Error("blob-read deterministic accounting invariant failed");
}

const installStart = performance.now();
const installed = await gateway.installArtifactBlob(targetStore, {
  principal,
  projectionId: "benchmark-blob",
  record: finalRecord,
  bytes: read.bytes,
});
const installMs = performance.now() - installStart;
if (
  installed.accounting.referencingRecords !== 1
  || installed.accounting.recordPolicyEvaluations !== 1
  || installed.accounting.blobPolicyEvaluations !== 1
  || installed.accounting.transferredBytes !== payloadBytes.byteLength
) {
  throw new Error("blob-install deterministic accounting invariant failed");
}

console.log(JSON.stringify({
  benchmark: "principal-scoped-artifact-blob-replication-v1",
  note: "Deterministic local authorization/work accounting. Elapsed time is observational only; no network, TLS, credential verification, RTT, remote-store, or throughput claim.",
  fixture: {
    referencingArtifactRecords: referenceCount,
    recordReadableReferences: recordReadable.size,
    blobBytes: payloadBytes.byteLength,
    projectionRecords: opened.view.recordCount,
  },
  read: {
    elapsedMs: round(readMs),
    ...read.accounting,
  },
  install: {
    elapsedMs: round(installMs),
    ...installed.accounting,
  },
  policyEvaluations: {
    "projection:read": evaluationCount("projection:read"),
    "record:read": evaluationCount("record:read"),
    "record:apply": evaluationCount("record:apply"),
    "artifact-blob:read": evaluationCount("artifact-blob:read"),
    "artifact-blob:apply": evaluationCount("artifact-blob:apply"),
  },
}, null, 2));
