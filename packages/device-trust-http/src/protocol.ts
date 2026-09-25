export const DEVICE_TRUST_HTTP_SIGNATURE_TAG = "ssrl-device-trust-v1" as const;
export const DEVICE_TRUST_HTTP_ERROR_SCHEMA = "ssrl-device-trust-http-error-v1" as const;
export const DEVICE_TRUST_HTTP_CHALLENGE_SCHEMA = "ssrl-device-trust-http-challenge-v1" as const;
export const DEVICE_TRUST_HTTP_MUTATION_SCHEMA = "ssrl-device-trust-http-mutation-v1" as const;

export const DEVICE_TRUST_HTTP_ROUTES = {
  startEnrollment: "/v1/device-trust/enrollments/start",
  completeEnrollment: "/v1/device-trust/enrollments/complete",
  startRotation: "/v1/device-trust/rotations/start",
  completeRotation: "/v1/device-trust/rotations/complete",
  revokeKey: "/v1/device-trust/keys/revoke",
  revokeDevice: "/v1/device-trust/devices/revoke",
} as const;

export type DeviceTrustHttpRoute = typeof DEVICE_TRUST_HTTP_ROUTES[keyof typeof DEVICE_TRUST_HTTP_ROUTES];

export interface DeviceTrustHttpErrorBody {
  readonly schema: typeof DEVICE_TRUST_HTTP_ERROR_SCHEMA;
  readonly code: string;
  readonly message: string;
}
