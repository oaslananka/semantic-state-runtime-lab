import { McpServer } from "@modelcontextprotocol/server";
import type {
  EntityId,
  StateValue,
} from "@ssrl/core";
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

export interface RuntimeMcpServerOptions {
  readonly host: RuntimeHost;
  readonly principal: RuntimePrincipal;
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

export function createRuntimeMcpServer(
  options: RuntimeMcpServerOptions,
): McpServer {
  const server = new McpServer({
    name: options.name ?? "ssrl-runtime",
    version: options.version ?? "0.0.0",
  });

  server.registerTool(
    MCP_TOOL_NAMES.plan,
    {
      description: "Plan policy-filtered state reconciliation without applying external mutations.",
      inputSchema: mcpPlanInputSchema,
      outputSchema: mcpPlanOutputSchema,
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
