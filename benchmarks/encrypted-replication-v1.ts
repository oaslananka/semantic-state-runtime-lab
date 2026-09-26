import { generateVaultEpoch } from "../packages/e2e/dist/index.js";
import { temporalObservationJson } from "../packages/state-store/dist/index.js";
import {
  createReplicationRecord,
  replicationDescriptor,
} from "../packages/replication/dist/index.js";
import {
  encryptArtifactBlob,
  encryptedReplicationObjectJson,
  encryptReplicationRecord,
  opaqueReplicationDescriptorJson,
} from "../packages/replication/dist/encrypted.js";

const encoder = new TextEncoder();
const epoch = generateVaultEpoch();

function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

async function digest(value: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return `sha256:${[...hash]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

const recordId = "benchmark-encrypted-replication";
const record = await createReplicationRecord({
  kind: "semantic-observation",
  recordId,
  payload: temporalObservationJson({
    id: recordId,
    entityId: "entity://project/encrypted-replication-benchmark",
    property: "Project.status",
    value: "active",
    source: {
      provider: "benchmark",
      externalId: recordId,
      revision: "r1",
    },
    validFrom: "2026-09-01T00:00:00Z",
    recordedAt: "2026-09-01T00:00:00Z",
  }),
});
const encryptedRecord = await encryptReplicationRecord({
  epochId: epoch.epochId,
  epochSecret: epoch.secret,
  record,
});
const plaintextDescriptorBytes = bytes(JSON.stringify(replicationDescriptor(record)));
const opaqueDescriptorBytes = bytes(
  await opaqueReplicationDescriptorJson(encryptedRecord.descriptor),
);
const encryptedRecordObjectBytes = bytes(
  await encryptedReplicationObjectJson(encryptedRecord),
);

const blobResults = [];
for (const size of [1_024, 64 * 1_024] as const) {
  const blob = new Uint8Array(size);
  for (let index = 0; index < blob.length; index += 1) {
    blob[index] = index % 251;
  }
  const plaintextDigest = await digest(blob);
  const encrypted = await encryptArtifactBlob({
    epochId: epoch.epochId,
    epochSecret: epoch.secret,
    plaintextDigest,
    bytes: blob,
  });
  blobResults.push({
    plaintextBytes: blob.byteLength,
    opaqueDescriptorBytes: bytes(await opaqueReplicationDescriptorJson(encrypted.descriptor)),
    encryptedObjectJsonBytes: bytes(await encryptedReplicationObjectJson(encrypted)),
    jsonExpansionRatio: Number((
      bytes(await encryptedReplicationObjectJson(encrypted)) / blob.byteLength
    ).toFixed(3)),
  });
}

console.log(JSON.stringify({
  benchmark: "encrypted-replication-v1-overhead-accounting",
  note: "Byte accounting only. This does not measure network latency, throughput, relay storage engine overhead, TLS, or metadata-privacy strength.",
  semanticRecord: {
    canonicalPayloadBytes: record.payloadBytes,
    plaintextDescriptorBytes,
    opaqueDescriptorBytes,
    encryptedObjectJsonBytes: encryptedRecordObjectBytes,
    descriptorRatio: Number((opaqueDescriptorBytes / plaintextDescriptorBytes).toFixed(3)),
  },
  artifactBlobs: blobResults,
}, null, 2));
