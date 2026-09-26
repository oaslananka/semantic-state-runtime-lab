import { createHash } from "node:crypto";
import { canonicalJson } from "../packages/core/dist/index.js";
import { generateVaultEpoch } from "../packages/e2e/dist/index.js";
import {
  replicationRecordFingerprint,
  replicationRecordKey,
  type ReplicationRecordDescriptor,
} from "../packages/replication/dist/index.js";
import {
  OPAQUE_REPLICATION_DESCRIPTOR_SCHEMA,
  type OpaqueReplicationDescriptor,
  type OpaqueReplicationTag,
} from "../packages/replication/dist/encrypted.js";
import { buildOpaquePrefixMerkleIndex } from "../packages/replication/dist/opaque-merkle.js";
import {
  FrozenOpaquePrefixMerkleView,
  InMemoryOpaqueReconciliationEndpoint,
  InMemoryOpaqueReconciliationViewRegistry,
  OpaqueBoundedReconciliationSession,
} from "../packages/replication/dist/opaque-sync.js";

const recordCount = 100_000;
const deltaSize = 10;
const prefixBits = 12 as const;
const descriptorSampleSize = 1_000;
const fixedPayloadDigest = `sha256:${"a".repeat(64)}`;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function opaqueTag(seed: string): OpaqueReplicationTag {
  return `hmac-sha256:${sha256(seed).toString("base64url")}` as OpaqueReplicationTag;
}

function opaqueDescriptor(
  epochId: ReturnType<typeof generateVaultEpoch>["epochId"],
  ordinal: number,
): OpaqueReplicationDescriptor {
  const material = {
    schema: OPAQUE_REPLICATION_DESCRIPTOR_SCHEMA,
    epochId,
    objectKind: "replication-record" as const,
    opaqueKey: opaqueTag(`opaque-key:${ordinal}`),
    opaqueContentTag: opaqueTag(`opaque-content:${ordinal}`),
    ciphertextBytes: 384 + (ordinal % 64),
  };
  return {
    ...material,
    fingerprint: `sha256:${sha256(canonicalJson(material)).toString("hex")}`,
  };
}

async function plaintextDescriptor(ordinal: number): Promise<ReplicationRecordDescriptor> {
  const recordId = `opaque-benchmark-${String(ordinal).padStart(9, "0")}`;
  const key = replicationRecordKey("semantic-observation", recordId);
  return {
    key,
    kind: "semantic-observation",
    recordId,
    payloadDigest: fixedPayloadDigest,
    fingerprint: await replicationRecordFingerprint(key, fixedPayloadDigest),
    payloadBytes: 384 + (ordinal % 64),
  };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

const epoch = generateVaultEpoch();
const base = Array.from({ length: recordCount }, (_, index) => opaqueDescriptor(epoch.epochId, index));
const extras = Array.from(
  { length: deltaSize },
  (_, index) => opaqueDescriptor(epoch.epochId, 1_000_000 + index),
);
const remoteDescriptors = [...base.slice(deltaSize), ...extras];

const localIndex = await buildOpaquePrefixMerkleIndex(base, { prefixBits });
const remoteIndex = await buildOpaquePrefixMerkleIndex(remoteDescriptors, { prefixBits });
const localView = await FrozenOpaquePrefixMerkleView.open(localIndex);
const registry = new InMemoryOpaqueReconciliationViewRegistry();
const remoteView = await registry.open(remoteIndex);
const endpoint = new InMemoryOpaqueReconciliationEndpoint(registry);
const session = await OpaqueBoundedReconciliationSession.start(
  localView,
  endpoint,
  remoteView.info().viewId,
  {
    maxNodeRefsPerStep: 64,
    maxLeafDescriptors: 64,
    maxLeafBytes: 64 * 1024,
  },
);
const result = await session.runToCompletion(localView, endpoint);

if (
  result.localOnly.length !== deltaSize
  || result.remoteOnly.length !== deltaSize
  || result.collisions.length !== 0
) {
  throw new Error("opaque 100k reconciliation delta invariant failed");
}
if (result.counters.remoteLeafDescriptors >= 2_000) {
  throw new Error("opaque reconciliation examined unexpectedly broad leaf descriptor region");
}
if (result.counters.remoteNodeHashes >= localIndex.leafCount / 4) {
  throw new Error("opaque reconciliation examined unexpectedly broad Merkle node region");
}

const opaqueSample = base.slice(0, descriptorSampleSize);
const plaintextSample = await Promise.all(
  Array.from({ length: descriptorSampleSize }, (_, index) => plaintextDescriptor(index)),
);
const opaqueAverageBytes = average(opaqueSample.map(jsonBytes));
const plaintextAverageBytes = average(plaintextSample.map(jsonBytes));

console.log(JSON.stringify({
  benchmark: "opaque-reconciliation-v1",
  note: "Protocol-work and serialized-byte accounting only. The 100k opaque fixtures are structurally valid relay descriptors with deterministic synthetic tags so this benchmark isolates Merkle/session behavior from HKDF/HMAC/AES cost. Cryptographic derivation and encryption are covered separately by the encrypted-replication benchmark and tests. No network-latency or throughput claim is made.",
  fixture: {
    records: recordCount,
    delta: `${deltaSize}+${deltaSize}`,
    prefixBits,
    leafCount: localIndex.leafCount,
  },
  descriptorBytes: {
    sampleSize: descriptorSampleSize,
    plaintextAverage: round(plaintextAverageBytes),
    opaqueAverage: round(opaqueAverageBytes),
    opaqueToPlaintextRatio: round(opaqueAverageBytes / plaintextAverageBytes),
  },
  boundedTraversal: {
    steps: result.counters.steps,
    remoteNodeQueries: result.counters.remoteNodeQueries,
    remoteNodeHashes: result.counters.remoteNodeHashes,
    remoteLeafPages: result.counters.remoteLeafPages,
    remoteLeafDescriptors: result.counters.remoteLeafDescriptors,
    remoteLeafBytes: result.counters.remoteLeafBytes,
    touchedLeafDescriptorRatio: round(result.counters.remoteLeafDescriptors / recordCount),
    touchedNodeHashRatio: round(result.counters.remoteNodeHashes / localIndex.leafCount),
  },
}, null, 2));
