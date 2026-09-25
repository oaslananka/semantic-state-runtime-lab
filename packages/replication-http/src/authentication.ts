import type { AccessPrincipal } from "@ssrl/access";

export interface ReplicationHttpAuthentication {
  readonly principal: AccessPrincipal;
  readonly device?: {
    readonly keyId: string;
    readonly deviceId?: string;
  };
  /**
   * Optional post-read integrity check. The server invokes this only after the
   * request body has passed its configured byte bound and before parsing/domain work.
   */
  readonly verifyBody?: (bytes: Uint8Array) => boolean | Promise<boolean>;
}

export type ReplicationHttpAuthenticationResult =
  | AccessPrincipal
  | ReplicationHttpAuthentication
  | Response;

export interface ReplicationHttpAuthenticator {
  authenticate(
    request: Request,
  ): ReplicationHttpAuthenticationResult | Promise<ReplicationHttpAuthenticationResult>;
}
