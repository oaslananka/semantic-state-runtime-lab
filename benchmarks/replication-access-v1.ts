import { performance } from "node:perf_hooks";
import type { AccessPrincipal } from "../packages/access/dist/index.js";
import {
  createReplicationRecord,
  type ReplicationRecord,
} from "../packages/replication/dist/index.js";
import {
  MutableReplicationRecordSource,
  ReplicationAccessGateway,
  replicationAccessTransferBytes,
  type ReplicationAccessOperation,
  type ReplicationAccessPolicy,
} from "../packages/replication-access/dist/index.js";
import { temporalObservationJson } from "../packages/state-store/dist/index.js";

const sourceRecordCount = 5_000;
const allowEvery = 5;
const transferCount = 64;
const principal: AccessPrincipal = {
  subject: "benchmark:device",
  scopes: ["replication:read"],
};

function round(value: number): number {
  return Number(value.toFixed(3));
}

async function record(index: number): Promise<ReplicationRecord> {
  const id = `benchmark-observation-${String(index).padStart(6, "0")}`;
  return createReplicationRecord({
    kind: "semantic-observation",
    recordId: id,
    payload: temporalObservationJson({
      id,
      entityId: `entity://project/${String(index % 100).padStart(3, "0")}`,
      property: "Project.status",
      value: index % 2 === 0 ? "active" : "paused",
      source: { provider: "benchmark", externalId: id },
      validFrom: "2026-01-01T00:00:00Z",
      recordedAt: "2026-01-01T00:00:00Z",
    }),
  });
}

const buildStart = performance.now();
const records: ReplicationRecord[] = [];
for (let offset = 0; offset < sourceRecordCount; offset += 500) {
  const length = Math.min(500, sourceRecordCount - offset);
  records.push(...await Promise.all(Array.from({ length }, (_, index) => record(offset + index))));
}
const recordBuildMs = performance.now() - buildStart;

const allowedIds = new Set(
  records
    .filter((_, index) => index % allowEvery === 0)
    .map((item) => item.recordId),
);
const evaluations: Record<ReplicationAccessOperation, number> = {
  "projection:read": 0,
  "record:read": 0,
  "record:apply": 0,
  "artifact-blob:read": 0,
  "artifact-blob:apply": 0,
};
const policy: ReplicationAccessPolicy = {
  evaluate(request) {
    evaluations[request.operation] += 1;
    if (
      request.operation === "record:apply"
      || request.operation === "artifact-blob:read"
      || request.operation === "artifact-blob:apply"
    ) {
      return { effect: "deny", code: "benchmark-read-only" };
    }
    return allowedIds.has(request.record.recordId)
      ? { effect: "allow" }
      : { effect: "deny", code: "not-in-benchmark-projection" };
  },
};
const source = new MutableReplicationRecordSource(records);
const gateway = new ReplicationAccessGateway({
  source,
  policy,
  policyVersion: () => "benchmark-v1",
  projectionIds: ["benchmark-personal"],
  maxSourceRecords: sourceRecordCount,
  maxProjectionRecords: sourceRecordCount,
  maxPolicyEvaluations: sourceRecordCount,
  maxReadRecords: 128,
  maxReadBytes: 4 * 1024 * 1024,
  maxLeaseMs: 60_000,
  now: () => "2026-09-25T00:00:00Z",
});

const projectionStart = performance.now();
const opened = await gateway.openProjection({
  principal,
  projectionId: "benchmark-personal",
  prefixBits: 12,
  leaseMs: 60_000,
});
const projectionMs = performance.now() - projectionStart;
if (opened.view.recordCount !== allowedIds.size) {
  throw new Error("projection benchmark allowed-record invariant failed");
}
if (opened.accounting.policyEvaluations !== sourceRecordCount) {
  throw new Error("projection benchmark policy-evaluation invariant failed");
}

const allowedRecords = records
  .filter((item) => allowedIds.has(item.recordId))
  .toSorted((left, right) => left.key.localeCompare(right.key));
const keys = allowedRecords.slice(0, transferCount).map((item) => item.key);
const readsBefore = evaluations["record:read"];
const transferStart = performance.now();
const transferred = await gateway.readRecords({
  principal,
  projectionId: "benchmark-personal",
  viewId: opened.view.viewId,
  keys,
});
const transferMs = performance.now() - transferStart;
const transferPolicyEvaluations = evaluations["record:read"] - readsBefore;
if (transferred.length !== transferCount || transferPolicyEvaluations !== transferCount) {
  throw new Error("record-transfer benchmark accounting invariant failed");
}

console.log(JSON.stringify({
  benchmark: "replication-access-v1",
  note: "Observational local authorization/projection work accounting. No network, credential verification, token parsing, TLS, RTT, storage I/O, or policy-cache claim.",
  fixture: {
    sourceRecords: sourceRecordCount,
    allowEvery,
    expectedAllowedRecords: allowedIds.size,
    transferRecords: transferCount,
    recordBuildMs: round(recordBuildMs),
  },
  projection: {
    elapsedMs: round(projectionMs),
    sourceRecordsScanned: opened.accounting.sourceRecordsScanned,
    policyEvaluations: opened.accounting.policyEvaluations,
    allowedDescriptors: opened.accounting.allowedDescriptors,
    rootRecordCount: opened.view.recordCount,
  },
  transfer: {
    elapsedMs: round(transferMs),
    records: transferred.length,
    policyEvaluations: transferPolicyEvaluations,
    envelopeBytes: replicationAccessTransferBytes(transferred),
  },
}, null, 2));
