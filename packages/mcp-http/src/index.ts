import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
  requireBearerAuth,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import {
  normalizeAccessPrincipal,
  type AccessPrincipal,
} from "@ssrl/access";
import {
  createRuntimeMcpServer,
  type RuntimeMcpArtifactOptions,
  type RuntimeMcpScopeOptions,
} from "@ssrl/mcp-server";
import type { RuntimeHost } from "@ssrl/runtime-host";

export interface VerifiedMcpAuthContext {
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
  readonly resource?: URL;
  readonly resourceMetadataUrl?: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface McpAuthPrincipalMapper {
  map(auth: VerifiedMcpAuthContext): AccessPrincipal | Promise<AccessPrincipal>;
}

export interface SubjectClaimPrincipalMapperOptions {
  readonly claim?: string;
  readonly prefix?: string;
}

export interface AuthenticatedRuntimeMcpHttpOptions {
  readonly host: RuntimeHost;
  readonly verifier: OAuthTokenVerifier;
  readonly principalMapper: McpAuthPrincipalMapper;
  readonly artifacts?: RuntimeMcpArtifactOptions;
  readonly endpointScopes?: readonly string[];
  readonly operationScopes?: RuntimeMcpScopeOptions;
  readonly resourceMetadataUrl?: string;
  readonly allowedHostnames: readonly string[];
  readonly allowedOriginHostnames?: readonly string[];
  readonly maxRequestBodySize?: number;
  readonly name?: string;
  readonly version?: string;
}

export interface AuthenticatedRuntimeMcpHttpHandler {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export class McpPrincipalMappingError extends Error {
  constructor() {
    super("Authenticated principal mapping failed.");
    this.name = "McpPrincipalMappingError";
  }
}

function nonEmptyStrings(values: readonly string[], label: string): string[] {
  const normalized = values.map((value) => value.trim());
  if (normalized.length === 0 || normalized.some((value) => value.length === 0)) {
    throw new TypeError(`${label} must contain non-empty values`);
  }
  return [...new Set(normalized)].toSorted((left, right) => left.localeCompare(right));
}

function verifiedAuthContext(authInfo: AuthInfo): VerifiedMcpAuthContext {
  if (authInfo.expiresAt === undefined) {
    throw new McpPrincipalMappingError();
  }
  return {
    clientId: authInfo.clientId,
    scopes: [...authInfo.scopes],
    expiresAt: authInfo.expiresAt,
    ...(authInfo.resource === undefined ? {} : { resource: authInfo.resource }),
    ...(authInfo.resourceMetadataUrl === undefined
      ? {}
      : { resourceMetadataUrl: authInfo.resourceMetadataUrl }),
    ...(authInfo.extra === undefined ? {} : { extra: authInfo.extra }),
  };
}

export function subjectClaimPrincipalMapper(
  options: SubjectClaimPrincipalMapperOptions = {},
): McpAuthPrincipalMapper {
  const claim = options.claim ?? "sub";
  const prefix = options.prefix ?? "";
  if (claim.trim().length === 0) throw new TypeError("subject claim must not be empty");
  return {
    map(auth) {
      const subject = auth.extra?.[claim];
      if (typeof subject !== "string" || subject.trim().length === 0) {
        throw new McpPrincipalMappingError();
      }
      return normalizeAccessPrincipal({
        subject: `${prefix}${subject.trim()}`,
        scopes: auth.scopes,
      });
    },
  };
}

function safePrincipalMapper(
  mapper: McpAuthPrincipalMapper,
): McpAuthPrincipalMapper {
  return {
    async map(auth) {
      try {
        return normalizeAccessPrincipal(await mapper.map(auth));
      } catch {
        throw new McpPrincipalMappingError();
      }
    },
  };
}

export const DEFAULT_REMOTE_MCP_OPERATION_SCOPES: RuntimeMcpScopeOptions = {
  plan: ["state:read"],
  apply: ["state:write"],
  artifacts: ["artifact:read"],
} as const;

export function createAuthenticatedRuntimeMcpHttpHandler(
  options: AuthenticatedRuntimeMcpHttpOptions,
): AuthenticatedRuntimeMcpHttpHandler {
  const allowedHostnames = nonEmptyStrings(options.allowedHostnames, "allowedHostnames");
  const allowedOriginHostnames = options.allowedOriginHostnames === undefined
    ? allowedHostnames
    : nonEmptyStrings(options.allowedOriginHostnames, "allowedOriginHostnames");
  const endpointScopes = nonEmptyStrings(options.endpointScopes ?? ["mcp"], "endpointScopes");
  const mapper = safePrincipalMapper(options.principalMapper);
  const authGate = requireBearerAuth({
    verifier: options.verifier,
    requiredScopes: endpointScopes,
    ...(options.resourceMetadataUrl === undefined
      ? {}
      : { resourceMetadataUrl: options.resourceMetadataUrl }),
  });

  const mcp = createMcpHandler(async (ctx) => {
    if (ctx.authInfo === undefined) throw new McpPrincipalMappingError();
    const principal = await mapper.map(verifiedAuthContext(ctx.authInfo));
    return createRuntimeMcpServer({
      host: options.host,
      principal,
      ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
      scopes: options.operationScopes ?? DEFAULT_REMOTE_MCP_OPERATION_SCOPES,
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.version === undefined ? {} : { version: options.version }),
    });
  }, {
    legacy: "reject",
    ...(options.maxRequestBodySize === undefined
      ? {}
      : { maxRequestBodySize: options.maxRequestBodySize }),
  });

  return {
    async fetch(request) {
      const rejectedHost = hostHeaderValidationResponse(request, allowedHostnames);
      if (rejectedHost !== undefined) return rejectedHost;
      const rejectedOrigin = originValidationResponse(request, allowedOriginHostnames);
      if (rejectedOrigin !== undefined) return rejectedOrigin;
      const auth = await authGate(request);
      if (auth instanceof Response) return auth;
      return mcp.fetch(request, { authInfo: auth });
    },
    close: mcp.close,
  };
}
