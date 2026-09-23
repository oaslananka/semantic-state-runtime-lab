import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  validateConnectorManifest,
  type ConnectorManifest,
} from "@ssrl/connector-sdk";
import type { EntityId } from "@ssrl/core";
import * as z from "zod/v4";

const entityIdSchema = z.string().regex(/^entity:\/\/.+$/);
const nonEmptyString = z.string().trim().min(1);

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

const configSchema = z.object({
  schemaVersion: z.literal("1"),
  journalPath: nonEmptyString,
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

export interface LocalAppConfig {
  readonly schemaVersion: "1";
  readonly configPath: string;
  readonly journalPath: string;
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

function semanticIssues(config: ParsedConfig): string[] {
  const issues: string[] = [];
  const providers = new Map<string, ParsedConfig["providers"][number]>();

  for (const provider of config.providers) {
    if (providers.has(provider.id)) {
      issues.push(`providers: duplicate provider id ${provider.id}`);
      continue;
    }
    providers.set(provider.id, provider);
    if (provider.manifest.id !== provider.id) {
      issues.push(`provider ${provider.id}: manifest.id must match provider id`);
    }
    try {
      validateConnectorManifest(provider.manifest as ConnectorManifest);
    } catch (error) {
      issues.push(
        `provider ${provider.id}: ${error instanceof Error ? error.message : "invalid connector manifest"}`,
      );
    }
  }

  const entities = new Map<string, ParsedConfig["entities"][number]>();
  const entityProperties = new Map<string, Map<string, Set<string>>>();

  for (const entity of config.entities) {
    if (entities.has(entity.entityId)) {
      issues.push(`entities: duplicate entityId ${entity.entityId}`);
      continue;
    }
    entities.set(entity.entityId, entity);

    const seenProviders = new Set<string>();
    const propertyProviders = new Map<string, Set<string>>();

    for (const binding of entity.bindings) {
      if (seenProviders.has(binding.provider)) {
        issues.push(
          `entity ${entity.entityId}: provider ${binding.provider} may be bound only once in config v1`,
        );
      }
      seenProviders.add(binding.provider);

      const provider = providers.get(binding.provider);
      if (provider === undefined) {
        issues.push(`entity ${entity.entityId}: unknown provider ${binding.provider}`);
        continue;
      }
      const mapping = provider.manifest.entities.find(
        (candidate) => candidate.canonicalType === binding.canonicalType,
      );
      if (mapping === undefined) {
        issues.push(
          `entity ${entity.entityId}: provider ${binding.provider} does not declare canonical type ${binding.canonicalType}`,
        );
        continue;
      }
      for (const field of mapping.fields) {
        const set = propertyProviders.get(field.canonical) ?? new Set<string>();
        set.add(binding.provider);
        propertyProviders.set(field.canonical, set);
      }
    }

    entityProperties.set(entity.entityId, propertyProviders);

    const seenAuthority = new Set<string>();
    for (const rule of entity.authority) {
      if (seenAuthority.has(rule.property)) {
        issues.push(`entity ${entity.entityId}: duplicate authority rule for ${rule.property}`);
        continue;
      }
      seenAuthority.add(rule.property);

      const providersForProperty = propertyProviders.get(rule.property);
      if (providersForProperty === undefined || !providersForProperty.has(rule.provider)) {
        issues.push(
          `entity ${entity.entityId}: authority provider ${rule.provider} does not expose ${rule.property}`,
        );
      }
    }
  }

  const seenPolicyFields = new Set<string>();
  for (const grant of config.policy.fields) {
    const key = `${grant.entityId}\0${grant.property}`;
    if (seenPolicyFields.has(key)) {
      issues.push(`policy.fields: duplicate grant for ${grant.entityId} / ${grant.property}`);
      continue;
    }
    seenPolicyFields.add(key);

    const properties = entityProperties.get(grant.entityId);
    const availableProviders = properties?.get(grant.property);
    if (availableProviders === undefined) {
      issues.push(`policy.fields: unknown property ${grant.entityId} / ${grant.property}`);
      continue;
    }
    if (grant.providers !== undefined) {
      for (const provider of grant.providers) {
        if (!availableProviders.has(provider)) {
          issues.push(
            `policy.fields: provider ${provider} does not expose ${grant.entityId} / ${grant.property}`,
          );
        }
      }
    }
  }

  const scopes = new Set(config.principal.scopes);
  if (config.policy.operations.plan && !scopes.has("state:read")) {
    issues.push("principal.scopes must include state:read when policy.operations.plan is enabled");
  }
  if (config.policy.operations.apply && !scopes.has("state:write")) {
    issues.push("principal.scopes must include state:write when policy.operations.apply is enabled");
  }
  if (config.policy.fields.some((grant) => grant.read) && !scopes.has("state:read")) {
    issues.push("principal.scopes must include state:read when any field read grant is enabled");
  }
  if (config.policy.fields.some((grant) => grant.write) && !scopes.has("state:write")) {
    issues.push("principal.scopes must include state:write when any field write grant is enabled");
  }

  return issues;
}

export async function loadLocalAppConfig(
  configPathInput: string,
): Promise<{
  readonly config: LocalAppConfig;
  readonly warnings: readonly string[];
}> {
  const configPath = resolve(configPathInput);
  const [raw, info] = await Promise.all([
    readFile(configPath, "utf8"),
    stat(configPath),
  ]);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new InvalidLocalAppConfigError(["<root>: config file is not valid JSON"]);
  }

  const parsed = configSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new InvalidLocalAppConfigError(formatZodIssues(parsed.error));
  }

  const issues = semanticIssues(parsed.data);
  if (issues.length > 0) {
    throw new InvalidLocalAppConfigError(issues);
  }

  const baseDir = dirname(configPath);
  const config: LocalAppConfig = {
    schemaVersion: "1",
    configPath,
    journalPath: absoluteFrom(baseDir, parsed.data.journalPath),
    principal: {
      subject: parsed.data.principal.subject,
      scopes: [...parsed.data.principal.scopes],
    },
    providers: parsed.data.providers.map((provider) => ({
      id: provider.id,
      root: absoluteFrom(baseDir, provider.root),
      manifest: provider.manifest as ConnectorManifest,
    })),
    entities: parsed.data.entities.map((entity) => ({
      entityId: entity.entityId as EntityId,
      bindings: entity.bindings.map((binding) => ({ ...binding })),
      authority: entity.authority.map((rule) => ({ ...rule })),
    })),
    policy: {
      operations: { ...parsed.data.policy.operations },
      fields: parsed.data.policy.fields.map((grant) => ({
        entityId: grant.entityId as EntityId,
        property: grant.property,
        ...(grant.providers === undefined ? {} : { providers: [...grant.providers] }),
        read: grant.read,
        write: grant.write,
      })),
    },
  };

  const warnings: string[] = [];
  if (process.platform !== "win32" && (info.mode & 0o022) !== 0) {
    warnings.push("config file is group/world writable");
  }

  return { config, warnings };
}
