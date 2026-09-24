import { performance } from "node:perf_hooks";
import {
  replicationRecordFingerprint,
  replicationRecordKey,
  type ReplicationRecordDescriptor,
} from "../packages/replication/dist/index.js";
import {
  buildPrefixMerkleIndex,
  comparePrefixMerkleIndexes,
} from "../packages/replication/dist/merkle.js";

const sizes = [1_000, 10_000, 100_000] as const;
const deltaSize = 10;
const kind = "semantic-observation" as const;
const PAYLOAD_DIGEST_A = `sha256:${"a".repeat(64)}`;
const PAYLOAD_DIGEST_B = `sha256:${"b".repeat(64)}`;

async function descriptor(
  ordinal: number,
  payloadDigest = PAYLOAD_DIGEST_A,
): Promise<ReplicationRecordDescriptor> {
  const recordId = `benchmark-observation-${String(ordinal).padStart(8, "0")}`;
  const key = replicationRecordKey(kind, recordId);
  return {
    key,
    kind,
    recordId,
    payloadDigest,
    fingerprint: await replicationRecordFingerprint(key, payloadDigest),
    payloadBytes: 1,
  };
}

async function buildDescriptors(
  count: number,
  start = 0,
  payloadDigest = PAYLOAD_DIGEST_A,
): Promise<ReplicationRecordDescriptor[]> {
  const result: ReplicationRecordDescriptor[] = [];
  const batchSize = 1_000;
  for (let offset = 0; offset < count; offset += batchSize) {
    const length = Math.min(batchSize, count - offset);
    result.push(...await Promise.all(Array.from({ length }, (_, index) => (
      descriptor(start + offset + index, payloadDigest)
    ))));
  }
  return result;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function diffMetrics(diff: ReturnType<typeof comparePrefixMerkleIndexes>) {
  return {
    hashComparisons: diff.internalHashComparisons,
    mismatchedLeaves: diff.mismatchedLeafIds.length,
    leafDescriptorsExamined: diff.leafDescriptorsExamined,
    estimatedDescriptorBytesExchanged: diff.estimatedLeafDescriptorBytesExchanged,
  };
}

const results = [];
for (const size of sizes) {
  const descriptorStart = performance.now();
  const localDescriptors = await buildDescriptors(size);
  const descriptorBuildMs = performance.now() - descriptorStart;
  const flatDescriptorBytes = jsonBytes(localDescriptors);

  const localBuildStart = performance.now();
  const localIndex = await buildPrefixMerkleIndex(localDescriptors);
  const localIndexBuildMs = performance.now() - localBuildStart;

  const equalStart = performance.now();
  const equal = comparePrefixMerkleIndexes(localIndex, localIndex);
  const equalCompareMs = performance.now() - equalStart;
  if (!equal.rootEqual || equal.internalHashComparisons !== 1 || equal.leafDescriptorsExamined !== 0) {
    throw new Error("equal Merkle benchmark invariant failed");
  }

  const oneExtra = await descriptor(size + 1_000_000);
  const oneDeltaBuildStart = performance.now();
  const oneDeltaIndex = await buildPrefixMerkleIndex([...localDescriptors, oneExtra]);
  const oneDeltaIndexBuildMs = performance.now() - oneDeltaBuildStart;
  const oneDeltaStart = performance.now();
  const oneDelta = comparePrefixMerkleIndexes(localIndex, oneDeltaIndex);
  const oneDeltaCompareMs = performance.now() - oneDeltaStart;
  if (oneDelta.localOnly.length !== 0 || oneDelta.remoteOnly.length !== 1 || oneDelta.collisions.length !== 0) {
    throw new Error("one-record delta Merkle benchmark invariant failed");
  }

  const extras = await buildDescriptors(deltaSize, size + 2_000_000);
  const remoteDescriptors = [...localDescriptors.slice(deltaSize), ...extras];
  const remoteBuildStart = performance.now();
  const remoteIndex = await buildPrefixMerkleIndex(remoteDescriptors);
  const remoteIndexBuildMs = performance.now() - remoteBuildStart;
  const deltaStart = performance.now();
  const delta = comparePrefixMerkleIndexes(localIndex, remoteIndex);
  const smallDeltaCompareMs = performance.now() - deltaStart;
  if (
    delta.localOnly.length !== deltaSize
    || delta.remoteOnly.length !== deltaSize
    || delta.collisions.length !== 0
  ) {
    throw new Error("10+10 delta Merkle benchmark invariant failed");
  }

  const collisionAt = Math.min(deltaSize, size - 1);
  const collisionDescriptor = await descriptor(collisionAt, PAYLOAD_DIGEST_B);
  const collisionDescriptors = [...localDescriptors];
  collisionDescriptors[collisionAt] = collisionDescriptor;
  const collisionBuildStart = performance.now();
  const collisionIndex = await buildPrefixMerkleIndex(collisionDescriptors);
  const collisionIndexBuildMs = performance.now() - collisionBuildStart;
  const collisionStart = performance.now();
  const collision = comparePrefixMerkleIndexes(localIndex, collisionIndex);
  const collisionCompareMs = performance.now() - collisionStart;
  if (collision.collisions.length !== 1 || collision.localOnly.length !== 0 || collision.remoteOnly.length !== 0) {
    throw new Error("collision Merkle benchmark invariant failed");
  }

  const incremental = await descriptor(size + 3_000_000);
  const incrementalStart = performance.now();
  const addResult = await localIndex.add(incremental);
  const incrementalAddMs = performance.now() - incrementalStart;
  if (addResult !== "inserted") throw new Error("incremental add benchmark invariant failed");

  results.push({
    records: size,
    prefixBits: localIndex.prefixBits,
    leafCount: localIndex.leafCount,
    descriptorBuildMs: round(descriptorBuildMs),
    localIndexBuildMs: round(localIndexBuildMs),
    equalCompareMs: round(equalCompareMs),
    equalHashComparisons: equal.internalHashComparisons,
    oneDelta: {
      remoteIndexBuildMs: round(oneDeltaIndexBuildMs),
      compareMs: round(oneDeltaCompareMs),
      ...diffMetrics(oneDelta),
      exchangeReductionRatio: round(
        flatDescriptorBytes / Math.max(1, oneDelta.estimatedLeafDescriptorBytesExchanged),
      ),
    },
    tenPlusTenDelta: {
      remoteIndexBuildMs: round(remoteIndexBuildMs),
      compareMs: round(smallDeltaCompareMs),
      ...diffMetrics(delta),
      exchangeReductionRatio: round(
        flatDescriptorBytes / Math.max(1, delta.estimatedLeafDescriptorBytesExchanged),
      ),
    },
    collision: {
      remoteIndexBuildMs: round(collisionIndexBuildMs),
      compareMs: round(collisionCompareMs),
      collisions: collision.collisions.length,
      ...diffMetrics(collision),
      exchangeReductionRatio: round(
        flatDescriptorBytes / Math.max(1, collision.estimatedLeafDescriptorBytesExchanged),
      ),
    },
    flatDescriptorBytes,
    incrementalAddMs: round(incrementalAddMs),
  });
}

console.log(JSON.stringify({
  benchmark: "prefix-merkle-reconciliation-v1",
  note: "Observational local protocol-work benchmark over valid payload-free replication descriptors. Index build is local derived work. Exchange estimates count both mismatched leaf descriptor lists but exclude node-hash framing, authentication, transport overhead, and network latency.",
  results,
}, null, 2));
