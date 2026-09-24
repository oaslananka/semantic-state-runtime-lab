import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { MarkdownAuthoritativeIngestionAdapter } from "@ssrl/connector-markdown-fs";
import {
  ArtifactAccessGateway,
  type ArtifactAccessGatewayOptions,
  type ArtifactAccessPage,
  type ArtifactAccessPolicy,
  type ArtifactAccessRequest,
  type ArtifactListRequest,
  type ArtifactReadRequest,
  type ArtifactReadResult,
} from "@ssrl/artifact-access";
import {
  canonicalJson,
  normalizeEntityAlias,
  type AuthorityRule,
  type EntityId,
  type EntityTypeDescriptor,
} from "@ssrl/core";
import {
  ContextAccessGateway,
  type ContextAccessPolicy,
  type ContextAccessRequest,
} from "@ssrl/context-access";
import {
  IngestionEngine,
  ingestionSourceKey,
  type IngestionSourceKey,
} from "@ssrl/ingestion";
import {
  ContextCapsuleBootstrapper,
  ContextCapsuleMaterializer,
  IncrementalContextCapsuleSynchronizer,
  IncrementalContextCapsuleWorker,
} from "@ssrl/materializer";
import type { RuntimeMcpContextGateway } from "@ssrl/mcp-server";
import type { EntityAliasRecord } from "@ssrl/state-store";
import { LocalArtifactStore } from "@ssrl/storage-local-artifacts";
import { SQLiteContextCapsuleStore } from "@ssrl/storage-sqlite-capsules";
import {
  SQLiteIngestionStateStore,
  SQLiteSemanticStateStore,
} from "@ssrl/storage-sqlite";
import type {
  LocalAppConfig,
  LocalContextSourceConfig,
  LocalEntityConfig,
  LocalProviderConfig,
} from "./config.js";
import { providerExternalTypeMapping } from "./provider-mapping.js";
import {
  CoalescedVerifiedSourceSync,
  SourceVerificationGate,
  createRecursiveFsDirtyHint,
  type SourceDirtyHint,
} from "./source-verification.js";

const CONFIG_ALIAS_PREFIX = "local-context-alias-v1:sha256:";
const COMPOSITION_METADATA_SCHEMA = "ssrl-local-context-composition-v1" as const;
const COMPOSITION_METADATA_FILE = "local-context-composition-v1.json";

interface LocalContextSource {
  readonly sourceKey: IngestionSourceKey;
  readonly root: string;
  readonly adapter: MarkdownAuthoritativeIngestionAdapter;
  readonly verification: SourceVerificationGate;
}

interface ResolvedContextSource {
  readonly config: LocalContextSourceConfig;
  readonly provider: LocalProviderConfig;
  readonly canonicalType: string;
  readonly externalType: string;
}

function resolvedContextSources(config: LocalAppConfig): ResolvedContextSource[] {
  const context = config.context;
  if (context === undefined) return [];
  const providers = new Map(config.providers.map((provider) => [provider.id, provider]));
  return context.sources.map((source) => {
    const provider = providers.get(source.provider);
    if (provider === undefined) throw new Error(`Unknown context provider ${source.provider}`);
    const mapping = providerExternalTypeMapping(provider, source.externalType);
    return {
      config: source,
      provider,
      canonicalType: mapping.canonicalType,
      externalType: mapping.externalType,
    };
  }).toSorted((left, right) => (
    left.provider.id.localeCompare(right.provider.id)
    || left.externalType.localeCompare(right.externalType)
  ));
}

function sourceParticipatingEntities(config: LocalAppConfig): LocalEntityConfig[] {
  const sources = resolvedContextSources(config);
  return config.entities.filter((entity) => entity.bindings.some((binding) => sources.some(
    (source) => binding.provider === source.provider.id
      && binding.canonicalType === source.canonicalType,
  )));
}

function contextCanonicalType(config: LocalAppConfig, entity: LocalEntityConfig): string {
  const sourceTypes = new Set(resolvedContextSources(config).flatMap((source) => entity.bindings
    .filter((binding) => (
      binding.provider === source.provider.id
      && binding.canonicalType === source.canonicalType
    ))
    .map((binding) => binding.canonicalType)));
  if (sourceTypes.size !== 1) {
    throw new Error(`Entity ${entity.entityId} does not resolve to exactly one context canonical type`);
  }
  return [...sourceTypes][0]!;
}

export interface LocalContextRuntime {
  readonly semanticState: SQLiteSemanticStateStore;
  readonly ingestionState: SQLiteIngestionStateStore;
  readonly capsuleStore: SQLiteContextCapsuleStore;
  readonly artifactStore: LocalArtifactStore;
  readonly gateway: RuntimeMcpContextGateway;
  readonly artifactGateway: ArtifactAccessGateway;
  close(): void;
}

export class LocalContextAliasRemovalUnsupportedError extends Error {
  constructor(
    readonly entityId: EntityId,
    readonly alias: string,
  ) {
    super(`Removing persisted local context alias ${alias} from ${entityId} is not supported in v1`);
    this.name = "LocalContextAliasRemovalUnsupportedError";
  }
}

export class LocalContextConfigurationDriftError extends Error {
  constructor() {
    super("Local context ingestion configuration changed; use an explicit migration or fresh context storage");
    this.name = "LocalContextConfigurationDriftError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function configAliasId(entityId: EntityId, alias: string): string {
  return `${CONFIG_ALIAS_PREFIX}${sha256(canonicalJson([entityId, normalizeEntityAlias(alias)]))}`;
}

function contextDefinition(config: LocalAppConfig) {
  const context = config.context;
  if (context === undefined) throw new Error("Context definition requires context configuration");
  const sources = resolvedContextSources(config);
  const entities = sourceParticipatingEntities(config);
  return {
    storage: {
      semanticStatePath: context.semanticStatePath,
      ingestionStatePath: context.ingestionStatePath,
      artifactStoreRoot: context.artifactStoreRoot,
    },
    sources: sources.map((source) => ({
      provider: source.provider.id,
      root: source.provider.root,
      mapping: providerExternalTypeMapping(source.provider, source.externalType),
    })),
    bindings: entities
      .flatMap((entity) => entity.bindings.flatMap((binding) => sources
        .filter((source) => (
          binding.provider === source.provider.id
          && binding.canonicalType === source.canonicalType
        ))
        .map(() => ({
          entityId: entity.entityId,
          provider: binding.provider,
          externalId: binding.externalId,
          canonicalType: binding.canonicalType,
        }))))
      .toSorted((left, right) => (
        left.provider.localeCompare(right.provider)
        || left.externalId.localeCompare(right.externalId)
        || left.entityId.localeCompare(right.entityId)
      )),
  };
}

function compositionFingerprint(config: LocalAppConfig): string {
  return `sha256:${sha256(canonicalJson(contextDefinition(config)))}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeCompositionMetadata(path: string, fingerprint: string): Promise<void> {
  const payload = `${canonicalJson({
    schema: COMPOSITION_METADATA_SCHEMA,
    fingerprint,
  })}\n`;
  try {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(payload, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function ensureCompositionMetadata(config: LocalAppConfig): Promise<void> {
  const context = config.context;
  if (context === undefined) return;
  await mkdir(context.artifactStoreRoot, { recursive: true, mode: 0o700 });
  const path = join(context.artifactStoreRoot, COMPOSITION_METADATA_FILE);
  const fingerprint = compositionFingerprint(config);
  if (!(await exists(path))) {
    const persistentStoreExists = await Promise.all([
      exists(context.semanticStatePath),
      exists(context.ingestionStatePath),
      exists(join(context.artifactStoreRoot, "artifacts.sqlite")),
    ]).then((values) => values.some(Boolean));
    if (persistentStoreExists) throw new LocalContextConfigurationDriftError();
    await writeCompositionMetadata(path, fingerprint);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new LocalContextConfigurationDriftError();
  }
  if (
    parsed === null
    || typeof parsed !== "object"
    || (parsed as { readonly schema?: unknown }).schema !== COMPOSITION_METADATA_SCHEMA
    || (parsed as { readonly fingerprint?: unknown }).fingerprint !== fingerprint
  ) {
    throw new LocalContextConfigurationDriftError();
  }
}

function desiredAliases(entity: LocalEntityConfig): ReadonlyMap<string, string> {
  return new Map(entity.aliases.map((alias) => [configAliasId(entity.entityId, alias), alias]));
}

async function seedContextIdentity(
  config: LocalAppConfig,
  state: SQLiteSemanticStateStore,
  now: () => string,
): Promise<void> {
  const contextEntities = sourceParticipatingEntities(config);
  const entities = contextEntities.map((entity) => ({
    entityId: entity.entityId,
    entityType: contextCanonicalType(config, entity),
  }));
  const additions: EntityAliasRecord[] = [];

  for (const entity of contextEntities) {
    const desired = desiredAliases(entity);
    const existing = await state.aliasesForEntity(entity.entityId);
    const owned = existing.filter((alias) => alias.id.startsWith(CONFIG_ALIAS_PREFIX));
    for (const alias of owned) {
      if (!desired.has(alias.id)) {
        throw new LocalContextAliasRemovalUnsupportedError(entity.entityId, alias.value);
      }
      if (desired.get(alias.id) !== alias.value) {
        throw new LocalContextConfigurationDriftError();
      }
    }
    const existingIds = new Set(existing.map((alias) => alias.id));
    for (const [id, value] of desired) {
      if (existingIds.has(id)) continue;
      additions.push({
        id,
        entityId: entity.entityId,
        value,
        recordedAt: now(),
        evidenceRefs: ["local-config:identity"],
      });
    }
  }

  await state.append({
    entities,
    ...(additions.length === 0 ? {} : { aliases: additions }),
  });
}

function sourceKey(
  providerId: string,
  canonicalType: string,
  externalType: string,
): IngestionSourceKey {
  const fingerprint = sha256(canonicalJson([providerId, canonicalType, externalType]));
  return ingestionSourceKey(`local-markdown-context-v1:${fingerprint}`);
}

function bindingsFor(
  config: LocalAppConfig,
  provider: LocalProviderConfig,
  canonicalTypeValue: string,
): readonly { readonly externalId: string; readonly entityId: EntityId }[] {
  return config.entities
    .flatMap((entity) => entity.bindings
      .filter((binding) => (
        binding.provider === provider.id
        && binding.canonicalType === canonicalTypeValue
      ))
      .map((binding) => ({ externalId: binding.externalId, entityId: entity.entityId })))
    .toSorted((left, right) => left.externalId.localeCompare(right.externalId));
}

function contextSources(
  config: LocalAppConfig,
  monotonicNow?: () => number,
): LocalContextSource[] {
  const context = config.context;
  if (context === undefined) return [];
  const sources: LocalContextSource[] = [];
  for (const source of resolvedContextSources(config)) {
    const mapping = providerExternalTypeMapping(source.provider, source.externalType);
    const bindings = bindingsFor(config, source.provider, mapping.canonicalType);
    const ids = new Map(bindings.map((binding) => [binding.externalId, binding.entityId]));
    sources.push({
      sourceKey: sourceKey(source.provider.id, mapping.canonicalType, mapping.externalType),
      root: source.provider.root,
      verification: new SourceVerificationGate({
        maxVerificationAgeMs: context.sourceVerificationMaxAgeMs,
        ...(monotonicNow === undefined ? {} : { monotonicNow }),
      }),
      adapter: new MarkdownAuthoritativeIngestionAdapter({
        root: source.provider.root,
        manifest: source.provider.manifest,
        externalType: mapping.externalType,
        externalIds: bindings.map((binding) => binding.externalId),
        rejectUnlistedExternalIds: true,
        entityIdForExternalId(externalId) {
          const entityId = ids.get(externalId);
          if (entityId === undefined) {
            throw new Error(`Unconfigured local context resource ${source.provider.id}/${externalId}`);
          }
          return entityId;
        },
      }),
    });
  }
  return sources.toSorted((left, right) => left.sourceKey.localeCompare(right.sourceKey));
}

function contextSourceDirtyHints(sources: readonly LocalContextSource[]): SourceDirtyHint[] {
  const gatesByRoot = new Map<string, SourceVerificationGate[]>();
  for (const source of sources) {
    if (!source.verification.optimizationEnabled) continue;
    const gates = gatesByRoot.get(source.root) ?? [];
    gates.push(source.verification);
    gatesByRoot.set(source.root, gates);
  }
  return [...gatesByRoot.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([root, gates]) => createRecursiveFsDirtyHint(root, gates));
}

function entityTypes(config: LocalAppConfig): EntityTypeDescriptor[] {
  return [...new Set(sourceParticipatingEntities(config).map(
    (entity) => contextCanonicalType(config, entity),
  ))]
    .toSorted((left, right) => left.localeCompare(right))
    .map((id) => ({ id, aliases: [id] }));
}

function propertyDescriptors(config: LocalAppConfig) {
  const aliases = new Map<string, Set<string>>();
  for (const source of resolvedContextSources(config)) {
    const mapping = providerExternalTypeMapping(source.provider, source.externalType);
    for (const field of mapping.fields) {
      const values = aliases.get(field.canonical) ?? new Set<string>();
      values.add(field.canonical);
      values.add(field.canonical.split(".").at(-1) ?? field.canonical);
      values.add(field.external);
      aliases.set(field.canonical, values);
    }
  }
  return [...aliases.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([property, values]) => ({
      property,
      aliases: [...values].toSorted((left, right) => left.localeCompare(right)),
    }));
}

function authorityByEntity(config: LocalAppConfig): ReadonlyMap<EntityId, readonly AuthorityRule[]> {
  return new Map(sourceParticipatingEntities(config).map((entity) => [
    entity.entityId,
    entity.authority.map((rule) => ({
      property: rule.property,
      strategy: { kind: "provider" as const, provider: rule.provider },
    })),
  ]));
}

function contextConfigurationVersion(config: LocalAppConfig): string {
  const authority = sourceParticipatingEntities(config)
    .map((entity) => ({ entityId: entity.entityId, authority: entity.authority }))
    .toSorted((left, right) => left.entityId.localeCompare(right.entityId));
  return `local-context-v1:sha256:${sha256(canonicalJson(authority))}`;
}

function fieldGrant(
  config: LocalAppConfig,
  entityId: EntityId,
  property: string,
) {
  return config.policy.fields.find((grant) => (
    grant.entityId === entityId && grant.property === property
  ));
}

function possiblePropertyProviders(
  config: LocalAppConfig,
  entity: LocalEntityConfig,
  property: string,
): Set<string> {
  const providerById = new Map(config.providers.map((provider) => [provider.id, provider]));
  const result = new Set<string>();
  for (const binding of entity.bindings) {
    const provider = providerById.get(binding.provider);
    if (provider === undefined) continue;
    const mapping = provider.manifest.entities.find(
      (candidate) => candidate.canonicalType === binding.canonicalType,
    );
    if (mapping?.fields.some((field) => field.canonical === property)) {
      result.add(binding.provider);
    }
  }
  return result;
}

function propertyAllowed(
  config: LocalAppConfig,
  entityId: EntityId,
  property: string,
): boolean {
  const grant = fieldGrant(config, entityId, property);
  if (grant?.read !== true) return false;
  if (grant.providers === undefined) return true;
  const entity = config.entities.find((candidate) => candidate.entityId === entityId);
  if (entity === undefined) return false;
  const authority = entity.authority.find((rule) => rule.property === property);
  if (authority !== undefined) return grant.providers.includes(authority.provider);
  const providers = possiblePropertyProviders(config, entity, property);
  return providers.size > 0
    && [...providers].every((provider) => grant.providers!.includes(provider));
}

function entityAllowed(config: LocalAppConfig, entityId: EntityId): boolean {
  if (!sourceParticipatingEntities(config).some((entity) => entity.entityId === entityId)) return false;
  return config.policy.fields.some((grant) => (
    grant.entityId === entityId
    && grant.read
    && propertyAllowed(config, entityId, grant.property)
  ));
}

function localContextPolicy(config: LocalAppConfig): ContextAccessPolicy {
  return {
    evaluate(request: ContextAccessRequest) {
      if (request.principal.subject !== config.principal.subject) {
        return { effect: "deny", code: "principal-subject-mismatch" } as const;
      }
      if (!request.principal.scopes.includes("context:read")) {
        return { effect: "deny", code: "context-scope-required" } as const;
      }
      switch (request.kind) {
        case "operation":
          return { effect: "allow" } as const;
        case "entity":
          return entityAllowed(config, request.entityId)
            ? { effect: "allow" } as const
            : { effect: "deny", code: "entity-not-readable" } as const;
        case "property":
          return propertyAllowed(config, request.entityId, request.property)
            ? { effect: "allow" } as const
            : { effect: "deny", code: "property-read-denied" } as const;
        case "relation":
          return { effect: "deny", code: "relations-not-configured" } as const;
        case "provenance":
          return request.principal.scopes.includes("artifact:read")
            ? { effect: "allow" } as const
            : { effect: "deny", code: "artifact-read-scope-required" } as const;
      }
    },
  };
}

function artifactResourceKey(resource: {
  readonly sourceKey: string;
  readonly externalType: string;
  readonly externalId: string;
}): string {
  return canonicalJson([resource.sourceKey, resource.externalType, resource.externalId]);
}

function configuredArtifactResources(config: LocalAppConfig): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const source of resolvedContextSources(config)) {
    const mapping = providerExternalTypeMapping(source.provider, source.externalType);
    const bindings = bindingsFor(config, source.provider, mapping.canonicalType);
    const key = sourceKey(source.provider.id, mapping.canonicalType, mapping.externalType);
    for (const binding of bindings) {
      keys.add(artifactResourceKey({
        sourceKey: key,
        externalType: mapping.externalType,
        externalId: binding.externalId,
      }));
    }
  }
  return keys;
}

function localArtifactPolicy(config: LocalAppConfig): ArtifactAccessPolicy {
  const allowed = configuredArtifactResources(config);
  return {
    evaluate(request: ArtifactAccessRequest) {
      if (request.principal.subject !== config.principal.subject) {
        return { effect: "deny", code: "principal-subject-mismatch" } as const;
      }
      if (!request.principal.scopes.includes("artifact:read")) {
        return { effect: "deny", code: "artifact-read-scope-required" } as const;
      }
      return allowed.has(artifactResourceKey(request.resource))
        ? { effect: "allow" } as const
        : { effect: "deny", code: "artifact-not-configured" } as const;
    },
  };
}

class CoalescedLocalSourceSync {
  readonly #synchronize: () => Promise<void>;
  #inFlight: Promise<void> | undefined;

  constructor(synchronize: () => Promise<void>) {
    this.#synchronize = synchronize;
  }

  async run(): Promise<void> {
    if (this.#inFlight !== undefined) return this.#inFlight;
    const run = this.#synchronize();
    this.#inFlight = run;
    try {
      await run;
    } finally {
      if (this.#inFlight === run) this.#inFlight = undefined;
    }
  }
}

class FreshLocalArtifactGateway extends ArtifactAccessGateway {
  readonly #synchronize: () => Promise<void>;

  constructor(
    options: ArtifactAccessGatewayOptions & { readonly synchronize: () => Promise<void> },
  ) {
    super(options);
    this.#synchronize = options.synchronize;
  }

  override async list(request: ArtifactListRequest = {}): Promise<ArtifactAccessPage> {
    await this.#synchronize();
    return super.list(request);
  }

  override async read(request: ArtifactReadRequest): Promise<ArtifactReadResult> {
    await this.#synchronize();
    return super.read(request);
  }
}

export class FreshLocalContextGateway implements RuntimeMcpContextGateway {
  readonly #delegate: RuntimeMcpContextGateway;
  readonly #sourceSync: CoalescedLocalSourceSync;

  constructor(options: {
    readonly delegate: RuntimeMcpContextGateway;
    readonly synchronize: () => Promise<void>;
  }) {
    this.#delegate = options.delegate;
    this.#sourceSync = new CoalescedLocalSourceSync(options.synchronize);
  }

  async compile(request: Parameters<RuntimeMcpContextGateway["compile"]>[0]) {
    await this.#sourceSync.run();
    return this.#delegate.compile(request);
  }
}

async function createPersistentStores(config: LocalAppConfig) {
  const context = config.context!;
  await Promise.all([
    mkdir(dirname(context.semanticStatePath), { recursive: true }),
    mkdir(dirname(context.ingestionStatePath), { recursive: true }),
    mkdir(dirname(context.capsuleCachePath), { recursive: true }),
    mkdir(context.artifactStoreRoot, { recursive: true, mode: 0o700 }),
  ]);
  const semanticState = new SQLiteSemanticStateStore({ path: context.semanticStatePath, wal: true });
  try {
    const ingestionState = new SQLiteIngestionStateStore({ path: context.ingestionStatePath, wal: true });
    try {
      const capsuleStore = new SQLiteContextCapsuleStore({ path: context.capsuleCachePath, wal: true });
      try {
        const artifactStore = new LocalArtifactStore({ root: context.artifactStoreRoot });
        return { semanticState, ingestionState, capsuleStore, artifactStore };
      } catch (error) {
        capsuleStore.close();
        throw error;
      }
    } catch (error) {
      ingestionState.close();
      throw error;
    }
  } catch (error) {
    semanticState.close();
    throw error;
  }
}

function closePersistentStores(stores: Awaited<ReturnType<typeof createPersistentStores>>): void {
  stores.artifactStore.close();
  stores.capsuleStore.close();
  stores.ingestionState.close();
  stores.semanticState.close();
}

export async function createLocalContextRuntime(
  config: LocalAppConfig,
  now: () => string = () => new Date().toISOString(),
  monotonicNow?: () => number,
): Promise<LocalContextRuntime | undefined> {
  const context = config.context;
  if (context === undefined) return undefined;
  await ensureCompositionMetadata(config);
  const stores = await createPersistentStores(config);
  let sourceDirtyHints: readonly SourceDirtyHint[] = [];
  try {
    await seedContextIdentity(config, stores.semanticState, now);
    const sources = contextSources(config, monotonicNow);
    sourceDirtyHints = contextSourceDirtyHints(sources);
    const engine = new IngestionEngine({
      semanticState: stores.semanticState,
      ingestionState: stores.ingestionState,
      artifactStore: stores.artifactStore,
      now,
    });
    const capsules = stores.capsuleStore;
    const materializer = new ContextCapsuleMaterializer({
      stateStore: stores.semanticState,
      authorityByEntity: authorityByEntity(config),
      configurationVersion: contextConfigurationVersion(config),
    });
    const worker = new IncrementalContextCapsuleWorker({
      stateStore: stores.semanticState,
      capsuleStore: capsules,
      materializer,
    });
    const synchronizer = new IncrementalContextCapsuleSynchronizer({
      worker,
      bootstrapper: new ContextCapsuleBootstrapper({
        stateStore: stores.semanticState,
        capsuleStore: capsules,
        materializer,
      }),
      ...(context.syncPageSize === undefined ? {} : { pageSize: context.syncPageSize }),
      ...(context.syncMaxPages === undefined ? {} : { maxPages: context.syncMaxPages }),
    });
    const delegate = new ContextAccessGateway({
      capsules,
      synchronizer,
      entityTypes: entityTypes(config),
      relationTypes: [],
      properties: propertyDescriptors(config),
      policy: localContextPolicy(config),
      ...(context.maxBudgetTokens === undefined ? {} : { maxBudgetTokens: context.maxBudgetTokens }),
      ...(context.maxIdentityCandidates === undefined
        ? {}
        : { maxIdentityCandidates: context.maxIdentityCandidates }),
      ...(context.maxIdentityScans === undefined ? {} : { maxIdentityScans: context.maxIdentityScans }),
      ...(context.maxRelationCandidates === undefined
        ? {}
        : { maxRelationCandidates: context.maxRelationCandidates }),
      ...(context.maxRelationScans === undefined ? {} : { maxRelationScans: context.maxRelationScans }),
      ...(context.maxRelationEdges === undefined ? {} : { maxRelationEdges: context.maxRelationEdges }),
      now,
    });
    const sourceSync = new CoalescedVerifiedSourceSync(sources.map((source) => ({
      id: source.sourceKey,
      gate: source.verification,
      async verify() {
        await engine.sync({
          sourceKey: source.sourceKey,
          source: source.adapter,
          mapper: source.adapter,
          artifactMapper: source.adapter,
        });
      },
    })));
    const synchronizeSources = async () => {
      await sourceSync.run();
    };
    const artifactGateway = new FreshLocalArtifactGateway({
      store: stores.artifactStore,
      policy: localArtifactPolicy(config),
      now,
      synchronize: synchronizeSources,
    });
    const gateway = new FreshLocalContextGateway({
      delegate,
      synchronize: synchronizeSources,
    });

    let closed = false;
    return {
      ...stores,
      gateway,
      artifactGateway,
      close() {
        if (closed) return;
        closed = true;
        for (const hint of sourceDirtyHints) hint.close();
        closePersistentStores(stores);
      },
    };
  } catch (error) {
    for (const hint of sourceDirtyHints) hint.close();
    closePersistentStores(stores);
    throw error;
  }
}
