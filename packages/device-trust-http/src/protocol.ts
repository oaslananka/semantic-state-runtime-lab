export const DEVICE_TRUST_HTTP_SIGNATURE_TAG = "ssrl-device-trust-v1" as const;
export const DEVICE_TRUST_HTTP_ERROR_SCHEMA = "ssrl-device-trust-http-error-v1" as const;
export const DEVICE_TRUST_HTTP_CHALLENGE_SCHEMA = "ssrl-device-trust-http-challenge-v1" as const;
export const DEVICE_TRUST_HTTP_MUTATION_SCHEMA = "ssrl-device-trust-http-mutation-v1" as const;
export const DEVICE_TRUST_HTTP_RECOVERY_PROVISIONING_SCHEMA =
  "ssrl-device-trust-http-recovery-provisioning-v1" as const;
export const DEVICE_TRUST_HTTP_RECOVERY_CREDENTIAL_MUTATION_SCHEMA =
  "ssrl-device-trust-http-recovery-credential-mutation-v1" as const;
export const DEVICE_TRUST_HTTP_RECOVERY_CHALLENGE_SCHEMA =
  "ssrl-device-trust-http-recovery-challenge-v1" as const;
export const DEVICE_TRUST_HTTP_RECOVERY_MUTATION_SCHEMA =
  "ssrl-device-trust-http-recovery-mutation-v1" as const;

export const DEVICE_TRUST_HTTP_ROUTES = {
  startEnrollment: "/v1/device-trust/enrollments/start",
  completeEnrollment: "/v1/device-trust/enrollments/complete",
  startRotation: "/v1/device-trust/rotations/start",
  completeRotation: "/v1/device-trust/rotations/complete",
  revokeKey: "/v1/device-trust/keys/revoke",
  revokeDevice: "/v1/device-trust/devices/revoke",
  prepareRecoveryCredential: "/v1/device-trust/recovery-credentials/prepare",
  commitRecoveryCredential: "/v1/device-trust/recovery-credentials/commit",
  startRecovery: "/v1/device-trust/recovery/start",
  completeRecovery: "/v1/device-trust/recovery/complete",
} as const;

export type DeviceTrustHttpRoute = typeof DEVICE_TRUST_HTTP_ROUTES[keyof typeof DEVICE_TRUST_HTTP_ROUTES];

export interface DeviceTrustHttpErrorBody {
  readonly schema: typeof DEVICE_TRUST_HTTP_ERROR_SCHEMA;
  readonly code: string;
  readonly message: string;
}
