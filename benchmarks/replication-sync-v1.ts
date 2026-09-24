import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  diffReplicationDescriptors,
  replicationRecordFingerprint,
  replicationRecordKey,
  type ReplicationRecordDescriptor,
} from "../packages/replication/dist/index.js";
import {
  buildPrefixMerkleIndex,
  restorePrefixMerkleIndex,
  type PrefixMerkleIndex,
} from "../packages/replication/dist/merkle.js";
import {
  BoundedReconciliationSession,
  FrozenPrefixMerkleView,
  InMemoryReconciliationEndpoint,
  InMemoryReconciliationViewRegistry,
  type ReconciliationResult,
  type ReconciliationSessionOptions,
} from "../packages/replication/dist/sync.js";

const kind = "semantic-observation" as const;
const payloadDigest = `sha256:${"a".repeat(64)}`;
const recordCount = 10_000;
const deltaSize = 10;
const hotLeafDescriptorCount = 10_000;
const basePrefixBits = 12 as const;
const hotPrefixBits = 8 as const;

function round(value: number): number {
  return Number(value.toFixed(3));
}

async function descriptor(recordId: string): Promise<ReplicationRecordDescriptor> {
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

async function buildDescriptors(count: number, start = 0): Promise<ReplicationRecordDescriptor[]> {
  const result: ReplicationRecordDescriptor[] = [];
  const batchSize = 1_000;
  for (let offset = 0; offset < count; offset += batchSize) {
    const length = Math.min(batchSize, count - offset);
    result.push(...await Promise.all(Array.from({ length }, (_, index) => (
      descriptor(`sync-benchmark-${String(start + offset + index).padStart(9, "0")}`)
    ))));
  }
  return result;
}

function firstPrefixByte(recordId: string): number {
  const key = JSON.stringify([kind, recordId]);
  return createHash("sha256").update(key).digest()[0] ?? -1;
}

async function hotLeafDescriptors(count: number): Promise<ReplicationRecordDescriptor[]> {
  const ids: string[] = [];
  for (let ordinal = 0; ids.length < count; ordinal += 1) {
    const id = `hot-sync-${String(ordinal).padStart(10, "0")}`;
    if (firstPrefixByte(id) === 0) ids.push(id);
  }
  const result: ReplicationRecordDescriptor[] = [];
  const batchSize = 1_000;
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    result.push(...await Promise.all(ids.slice(offset, offset + batchSize).map(descriptor)));
  }
  return result;
}

interface SessionRuntime {
  readonly localView: FrozenPrefixMerkleView;
  readonly endpoint: InMemoryReconciliationEndpoint;
  readonly remoteViewId: string;
  readonly session: BoundedReconciliationSession;
}

async function sessionRuntime(
  localIndex: PrefixMerkleIndex,
  remoteIndex: PrefixMerkleIndex,
  options: ReconciliationSessionOptions = {},
): Promise<SessionRuntime> {
  const localView = await FrozenPrefixMerkleView.open(localIndex);
  const registry = new InMemoryReconciliationViewRegistry();
  const remoteView = await registry.open(remoteIndex);
  const endpoint = new InMemoryReconciliationEndpoint(registry);
  const remoteViewId = remoteView.info().viewId;
  const session = await BoundedReconciliationSession.start(
    localView,
    endpoint,
    remoteViewId,
    options,
  );
  return { localView, endpoint, remoteViewId, session };
}

function assertDelta(
  result: ReconciliationResult,
  expected: ReturnType<typeof diffReplicationDescriptors>,
): void {
  if (
    JSON.stringify(result.localOnly) !== JSON.stringify(expected.localOnly)
    || JSON.stringify(result.remoteOnly) !== JSON.stringify(expected.remoteOnly)
    || JSON.stringify(result.collisions) !== JSON.stringify(expected.collisions)
  ) {
    throw new Error("bounded reconciliation result differs from flat v0");
  }
}

function protocolWork(result: ReconciliationResult) {
  return {
    remoteMessages: 1 + result.counters.remoteNodeQueries + result.counters.remoteLeafPages,
    steps: result.counters.steps,
    nodeQueries: result.counters.remoteNodeQueries,
    nodeHashes: result.counters.remoteNodeHashes,
    leafPages: result.counters.remoteLeafPages,
    leafDescriptors: result.counters.remoteLeafDescriptors,
    descriptorBytes: result.counters.remoteLeafBytes,
  };
}

const descriptorStart = performance.now();
const base = await buildDescriptors(recordCount);
const descriptorBuildMs = performance.now() - descriptorStart;

const localBuildStart = performance.now();
const localIndex = await buildPrefixMerkleIndex(base, { prefixBits: basePrefixBits });
const localIndexBuildMs = performance.now() - localBuildStart;

const equalIndex = await restorePrefixMerkleIndex(localIndex.snapshot());
const equalRuntime = await sessionRuntime(localIndex, equalIndex);
const equalStart = performance.now();
const equal = await equalRuntime.session.runToCompletion(equalRuntime.localView, equalRuntime.endpoint);
const equalMs = performance.now() - equalStart;
if (
  equal.localOnly.length !== 0
  || equal.remoteOnly.length !== 0
  || equal.collisions.length !== 0
  || equal.counters.remoteNodeQueries !== 0
  || equal.counters.remoteLeafPages !== 0
) {
  throw new Error("equal bounded-reconciliation benchmark invariant failed");
}

const oneExtra = await descriptor("sync-benchmark-one-extra");
const oneIndex = await restorePrefixMerkleIndex(localIndex.snapshot());
await oneIndex.add(oneExtra);
const oneRuntime = await sessionRuntime(localIndex, oneIndex, { maxLeafDescriptors: 128 });
const oneStart = performance.now();
const one = await oneRuntime.session.runToCompletion(oneRuntime.localView, oneRuntime.endpoint);
const oneMs = performance.now() - oneStart;
assertDelta(one, diffReplicationDescriptors(base, [...base, oneExtra]));

const extras = await buildDescriptors(deltaSize, 1_000_000);
const tenRemoteDescriptors = [...base.slice(deltaSize), ...extras];
const tenBuildStart = performance.now();
const tenRemoteIndex = await buildPrefixMerkleIndex(tenRemoteDescriptors, { prefixBits: basePrefixBits });
const tenRemoteIndexBuildMs = performance.now() - tenBuildStart;
const tenRuntime = await sessionRuntime(localIndex, tenRemoteIndex, {
  maxNodeRefsPerStep: 64,
  maxLeafDescriptors: 64,
  maxLeafBytes: 64 * 1024,
});
while (!tenRuntime.session.complete && tenRuntime.session.counters().remoteLeafPages === 0) {
  await tenRuntime.session.step(tenRuntime.localView, tenRuntime.endpoint);
}
if (tenRuntime.session.complete) throw new Error("10+10 benchmark completed before resume checkpoint");
const encodeStart = performance.now();
const encoded = tenRuntime.session.encode();
const encodeMs = performance.now() - encodeStart;
const restoreStart = performance.now();
const restoredTenSession = await BoundedReconciliationSession.restore(encoded);
const restoreMs = performance.now() - restoreStart;
const tenStart = performance.now();
const ten = await restoredTenSession.runToCompletion(tenRuntime.localView, tenRuntime.endpoint);
const tenCompletionMs = performance.now() - tenStart;
assertDelta(ten, diffReplicationDescriptors(base, tenRemoteDescriptors));

const hotSearchStart = performance.now();
const hotDescriptors = await hotLeafDescriptors(hotLeafDescriptorCount);
const hotFixtureBuildMs = performance.now() - hotSearchStart;
const hotRemoteBuildStart = performance.now();
const [emptyIndex, hotIndex] = await Promise.all([
  buildPrefixMerkleIndex([], { prefixBits: hotPrefixBits }),
  buildPrefixMerkleIndex(hotDescriptors, { prefixBits: hotPrefixBits }),
]);
const hotIndexBuildMs = performance.now() - hotRemoteBuildStart;
const hotRuntime = await sessionRuntime(emptyIndex, hotIndex, {
  maxLeafDescriptors: 128,
  maxLeafBytes: 64 * 1024,
  maxSteps: 10_000,
});
const hotStart = performance.now();
const hot = await hotRuntime.session.runToCompletion(hotRuntime.localView, hotRuntime.endpoint);
const hotMs = performance.now() - hotStart;
if (
  hot.localOnly.length !== 0
  || hot.remoteOnly.length !== hotLeafDescriptorCount
  || hot.collisions.length !== 0
  || hot.counters.remoteLeafDescriptors !== hotLeafDescriptorCount
) {
  throw new Error("10k hot-leaf bounded-reconciliation benchmark invariant failed");
}

console.log(JSON.stringify({
  benchmark: "bounded-reconciliation-session-v1",
  note: "Observational local protocol-work benchmark. remoteMessages counts one root/view-info exchange plus remote node-query and leaf-page responses. It excludes authentication, transport framing, RTT, packet loss, compression, payload transfer, and network latency. Hot-leaf fixture generation deliberately brute-forces an 8-bit public prefix to measure the known fixed-prefix clustering case.",
  fixture: {
    records: recordCount,
    prefixBits: basePrefixBits,
    descriptorBuildMs: round(descriptorBuildMs),
    localIndexBuildMs: round(localIndexBuildMs),
  },
  equal: {
    compareMs: round(equalMs),
    ...protocolWork(equal),
  },
  oneRecordDelta: {
    compareMs: round(oneMs),
    ...protocolWork(one),
  },
  tenPlusTenDeltaWithResume: {
    remoteIndexBuildMs: round(tenRemoteIndexBuildMs),
    encodedStateBytes: Buffer.byteLength(encoded, "utf8"),
    encodeMs: round(encodeMs),
    restoreMs: round(restoreMs),
    postRestoreCompletionMs: round(tenCompletionMs),
    ...protocolWork(ten),
  },
  hotLeaf: {
    descriptors: hotLeafDescriptorCount,
    prefixBits: hotPrefixBits,
    leafId: 0,
    fixtureSearchAndDescriptorBuildMs: round(hotFixtureBuildMs),
    indexBuildMs: round(hotIndexBuildMs),
    reconcileMs: round(hotMs),
    ...protocolWork(hot),
  },
}, null, 2));
