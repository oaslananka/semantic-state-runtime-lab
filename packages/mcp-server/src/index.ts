import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
  requireScopes,
  type ScopeChallengeHandler,
} from "@modelcontextprotocol/server";
import {
  ArtifactAccessDeniedError,
  ArtifactAccessNotFoundError,
  ArtifactCatalogScanLimitError,
  ArtifactReadTooLargeError,
  type ArtifactAccessGateway,
  type ArtifactResourceDescriptor,
} from "@ssrl/artifact-access";
import type {
  EntityId,
  StateValue,
} from "@ssrl/core";
import {
  ContextAccessDeniedError,
  ContextAccessSynchronizationLimitError,
  ContextIdentityCandidateLimitError,
  ContextIdentityScanLimitError,
  ContextRelationCandidateLimitError,
  ContextRelationScanLimitError,
  type ContextAccessCompileRequest,
  type ContextAccessResult,
} from "@ssrl/context-access";
import {
  ReconciliationApplyError,
  ReconciliationBlockedError,
  ReconciliationPlanDriftError,
} from "@ssrl/runtime";
import {
  EntityNotConfiguredError,
  InvalidProposalDigestError,
  RuntimeAccessDeniedError,
  type RuntimeHost,
  type RuntimePrincipal,
} from "@ssrl/runtime-host";
import * as z from "zod/v4";

export const MCP_TOOL_NAMES = {
  plan: "state.plan",
  apply: "state.apply",
  context: "context.compile",
} as const;

const entityIdSchema = z.string().regex(/^entity:\/\/.+$/);
const proposalDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const stateValueSchema: z.ZodType<StateValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(stateValueSchema),
  z.record(z.string(), stateValueSchema),
]));

const sourceRefSchema = z.object({
  provider: z.string(),
  externalId: z.string(),
  revision: z.string().optional(),
});

const canonicalPropertySchema = z.object({
  property: z.string(),
  value: stateValueSchema,
  source: sourceRefSchema,
  observedAt: z.string(),
});

const mutationSchema = z.object({
  provider: z.string(),
  externalId: z.string(),
  externalPath: z.string(),
  canonicalProperty: z.string(),
  nextValue: stateValueSchema,
  previousValue: stateValueSchema.optional(),
  baseRevision: z.string().optional(),
});

const conflictCandidateSchema = z.object({
  provider: z.string(),
  externalId: z.string(),
  value: stateValueSchema,
  observedAt: z.string(),
});

const conflictSchema = z.object({
  property: z.string(),
  reason: z.enum(["ambiguous-authority", "ambiguous-freshest"]),
  candidates: z.array(conflictCandidateSchema),
});

export const mcpPlanInputSchema = z.object({
  entityId: entityIdSchema,
});

export const mcpPlanOutputSchema = z.object({
  schemaVersion: z.literal("1"),
  entityId: entityIdSchema,
  status: z.enum(["ready", "blocked", "noop"]),
  digestAlgorithm: z.literal("sha256"),
  proposalDigest: proposalDigestSchema,
  canonical: z.record(z.string(), canonicalPropertySchema),
  mutations: z.array(mutationSchema),
  conflicts: z.array(conflictSchema),
  journalRunId: z.string().optional(),
});

export const mcpApplyInputSchema = z.object({
  entityId: entityIdSchema,
  proposalDigest: proposalDigestSchema,
});

export const mcpApplyOutputSchema = z.object({
  schemaVersion: z.literal("1"),
  entityId: entityIdSchema,
  appliedCount: z.number().int().nonnegative(),
  converged: z.boolean(),
  remainingMutationCount: z.number().int().nonnegative(),
  conflictCount: z.number().int().nonnegative(),
  journalRunId: z.string().optional(),
});


const contextKindSchema = z.enum([
  "state",
  "decision",
  "commitment",
  "event",
  "artifact",
  "relationship",
]);

const contextRecordSchema = z.object({
  id: z.string(),
  entityId: entityIdSchema,
  kind: contextKindSchema,
  text: z.string(),
  current: z.boolean().optional(),
  importance: z.number().finite().optional(),
  relatedEntityIds: z.array(entityIdSchema).optional(),
  evidenceRefs: z.array(z.string()).optional(),
});

const contextResolutionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none") }),
  z.object({
    status: z.literal("resolved"),
    entityId: entityIdSchema,
    entityType: z.string(),
  }),
  z.object({
    status: z.literal("ambiguous"),
    candidates: z.array(z.object({
      entityId: entityIdSchema,
      entityType: z.string(),
    })),
  }),
]);

export const mcpContextCompileInputSchema = z.strictObject({
  task: z.string().trim().min(1),
  budgetTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const mcpContextCompileOutputSchema = z.object({
  schemaVersion: z.literal("1"),
  resolution: contextResolutionSchema,
  records: z.array(contextRecordSchema),
  resolvedEntityIds: z.array(entityIdSchema),
  relatedEntityIds: z.array(entityIdSchema),
  estimatedTokens: z.number().int().nonnegative(),
  consideredRecords: z.number().int().nonnegative(),
});

export interface RuntimeMcpContextGateway {
  compile(request: ContextAccessCompileRequest): Promise<ContextAccessResult>;
}

export interface RuntimeMcpContextOptions {
  readonly gateway: RuntimeMcpContextGateway;
}

export interface RuntimeMcpArtifactOptions {
  readonly gateway: ArtifactAccessGateway;
  readonly maxListedResources?: number;
  readonly maxResourceBytes?: number;
}

export interface RuntimeMcpScopeOptions {
  readonly plan?: readonly string[];
  readonly apply?: readonly string[];
  readonly artifacts?: readonly string[];
  readonly context?: readonly string[];
}

export interface RuntimeMcpServerOptions {
  readonly host: RuntimeHost;
  readonly principal: RuntimePrincipal;
  readonly artifacts?: RuntimeMcpArtifactOptions;
  readonly context?: RuntimeMcpContextOptions;
  readonly scopes?: RuntimeMcpScopeOptions;
  readonly name?: string;
  readonly version?: string;
}

type SafeErrorCode =
  | "access_denied"
  | "entity_not_configured"
  | "invalid_proposal_digest"
  | "proposal_drifted"
  | "proposal_blocked"
  | "apply_failed"
  | "internal_error";

const SAFE_ERROR_MESSAGES: Readonly<Record<SafeErrorCode, string>> = {
  access_denied: "Access denied.",
  entity_not_configured: "Entity is not configured.",
  invalid_proposal_digest: "Proposal digest is invalid.",
  proposal_drifted: "Proposal drifted; call state.plan again before applying.",
  proposal_blocked: "Proposal is blocked by unresolved conflicts.",
  apply_failed: "Applying the proposal failed.",
  internal_error: "Internal server error.",
};

function errorCode(error: unknown): SafeErrorCode {
  if (error instanceof RuntimeAccessDeniedError) return "access_denied";
  if (error instanceof EntityNotConfiguredError) return "entity_not_configured";
  if (error instanceof InvalidProposalDigestError) return "invalid_proposal_digest";
  if (error instanceof ReconciliationPlanDriftError) return "proposal_drifted";
  if (error instanceof ReconciliationBlockedError) return "proposal_blocked";
  if (error instanceof ReconciliationApplyError) return "apply_failed";
  return "internal_error";
}

function toolError(error: unknown) {
  const code = errorCode(error);
  return {
    isError: true,
    content: [{
      type: "text" as const,
      text: `${code}: ${SAFE_ERROR_MESSAGES[code]}`,
    }],
  };
}

type ContextToolErrorCode =
  | "access_denied"
  | "context_limit_exceeded"
  | "context_sync_incomplete"
  | "context_request_rejected"
  | "internal_error";

const CONTEXT_ERROR_MESSAGES: Readonly<Record<ContextToolErrorCode, string>> = {
  access_denied: "Access denied.",
  context_limit_exceeded: "Context request exceeded a server safety limit.",
  context_sync_incomplete: "Context could not be synchronized within the server limit.",
  context_request_rejected: "Context request was rejected by server limits.",
  internal_error: "Internal server error.",
};

function contextErrorCode(error: unknown): ContextToolErrorCode {
  if (error instanceof ContextAccessDeniedError) return "access_denied";
  if (
    error instanceof ContextIdentityCandidateLimitError
    || error instanceof ContextIdentityScanLimitError
    || error instanceof ContextRelationCandidateLimitError
    || error instanceof ContextRelationScanLimitError
  ) return "context_limit_exceeded";
  if (error instanceof ContextAccessSynchronizationLimitError) return "context_sync_incomplete";
  if (error instanceof RangeError || error instanceof TypeError) return "context_request_rejected";
  return "internal_error";
}

function contextToolError(error: unknown) {
  const code = contextErrorCode(error);
  return {
    isError: true,
    content: [{
      type: "text" as const,
      text: `${code}: ${CONTEXT_ERROR_MESSAGES[code]}`,
    }],
  };
}

function contextSummary(result: ContextAccessResult): string {
  return [
    `Context resolution: ${result.resolution.status}.`,
    `Records: ${result.context.records.length}.`,
    `Estimated tokens: ${result.context.estimatedTokens}.`,
  ].join(" ");
}

function safeContextOutput(
  result: ContextAccessResult,
  budgetTokens: number,
): z.infer<typeof mcpContextCompileOutputSchema> {
  if (result.context.estimatedTokens > budgetTokens) {
    throw new RangeError("Context gateway exceeded requested token budget");
  }
  return mcpContextCompileOutputSchema.parse({
    schemaVersion: "1",
    resolution: result.resolution,
    records: result.context.records,
    resolvedEntityIds: result.context.resolvedEntityIds,
    relatedEntityIds: result.relatedEntityIds,
    estimatedTokens: result.context.estimatedTokens,
    consideredRecords: result.context.consideredRecords,
  });
}

function planText(
  status: "ready" | "blocked" | "noop",
  digest: string,
  mutationCount: number,
  conflictCount: number,
): string {
  return [
    `Proposal status: ${status}.`,
    `Digest: ${digest}.`,
    `Mutations: ${mutationCount}.`,
    `Conflicts: ${conflictCount}.`,
  ].join(" ");
}

const ARTIFACT_RESOURCE_TEMPLATE = "ssrl://artifact/resource/sha256/{fingerprint}";
const ARTIFACT_VERSION_TEMPLATE = "ssrl://artifact/version/sha256/{fingerprint}";
export const MCP_ARTIFACT_CACHE_HINT = {
  ttlMs: 0,
  cacheScope: "private" as const,
} as const;

function scopeChallenge(scopes: readonly string[] | undefined): ScopeChallengeHandler | undefined {
  if (scopes === undefined || scopes.length === 0) return undefined;
  const normalized = [...new Set(scopes.map((scope) => scope.trim()))]
    .filter((scope) => scope.length > 0)
    .toSorted((left, right) => left.localeCompare(right));
  if (normalized.length === 0) return undefined;
  const [first, ...rest] = normalized;
  if (first === undefined) return undefined;
  return requireScopes(first, ...rest);
}

function opaqueResourceName(descriptor: ArtifactResourceDescriptor): string {
  return `artifact-${descriptor.uri.slice(-12)}`;
}

function mcpResourceDescriptor(descriptor: ArtifactResourceDescriptor) {
  return {
    uri: descriptor.uri,
    name: opaqueResourceName(descriptor),
    ...(descriptor.title === undefined ? {} : { title: descriptor.title }),
    mimeType: descriptor.mediaType,
    size: descriptor.size,
  };
}

function strictUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function sanitizedArtifactReadError(uri: string, error: unknown): never {
  if (error instanceof ArtifactAccessDeniedError || error instanceof ArtifactAccessNotFoundError) {
    throw new ResourceNotFoundError(uri);
  }
  if (error instanceof ArtifactReadTooLargeError) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      "Artifact resource exceeds the MCP read limit.",
    );
  }
  throw new ProtocolError(
    ProtocolErrorCode.InternalError,
    "Artifact resource read failed.",
  );
}

function registerArtifactResources(
  server: McpServer,
  options: RuntimeMcpServerOptions,
): void {
  const artifactOptions = options.artifacts;
  if (artifactOptions === undefined) return;
  const maxListedResources = artifactOptions.maxListedResources ?? 500;
  const maxResourceBytes = artifactOptions.maxResourceBytes ?? 256 * 1024;
  const artifactScopeChallenge = scopeChallenge(options.scopes?.artifacts);
  for (const [name, value] of [
    ["maxListedResources", maxListedResources],
    ["maxResourceBytes", maxResourceBytes],
  ] as const) {
    if (!(Number.isSafeInteger(value) && value >= 1)) {
      throw new RangeError(`MCP artifact ${name} must be a positive safe integer`);
    }
  }

  const read = async (uri: URL) => {
    try {
      const result = await artifactOptions.gateway.read({
        uri: uri.href,
        principal: options.principal,
        maxBytes: maxResourceBytes,
      });
      const text = result.resource.mediaType.startsWith("text/")
        ? strictUtf8(result.bytes)
        : undefined;
      return {
        contents: [text === undefined
          ? {
            uri: uri.href,
            mimeType: result.resource.mediaType,
            blob: Buffer.from(result.bytes).toString("base64"),
          }
          : {
            uri: uri.href,
            mimeType: result.resource.mediaType,
            text,
          }],
      };
    } catch (error) {
      return sanitizedArtifactReadError(uri.href, error);
    }
  };

  server.registerResource(
    "artifact-current",
    new ResourceTemplate(ARTIFACT_RESOURCE_TEMPLATE, {
      list: async () => {
        try {
          const page = await artifactOptions.gateway.list({
            principal: options.principal,
            limit: Math.min(maxListedResources + 1, 1_000),
          });
          if (page.hasMore || page.resources.length > maxListedResources) {
            throw new ProtocolError(
              ProtocolErrorCode.InternalError,
              "Artifact resource list exceeds the MCP server limit.",
            );
          }
          return { resources: page.resources.map(mcpResourceDescriptor) };
        } catch (error) {
          if (error instanceof ProtocolError) throw error;
          if (error instanceof ArtifactCatalogScanLimitError) {
            throw new ProtocolError(
              ProtocolErrorCode.InternalError,
              "Artifact resource listing exceeded its scan limit.",
            );
          }
          throw new ProtocolError(
            ProtocolErrorCode.InternalError,
            "Artifact resource listing failed.",
          );
        }
      },
    }),
    {
      description: "Policy-filtered current SSRL artifacts.",
      cacheHint: MCP_ARTIFACT_CACHE_HINT,
      ...(artifactScopeChallenge === undefined
        ? {}
        : { scopeChallenge: artifactScopeChallenge }),
    },
    read,
  );

  server.registerResource(
    "artifact-version",
    new ResourceTemplate(ARTIFACT_VERSION_TEMPLATE, { list: undefined }),
    {
      description: "Policy-filtered immutable SSRL artifact version.",
      cacheHint: MCP_ARTIFACT_CACHE_HINT,
      ...(artifactScopeChallenge === undefined
        ? {}
        : { scopeChallenge: artifactScopeChallenge }),
    },
    read,
  );
}

export function createRuntimeMcpServer(
  options: RuntimeMcpServerOptions,
): McpServer {
  const server = new McpServer({
    name: options.name ?? "ssrl-runtime",
    version: options.version ?? "0.0.0",
  });

  registerArtifactResources(server, options);
  const planScopeChallenge = scopeChallenge(options.scopes?.plan);
  const applyScopeChallenge = scopeChallenge(options.scopes?.apply);
  const contextScopeChallenge = scopeChallenge(options.scopes?.context);

  if (options.context !== undefined) {
    server.registerTool(
      MCP_TOOL_NAMES.context,
      {
        description: "Compile policy-filtered current semantic context for one task and token budget.",
        inputSchema: mcpContextCompileInputSchema,
        outputSchema: mcpContextCompileOutputSchema,
        ...(contextScopeChallenge === undefined
          ? {}
          : { scopeChallenge: contextScopeChallenge }),
        annotations: {
          title: "Compile current semantic context",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ task, budgetTokens }) => {
        try {
          const result = await options.context!.gateway.compile({
            principal: options.principal,
            task,
            budgetTokens,
          });
          const structured = safeContextOutput(result, budgetTokens);
          return {
            content: [{ type: "text" as const, text: contextSummary(result) }],
            structuredContent: structured,
          };
        } catch (error) {
          return contextToolError(error);
        }
      },
    );
  }

  server.registerTool(
    MCP_TOOL_NAMES.plan,
    {
      description: "Plan policy-filtered state reconciliation without applying external mutations.",
      inputSchema: mcpPlanInputSchema,
      outputSchema: mcpPlanOutputSchema,
      ...(planScopeChallenge === undefined
        ? {}
        : { scopeChallenge: planScopeChallenge }),
      annotations: {
        title: "Plan state reconciliation",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ entityId }) => {
      try {
        const proposal = await options.host.plan(
          entityId as EntityId,
          options.principal,
        );
        const structured = {
          schemaVersion: "1" as const,
          entityId: proposal.plan.entityId,
          status: proposal.status,
          digestAlgorithm: proposal.digestAlgorithm,
          proposalDigest: proposal.digest,
          canonical: proposal.plan.canonical.properties,
          mutations: proposal.plan.mutations,
          conflicts: proposal.plan.conflicts,
          ...(proposal.journalRunId === undefined
            ? {}
            : { journalRunId: proposal.journalRunId }),
        };

        return {
          content: [{
            type: "text" as const,
            text: planText(
              structured.status,
              structured.proposalDigest,
              structured.mutations.length,
              structured.conflicts.length,
            ),
          }],
          structuredContent: structured,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    MCP_TOOL_NAMES.apply,
    {
      description: "Apply exactly one previously planned proposal digest after live re-validation.",
      inputSchema: mcpApplyInputSchema,
      outputSchema: mcpApplyOutputSchema,
      ...(applyScopeChallenge === undefined
        ? {}
        : { scopeChallenge: applyScopeChallenge }),
      annotations: {
        title: "Apply state reconciliation",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ entityId, proposalDigest }) => {
      try {
        const result = await options.host.apply(
          entityId as EntityId,
          proposalDigest,
          options.principal,
        );
        const finalPlan = result.after ?? result.before;
        const structured = {
          schemaVersion: "1" as const,
          entityId: finalPlan.entityId,
          appliedCount: result.applied.length,
          converged: finalPlan.mutations.length === 0
            && finalPlan.conflicts.length === 0,
          remainingMutationCount: finalPlan.mutations.length,
          conflictCount: finalPlan.conflicts.length,
          ...(result.journalRunId === undefined
            ? {}
            : { journalRunId: result.journalRunId }),
        };

        return {
          content: [{
            type: "text" as const,
            text: [
              `Applied mutations: ${structured.appliedCount}.`,
              `Converged: ${structured.converged}.`,
              `Remaining mutations: ${structured.remainingMutationCount}.`,
              `Conflicts: ${structured.conflictCount}.`,
            ].join(" "),
          }],
          structuredContent: structured,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}
