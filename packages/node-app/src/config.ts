import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  validateConnectorManifest,
  type ConnectorManifest,
} from "@ssrl/connector-sdk";
import { normalizeEntityAlias, type EntityId } from "@ssrl/core";
import * as z from "zod/v4";

const entityIdSchema = z.string().regex(/^entity:\/\/.+$/);
const nonEmptyString = z.string().trim().min(1);
const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const externalIdSchema = nonEmptyString.superRefine((value, ctx) => {
  if (value.includes("\0")) {
    ctx.addIssue({ code: "custom", message: "NUL bytes are not allowed" });
  }
  if (value.includes("\\")) {
    ctx.addIssue({ code: "custom", message: "use forward slashes only" });
  }
  if (
    value.startsWith("/")
    || /^[A-Za-z]:\//.test(value)
  ) {
    ctx.addIssue({ code: "custom", message: "absolute paths are not allowed" });
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    ctx.addIssue({ code: "custom", message: "empty, dot, and parent segments are not allowed" });
  }
  if (!value.toLowerCase().endsWith(".md")) {
    ctx.addIssue({ code: "custom", message: "Markdown bindings must target .md files" });
  }
});

const accessSchema = z.array(z.enum(["read", "write"])).min(1)
  .refine((value) => new Set(value).size === value.length, "access entries must be unique");

const connectorFieldSchema = z.object({
  canonical: nonEmptyString,
  external: nonEmptyString,
  access: accessSchema,
  authorityHint: z.enum(["primary", "secondary", "replica", "observation"]).optional(),
}).strict();

const connectorEntitySchema = z.object({
  canonicalType: nonEmptyString,
  externalType: nonEmptyString,
  fields: z.array(connectorFieldSchema).min(1),
}).strict();

const manifestSchema = z.object({
  schemaVersion: z.literal("0.1"),
  id: nonEmptyString,
  displayName: nonEmptyString,
  capabilities: z.object({
    read: z.boolean(),
    write: z.boolean(),
    observe: z.boolean(),
    subscribe: z.boolean(),
    revisions: z.enum(["none", "opaque", "monotonic"]),
    idempotency: z.enum(["none", "keyed"]),
  }).strict(),
  entities: z.array(connectorEntitySchema).min(1),
}).strict();

const providerSchema = z.object({
  id: nonEmptyString,
  root: nonEmptyString,
  manifest: manifestSchema,
}).strict();

const bindingSchema = z.object({
  provider: nonEmptyString,
  externalId: externalIdSchema,
  canonicalType: nonEmptyString,
}).strict();

const authoritySchema = z.object({
  property: nonEmptyString,
  provider: nonEmptyString,
}).strict();

const entitySchema = z.object({
  entityId: entityIdSchema,
  aliases: z.array(nonEmptyString)
    .refine((value) => new Set(value).size === value.length, "entity aliases must be unique")
    .default([]),
  bindings: z.array(bindingSchema).min(1),
  authority: z.array(authoritySchema).default([]),
}).strict();

const policyFieldSchema = z.object({
  entityId: entityIdSchema,
  property: nonEmptyString,
  providers: z.array(nonEmptyString).min(1).optional(),
  read: z.boolean(),
  write: z.boolean(),
}).strict();

const contextSourceSchema = z.object({
  provider: nonEmptyString,
  externalType: nonEmptyString,
}).strict();

const contextSchema = z.object({
  semanticStatePath: nonEmptyString,
  ingestionStatePath: nonEmptyString,
  capsuleCachePath: nonEmptyString.optional(),
  artifactStoreRoot: nonEmptyString,
  sources: z.array(contextSourceSchema).min(1),
  maxBudgetTokens: positiveSafeInteger.optional(),
  maxIdentityCandidates: positiveSafeInteger.optional(),
  maxIdentityScans: positiveSafeInteger.optional(),
  maxRelationCandidates: positiveSafeInteger.optional(),
  maxRelationScans: positiveSafeInteger.optional(),
  maxRelationEdges: positiveSafeInteger.optional(),
  syncPageSize: positiveSafeInteger.max(1_000).optional(),
  syncMaxPages: positiveSafeInteger.optional(),
  sourceVerificationMaxAgeMs: nonNegativeSafeInteger.optional(),
}).strict();

const configSchema = z.object({
  schemaVersion: z.literal("1"),
  journalPath: nonEmptyString,
  context: contextSchema.optional(),
  principal: z.object({
    subject: nonEmptyString,
    scopes: z.array(nonEmptyString)
      .refine((value) => new Set(value).size === value.length, "principal scopes must be unique"),
  }).strict(),
  providers: z.array(providerSchema).min(1),
  entities: z.array(entitySchema).min(1),
  policy: z.object({
    operations: z.object({
      plan: z.boolean(),
      apply: z.boolean(),
    }).strict(),
    fields: z.array(policyFieldSchema),
  }).strict(),
}).strict();

type ParsedConfig = z.infer<typeof configSchema>;

export interface LocalProviderConfig {
  readonly id: string;
  readonly root: string;
  readonly manifest: ConnectorManifest;
}

export interface LocalEntityBindingConfig {
  readonly provider: string;
  readonly externalId: string;
  readonly canonicalType: string;
}

export interface LocalEntityConfig {
  readonly entityId: EntityId;
  readonly aliases: readonly string[];
  readonly bindings: readonly LocalEntityBindingConfig[];
  readonly authority: readonly {
    readonly property: string;
    readonly provider: string;
  }[];
}

export interface LocalPolicyFieldGrant {
  readonly entityId: EntityId;
  readonly property: string;
  readonly providers?: readonly string[];
  readonly read: boolean;
  readonly write: boolean;
}

export interface LocalContextSourceConfig {
  readonly provider: string;
  readonly externalType: string;
}

export interface LocalContextConfig {
  readonly semanticStatePath: string;
  readonly ingestionStatePath: string;
  readonly capsuleCachePath: string;
  readonly artifactStoreRoot: string;
  readonly sources: readonly LocalContextSourceConfig[];
  readonly maxBudgetTokens?: number;
  readonly maxIdentityCandidates?: number;
  readonly maxIdentityScans?: number;
  readonly maxRelationCandidates?: number;
  readonly maxRelationScans?: number;
  readonly maxRelationEdges?: number;
  readonly syncPageSize?: number;
  readonly syncMaxPages?: number;
  readonly sourceVerificationMaxAgeMs: number;
}

export interface LocalAppConfig {
  readonly schemaVersion: "1";
  readonly configPath: string;
  readonly journalPath: string;
  readonly context?: LocalContextConfig;
  readonly principal: {
    readonly subject: string;
    readonly scopes: readonly string[];
  };
  readonly providers: readonly LocalProviderConfig[];
  readonly entities: readonly LocalEntityConfig[];
  readonly policy: {
    readonly operations: {
      readonly plan: boolean;
      readonly apply: boolean;
    };
    readonly fields: readonly LocalPolicyFieldGrant[];
  };
}

export class InvalidLocalAppConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super("Invalid local app configuration");
    this.name = "InvalidLocalAppConfigError";
  }
}

function absoluteFrom(baseDir: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(baseDir, value);
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
    return `${path}: ${issue.message}`;
  });
}

type ParsedProvider = ParsedConfig["providers"][number];
type ParsedEntity = ParsedConfig["entities"][number];
type PropertyProviders = Map<string, Set<string>>;
type EntityProperties = Map<string, PropertyProviders>;

function validateProvider(
  provider: ParsedProvider,
  providers: Map<string, ParsedProvider>,
  issues: string[],
): void {
  if (providers.has(provider.id)) {
    issues.push(`providers: duplicate provider id ${provider.id}`);
    return;
  }
  providers.set(provider.id, provider);

  if (provider.manifest.id !== provider.id) {
    issues.push(`provider ${provider.id}: manifest.id must match provider id`);
  }
  try {
    validateConnectorManifest(provider.manifest as ConnectorManifest);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid connector manifest";
    issues.push(`provider ${provider.id}: ${detail}`);
  }
}

function collectProviders(
  config: ParsedConfig,
  issues: string[],
): Map<string, ParsedProvider> {
  const providers = new Map<string, ParsedProvider>();
  for (const provider of config.providers) {
    validateProvider(provider, providers, issues);
  }
  return providers;
}

function addBindingProperties(
  entity: ParsedEntity,
  binding: ParsedEntity["bindings"][number],
  providers: ReadonlyMap<string, ParsedProvider>,
  properties: PropertyProviders,
  issues: string[],
): void {
  const provider = providers.get(binding.provider);
  if (provider === undefined) {
    issues.push(`entity ${entity.entityId}: unknown provider ${binding.provider}`);
    return;
  }

  const mapping = provider.manifest.entities.find(
    (candidate) => candidate.canonicalType === binding.canonicalType,
  );
  if (mapping === undefined) {
    issues.push(
      `entity ${entity.entityId}: provider ${binding.provider} does not declare canonical type ${binding.canonicalType}`,
    );
    return;
  }

  for (const field of mapping.fields) {
    const fieldProviders = properties.get(field.canonical) ?? new Set<string>();
    fieldProviders.add(binding.provider);
    properties.set(field.canonical, fieldProviders);
  }
}

function validateAuthority(
  entity: ParsedEntity,
  properties: PropertyProviders,
  issues: string[],
): void {
  const seen = new Set<string>();
  for (const rule of entity.authority) {
    if (seen.has(rule.property)) {
      issues.push(`entity ${entity.entityId}: duplicate authority rule for ${rule.property}`);
      continue;
    }
    seen.add(rule.property);

    if (!properties.get(rule.property)?.has(rule.provider)) {
      issues.push(
        `entity ${entity.entityId}: authority provider ${rule.provider} does not expose ${rule.property}`,
      );
    }
  }
}

function validateEntity(
  entity: ParsedEntity,
  entities: Set<string>,
  providers: ReadonlyMap<string, ParsedProvider>,
  issues: string[],
): PropertyProviders | undefined {
  if (entities.has(entity.entityId)) {
    issues.push(`entities: duplicate entityId ${entity.entityId}`);
    return undefined;
  }
  entities.add(entity.entityId);

  const seenProviders = new Set<string>();
  const properties: PropertyProviders = new Map();
  for (const binding of entity.bindings) {
    if (seenProviders.has(binding.provider)) {
      issues.push(
        `entity ${entity.entityId}: provider ${binding.provider} may be bound only once in config v1`,
      );
    }
    seenProviders.add(binding.provider);
    addBindingProperties(entity, binding, providers, properties, issues);
  }
  validateAuthority(entity, properties, issues);
  return properties;
}

function collectEntityProperties(
  config: ParsedConfig,
  providers: ReadonlyMap<string, ParsedProvider>,
  issues: string[],
): EntityProperties {
  const entityProperties: EntityProperties = new Map();
  const entities = new Set<string>();
  for (const entity of config.entities) {
    const properties = validateEntity(entity, entities, providers, issues);
    if (properties !== undefined) {
      entityProperties.set(entity.entityId, properties);
    }
  }
  return entityProperties;
}

function validateGrantProviders(
  grant: ParsedConfig["policy"]["fields"][number],
  available: ReadonlySet<string>,
  issues: string[],
): void {
  for (const provider of grant.providers ?? []) {
    if (!available.has(provider)) {
      issues.push(
        `policy.fields: provider ${provider} does not expose ${grant.entityId} / ${grant.property}`,
      );
    }
  }
}

function validatePolicyFields(
  config: ParsedConfig,
  entityProperties: EntityProperties,
  issues: string[],
): void {
  const seen = new Set<string>();
  for (const grant of config.policy.fields) {
    const key = JSON.stringify([grant.entityId, grant.property]);
    if (seen.has(key)) {
      issues.push(`policy.fields: duplicate grant for ${grant.entityId} / ${grant.property}`);
      continue;
    }
    seen.add(key);

    const available = entityProperties.get(grant.entityId)?.get(grant.property);
    if (available === undefined) {
      issues.push(`policy.fields: unknown property ${grant.entityId} / ${grant.property}`);
      continue;
    }
    validateGrantProviders(grant, available, issues);
  }
}

interface ParsedContextSourceMapping {
  readonly provider: ParsedProvider;
  readonly canonicalType: string;
  readonly externalType: string;
}

function resolveContextSource(
  source: NonNullable<ParsedConfig["context"]>["sources"][number],
  providers: ReadonlyMap<string, ParsedProvider>,
  issues: string[],
): ParsedContextSourceMapping | undefined {
  const provider = providers.get(source.provider);
  if (provider === undefined) {
    issues.push(`context source ${source.provider}/${source.externalType}: unknown provider`);
    return undefined;
  }
  const mappings = provider.manifest.entities.filter(
    (mapping) => mapping.externalType === source.externalType,
  );
  if (mappings.length !== 1) {
    issues.push(
      `context source ${source.provider}/${source.externalType}: externalType must match exactly one manifest entity mapping`,
    );
    return undefined;
  }
  return {
    provider,
    canonicalType: mappings[0]!.canonicalType,
    externalType: source.externalType,
  };
}

function contextSourceKey(provider: string, externalType: string): string {
  return JSON.stringify([provider, externalType]);
}

function contextSourceMappings(
  config: ParsedConfig,
  providers: ReadonlyMap<string, ParsedProvider>,
  issues: string[],
): Map<string, ParsedContextSourceMapping> {
  const result = new Map<string, ParsedContextSourceMapping>();
  for (const source of config.context?.sources ?? []) {
    const key = contextSourceKey(source.provider, source.externalType);
    if (result.has(key)) {
      issues.push(`context.sources: duplicate source ${source.provider}/${source.externalType}`);
      continue;
    }
    const resolved = resolveContextSource(source, providers, issues);
    if (resolved !== undefined) result.set(key, resolved);
  }
  return result;
}

function registerContextBindingOwner(
  entity: ParsedEntity,
  binding: ParsedEntity["bindings"][number],
  bindingOwners: Map<string, string>,
  issues: string[],
): void {
  const key = JSON.stringify([binding.provider, binding.externalId]);
  if (bindingOwners.has(key)) {
    issues.push(`context binding ${binding.provider}/${binding.externalId} is duplicated`);
    return;
  }
  bindingOwners.set(key, entity.entityId);
}

function sourceKeysForBinding(
  binding: ParsedEntity["bindings"][number],
  sourceMappings: ReadonlyMap<string, ParsedContextSourceMapping>,
): string[] {
  return [...sourceMappings.entries()]
    .filter(([, source]) => (
      binding.provider === source.provider.id
      && binding.canonicalType === source.canonicalType
    ))
    .map(([key]) => key);
}

interface ContextEntityValidationState {
  readonly sourceMappings: ReadonlyMap<string, ParsedContextSourceMapping>;
  readonly bindingOwners: Map<string, string>;
  readonly sourceBindingCounts: Map<string, number>;
  readonly issues: string[];
}

function contextTypesForEntity(
  entity: ParsedEntity,
  state: ContextEntityValidationState,
): Set<string> {
  const types = new Set<string>();
  for (const binding of entity.bindings) {
    registerContextBindingOwner(entity, binding, state.bindingOwners, state.issues);
    for (const sourceKey of sourceKeysForBinding(binding, state.sourceMappings)) {
      types.add(binding.canonicalType);
      state.sourceBindingCounts.set(
        sourceKey,
        (state.sourceBindingCounts.get(sourceKey) ?? 0) + 1,
      );
    }
  }
  return types;
}

function validateContextAliases(entity: ParsedEntity, issues: string[]): void {
  if (entity.aliases.length === 0) {
    issues.push(`entity ${entity.entityId}: context requires at least one explicit alias`);
    return;
  }
  const normalized = entity.aliases.map(normalizeEntityAlias);
  if (normalized.some((alias) => alias.length === 0)) {
    issues.push(`entity ${entity.entityId}: context aliases must contain letters or numbers`);
  }
  if (new Set(normalized).size !== normalized.length) {
    issues.push(`entity ${entity.entityId}: context aliases must be unique after normalization`);
  }
}

function validateContextEntity(
  entity: ParsedEntity,
  state: ContextEntityValidationState,
): void {
  const types = contextTypesForEntity(entity, state);
  if (types.size === 0) return;
  if (types.size !== 1) {
    state.issues.push(`entity ${entity.entityId}: context bindings must resolve to one canonicalType`);
  }
  validateContextAliases(entity, state.issues);
}

function validateContextSourceCoverage(
  sourceMappings: ReadonlyMap<string, ParsedContextSourceMapping>,
  sourceBindingCounts: ReadonlyMap<string, number>,
  issues: string[],
): void {
  for (const [key, source] of sourceMappings) {
    if ((sourceBindingCounts.get(key) ?? 0) > 0) continue;
    issues.push(
      `context source ${source.provider.id}/${source.externalType}: no configured entity bindings`,
    );
  }
}

function boundedBy(
  smaller: number | undefined,
  larger: number | undefined,
  message: string,
  issues: string[],
): void {
  if (smaller !== undefined && larger !== undefined && smaller > larger) issues.push(message);
}

function validateContextLimits(context: NonNullable<ParsedConfig["context"]>, issues: string[]): void {
  boundedBy(
    context.maxIdentityCandidates,
    context.maxIdentityScans,
    "context.maxIdentityCandidates must not exceed maxIdentityScans",
    issues,
  );
  boundedBy(
    context.maxRelationCandidates,
    context.maxRelationScans,
    "context.maxRelationCandidates must not exceed maxRelationScans",
    issues,
  );
  boundedBy(
    context.maxRelationEdges,
    context.maxRelationCandidates,
    "context.maxRelationEdges must not exceed maxRelationCandidates",
    issues,
  );
}

function validateContextEntities(
  config: ParsedConfig,
  providers: ReadonlyMap<string, ParsedProvider>,
  issues: string[],
): void {
  if (config.context === undefined) return;
  const sourceMappings = contextSourceMappings(config, providers, issues);
  const state: ContextEntityValidationState = {
    sourceMappings,
    bindingOwners: new Map(),
    sourceBindingCounts: new Map(),
    issues,
  };
  for (const entity of config.entities) validateContextEntity(entity, state);
  validateContextSourceCoverage(sourceMappings, state.sourceBindingCounts, issues);
  validateContextLimits(config.context, issues);
}

function validatePrincipalScopes(config: ParsedConfig, issues: string[]): void {
  const scopes = new Set(config.principal.scopes);
  const needsRead = config.policy.operations.plan
    || config.policy.fields.some((grant) => grant.read);
  const needsWrite = config.policy.operations.apply
    || config.policy.fields.some((grant) => grant.write);

  if (needsRead && !scopes.has("state:read")) {
    issues.push("principal.scopes must include state:read when read access is enabled");
  }
  if (needsWrite && !scopes.has("state:write")) {
    issues.push("principal.scopes must include state:write when write access is enabled");
  }
  if (config.context !== undefined && !scopes.has("context:read")) {
    issues.push("principal.scopes must include context:read when context is configured");
  }
}

function semanticIssues(config: ParsedConfig): string[] {
  const issues: string[] = [];
  const providers = collectProviders(config, issues);
  const entityProperties = collectEntityProperties(config, providers, issues);
  validatePolicyFields(config, entityProperties, issues);
  validateContextEntities(config, providers, issues);
  validatePrincipalScopes(config, issues);
  return issues;
}

function validateContextStoragePaths(
  journalPath: string,
  context: LocalContextConfig | undefined,
): string[] {
  if (context === undefined) return [];
  const artifactMetadata = join(context.artifactStoreRoot, "artifacts.sqlite");
  const paths = [
    ["journalPath", journalPath],
    ["context.semanticStatePath", context.semanticStatePath],
    ["context.ingestionStatePath", context.ingestionStatePath],
    ["context.capsuleCachePath", context.capsuleCachePath],
    ["context.artifactStoreRoot", context.artifactStoreRoot],
    ["context artifact metadata", artifactMetadata],
  ] as const;
  const issues: string[] = [];
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      if (paths[left]![1] === paths[right]![1]) {
        issues.push(`${paths[left]![0]} and ${paths[right]![0]} must use dedicated storage`);
      }
    }
  }
  return issues;
}

function parseConfigJson(raw: string): ParsedConfig {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new InvalidLocalAppConfigError(["<root>: config file is not valid JSON"]);
  }
  const parsed = configSchema.safeParse(parsedJson);
  if (!parsed.success) throw new InvalidLocalAppConfigError(formatZodIssues(parsed.error));
  const issues = semanticIssues(parsed.data);
  if (issues.length > 0) throw new InvalidLocalAppConfigError(issues);
  return parsed.data;
}

function optionalNumber<T extends string>(
  key: T,
  value: number | undefined,
): {} | Readonly<Record<T, number>> {
  return value === undefined ? {} : { [key]: value } as Readonly<Record<T, number>>;
}

function localContextConfig(
  baseDir: string,
  parsed: NonNullable<ParsedConfig["context"]>,
): LocalContextConfig {
  const semanticStatePath = absoluteFrom(baseDir, parsed.semanticStatePath);
  const capsuleCachePath = parsed.capsuleCachePath === undefined
    ? `${semanticStatePath}.capsules.sqlite`
    : absoluteFrom(baseDir, parsed.capsuleCachePath);
  return {
    semanticStatePath,
    ingestionStatePath: absoluteFrom(baseDir, parsed.ingestionStatePath),
    capsuleCachePath,
    artifactStoreRoot: absoluteFrom(baseDir, parsed.artifactStoreRoot),
    sources: parsed.sources.map((source) => ({ ...source })),
    ...optionalNumber("maxBudgetTokens", parsed.maxBudgetTokens),
    ...optionalNumber("maxIdentityCandidates", parsed.maxIdentityCandidates),
    ...optionalNumber("maxIdentityScans", parsed.maxIdentityScans),
    ...optionalNumber("maxRelationCandidates", parsed.maxRelationCandidates),
    ...optionalNumber("maxRelationScans", parsed.maxRelationScans),
    ...optionalNumber("maxRelationEdges", parsed.maxRelationEdges),
    ...optionalNumber("syncPageSize", parsed.syncPageSize),
    ...optionalNumber("syncMaxPages", parsed.syncMaxPages),
    sourceVerificationMaxAgeMs: parsed.sourceVerificationMaxAgeMs ?? 0,
  };
}

function runtimeConfig(
  configPath: string,
  parsed: ParsedConfig,
): LocalAppConfig {
  const baseDir = dirname(configPath);
  const journalPath = absoluteFrom(baseDir, parsed.journalPath);
  const context = parsed.context === undefined ? undefined : localContextConfig(baseDir, parsed.context);
  const storageIssues = validateContextStoragePaths(journalPath, context);
  if (storageIssues.length > 0) throw new InvalidLocalAppConfigError(storageIssues);
  return {
    schemaVersion: "1",
    configPath,
    journalPath,
    ...(context === undefined ? {} : { context }),
    principal: {
      subject: parsed.principal.subject,
      scopes: [...parsed.principal.scopes],
    },
    providers: parsed.providers.map((provider) => ({
      id: provider.id,
      root: absoluteFrom(baseDir, provider.root),
      manifest: provider.manifest as ConnectorManifest,
    })),
    entities: parsed.entities.map((entity) => ({
      entityId: entity.entityId as EntityId,
      aliases: [...entity.aliases],
      bindings: entity.bindings.map((binding) => ({ ...binding })),
      authority: entity.authority.map((rule) => ({ ...rule })),
    })),
    policy: {
      operations: { ...parsed.policy.operations },
      fields: parsed.policy.fields.map((grant) => ({
        entityId: grant.entityId as EntityId,
        property: grant.property,
        ...(grant.providers === undefined ? {} : { providers: [...grant.providers] }),
        read: grant.read,
        write: grant.write,
      })),
    },
  };
}

function configWarnings(mode: number): string[] {
  if (process.platform === "win32" || (mode & 0o022) === 0) return [];
  return ["config file is group/world writable"];
}

export async function loadLocalAppConfig(
  configPathInput: string,
): Promise<{
  readonly config: LocalAppConfig;
  readonly warnings: readonly string[];
}> {
  const configPath = resolve(configPathInput);
  const [raw, info] = await Promise.all([readFile(configPath, "utf8"), stat(configPath)]);
  const parsed = parseConfigJson(raw);
  return {
    config: runtimeConfig(configPath, parsed),
    warnings: configWarnings(info.mode),
  };
}
