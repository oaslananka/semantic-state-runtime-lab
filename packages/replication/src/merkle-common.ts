export const DEFAULT_PREFIX_MERKLE_BITS = 12 as const;
export const SUPPORTED_PREFIX_MERKLE_BITS = [8, 12, 16] as const;
export type PrefixMerkleBits = (typeof SUPPORTED_PREFIX_MERKLE_BITS)[number];

export function resolvePrefixMerkleBits(value?: PrefixMerkleBits): PrefixMerkleBits {
  const resolved = value ?? DEFAULT_PREFIX_MERKLE_BITS;
  if (!SUPPORTED_PREFIX_MERKLE_BITS.includes(resolved)) {
    throw new RangeError(`prefixBits must be one of ${SUPPORTED_PREFIX_MERKLE_BITS.join(", ")}`);
  }
  return resolved;
}
