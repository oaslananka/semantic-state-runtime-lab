import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { MarkdownFilesystemConnector } from "@ssrl/connector-markdown-fs";
import type { ConnectorEntityMapping } from "@ssrl/connector-sdk";
import type {
  AuthorityRule,
  ExternalBinding,
} from "@ssrl/core";
import { createRuntimeMcpServer } from "@ssrl/mcp-server";
import type { StateProvider } from "@ssrl/runtime";
import {
  InMemoryEntityRuntimeCatalog,
  RuntimeHost,
  type EntityRuntimeDefinition,
  type RuntimeAccessPolicy,
  type RuntimePrincipal,
} from "@ssrl/runtime-host";
import { SQLiteEventJournal } from "@ssrl/storage-sqlite";
import {
  loadLocalAppConfig,
  type LocalAppConfig,
  type LocalEntityBindingConfig,
  type LocalEntityConfig,
  type LocalPolicyFieldGrant,
  type LocalProviderConfig,
} from "./config.js";

function mappingFor(
  provider: LocalProviderConfig,
  binding: LocalEntityBindingConfig,
): ConnectorEntityMapping {
  const mapping = provider.manifest.entities.find(
    (candidate) => candidate.canonicalType === binding.canonicalType,
  );
  if (mapping === undefined) {
    throw new Error(
      `Provider ${provider.id} does not declare canonical type ${binding.canonicalType}`,
    );
  }
  return mapping;
}

function externalBinding(
  entity: LocalEntityConfig,
  binding: LocalEntityBindingConfig,
  provider: LocalProviderConfig,
): ExternalBinding {
  const mapping = mappingFor(provider, binding);
  return {
    entityId: entity.entityId,
    provider: provider.id,
    externalId: binding.externalId,
    fields: mapping.fields.map((field) => ({
      canonical: field.canonical,
      external: field.external,
      readable: field.access.includes("read"),
      writable: field.access.includes("write"),
    })),
  };
}

function authorityRules(entity: LocalEntityConfig): AuthorityRule[] {
  return entity.authority.map((rule) => ({
    property: rule.property,
    strategy: {
      kind: "provider",
      provider: rule.provider,
    },
  }));
}

function fieldGrant(
  config: LocalAppConfig,
  entityId: string,
  property: string,
): LocalPolicyFieldGrant | undefined {
  return config.policy.fields.find(
    (grant) => grant.entityId === entityId && grant.property === property,
  );
}

function hasScope(principal: RuntimePrincipal, scope: string): boolean {
  return principal.scopes.includes(scope);
}

export function createLocalAccessPolicy(
  config: LocalAppConfig,
): RuntimeAccessPolicy {
  return {
    evaluate(request) {
      if (request.principal.subject !== config.principal.subject) {
        return { effect: "deny", code: "principal-subject-mismatch" };
      }

      if (request.kind === "operation") {
        if (request.operation === "plan") {
          return config.policy.operations.plan && hasScope(request.principal, "state:read")
            ? { effect: "allow" }
            : { effect: "deny", code: "plan-denied" };
        }
        return config.policy.operations.apply && hasScope(request.principal, "state:write")
          ? { effect: "allow" }
          : { effect: "deny", code: "apply-denied" };
      }

      if (request.kind === "proposal") {
        return config.policy.operations.apply && hasScope(request.principal, "state:write")
          ? { effect: "allow" }
          : { effect: "deny", code: "proposal-apply-denied" };
      }

      const grant = fieldGrant(
        config,
        request.entityId,
        request.canonicalProperty,
      );
      if (
        grant === undefined
        || (grant.providers !== undefined && !grant.providers.includes(request.provider))
      ) {
        return { effect: "deny", code: "field-not-granted" };
      }

      if (request.operation === "read") {
        return grant.read && hasScope(request.principal, "state:read")
          ? { effect: "allow" }
          : { effect: "deny", code: "field-read-denied" };
      }
      return grant.write && hasScope(request.principal, "state:write")
        ? { effect: "allow" }
        : { effect: "deny", code: "field-write-denied" };
    },
  };
}

async function assertProviderRoots(config: LocalAppConfig): Promise<void> {
  for (const provider of config.providers) {
    const info = await stat(provider.root);
    if (!info.isDirectory()) {
      throw new Error(`Provider root is not a directory: ${provider.id}`);
    }
  }
}

export interface LocalRuntimeApp {
  readonly config: LocalAppConfig;
  readonly host: RuntimeHost;
  readonly principal: RuntimePrincipal;
  readonly journal: SQLiteEventJournal;
  createMcpServer(): ReturnType<typeof createRuntimeMcpServer>;
  close(): void;
}

export async function createLocalRuntimeApp(
  config: LocalAppConfig,
): Promise<LocalRuntimeApp> {
  await assertProviderRoots(config);

  const providerConfigs = new Map(
    config.providers.map((provider) => [provider.id, provider] as const),
  );
  const providers = new Map<string, StateProvider>();

  for (const providerConfig of config.providers) {
    const provider = new MarkdownFilesystemConnector({
      root: providerConfig.root,
      manifest: providerConfig.manifest,
    });
    providers.set(provider.id, provider);
  }

  const definitions: EntityRuntimeDefinition[] = config.entities.map((entity) => ({
    entityId: entity.entityId,
    bindings: entity.bindings.map((binding) => {
      const provider = providerConfigs.get(binding.provider);
      if (provider === undefined) {
        throw new Error(`Unknown provider ${binding.provider}`);
      }
      return externalBinding(entity, binding, provider);
    }),
    authority: authorityRules(entity),
  }));

  await mkdir(dirname(config.journalPath), { recursive: true });
  const journal = new SQLiteEventJournal({ path: config.journalPath });
  const principal: RuntimePrincipal = {
    subject: config.principal.subject,
    scopes: [...config.principal.scopes],
  };
  const host = new RuntimeHost({
    catalog: new InMemoryEntityRuntimeCatalog(definitions),
    registry: { providers },
    journal,
    accessPolicy: createLocalAccessPolicy(config),
  });

  let closed = false;
  return {
    config,
    host,
    principal,
    journal,
    createMcpServer() {
      return createRuntimeMcpServer({
        host,
        principal,
        name: "ssrl-local",
        version: "0.1.0",
      });
    },
    close() {
      if (closed) return;
      closed = true;
      journal.close();
    },
  };
}

export async function loadAndCreateLocalRuntimeApp(
  configPath: string,
): Promise<{
  readonly app: LocalRuntimeApp;
  readonly warnings: readonly string[];
}> {
  const loaded = await loadLocalAppConfig(configPath);
  const app = await createLocalRuntimeApp(loaded.config);
  return {
    app,
    warnings: loaded.warnings,
  };
}

export * from "./config.js";
