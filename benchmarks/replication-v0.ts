import { performance } from "node:perf_hooks";
import { temporalObservationJson } from "../packages/state-store/dist/index.js";
import {
  createReplicationRecord,
  diffReplicationInventories,
  replicationInventory,
  type ReplicationRecord,
} from "../packages/replication/dist/index.js";

const project = "entity://project/replication-benchmark" as const;
const sizes = [1_000, 10_000, 100_000] as const;
const deltaSize = 10;

function observationPayload(id: string, value: string): string {
  return temporalObservationJson({
    id,
    entityId: project,
    property: "Benchmark.value",
    value,
    source: { provider: "benchmark", externalId: id, revision: id },
    validFrom: "2026-01-01T00:00:00Z",
    recordedAt: "2026-01-01T00:00:00Z",
  });
}

async function record(id: string, value: string): Promise<ReplicationRecord> {
  return createReplicationRecord({
    kind: "semantic-observation",
    recordId: id,
    payload: observationPayload(id, value),
  });
}

async function buildRecords(count: number, start = 0): Promise<ReplicationRecord[]> {
  const result: ReplicationRecord[] = [];
  const batchSize = 1_000;
  for (let offset = 0; offset < count; offset += batchSize) {
    const length = Math.min(batchSize, count - offset);
    const batch = await Promise.all(Array.from({ length }, (_, index) => {
      const ordinal = start + offset + index;
      const id = `benchmark-observation-${String(ordinal).padStart(8, "0")}`;
      return record(id, `value-${ordinal}`);
    }));
    result.push(...batch);
  }
  return result;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

const results = [];
for (const size of sizes) {
  const heapBefore = process.memoryUsage().heapUsed;
  const recordStart = performance.now();
  const localRecords = await buildRecords(size);
  const recordBuildMs = performance.now() - recordStart;

  const inventoryStart = performance.now();
  const localInventory = await replicationInventory(localRecords);
  const inventoryBuildMs = performance.now() - inventoryStart;

  const equalStart = performance.now();
  const equal = await diffReplicationInventories(localInventory, localInventory);
  const equalDiffMs = performance.now() - equalStart;
  if (!equal.equal) throw new Error("equal inventory benchmark invariant failed");

  const extras = await buildRecords(deltaSize, size);
  const remoteRecords = [...localRecords.slice(deltaSize), ...extras];
  const remoteStart = performance.now();
  const remoteInventory = await replicationInventory(remoteRecords);
  const deltaInventoryBuildMs = performance.now() - remoteStart;
  const deltaStart = performance.now();
  const delta = await diffReplicationInventories(localInventory, remoteInventory);
  const smallDeltaDiffMs = performance.now() - deltaStart;
  if (
    delta.localOnly.length !== deltaSize
    || delta.remoteOnly.length !== deltaSize
    || delta.collisions.length !== 0
  ) {
    throw new Error("small delta benchmark invariant failed");
  }

  const collisionAt = Math.min(deltaSize, size - 1);
  const original = localRecords[collisionAt]!;
  const divergent = await record(original.recordId, "divergent-value");
  const collisionRecords = [...localRecords];
  collisionRecords[collisionAt] = divergent;
  const collisionInventoryStart = performance.now();
  const collisionInventory = await replicationInventory(collisionRecords);
  const collisionInventoryBuildMs = performance.now() - collisionInventoryStart;
  const collisionStart = performance.now();
  const collision = await diffReplicationInventories(localInventory, collisionInventory);
  const collisionDiffMs = performance.now() - collisionStart;
  if (collision.collisions.length !== 1) {
    throw new Error("collision benchmark invariant failed");
  }

  const heapAfter = process.memoryUsage().heapUsed;
  results.push({
    records: size,
    recordBuildMs: round(recordBuildMs),
    inventoryBuildMs: round(inventoryBuildMs),
    equalDiffMs: round(equalDiffMs),
    deltaRecordsEachSide: deltaSize,
    deltaInventoryBuildMs: round(deltaInventoryBuildMs),
    smallDeltaDiffMs: round(smallDeltaDiffMs),
    collisionInventoryBuildMs: round(collisionInventoryBuildMs),
    collisionDiffMs: round(collisionDiffMs),
    descriptorJsonBytes: Buffer.byteLength(JSON.stringify(localInventory.records), "utf8"),
    heapDeltaMiB: round((heapAfter - heapBefore) / (1024 * 1024)),
    rootDigestStable: localInventory.rootDigest === (await replicationInventory([...localRecords].reverse())).rootDigest,
  });
}

console.log(JSON.stringify({
  benchmark: "immutable-replication-records-v0",
  note: "Observational local benchmark. v0 exchanges O(N) sorted descriptors; this is a correctness baseline, not a production sync protocol or SLA.",
  results,
}, null, 2));
