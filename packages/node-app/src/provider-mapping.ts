import type { ConnectorEntityMapping } from "@ssrl/connector-sdk";
import type { LocalProviderConfig } from "./config.js";

function exactlyOneMapping(
  provider: LocalProviderConfig,
  predicate: (candidate: ConnectorEntityMapping) => boolean,
  label: string,
): ConnectorEntityMapping {
  const matches = provider.manifest.entities.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(`Provider ${provider.id} must declare ${label} exactly once`);
  }
  return matches[0]!;
}

export function providerEntityMapping(
  provider: LocalProviderConfig,
  canonicalType: string,
): ConnectorEntityMapping {
  return exactlyOneMapping(
    provider,
    (candidate) => candidate.canonicalType === canonicalType,
    `canonical type ${canonicalType}`,
  );
}

export function providerExternalTypeMapping(
  provider: LocalProviderConfig,
  externalType: string,
): ConnectorEntityMapping {
  return exactlyOneMapping(
    provider,
    (candidate) => candidate.externalType === externalType,
    `external type ${externalType}`,
  );
}
