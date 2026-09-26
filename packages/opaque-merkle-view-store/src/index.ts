import type { VaultEpochId } from "@ssrl/e2e";
import type {
  OpaqueReconciliationEndpoint,
  OpaqueReconciliationViewInfo,
} from "@ssrl/replication/opaque-sync";

export interface OpaqueMerkleCatchUpResult {
  readonly bootstrapped: boolean;
  readonly pages: number;
  readonly descriptorsRead: number;
  readonly descriptorsInserted: number;
}

export interface OpaqueMerkleViewProvider extends OpaqueReconciliationEndpoint {
  catchUp(): Promise<OpaqueMerkleCatchUpResult>;
  openView(epochId: VaultEpochId): Promise<OpaqueReconciliationViewInfo>;
  expireView(viewId: string): boolean;
}

export class OpaqueMerkleSourceCheckpointError extends Error {
  constructor(message = "Opaque Merkle source checkpoint does not belong to the configured source") {
    super(message);
    this.name = "OpaqueMerkleSourceCheckpointError";
  }
}
