import type { AccessDecision, AccessPrincipal } from "@ssrl/access";
import {
  artifactResourceUri,
  artifactVersionUri,
  resolveArtifact,
  type ArtifactBlobReadResult,
  type ArtifactCatalog,
  type ArtifactCatalogCursor,
  type ArtifactResourceIdentity,
  type ArtifactStore,
  type ArtifactUpsert,
} from "@ssrl/artifact-store";

export type ArtifactAccessTarget = "current" | "version";
export type ArtifactAccessOperation = "metadata" | "read";

export interface ArtifactAccessRequest {
  readonly operation: ArtifactAccessOperation;
  readonly principal: AccessPrincipal;
  readonly target: ArtifactAccessTarget;
  readonly publicUri: string;
  readonly resource: ArtifactResourceIdentity;
  readonly mutation: ArtifactUpsert;
  readonly range?: {
    readonly offset: number;
    readonly length: number;
  };
}

export interface ArtifactAccessPolicy {
  evaluate(
    request: ArtifactAccessRequest,
  ): AccessDecision | undefined | Promise<AccessDecision | undefined>;
}

export interface ArtifactAccessEvent {
  readonly at: string;
  readonly operation: ArtifactAccessOperation;
  readonly publicUri: string;
  readonly target: ArtifactAccessTarget;
  readonly outcome: "allow" | "deny";
  readonly subject?: string;
  readonly code?: string;
  readonly offset?: number;
  readonly byteCount?: number;
}

export interface ArtifactAccessEventSink {
  emit(event: ArtifactAccessEvent): void | Promise<void>;
}

export interface ArtifactResourceDescriptor {
  readonly uri: string;
  readonly versionUri: string;
  readonly mediaType: string;
  readonly size: number;
  readonly title?: string;
  readonly effectiveAt: string;
  readonly recordedAt: string;
}

export interface ArtifactAccessPage {
  readonly resources: readonly ArtifactResourceDescriptor[];
  readonly nextCursor?: ArtifactCatalogCursor;
  readonly hasMore: boolean;
}

export interface ArtifactReadRequest {
  readonly uri: string;
  readonly principal?: AccessPrincipal;
  readonly validAt?: string;
  readonly knownAt?: string;
  readonly offset?: number;
  readonly length?: number;
  /** Optional caller-owned lower ceiling. It can never raise the gateway cap. */
  readonly maxBytes?: number;
}

export interface ArtifactReadResult extends ArtifactBlobReadResult {
  readonly resource: ArtifactResourceDescriptor;
  readonly target: ArtifactAccessTarget;
}

export interface ArtifactListRequest {
  readonly principal?: AccessPrincipal;
  readonly cursor?: ArtifactCatalogCursor;
  readonly limit?: number;
  readonly validAt?: string;
  readonly knownAt?: string;
}

export interface ArtifactAccessGatewayOptions {
  readonly store: ArtifactStore & ArtifactCatalog;
  readonly policy?: ArtifactAccessPolicy;
  readonly events?: ArtifactAccessEventSink;
  readonly maxReadBytes?: number;
  readonly maxCatalogScansPerList?: number;
  readonly now?: () => string;
}

export class ArtifactAccessDeniedError extends Error {
  constructor(readonly code: string, readonly operation: ArtifactAccessOperation) {
    super(`Artifact access denied: ${code}`);
    this.name = "ArtifactAccessDeniedError";
  }
}

export class ArtifactAccessNotFoundError extends Error {
  constructor() {
    super("Artifact resource was not found");
    this.name = "ArtifactAccessNotFoundError";
  }
}

export class ArtifactReadTooLargeError extends Error {
  constructor(readonly requestedBytes: number, readonly maxBytes: number) {
    super(`Artifact read requires ${requestedBytes} bytes but gateway max is ${maxBytes}`);
    this.name = "ArtifactReadTooLargeError";
  }
}

export class ArtifactCatalogScanLimitError extends Error {
  constructor(readonly maxScans: number) {
    super(`Artifact catalog scan exceeded ${maxScans} entries`);
    this.name = "ArtifactCatalogScanLimitError";
  }
}

function gatewayLimit(value: number, label: string): number {
  const valid = Number.isSafeInteger(value) && value >= 1;
  if (!valid) throw new RangeError(`Artifact gateway ${label} must be >= 1`);
  return value;
}

function gatewayTime(value: string, label: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`Invalid artifact gateway ${label}`);
  return parsed.toISOString();
}

function descriptor(
  resourceUri: string,
  mutation: ArtifactUpsert,
): Promise<ArtifactResourceDescriptor> {
  return artifactVersionUri(mutation).then((versionUri) => ({
    uri: resourceUri,
    versionUri,
    mediaType: mutation.blob.mediaType,
    size: mutation.blob.size,
    ...(mutation.title === undefined ? {} : { title: mutation.title }),
    effectiveAt: mutation.effectiveAt,
    recordedAt: mutation.recordedAt,
  }));
}

function isCurrentResourceUri(uri: string): boolean {
  return uri.startsWith("ssrl://artifact/resource/sha256/");
}

function isVersionUri(uri: string): boolean {
  return uri.startsWith("ssrl://artifact/version/sha256/");
}

export class ArtifactAccessGateway {
  readonly #store: ArtifactStore & ArtifactCatalog;
  readonly #policy: ArtifactAccessPolicy | undefined;
  readonly #events: ArtifactAccessEventSink | undefined;
  readonly #maxReadBytes: number;
  readonly #maxCatalogScansPerList: number;
  readonly #now: () => string;

  constructor(options: ArtifactAccessGatewayOptions) {
    this.#store = options.store;
    this.#policy = options.policy;
    this.#events = options.events;
    this.#maxReadBytes = gatewayLimit(options.maxReadBytes ?? 256 * 1024, "maxReadBytes");
    this.#maxCatalogScansPerList = gatewayLimit(
      options.maxCatalogScansPerList ?? 10_000,
      "maxCatalogScansPerList",
    );
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  #principal(principal: AccessPrincipal | undefined, operation: ArtifactAccessOperation): AccessPrincipal | undefined {
    if (this.#policy === undefined) return principal;
    if (principal !== undefined) return principal;
    throw new ArtifactAccessDeniedError("principal-required", operation);
  }

  async #emit(event: Omit<ArtifactAccessEvent, "at">): Promise<void> {
    if (this.#events === undefined) return;
    await this.#events.emit({ at: gatewayTime(this.#now(), "artifact access event time"), ...event });
  }

  async #authorization(input: {
    readonly operation: ArtifactAccessOperation;
    readonly principal: AccessPrincipal | undefined;
    readonly target: ArtifactAccessTarget;
    readonly publicUri: string;
    readonly mutation: ArtifactUpsert;
    readonly range?: { readonly offset: number; readonly length: number };
  }): Promise<AccessDecision> {
    if (this.#policy === undefined) return { effect: "allow" };
    const actor = this.#principal(input.principal, input.operation)!;
    const decision = await this.#policy.evaluate({
      operation: input.operation,
      principal: actor,
      target: input.target,
      publicUri: input.publicUri,
      resource: input.mutation.resource,
      mutation: input.mutation,
      ...(input.range === undefined ? {} : { range: input.range }),
    }) ?? { effect: "deny", code: "no-matching-policy-rule" };
    if (decision.effect === "allow") return decision;
    await this.#emit({
      operation: input.operation,
      publicUri: input.publicUri,
      target: input.target,
      outcome: "deny",
      ...(input.principal === undefined ? {} : { subject: input.principal.subject }),
      code: decision.code,
    });
    return decision;
  }

  async #currentMutation(
    resourceUri: string,
    validAt: string,
    knownAt: string,
  ): Promise<ArtifactUpsert | undefined> {
    const resource = await this.#store.artifactResourceByUri(resourceUri);
    if (resource === undefined) return undefined;
    const resolved = resolveArtifact({
      resource,
      mutations: await this.#store.mutationsForResource(resource),
      validAt,
      knownAt,
    });
    return resolved.status === "present" ? resolved.mutation : undefined;
  }

  async #versionMutation(versionUri: string): Promise<ArtifactUpsert | undefined> {
    const mutation = await this.#store.artifactVersionByUri(versionUri);
    return mutation?.kind === "upsert" ? mutation : undefined;
  }

  async #resolveReadTarget(request: ArtifactReadRequest): Promise<{
    readonly target: ArtifactAccessTarget;
    readonly publicUri: string;
    readonly resourceUri: string;
    readonly mutation: ArtifactUpsert;
  }> {
    const now = gatewayTime(this.#now(), "artifact access time");
    if (isCurrentResourceUri(request.uri)) {
      const mutation = await this.#currentMutation(
        request.uri,
        gatewayTime(request.validAt ?? now, "artifact validAt"),
        gatewayTime(request.knownAt ?? now, "artifact knownAt"),
      );
      if (mutation === undefined) throw new ArtifactAccessNotFoundError();
      return { target: "current", publicUri: request.uri, resourceUri: request.uri, mutation };
    }
    if (isVersionUri(request.uri)) {
      const mutation = await this.#versionMutation(request.uri);
      if (mutation === undefined) throw new ArtifactAccessNotFoundError();
      return {
        target: "version",
        publicUri: request.uri,
        resourceUri: await artifactResourceUri(mutation.resource),
        mutation,
      };
    }
    throw new ArtifactAccessNotFoundError();
  }

  async #listedDescriptor(
    uri: string,
    principal: AccessPrincipal | undefined,
    validAt: string,
    knownAt: string,
  ): Promise<ArtifactResourceDescriptor | undefined> {
    const mutation = await this.#currentMutation(uri, validAt, knownAt);
    if (mutation === undefined) return undefined;
    const access = await this.#authorization({
      operation: "metadata",
      principal,
      target: "current",
      publicUri: uri,
      mutation,
    });
    if (access.effect === "deny") return undefined;
    const resource = await descriptor(uri, mutation);
    await this.#emit({
      operation: "metadata",
      publicUri: uri,
      target: "current",
      outcome: "allow",
      ...(principal === undefined ? {} : { subject: principal.subject }),
    });
    return resource;
  }

  async list(request: ArtifactListRequest = {}): Promise<ArtifactAccessPage> {
    const principal = this.#principal(request.principal, "metadata");
    const limit = gatewayLimit(request.limit ?? 100, "artifact access list limit");
    if (limit > 1_000) throw new RangeError("artifact access list limit must not exceed 1000");
    const now = gatewayTime(this.#now(), "artifact access time");
    const validAt = gatewayTime(request.validAt ?? now, "artifact validAt");
    const knownAt = gatewayTime(request.knownAt ?? now, "artifact knownAt");
    const resources: ArtifactResourceDescriptor[] = [];
    let cursor = request.cursor;
    let hasMore = true;
    let scans = 0;

    while (resources.length < limit && hasMore) {
      scans += 1;
      if (scans > this.#maxCatalogScansPerList) {
        throw new ArtifactCatalogScanLimitError(this.#maxCatalogScansPerList);
      }
      const page = await this.#store.listArtifactResources({
        ...(cursor === undefined ? {} : { cursor }),
        limit: 1,
      });
      const candidate = page.resources[0];
      cursor = page.nextCursor ?? cursor;
      hasMore = page.hasMore;
      if (candidate === undefined) break;
      const visible = await this.#listedDescriptor(candidate.uri, principal, validAt, knownAt);
      if (visible !== undefined) resources.push(visible);
    }

    return {
      resources,
      ...(hasMore && cursor !== undefined ? { nextCursor: cursor } : {}),
      hasMore,
    };
  }

  async read(request: ArtifactReadRequest): Promise<ArtifactReadResult> {
    const principal = this.#principal(request.principal, "read");
    const target = await this.#resolveReadTarget(request);
    const offset = request.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError("artifact read offset must be a non-negative safe integer");
    }
    if (request.length !== undefined
      && (!Number.isSafeInteger(request.length) || request.length < 0)) {
      throw new RangeError("artifact read length must be a non-negative safe integer");
    }
    const requestedLength = request.length
      ?? Math.max(0, target.mutation.blob.size - offset);
    const range = { offset, length: requestedLength };
    const access = await this.#authorization({
      operation: "read",
      principal,
      target: target.target,
      publicUri: target.publicUri,
      mutation: target.mutation,
      range,
    });
    if (access.effect === "deny") {
      throw new ArtifactAccessDeniedError(access.code, "read");
    }

    if (offset > target.mutation.blob.size || offset + requestedLength > target.mutation.blob.size) {
      throw new RangeError("artifact read range exceeds blob size");
    }
    const callerCap = request.maxBytes === undefined
      ? this.#maxReadBytes
      : gatewayLimit(request.maxBytes, "artifact caller maxBytes");
    const effectiveCap = Math.min(this.#maxReadBytes, callerCap);
    if (requestedLength > effectiveCap) {
      throw new ArtifactReadTooLargeError(requestedLength, effectiveCap);
    }

    const blob = await this.#store.readBlobRange(target.mutation.blob.digest, {
      offset,
      length: requestedLength,
      maxBytes: effectiveCap,
    });
    await this.#emit({
      operation: "read",
      publicUri: target.publicUri,
      target: target.target,
      outcome: "allow",
      ...(principal === undefined ? {} : { subject: principal.subject }),
      offset,
      byteCount: blob.bytes.byteLength,
    });
    return {
      ...blob,
      resource: await descriptor(target.resourceUri, target.mutation),
      target: target.target,
    };
  }
}
