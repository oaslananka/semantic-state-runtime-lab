import { normalizeVaultEpochId, type VaultEpochId } from "@ssrl/e2e";
import {
  normalizeOpaqueReplicationTag,
  opaqueReplicationDescriptorJson,
  type EncryptedReplicationObject,
  type OpaqueReplicationDescriptor,
  type OpaqueReplicationTag,
} from "@ssrl/replication/encrypted";

export const DEFAULT_OPAQUE_OBJECT_READ_MAX_BYTES = 8 * 1024 * 1024;
export const HARD_OPAQUE_OBJECT_READ_MAX_BYTES = 128 * 1024 * 1024;
export const DEFAULT_OPAQUE_CATALOG_MAX_DESCRIPTORS = 256;
export const HARD_OPAQUE_CATALOG_MAX_DESCRIPTORS = 4_096;
export const DEFAULT_OPAQUE_CATALOG_MAX_BYTES = 1024 * 1024;
export const HARD_OPAQUE_CATALOG_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_OPAQUE_CHANGE_MAX_DESCRIPTORS = 256;
export const HARD_OPAQUE_CHANGE_MAX_DESCRIPTORS = 4_096;
export const DEFAULT_OPAQUE_CHANGE_MAX_BYTES = 1024 * 1024;
export const HARD_OPAQUE_CHANGE_MAX_BYTES = 8 * 1024 * 1024;

declare const opaqueDescriptorCatalogCursorBrand: unique symbol;
export type OpaqueDescriptorCatalogCursor = string & {
  readonly [opaqueDescriptorCatalogCursorBrand]: true;
};

declare const opaqueDescriptorChangeCursorBrand: unique symbol;
export type OpaqueDescriptorChangeCursor = string & {
  readonly [opaqueDescriptorChangeCursorBrand]: true;
};

export interface OpaqueObjectLocator {
  readonly epochId: VaultEpochId;
  readonly opaqueKey: OpaqueReplicationTag;
}

export interface OpaqueObjectInstallResult {
  readonly descriptor: OpaqueReplicationDescriptor;
  readonly inserted: boolean;
  /** Canonical encrypted-object JSON bytes stored for the committed body. */
  readonly storedBytes: number;
}

export interface OpaqueObjectReadOptions {
  readonly maxBytes?: number;
}

export interface OpaqueDescriptorCatalogRequest {
  readonly epochId: VaultEpochId;
  readonly cursor?: OpaqueDescriptorCatalogCursor;
  readonly maxDescriptors?: number;
  readonly maxBytes?: number;
}

export interface OpaqueDescriptorCatalogPage {
  readonly epochId: VaultEpochId;
  readonly descriptors: readonly OpaqueReplicationDescriptor[];
  readonly descriptorBytes: number;
  readonly hasMore: boolean;
  readonly nextCursor?: OpaqueDescriptorCatalogCursor;
}

export interface OpaqueDescriptorChangeRequest {
  readonly cursor?: OpaqueDescriptorChangeCursor;
  readonly maxDescriptors?: number;
  readonly maxBytes?: number;
}

export interface OpaqueDescriptorChangePage {
  readonly descriptors: readonly OpaqueReplicationDescriptor[];
  readonly descriptorBytes: number;
  readonly hasMore: boolean;
  /** Store-bound checkpoint cursor, including for an empty feed. */
  readonly nextCursor: OpaqueDescriptorChangeCursor;
}

export interface OpaqueReplicationObjectStore {
  install(object: EncryptedReplicationObject): Promise<OpaqueObjectInstallResult>;
  descriptor(locator: OpaqueObjectLocator): Promise<OpaqueReplicationDescriptor | undefined>;
  readObject(
    locator: OpaqueObjectLocator,
    options?: OpaqueObjectReadOptions,
  ): Promise<EncryptedReplicationObject>;
  descriptorPage(request: OpaqueDescriptorCatalogRequest): Promise<OpaqueDescriptorCatalogPage>;
  descriptorChangesAfter(
    request?: OpaqueDescriptorChangeRequest,
  ): Promise<OpaqueDescriptorChangePage>;
}

export class OpaqueReplicationObjectNotFoundError extends Error {
  constructor(readonly locator: OpaqueObjectLocator) {
    super(`Opaque replication object not found in epoch ${locator.epochId}`);
    this.name = "OpaqueReplicationObjectNotFoundError";
  }
}

export class OpaqueReplicationObjectReadLimitError extends Error {
  constructor(readonly requiredBytes: number, readonly maxBytes: number) {
    super(`Opaque replication object requires ${requiredBytes} bytes; maxBytes is ${maxBytes}`);
    this.name = "OpaqueReplicationObjectReadLimitError";
  }
}

export class OpaqueReplicationStoreCorruptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpaqueReplicationStoreCorruptionError";
  }
}

export class InvalidOpaqueDescriptorCatalogCursorError extends Error {
  constructor(readonly cursor: string) {
    super("Invalid opaque descriptor catalog cursor");
    this.name = "InvalidOpaqueDescriptorCatalogCursorError";
  }
}

export class InvalidOpaqueDescriptorChangeCursorError extends Error {
  constructor(readonly cursor: string) {
    super("Invalid opaque descriptor change cursor");
    this.name = "InvalidOpaqueDescriptorChangeCursorError";
  }
}

export class OpaqueDescriptorCatalogEntryTooLargeError extends Error {
  constructor(readonly requiredBytes: number, readonly maxBytes: number) {
    super(`Opaque descriptor requires ${requiredBytes} bytes; catalog maxBytes is ${maxBytes}`);
    this.name = "OpaqueDescriptorCatalogEntryTooLargeError";
  }
}

export class OpaqueDescriptorChangeEntryTooLargeError extends Error {
  constructor(readonly requiredBytes: number, readonly maxBytes: number) {
    super(`Opaque descriptor change requires ${requiredBytes} bytes; maxBytes is ${maxBytes}`);
    this.name = "OpaqueDescriptorChangeEntryTooLargeError";
  }
}

export function normalizeOpaqueObjectLocator(value: OpaqueObjectLocator): OpaqueObjectLocator {
  return {
    epochId: normalizeVaultEpochId(value.epochId),
    opaqueKey: normalizeOpaqueReplicationTag(value.opaqueKey, "opaque object key"),
  };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  hardMax: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > hardMax) {
    throw new RangeError(`${label} must be an integer between 1 and ${hardMax}`);
  }
  return resolved;
}

export function opaqueObjectReadLimit(value?: number): number {
  return boundedInteger(
    value,
    DEFAULT_OPAQUE_OBJECT_READ_MAX_BYTES,
    HARD_OPAQUE_OBJECT_READ_MAX_BYTES,
    "maxBytes",
  );
}

export function opaqueChangeLimits(request: OpaqueDescriptorChangeRequest = {}): {
  readonly maxDescriptors: number;
  readonly maxBytes: number;
} {
  return {
    maxDescriptors: boundedInteger(
      request.maxDescriptors,
      DEFAULT_OPAQUE_CHANGE_MAX_DESCRIPTORS,
      HARD_OPAQUE_CHANGE_MAX_DESCRIPTORS,
      "maxDescriptors",
    ),
    maxBytes: boundedInteger(
      request.maxBytes,
      DEFAULT_OPAQUE_CHANGE_MAX_BYTES,
      HARD_OPAQUE_CHANGE_MAX_BYTES,
      "maxBytes",
    ),
  };
}

export function opaqueCatalogLimits(request: OpaqueDescriptorCatalogRequest): {
  readonly epochId: VaultEpochId;
  readonly maxDescriptors: number;
  readonly maxBytes: number;
} {
  return {
    epochId: normalizeVaultEpochId(request.epochId),
    maxDescriptors: boundedInteger(
      request.maxDescriptors,
      DEFAULT_OPAQUE_CATALOG_MAX_DESCRIPTORS,
      HARD_OPAQUE_CATALOG_MAX_DESCRIPTORS,
      "maxDescriptors",
    ),
    maxBytes: boundedInteger(
      request.maxBytes,
      DEFAULT_OPAQUE_CATALOG_MAX_BYTES,
      HARD_OPAQUE_CATALOG_MAX_BYTES,
      "maxBytes",
    ),
  };
}

export async function opaqueDescriptorBytes(
  descriptor: OpaqueReplicationDescriptor,
): Promise<number> {
  return new TextEncoder().encode(await opaqueReplicationDescriptorJson(descriptor)).byteLength;
}
