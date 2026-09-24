import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { MarkdownFilesystemConnector } from "@ssrl/connector-markdown-fs";
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
  type RuntimeAccessDecision,
  type RuntimeAccessPolicy,
  type RuntimeAccessRequest,
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
import { createLocalContextRuntime } from "./local-context.js";
import { providerEntityMapping } from "./provider-mapping.js";

function externalBinding(
  entity: LocalEntityConfig,
  binding: LocalEntityBindingConfig,
  provider: LocalProviderConfig,
): ExternalBinding {
  const mapping = providerEntityMapping(provider, binding.canonicalType);
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

function operationDecision(
  config: LocalAppConfig,
  request: Extract<RuntimeAccessRequest, { readonly kind: "operation" }>,
): RuntimeAccessDecision {
  const plan = request.operation === "plan";
  const enabled = plan ? config.policy.operations.plan : config.policy.operations.apply;
  const scope = plan ? "state:read" : "state:write";
  if (enabled && hasScope(request.principal, scope)) return { effect: "allow" };
  return { effect: "deny", code: plan ? "plan-denied" : "apply-denied" };
}

function proposalDecision(
  config: LocalAppConfig,
  request: Extract<RuntimeAccessRequest, { readonly kind: "proposal" }>,
): RuntimeAccessDecision {
  if (config.policy.operations.apply && hasScope(request.principal, "state:write")) {
    return { effect: "allow" };
  }
  return { effect: "deny", code: "proposal-apply-denied" };
}

function fieldDecision(
  config: LocalAppConfig,
  request: Extract<RuntimeAccessRequest, { readonly kind: "field" }>,
): RuntimeAccessDecision {
  const grant = fieldGrant(config, request.entityId, request.canonicalProperty);
  if (grant === undefined || (grant.providers?.includes(request.provider) === false)) {
    return { effect: "deny", code: "field-not-granted" };
  }

  const read = request.operation === "read";
  const enabled = read ? grant.read : grant.write;
  const scope = read ? "state:read" : "state:write";
  if (enabled && hasScope(request.principal, scope)) return { effect: "allow" };
  return { effect: "deny", code: read ? "field-read-denied" : "field-write-denied" };
}

function accessDecision(
  config: LocalAppConfig,
  request: RuntimeAccessRequest,
): RuntimeAccessDecision {
  if (request.principal.subject !== config.principal.subject) {
    return { effect: "deny", code: "principal-subject-mismatch" };
  }

  switch (request.kind) {
    case "operation":
      return operationDecision(config, request);
    case "proposal":
      return proposalDecision(config, request);
    case "field":
      return fieldDecision(config, request);
  }
}

export function createLocalAccessPolicy(
  config: LocalAppConfig,
): RuntimeAccessPolicy {
  return {
    evaluate: (request) => accessDecision(config, request),
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
  readonly context?: Awaited<ReturnType<typeof createLocalContextRuntime>>;
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
  let contextRuntime: Awaited<ReturnType<typeof createLocalContextRuntime>>;
  try {
    contextRuntime = await createLocalContextRuntime(config);
  } catch (cause) {
    journal.close();
    throw cause;
  }
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
    ...(contextRuntime === undefined ? {} : { context: contextRuntime }),
    createMcpServer() {
      return createRuntimeMcpServer({
        host,
        principal,
        ...(contextRuntime === undefined
          ? {}
          : {
              context: { gateway: contextRuntime.gateway },
              artifacts: { gateway: contextRuntime.artifactGateway },
            }),
        name: "ssrl-local",
        version: "0.1.0",
      });
    },
    close() {
      if (closed) return;
      closed = true;
      contextRuntime?.close();
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
export {
  LocalContextAliasRemovalUnsupportedError,
  LocalContextConfigurationDriftError,
} from "./local-context.js";
