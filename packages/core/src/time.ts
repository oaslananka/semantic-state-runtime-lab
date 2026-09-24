export function timestamp(value: string, label: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(`Invalid ${label} timestamp: ${value}`);
  return result;
}

export function temporalWindowIsActive(input: {
  readonly validFrom: string;
  readonly recordedAt: string;
  readonly validAt: number;
  readonly knownAt: number;
  readonly effectiveValidTo: number;
}): boolean {
  return Date.parse(input.validFrom) <= input.validAt
    && input.validAt < input.effectiveValidTo
    && Date.parse(input.recordedAt) <= input.knownAt;
}
