import type { StateProvider } from "@ssrl/runtime";

export type ConnectorAccess = "read" | "write";
export type ConnectorRevisionMode = "none" | "opaque" | "monotonic";
export type ConnectorIdempotencyMode = "none" | "keyed";
export type AuthorityHint = "primary" | "secondary" | "replica" | "observation";

export interface ConnectorCapabilities {
  readonly read: boolean;
  readonly write: boolean;
  readonly observe: boolean;
  readonly subscribe: boolean;
  readonly revisions: ConnectorRevisionMode;
  readonly idempotency: ConnectorIdempotencyMode;
}

export interface ConnectorFieldMapping {
  readonly canonical: string;
  readonly external: string;
  readonly access: readonly ConnectorAccess[];
  readonly authorityHint?: AuthorityHint;
}

export interface ConnectorEntityMapping {
  readonly canonicalType: string;
  readonly externalType: string;
  readonly fields: readonly ConnectorFieldMapping[];
}

export interface ConnectorManifest {
  readonly schemaVersion: "0.1";
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ConnectorCapabilities;
  readonly entities: readonly ConnectorEntityMapping[];
}

export interface ManifestedStateProvider extends StateProvider {
  readonly manifest: ConnectorManifest;
}

export function validateConnectorManifest(manifest: ConnectorManifest): void {
  if (manifest.id.trim().length === 0) {
    throw new Error("Connector id must not be empty");
  }
  if (manifest.entities.length === 0) {
    throw new Error("Connector must declare at least one entity mapping");
  }

  for (const entity of manifest.entities) {
    if (entity.fields.length === 0) {
      throw new Error(`Entity mapping ${entity.canonicalType} has no fields`);
    }

    const canonical = new Set<string>();
    const external = new Set<string>();
    for (const field of entity.fields) {
      if (canonical.has(field.canonical)) {
        throw new Error(`Duplicate canonical field mapping: ${field.canonical}`);
      }
      if (external.has(field.external)) {
        throw new Error(`Duplicate external field mapping: ${field.external}`);
      }
      canonical.add(field.canonical);
      external.add(field.external);

      if (field.access.length === 0) {
        throw new Error(`Field ${field.canonical} must declare access`);
      }
      if (field.access.includes("read") && !manifest.capabilities.read) {
        throw new Error(`Field ${field.canonical} requires connector read capability`);
      }
      if (field.access.includes("write") && !manifest.capabilities.write) {
        throw new Error(`Field ${field.canonical} requires connector write capability`);
      }
    }
  }
}
