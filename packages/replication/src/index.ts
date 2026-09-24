import {
  artifactDigest,
  artifactMutationJson,
  parseArtifactMutationJson,
  type ArtifactDigest,
  type ArtifactMutation,
  type ArtifactStore,
} from "@ssrl/artifact-store";
import { canonicalJson } from "@ssrl/core";
import {
  entityAliasJson,
  parseEntityAliasJson,
  parseSemanticEntityJson,
  parseSemanticRetractionJson,
  parseTemporalObservationJson,
  parseTemporalRelationJson,
  semanticEntityJson,
  semanticRetractionJson,
  temporalObservationJson,
  temporalRelationJson,
  type SemanticStateBatch,
  type SemanticStateStore,
} from "@ssrl/state-store";

export const REPLICATION_INVENTORY_SCHEMA = "ssrl-replication-inventory-v0" as const;

export type ReplicationRecordKind =
  | "semantic-entity"
  | "semantic-alias"
  | "semantic-observation"
  | "semantic-relation"
  | "semantic-retraction"
  | "artifact-mutation";

declare const replicationRecordKeyBrand: unique symbol;
export type ReplicationRecordKey = string & { readonly [replicationRecordKeyBrand]: true };

export interface ReplicationRecordDescriptor {
  readonly key: ReplicationRecordKey;
  readonly kind: ReplicationRecordKind;
  readonly recordId: string;
  readonly payloadDigest: string;
  /** Digest of canonical (key, payloadDigest); useful for future hierarchical reconciliation. */
  readonly fingerprint: string;
  readonly payloadBytes: number;
}

export interface ReplicationApplyOptions {
  readonly maxRecords?: number;
}

export const DEFAULT_REPLICATION_APPLY_MAX_RECORDS = 1_000;
export const MAX_REPLICATION_APPLY_RECORDS = 10_000;

export interface ReplicationRecord extends ReplicationRecordDescriptor {
  /** Canonical JSON payload. Network/wire encoding remains a transport concern. */
  readonly payload: string;
}

export interface ReplicationInventory {
  readonly schema: typeof REPLICATION_INVENTORY_SCHEMA;
  readonly rootDigest: string;
  readonly records: readonly ReplicationRecordDescriptor[];
}

export interface ReplicationRecordCollision {
  readonly key: ReplicationRecordKey;
  readonly localDigest: string;
  readonly remoteDigest: string;
}

export interface ReplicationInventoryDiff {
  readonly localOnly: readonly ReplicationRecordKey[];
  readonly remoteOnly: readonly ReplicationRecordKey[];
  readonly collisions: readonly ReplicationRecordCollision[];
  readonly equal: boolean;
}

export interface RequiredArtifactBlob {
  readonly digest: ArtifactDigest;
  readonly size: number;
  readonly mediaTypes: readonly string[];
}

export interface ArtifactBlobTransferResult {
  readonly transferredDigests: readonly ArtifactDigest[];
  readonly skippedDigests: readonly ArtifactDigest[];
  readonly transferredBytes: number;
}

export class ReplicationRecordCollisionError extends Error {
  constructor(readonly collision: ReplicationRecordCollision) {
    super(`Replication record ${collision.key} has different canonical payload digests`);
    this.name = "ReplicationRecordCollisionError";
  }
}

export class InvalidReplicationRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReplicationRecordError";
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidReplicationRecordError(`${label} must be a non-empty string`);
  }
  return value;
}

function assertReplicationRecordKind(value: unknown): asserts value is ReplicationRecordKind {
  if (
    value !== "semantic-entity"
    && value !== "semantic-alias"
    && value !== "semantic-observation"
    && value !== "semantic-relation"
    && value !== "semantic-retraction"
    && value !== "artifact-mutation"
  ) {
    throw new InvalidReplicationRecordError(`Unsupported replication record kind: ${String(value)}`);
  }
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function sha256(value: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}


function assertSha256Digest(value: string, label: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new InvalidReplicationRecordError(`${label} must be a lowercase SHA-256 digest`);
  }
}

export async function replicationRecordFingerprint(
  key: ReplicationRecordKey,
  payloadDigest: string,
): Promise<string> {
  assertSha256Digest(payloadDigest, "replication payloadDigest");
  const material = canonicalJson({ key, payloadDigest });
  return `sha256:${await sha256(utf8Bytes(material))}`;
}

function assertApplyBatchBound(
  records: readonly ReplicationRecord[],
  options: ReplicationApplyOptions,
): void {
  const maxRecords = options.maxRecords ?? DEFAULT_REPLICATION_APPLY_MAX_RECORDS;
  if (
    !Number.isSafeInteger(maxRecords)
    || maxRecords < 1
    || maxRecords > MAX_REPLICATION_APPLY_RECORDS
  ) {
    throw new RangeError(
      `maxRecords must be an integer between 1 and ${MAX_REPLICATION_APPLY_RECORDS}`,
    );
  }
  if (records.length > maxRecords) {
    throw new RangeError(
      `Replication apply batch contains ${records.length} records; maxRecords is ${maxRecords}`,
    );
  }
}

export function replicationRecordKey(
  kind: ReplicationRecordKind,
  recordId: string,
): ReplicationRecordKey {
  assertReplicationRecordKind(kind);
  return canonicalJson([kind, requiredString(recordId, "replication recordId")]) as ReplicationRecordKey;
}

function descriptorOrder(
  left: Pick<ReplicationRecordDescriptor, "key">,
  right: Pick<ReplicationRecordDescriptor, "key">,
): number {
  return left.key.localeCompare(right.key);
}

function canonicalReplicationPayload(
  kind: ReplicationRecordKind,
  payload: string,
): { readonly payload: string; readonly recordId: string } {
  switch (kind) {
    case "semantic-entity": {
      const value = parseSemanticEntityJson(payload);
      return { payload: semanticEntityJson(value), recordId: value.entityId };
    }
    case "semantic-alias": {
      const value = parseEntityAliasJson(payload);
      return { payload: entityAliasJson(value), recordId: value.id };
    }
    case "semantic-observation": {
      const value = parseTemporalObservationJson(payload);
      return { payload: temporalObservationJson(value), recordId: value.id };
    }
    case "semantic-relation": {
      const value = parseTemporalRelationJson(payload);
      return { payload: temporalRelationJson(value), recordId: value.id };
    }
    case "semantic-retraction": {
      const value = parseSemanticRetractionJson(payload);
      return { payload: semanticRetractionJson(value), recordId: value.id };
    }
    case "artifact-mutation": {
      const value = parseArtifactMutationJson(payload);
      return { payload: artifactMutationJson(value), recordId: value.id };
    }
  }
}

export async function createReplicationRecord(input: {
  readonly kind: ReplicationRecordKind;
  readonly recordId: string;
  readonly payload: string;
}): Promise<ReplicationRecord> {
  const canonical = canonicalReplicationPayload(input.kind, input.payload);
  if (canonical.recordId !== input.recordId) {
    throw new InvalidReplicationRecordError(
      `Replication recordId ${input.recordId} disagrees with canonical payload id ${canonical.recordId}`,
    );
  }
  const key = replicationRecordKey(input.kind, input.recordId);
  const bytes = utf8Bytes(canonical.payload);
  const payloadDigest = `sha256:${await sha256(bytes)}`;
  return {
    key,
    kind: input.kind,
    recordId: input.recordId,
    payloadDigest,
    fingerprint: await replicationRecordFingerprint(key, payloadDigest),
    payloadBytes: bytes.byteLength,
    payload: canonical.payload,
  };
}

function assertRecordKeyIdentity(
  record: Pick<ReplicationRecordDescriptor, "key" | "kind" | "recordId">,
): void {
  assertReplicationRecordKind(record.kind);
  requiredString(record.recordId, "replication recordId");
  requiredString(record.key, "replication record key");
  if (record.key !== replicationRecordKey(record.kind, record.recordId)) {
    throw new InvalidReplicationRecordError(`Replication record key disagrees with kind/id: ${record.key}`);
  }
}

function replicationDescriptor(
  record: Pick<ReplicationRecord, keyof ReplicationRecordDescriptor>,
): ReplicationRecordDescriptor {
  return {
    key: record.key,
    kind: record.kind,
    recordId: record.recordId,
    payloadDigest: record.payloadDigest,
    fingerprint: record.fingerprint,
    payloadBytes: record.payloadBytes,
  };
}

function replicationCollision(
  existing: Pick<ReplicationRecordDescriptor, "payloadDigest">,
  incoming: Pick<ReplicationRecordDescriptor, "key" | "payloadDigest">,
): ReplicationRecordCollisionError {
  return new ReplicationRecordCollisionError({
    key: incoming.key,
    localDigest: existing.payloadDigest,
    remoteDigest: incoming.payloadDigest,
  });
}

function assertSameDescriptorKey(
  existing: ReplicationRecordDescriptor,
  incoming: Pick<ReplicationRecord, keyof ReplicationRecordDescriptor>,
): void {
  if (existing.payloadDigest !== incoming.payloadDigest) {
    throw replicationCollision(existing, incoming);
  }
  if (
    existing.fingerprint !== incoming.fingerprint
    || existing.payloadBytes !== incoming.payloadBytes
    || existing.kind !== incoming.kind
    || existing.recordId !== incoming.recordId
  ) {
    throw new InvalidReplicationRecordError(
      `Duplicate replication record key ${incoming.key} has inconsistent descriptor metadata`,
    );
  }
}

function assertSameRecordEnvelope(
  existing: ReplicationRecord,
  incoming: ReplicationRecord,
): void {
  if (
    existing.payloadDigest !== incoming.payloadDigest
    || existing.payload !== incoming.payload
  ) {
    throw replicationCollision(existing, incoming);
  }
  if (
    existing.fingerprint !== incoming.fingerprint
    || existing.payloadBytes !== incoming.payloadBytes
  ) {
    throw new InvalidReplicationRecordError(
      `Duplicate replication record ${incoming.key} has inconsistent envelope metadata`,
    );
  }
}

async function validateReplicationDescriptor(
  record: Pick<ReplicationRecord, keyof ReplicationRecordDescriptor>,
): Promise<void> {
  assertRecordKeyIdentity(record);
  assertSha256Digest(record.payloadDigest, `Replication record ${record.key} payloadDigest`);
  assertSha256Digest(record.fingerprint, `Replication record ${record.key} fingerprint`);
  if (!Number.isSafeInteger(record.payloadBytes) || record.payloadBytes < 0) {
    throw new InvalidReplicationRecordError(
      `Replication record ${record.key} payloadBytes must be a non-negative safe integer`,
    );
  }
  const fingerprint = await replicationRecordFingerprint(record.key, record.payloadDigest);
  if (fingerprint !== record.fingerprint) {
    throw new InvalidReplicationRecordError(`Replication record ${record.key} fingerprint mismatch`);
  }
}

function inventoryRootMaterial(records: readonly ReplicationRecordDescriptor[]): string {
  return canonicalJson(records.map(replicationDescriptor));
}

export async function replicationInventory(
  records: readonly Pick<ReplicationRecord, keyof ReplicationRecordDescriptor>[],
): Promise<ReplicationInventory> {
  const sorted = [...records].toSorted(descriptorOrder);
  const unique: ReplicationRecordDescriptor[] = [];
  const seen = new Map<ReplicationRecordKey, ReplicationRecordDescriptor>();
  for (const record of sorted) {
    await validateReplicationDescriptor(record);
    const existing = seen.get(record.key);
    if (existing !== undefined) {
      assertSameDescriptorKey(existing, record);
      continue;
    }
    const descriptor = replicationDescriptor(record);
    seen.set(record.key, descriptor);
    unique.push(descriptor);
  }
  const rootMaterial = inventoryRootMaterial(unique);
  return {
    schema: REPLICATION_INVENTORY_SCHEMA,
    rootDigest: `sha256:${await sha256(utf8Bytes(rootMaterial))}`,
    records: unique,
  };
}

export async function verifyReplicationInventory(
  inventory: ReplicationInventory,
): Promise<ReplicationInventory> {
  if (inventory.schema !== REPLICATION_INVENTORY_SCHEMA) {
    throw new InvalidReplicationRecordError("Unsupported replication inventory schema");
  }
  if (!Array.isArray(inventory.records)) {
    throw new InvalidReplicationRecordError("Replication inventory records must be an array");
  }
  assertSha256Digest(inventory.rootDigest, "replication inventory rootDigest");
  const rebuilt = await replicationInventory(inventory.records);
  if (rebuilt.rootDigest !== inventory.rootDigest) {
    throw new InvalidReplicationRecordError("Replication inventory root digest mismatch");
  }
  return rebuilt;
}

function descriptorMap(
  inventory: ReplicationInventory,
): ReadonlyMap<ReplicationRecordKey, ReplicationRecordDescriptor> {
  return new Map(inventory.records.map((record) => [record.key, record]));
}

export async function diffReplicationInventories(
  local: ReplicationInventory,
  remote: ReplicationInventory,
): Promise<ReplicationInventoryDiff> {
  const [verifiedLocal, verifiedRemote] = await Promise.all([
    verifyReplicationInventory(local),
    verifyReplicationInventory(remote),
  ]);
  if (verifiedLocal.rootDigest === verifiedRemote.rootDigest) {
    return { localOnly: [], remoteOnly: [], collisions: [], equal: true };
  }
  const localMap = descriptorMap(verifiedLocal);
  const remoteMap = descriptorMap(verifiedRemote);
  const keys = [...new Set([...localMap.keys(), ...remoteMap.keys()])]
    .toSorted((left, right) => left.localeCompare(right));
  const localOnly: ReplicationRecordKey[] = [];
  const remoteOnly: ReplicationRecordKey[] = [];
  const collisions: ReplicationRecordCollision[] = [];
  for (const key of keys) {
    const left = localMap.get(key);
    const right = remoteMap.get(key);
    if (left === undefined) {
      remoteOnly.push(key);
      continue;
    }
    if (right === undefined) {
      localOnly.push(key);
      continue;
    }
    if (left.payloadDigest !== right.payloadDigest) {
      collisions.push({ key, localDigest: left.payloadDigest, remoteDigest: right.payloadDigest });
    }
  }
  return {
    localOnly,
    remoteOnly,
    collisions,
    equal: localOnly.length === 0 && remoteOnly.length === 0 && collisions.length === 0,
  };
}

export function assertCollisionFreeReplicationDiff(diff: ReplicationInventoryDiff): void {
  const collision = diff.collisions[0];
  if (collision !== undefined) throw new ReplicationRecordCollisionError(collision);
}

export async function exportSemanticReplicationRecords(
  store: SemanticStateStore,
): Promise<ReplicationRecord[]> {
  const snapshot = await store.snapshot();
  const pending: Promise<ReplicationRecord>[] = [];
  for (const entity of snapshot.entities) {
    pending.push(createReplicationRecord({
      kind: "semantic-entity",
      recordId: entity.entityId,
      payload: semanticEntityJson(entity),
    }));
  }
  for (const alias of snapshot.aliases) {
    pending.push(createReplicationRecord({
      kind: "semantic-alias",
      recordId: alias.id,
      payload: entityAliasJson(alias),
    }));
  }
  for (const observation of snapshot.observations) {
    pending.push(createReplicationRecord({
      kind: "semantic-observation",
      recordId: observation.id,
      payload: temporalObservationJson(observation),
    }));
  }
  for (const relation of snapshot.relations) {
    pending.push(createReplicationRecord({
      kind: "semantic-relation",
      recordId: relation.id,
      payload: temporalRelationJson(relation),
    }));
  }
  for (const retraction of snapshot.retractions) {
    pending.push(createReplicationRecord({
      kind: "semantic-retraction",
      recordId: retraction.id,
      payload: semanticRetractionJson(retraction),
    }));
  }
  return (await Promise.all(pending)).toSorted(descriptorOrder);
}

export async function exportArtifactReplicationRecords(
  store: ArtifactStore,
): Promise<ReplicationRecord[]> {
  const snapshot = await store.snapshot();
  return (await Promise.all(snapshot.mutations.map((mutation) => createReplicationRecord({
    kind: "artifact-mutation",
    recordId: mutation.id,
    payload: artifactMutationJson(mutation),
  })))).toSorted(descriptorOrder);
}

function assertRecordIdentity(record: ReplicationRecord): void {
  assertRecordKeyIdentity(record);
}

async function assertPayloadDigest(record: ReplicationRecord): Promise<void> {
  const canonical = canonicalReplicationPayload(record.kind, record.payload);
  if (canonical.recordId !== record.recordId || canonical.payload !== record.payload) {
    throw new InvalidReplicationRecordError(`Replication record ${record.key} payload is not canonical`);
  }
  const bytes = utf8Bytes(record.payload);
  const digest = `sha256:${await sha256(bytes)}`;
  const fingerprint = await replicationRecordFingerprint(record.key, record.payloadDigest);
  if (
    digest !== record.payloadDigest
    || fingerprint !== record.fingerprint
    || bytes.byteLength !== record.payloadBytes
  ) {
    throw new InvalidReplicationRecordError(`Replication record ${record.key} payload integrity mismatch`);
  }
}

type MutableSemanticStateBatch = {
  entities: NonNullable<SemanticStateBatch["entities"]>[number][];
  aliases: NonNullable<SemanticStateBatch["aliases"]>[number][];
  observations: NonNullable<SemanticStateBatch["observations"]>[number][];
  relations: NonNullable<SemanticStateBatch["relations"]>[number][];
  retractions: NonNullable<SemanticStateBatch["retractions"]>[number][];
};

function assertPayloadRecordId(
  actual: string,
  expected: string,
  label: string,
): void {
  if (actual !== expected) {
    throw new InvalidReplicationRecordError(`${label} recordId mismatch`);
  }
}

function appendSemanticRecordToBatch(
  batch: MutableSemanticStateBatch,
  record: ReplicationRecord,
): void {
  switch (record.kind) {
    case "semantic-entity": {
      const value = parseSemanticEntityJson(record.payload);
      assertPayloadRecordId(value.entityId, record.recordId, "Entity");
      batch.entities.push(value);
      return;
    }
    case "semantic-alias": {
      const value = parseEntityAliasJson(record.payload);
      assertPayloadRecordId(value.id, record.recordId, "Alias");
      batch.aliases.push(value);
      return;
    }
    case "semantic-observation": {
      const value = parseTemporalObservationJson(record.payload);
      assertPayloadRecordId(value.id, record.recordId, "Observation");
      batch.observations.push(value);
      return;
    }
    case "semantic-relation": {
      const value = parseTemporalRelationJson(record.payload);
      assertPayloadRecordId(value.id, record.recordId, "Relation");
      batch.relations.push(value);
      return;
    }
    case "semantic-retraction": {
      const value = parseSemanticRetractionJson(record.payload);
      assertPayloadRecordId(value.id, record.recordId, "Retraction");
      batch.retractions.push(value);
      return;
    }
    case "artifact-mutation":
      throw new InvalidReplicationRecordError("Artifact mutation cannot be applied to SemanticStateStore");
  }
}

export async function applySemanticReplicationRecords(
  store: SemanticStateStore,
  records: readonly ReplicationRecord[],
  options: ReplicationApplyOptions = {},
): Promise<void> {
  assertApplyBatchBound(records, options);
  const batch: MutableSemanticStateBatch = {
    entities: [],
    aliases: [],
    observations: [],
    relations: [],
    retractions: [],
  };

  for (const record of [...records].toSorted(descriptorOrder)) {
    assertRecordIdentity(record);
    await assertPayloadDigest(record);
    appendSemanticRecordToBatch(batch, record);
  }
  await store.append(batch);
}

export async function applyArtifactReplicationRecords(
  store: ArtifactStore,
  records: readonly ReplicationRecord[],
  options: ReplicationApplyOptions = {},
): Promise<number> {
  assertApplyBatchBound(records, options);
  const mutations: ArtifactMutation[] = [];
  for (const record of [...records].toSorted(descriptorOrder)) {
    assertRecordIdentity(record);
    await assertPayloadDigest(record);
    if (record.kind !== "artifact-mutation") {
      throw new InvalidReplicationRecordError(`${record.kind} cannot be applied to ArtifactStore`);
    }
    const mutation = parseArtifactMutationJson(record.payload);
    if (mutation.id !== record.recordId) {
      throw new InvalidReplicationRecordError("Artifact mutation recordId mismatch");
    }
    mutations.push(mutation);
  }
  return store.append(mutations);
}

function requiredArtifactBlobsFromValidatedRecords(
  records: readonly ReplicationRecord[],
): RequiredArtifactBlob[] {
  const byDigest = new Map<ArtifactDigest, { size: number; mediaTypes: Set<string> }>();
  for (const record of records) {
    if (record.kind !== "artifact-mutation") continue;
    const mutation = parseArtifactMutationJson(record.payload);
    if (mutation.kind !== "upsert") continue;
    const existing = byDigest.get(mutation.blob.digest);
    if (existing !== undefined) {
      if (existing.size !== mutation.blob.size) {
        throw new InvalidReplicationRecordError(`Artifact digest ${mutation.blob.digest} has conflicting sizes`);
      }
      existing.mediaTypes.add(mutation.blob.mediaType);
      continue;
    }
    byDigest.set(mutation.blob.digest, {
      size: mutation.blob.size,
      mediaTypes: new Set([mutation.blob.mediaType]),
    });
  }
  return [...byDigest.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([digest, value]) => ({
      digest,
      size: value.size,
      mediaTypes: [...value.mediaTypes].toSorted((left, right) => left.localeCompare(right)),
    }));
}

export async function requiredArtifactBlobs(
  records: readonly ReplicationRecord[],
): Promise<RequiredArtifactBlob[]> {
  for (const record of records) {
    assertRecordIdentity(record);
    await assertPayloadDigest(record);
    if (record.kind !== "artifact-mutation") {
      throw new InvalidReplicationRecordError(`${record.kind} is not artifact replication metadata`);
    }
  }
  return requiredArtifactBlobsFromValidatedRecords(records);
}

export async function missingArtifactBlobs(
  store: ArtifactStore,
  records: readonly ReplicationRecord[],
): Promise<RequiredArtifactBlob[]> {
  const missing: RequiredArtifactBlob[] = [];
  for (const blob of await requiredArtifactBlobs(records)) {
    const local = await store.headBlob(blob.digest);
    if (local === undefined) {
      missing.push(blob);
      continue;
    }
    if (local.size !== blob.size) {
      throw new InvalidReplicationRecordError(`Local artifact blob ${blob.digest} has conflicting size`);
    }
  }
  return missing;
}

async function targetAlreadyHasBlob(
  target: ArtifactStore,
  blob: RequiredArtifactBlob,
): Promise<boolean> {
  const existing = await target.headBlob(blob.digest);
  if (existing === undefined) return false;
  if (existing.size !== blob.size) {
    throw new InvalidReplicationRecordError(`Target blob ${blob.digest} has conflicting size`);
  }
  return true;
}

function replicationBlobReadLimit(blob: RequiredArtifactBlob, maxBlobBytes?: number): number {
  const maxBytes = maxBlobBytes ?? blob.size;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < blob.size) {
    throw new RangeError(
      `Artifact blob ${blob.digest} requires ${blob.size} bytes but maxBlobBytes is ${maxBytes}`,
    );
  }
  return maxBytes;
}

async function readVerifiedSourceBlob(
  source: ArtifactStore,
  blob: RequiredArtifactBlob,
  maxBlobBytes?: number,
): Promise<Uint8Array> {
  const maxBytes = replicationBlobReadLimit(blob, maxBlobBytes);
  const read = await source.readBlobRange(blob.digest, {
    offset: 0,
    length: blob.size,
    maxBytes,
  });
  if (!read.complete || read.offset !== 0 || read.bytes.byteLength !== blob.size) {
    throw new InvalidReplicationRecordError(`Source blob ${blob.digest} did not return complete content`);
  }
  const sourceDigest = `sha256:${await sha256(read.bytes)}`;
  if (sourceDigest !== blob.digest) {
    throw new InvalidReplicationRecordError(`Source blob ${blob.digest} failed content digest verification`);
  }
  return read.bytes;
}

async function installVerifiedTargetBlob(
  target: ArtifactStore,
  blob: RequiredArtifactBlob,
  bytes: Uint8Array,
): Promise<void> {
  const mediaType = blob.mediaTypes[0];
  if (mediaType === undefined) {
    throw new InvalidReplicationRecordError(`Blob ${blob.digest} has no media type`);
  }
  const installed = await target.putBlob(bytes, mediaType);
  if (installed.digest !== artifactDigest(blob.digest) || installed.size !== blob.size) {
    throw new InvalidReplicationRecordError(
      `Transferred blob ${blob.digest} failed target integrity verification`,
    );
  }
}

export async function copyMissingArtifactBlobs(input: {
  readonly source: ArtifactStore;
  readonly target: ArtifactStore;
  readonly records: readonly ReplicationRecord[];
  readonly maxBlobBytes?: number;
}): Promise<ArtifactBlobTransferResult> {
  const required = await requiredArtifactBlobs(input.records);
  const transferredDigests: ArtifactDigest[] = [];
  const skippedDigests: ArtifactDigest[] = [];
  let transferredBytes = 0;
  for (const blob of required) {
    if (await targetAlreadyHasBlob(input.target, blob)) {
      skippedDigests.push(blob.digest);
      continue;
    }
    const bytes = await readVerifiedSourceBlob(input.source, blob, input.maxBlobBytes);
    await installVerifiedTargetBlob(input.target, blob, bytes);
    transferredDigests.push(blob.digest);
    transferredBytes += blob.size;
  }
  return { transferredDigests, skippedDigests, transferredBytes };
}

export async function mergeReplicationRecordSets(
  ...sets: readonly (readonly ReplicationRecord[])[]
): Promise<ReplicationRecord[]> {
  const merged = new Map<ReplicationRecordKey, ReplicationRecord>();
  for (const set of sets) {
    for (const record of set) {
      assertRecordIdentity(record);
      await assertPayloadDigest(record);
      const existing = merged.get(record.key);
      if (existing === undefined) {
        merged.set(record.key, record);
        continue;
      }
      assertSameRecordEnvelope(existing, record);
    }
  }
  return [...merged.values()].toSorted(descriptorOrder);
}

export function recordsByKeys(
  records: readonly ReplicationRecord[],
  keys: readonly ReplicationRecordKey[],
): ReplicationRecord[] {
  const byKey = new Map<ReplicationRecordKey, ReplicationRecord>();
  for (const record of records) {
    assertRecordIdentity(record);
    const existing = byKey.get(record.key);
    if (existing !== undefined) {
      assertSameRecordEnvelope(existing, record);
      continue;
    }
    byKey.set(record.key, record);
  }
  return [...keys]
    .toSorted((left, right) => left.localeCompare(right))
    .map((key) => {
      const record = byKey.get(key);
      if (record === undefined) throw new InvalidReplicationRecordError(`Missing replication record ${key}`);
      return record;
    });
}
