import {
  normalizeAccessPrincipal,
  type AccessDecision,
  type AccessPrincipal,
} from "@ssrl/access";
import {
  applyArtifactReplicationRecords,
  applySemanticReplicationRecords,
  mergeReplicationRecordSets,
  replicationDescriptor,
  replicationRecordEnvelopeBytes,
  verifyReplicationRecord,
  type ReplicationRecord,
  type ReplicationRecordKey,
} from "@ssrl/replication";
import {
  buildPrefixMerkleIndex,
  type PrefixMerkleBits,
} from "@ssrl/replication/merkle";
import {
  FrozenPrefixMerkleView,
  type ReconciliationEndpoint,
  type ReconciliationViewInfo,
} from "@ssrl/replication/sync";

export type ReplicationAccessOperation = "projection:read" | "record:read" | "record:apply";

export interface ReplicationAccessRequest {
  readonly operation: ReplicationAccessOperation;
  readonly principal: AccessPrincipal;
  readonly projectionId: string;
  readonly record: ReplicationRecord;
  readonly kind: ReplicationRecord["kind"];
  readonly key: ReplicationRecordKey;
  readonly recordId: string;
  readonly payloadDigest: string;
}

export interface ReplicationAccessPolicy {
  evaluate(
    request: ReplicationAccessRequest,
  ): AccessDecision | undefined | Promise<AccessDecision | undefined>;
}

export type ReplicationAccessAuditOperation =
  | "projection.open"
  | "record.read"
  | "record.apply"
  | "view.expired"
  | "view.revoked";

export interface ReplicationAccessEvent {
  readonly at: string;
  readonly operation: ReplicationAccessAuditOperation;
  readonly outcome: "allow" | "deny";
  readonly subject: string;
  readonly projectionId: string;
  readonly code?: string;
  readonly recordKind?: ReplicationRecord["kind"];
  readonly recordKey?: ReplicationRecordKey;
}

export interface ReplicationAccessEventSink {
  emit(event: ReplicationAccessEvent): void;
}

export interface ReplicationRecordSource {
  records(): readonly ReplicationRecord[] | Promise<readonly ReplicationRecord[]>;
}

/** Small mutable source useful for local services/tests; transport and persistence remain separate concerns. */
export class MutableReplicationRecordSource implements ReplicationRecordSource {
  #records: ReplicationRecord[];

  constructor(records: readonly ReplicationRecord[] = []) {
    this.#records = [...records];
  }

  records(): readonly ReplicationRecord[] {
    return [...this.#records];
  }

  replace(records: readonly ReplicationRecord[]): void {
    this.#records = [...records];
  }
}

export interface ReplicationProjectionAccounting {
  readonly sourceRecordsScanned: number;
  readonly policyEvaluations: number;
  readonly allowedDescriptors: number;
}

export interface AuthorizedProjectionOpenResult {
  readonly view: ReconciliationViewInfo;
  readonly projectionId: string;
  readonly policyVersion: string;
  readonly expiresAt: string;
  readonly accounting: ReplicationProjectionAccounting;
}

export interface ReplicationAccessGatewayOptions {
  readonly source: ReplicationRecordSource;
  readonly policy: ReplicationAccessPolicy;
  readonly policyVersion: () => string;
  /** Server-configured logical projection ids. */
  readonly projectionIds: readonly string[];
  readonly events?: ReplicationAccessEventSink;
  readonly maxSourceRecords?: number;
  readonly maxProjectionRecords?: number;
  readonly maxPolicyEvaluations?: number;
  readonly maxReadRecords?: number;
  readonly maxReadBytes?: number;
  readonly maxApplyRecords?: number;
  readonly maxApplyBytes?: number;
  readonly maxLeaseMs?: number;
  readonly now?: () => string;
}

export class ReplicationAccessLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplicationAccessLimitError";
  }
}

export class ReplicationRecordUnavailableError extends Error {
  constructor() {
    super("Requested replication record is unavailable");
    this.name = "ReplicationRecordUnavailableError";
  }
}

export type ReplicationAuthorizationViewErrorCode =
  | "unknown"
  | "principal-mismatch"
  | "projection-mismatch"
  | "expired"
  | "revoked";

export class ReplicationAuthorizationViewError extends Error {
  constructor(readonly code: ReplicationAuthorizationViewErrorCode) {
    super("Replication authorization view is unavailable");
    this.name = "ReplicationAuthorizationViewError";
  }
}

export class ReplicationApplyDeniedError extends Error {
  constructor(readonly code: string) {
    super("Replication apply is not authorized");
    this.name = "ReplicationApplyDeniedError";
  }
}

interface AuthorizedViewState {
  readonly view: FrozenPrefixMerkleView;
  readonly principal: AccessPrincipal;
  readonly projectionId: string;
  readonly policyVersion: string;
  readonly expiresAt: string;
  readonly records: ReadonlyMap<ReplicationRecordKey, ReplicationRecord>;
}

const DEFAULT_MAX_SOURCE_RECORDS = 10_000;
const DEFAULT_MAX_PROJECTION_RECORDS = 10_000;
const DEFAULT_MAX_POLICY_EVALUATIONS = 10_000;
const DEFAULT_MAX_READ_RECORDS = 256;
const DEFAULT_MAX_READ_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_APPLY_RECORDS = 1_000;
const DEFAULT_MAX_APPLY_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_LEASE_MS = 5 * 60 * 1_000;
const MAX_CONFIGURED_COUNT = 1_000_000;
const MAX_CONFIGURED_BYTES = 1024 * 1024 * 1024;
const MAX_LEASE_MS = 60 * 60 * 1_000;

type SemanticApplyStore = Parameters<typeof applySemanticReplicationRecords>[0];
type ArtifactApplyStore = Parameters<typeof applyArtifactReplicationRecords>[0];

function positiveLimit(value: number, label: string, max = MAX_CONFIGURED_COUNT): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${label} must be an integer between 1 and ${max}`);
  }
  return value;
}

function requestLimit(
  requested: number | undefined,
  configured: number,
  label: string,
): number {
  if (requested === undefined) return configured;
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > configured) {
    throw new ReplicationAccessLimitError(`${label} exceeds the configured maximum`);
  }
  return requested;
}

function projectionId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError("projectionId must not be empty");
  return normalized;
}

function policyVersion(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError("policyVersion must not be empty");
  return normalized;
}

function normalizedTime(value: string, label: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new TypeError(`${label} must be a valid timestamp`);
  return new Date(millis).toISOString();
}

function samePrincipal(left: AccessPrincipal, right: AccessPrincipal): boolean {
  return left.subject === right.subject
    && left.scopes.length === right.scopes.length
    && left.scopes.every((scope, index) => scope === right.scopes[index]);
}

function accessRequest(
  operation: ReplicationAccessOperation,
  principal: AccessPrincipal,
  projection: string,
  record: ReplicationRecord,
): ReplicationAccessRequest {
  return {
    operation,
    principal,
    projectionId: projection,
    record,
    kind: record.kind,
    key: record.key,
    recordId: record.recordId,
    payloadDigest: record.payloadDigest,
  };
}

async function authorize(
  policy: ReplicationAccessPolicy,
  request: ReplicationAccessRequest,
): Promise<AccessDecision> {
  return await policy.evaluate(request) ?? {
    effect: "deny",
    code: "no-matching-policy-rule",
  };
}

function emit(
  sink: ReplicationAccessEventSink | undefined,
  now: () => string,
  event: Omit<ReplicationAccessEvent, "at">,
): void {
  if (sink === undefined) return;
  sink.emit({ at: normalizedTime(now(), "replication access audit time"), ...event });
}

function emitBestEffort(
  sink: ReplicationAccessEventSink | undefined,
  now: () => string,
  event: Omit<ReplicationAccessEvent, "at">,
): void {
  try {
    emit(sink, now, event);
  } catch {
    // Denial/error shape must remain stable even when audit infrastructure is unavailable.
  }
}

function sortedUniqueKeys(keys: readonly ReplicationRecordKey[]): ReplicationRecordKey[] {
  return [...new Set(keys)].toSorted((left, right) => left.localeCompare(right));
}

interface ReplicationApplyRequest {
  readonly principal: AccessPrincipal;
  readonly projectionId: string;
  readonly records: readonly ReplicationRecord[];
  readonly maxRecords?: number;
  readonly maxBytes?: number;
}

interface AuthorizedApplyBatch {
  readonly principal: AccessPrincipal;
  readonly projection: string;
  readonly records: readonly ReplicationRecord[];
}

function emitRecordEvent(
  sink: ReplicationAccessEventSink | undefined,
  now: () => string,
  input: {
    readonly operation: "record.read" | "record.apply";
    readonly outcome: "allow" | "deny";
    readonly principal: AccessPrincipal;
    readonly projectionId: string;
    readonly record?: ReplicationRecord;
    readonly recordKey?: ReplicationRecordKey;
    readonly code?: string;
    readonly bestEffort?: boolean;
  },
): void {
  const event: Omit<ReplicationAccessEvent, "at"> = {
    operation: input.operation,
    outcome: input.outcome,
    subject: input.principal.subject,
    projectionId: input.projectionId,
    ...(input.code === undefined ? {} : { code: input.code }),
    ...(input.record === undefined ? {} : {
      recordKind: input.record.kind,
      recordKey: input.record.key,
    }),
    ...(input.recordKey === undefined ? {} : { recordKey: input.recordKey }),
  };
  if (input.bestEffort === true) {
    emitBestEffort(sink, now, event);
    return;
  }
  emit(sink, now, event);
}

function emitAllowedApplyBatch(
  sink: ReplicationAccessEventSink | undefined,
  now: () => string,
  batch: AuthorizedApplyBatch,
): void {
  for (const record of batch.records) {
    emitRecordEvent(sink, now, {
      operation: "record.apply",
      outcome: "allow",
      principal: batch.principal,
      projectionId: batch.projection,
      record,
    });
  }
}

export class ReplicationAccessGateway {
  readonly #source: ReplicationRecordSource;
  readonly #policy: ReplicationAccessPolicy;
  readonly #policyVersion: () => string;
  readonly #projectionIds: ReadonlySet<string>;
  readonly #events: ReplicationAccessEventSink | undefined;
  readonly #maxSourceRecords: number;
  readonly #maxProjectionRecords: number;
  readonly #maxPolicyEvaluations: number;
  readonly #maxReadRecords: number;
  readonly #maxReadBytes: number;
  readonly #maxApplyRecords: number;
  readonly #maxApplyBytes: number;
  readonly #maxLeaseMs: number;
  readonly #now: () => string;
  readonly #views = new Map<string, AuthorizedViewState>();

  constructor(options: ReplicationAccessGatewayOptions) {
    this.#source = options.source;
    this.#policy = options.policy;
    this.#policyVersion = options.policyVersion;
    const projectionIds = options.projectionIds.map(projectionId);
    if (projectionIds.length === 0) throw new TypeError("At least one projectionId must be configured");
    if (new Set(projectionIds).size !== projectionIds.length) {
      throw new TypeError("Configured projectionIds must be unique");
    }
    this.#projectionIds = new Set(projectionIds);
    this.#events = options.events;
    this.#maxSourceRecords = positiveLimit(
      options.maxSourceRecords ?? DEFAULT_MAX_SOURCE_RECORDS,
      "maxSourceRecords",
    );
    this.#maxProjectionRecords = positiveLimit(
      options.maxProjectionRecords ?? DEFAULT_MAX_PROJECTION_RECORDS,
      "maxProjectionRecords",
    );
    this.#maxPolicyEvaluations = positiveLimit(
      options.maxPolicyEvaluations ?? DEFAULT_MAX_POLICY_EVALUATIONS,
      "maxPolicyEvaluations",
    );
    this.#maxReadRecords = positiveLimit(
      options.maxReadRecords ?? DEFAULT_MAX_READ_RECORDS,
      "maxReadRecords",
    );
    this.#maxReadBytes = positiveLimit(
      options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES,
      "maxReadBytes",
      MAX_CONFIGURED_BYTES,
    );
    this.#maxApplyRecords = positiveLimit(
      options.maxApplyRecords ?? DEFAULT_MAX_APPLY_RECORDS,
      "maxApplyRecords",
      10_000,
    );
    this.#maxApplyBytes = positiveLimit(
      options.maxApplyBytes ?? DEFAULT_MAX_APPLY_BYTES,
      "maxApplyBytes",
      MAX_CONFIGURED_BYTES,
    );
    this.#maxLeaseMs = positiveLimit(
      options.maxLeaseMs ?? DEFAULT_MAX_LEASE_MS,
      "maxLeaseMs",
      MAX_LEASE_MS,
    );
    this.#now = options.now ?? (() => new Date().toISOString());
    policyVersion(this.#policyVersion());
  }

  #configuredProjection(value: string): string {
    const normalized = projectionId(value);
    if (!this.#projectionIds.has(normalized)) {
      throw new ReplicationAuthorizationViewError("projection-mismatch");
    }
    return normalized;
  }

  #authorizedView(
    principalInput: AccessPrincipal,
    projectionInput: string,
    viewId: string,
  ): AuthorizedViewState {
    const state = this.#views.get(viewId);
    if (state === undefined) throw new ReplicationAuthorizationViewError("unknown");
    const principal = normalizeAccessPrincipal(principalInput);
    if (!samePrincipal(principal, state.principal)) {
      throw new ReplicationAuthorizationViewError("principal-mismatch");
    }
    const projection = this.#configuredProjection(projectionInput);
    if (projection !== state.projectionId) {
      throw new ReplicationAuthorizationViewError("projection-mismatch");
    }
    const now = Date.parse(normalizedTime(this.#now(), "replication authorization time"));
    if (now >= Date.parse(state.expiresAt)) {
      emitBestEffort(this.#events, this.#now, {
        operation: "view.expired",
        outcome: "deny",
        subject: principal.subject,
        projectionId: projection,
        code: "expired",
      });
      throw new ReplicationAuthorizationViewError("expired");
    }
    if (policyVersion(this.#policyVersion()) !== state.policyVersion) {
      emitBestEffort(this.#events, this.#now, {
        operation: "view.revoked",
        outcome: "deny",
        subject: principal.subject,
        projectionId: projection,
        code: "revoked",
      });
      throw new ReplicationAuthorizationViewError("revoked");
    }
    return state;
  }

  async openProjection(input: {
    readonly principal: AccessPrincipal;
    readonly projectionId: string;
    readonly prefixBits?: PrefixMerkleBits;
    readonly leaseMs?: number;
  }): Promise<AuthorizedProjectionOpenResult> {
    const principal = normalizeAccessPrincipal(input.principal);
    const projection = this.#configuredProjection(input.projectionId);
    const currentPolicyVersion = policyVersion(this.#policyVersion());
    const sourceRecords = await this.#source.records();
    if (sourceRecords.length > this.#maxSourceRecords) {
      throw new ReplicationAccessLimitError(
        `Projection source exceeds maxSourceRecords=${this.#maxSourceRecords}`,
      );
    }
    const records = await mergeReplicationRecordSets(sourceRecords);
    if (records.length > this.#maxPolicyEvaluations) {
      throw new ReplicationAccessLimitError(
        `Projection exceeds maxPolicyEvaluations=${this.#maxPolicyEvaluations}`,
      );
    }

    const allowed: ReplicationRecord[] = [];
    let policyEvaluations = 0;
    for (const record of records) {
      policyEvaluations += 1;
      const decision = await authorize(
        this.#policy,
        accessRequest("projection:read", principal, projection, record),
      );
      if (decision.effect === "deny") continue;
      allowed.push(record);
      if (allowed.length > this.#maxProjectionRecords) {
        throw new ReplicationAccessLimitError(
          `Authorized projection exceeds maxProjectionRecords=${this.#maxProjectionRecords}`,
        );
      }
    }

    const index = await buildPrefixMerkleIndex(
      allowed.map((record) => replicationDescriptor(record)),
      input.prefixBits === undefined ? {} : { prefixBits: input.prefixBits },
    );
    const frozen = await FrozenPrefixMerkleView.open(index);
    const view = frozen.info();
    const openedAt = Date.parse(normalizedTime(this.#now(), "replication projection open time"));
    const leaseMs = requestLimit(input.leaseMs, this.#maxLeaseMs, "leaseMs");
    const expiresAt = new Date(openedAt + leaseMs).toISOString();
    emit(this.#events, this.#now, {
      operation: "projection.open",
      outcome: "allow",
      subject: principal.subject,
      projectionId: projection,
    });
    this.#views.set(view.viewId, {
      view: frozen,
      principal,
      projectionId: projection,
      policyVersion: currentPolicyVersion,
      expiresAt,
      records: new Map(allowed.map((record) => [record.key, record])),
    });
    return {
      view,
      projectionId: projection,
      policyVersion: currentPolicyVersion,
      expiresAt,
      accounting: {
        sourceRecordsScanned: sourceRecords.length,
        policyEvaluations,
        allowedDescriptors: allowed.length,
      },
    };
  }

  endpoint(principal: AccessPrincipal, projectionInput: string): ReconciliationEndpoint {
    const projection = this.#configuredProjection(projectionInput);
    return {
      viewInfo: (viewId) => this.#authorizedView(principal, projection, viewId).view.info(),
      nodeHashes: (viewId, refs, options) => (
        this.#authorizedView(principal, projection, viewId).view.nodeHashes(refs, options)
      ),
      leafPage: (viewId, options) => (
        this.#authorizedView(principal, projection, viewId).view.leafPage(options)
      ),
    };
  }

  async readRecords(input: {
    readonly principal: AccessPrincipal;
    readonly projectionId: string;
    readonly viewId: string;
    readonly keys: readonly ReplicationRecordKey[];
    readonly maxRecords?: number;
    readonly maxBytes?: number;
  }): Promise<ReplicationRecord[]> {
    const maxRecords = requestLimit(input.maxRecords, this.#maxReadRecords, "maxRecords");
    const maxBytes = requestLimit(input.maxBytes, this.#maxReadBytes, "maxBytes");
    if (input.keys.length > maxRecords) {
      throw new ReplicationAccessLimitError(`Requested keys exceed maxRecords=${maxRecords}`);
    }
    const principal = normalizeAccessPrincipal(input.principal);
    const projection = this.#configuredProjection(input.projectionId);
    const state = this.#authorizedView(principal, projection, input.viewId);
    const result: ReplicationRecord[] = [];
    let bytes = 0;
    for (const key of sortedUniqueKeys(input.keys)) {
      const record = state.records.get(key);
      if (record === undefined) {
        emitRecordEvent(this.#events, this.#now, {
          operation: "record.read",
          outcome: "deny",
          principal,
          projectionId: projection,
          code: "record-unavailable",
          recordKey: key,
          bestEffort: true,
        });
        throw new ReplicationRecordUnavailableError();
      }
      const decision = await authorize(
        this.#policy,
        accessRequest("record:read", principal, projection, record),
      );
      if (decision.effect === "deny") {
        emitRecordEvent(this.#events, this.#now, {
          operation: "record.read",
          outcome: "deny",
          principal,
          projectionId: projection,
          code: decision.code,
          record,
          bestEffort: true,
        });
        throw new ReplicationRecordUnavailableError();
      }
      bytes += replicationRecordEnvelopeBytes(record);
      if (bytes > maxBytes) {
        throw new ReplicationAccessLimitError(`Authorized record transfer exceeds maxBytes=${maxBytes}`);
      }
      result.push({ ...record });
      emitRecordEvent(this.#events, this.#now, {
        operation: "record.read",
        outcome: "allow",
        principal,
        projectionId: projection,
        record,
      });
    }
    return result;
  }

  async #authorizedApply(input: ReplicationApplyRequest): Promise<AuthorizedApplyBatch> {
    const maxRecords = requestLimit(input.maxRecords, this.#maxApplyRecords, "maxRecords");
    const maxBytes = requestLimit(input.maxBytes, this.#maxApplyBytes, "maxBytes");
    if (input.records.length > maxRecords) {
      throw new ReplicationAccessLimitError(`Apply batch exceeds maxRecords=${maxRecords}`);
    }
    const principal = normalizeAccessPrincipal(input.principal);
    const projection = this.#configuredProjection(input.projectionId);
    const verified: ReplicationRecord[] = [];
    let bytes = 0;
    for (const record of input.records) {
      const canonical = await verifyReplicationRecord(record);
      bytes += replicationRecordEnvelopeBytes(canonical);
      if (bytes > maxBytes) {
        throw new ReplicationAccessLimitError(`Apply batch exceeds maxBytes=${maxBytes}`);
      }
      verified.push(canonical);
    }

    for (const record of verified) {
      const decision = await authorize(
        this.#policy,
        accessRequest("record:apply", principal, projection, record),
      );
      if (decision.effect === "deny") {
        emitRecordEvent(this.#events, this.#now, {
          operation: "record.apply",
          outcome: "deny",
          principal,
          projectionId: projection,
          code: decision.code,
          record,
          bestEffort: true,
        });
        throw new ReplicationApplyDeniedError(decision.code);
      }
    }
    return { principal, projection, records: verified };
  }

  async applySemantic(
    store: SemanticApplyStore,
    input: ReplicationApplyRequest,
  ): Promise<void> {
    const authorized = await this.#authorizedApply(input);
    emitAllowedApplyBatch(this.#events, this.#now, authorized);
    await applySemanticReplicationRecords(store, authorized.records, {
      maxRecords: authorized.records.length === 0 ? 1 : authorized.records.length,
    });
  }

  async applyArtifacts(
    store: ArtifactApplyStore,
    input: ReplicationApplyRequest,
  ): Promise<number> {
    const authorized = await this.#authorizedApply(input);
    emitAllowedApplyBatch(this.#events, this.#now, authorized);
    return applyArtifactReplicationRecords(store, authorized.records, {
      maxRecords: authorized.records.length === 0 ? 1 : authorized.records.length,
    });
  }
}

/** Deterministic transfer accounting helper; it intentionally makes no network/auth latency claim. */
export function replicationAccessTransferBytes(records: readonly ReplicationRecord[]): number {
  return records.reduce((total, record) => total + replicationRecordEnvelopeBytes(record), 0);
}
