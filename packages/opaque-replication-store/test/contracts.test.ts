import { describe, expect, it } from "vitest";
import { normalizeVaultEpochId } from "@ssrl/e2e";
import { normalizeOpaqueReplicationTag } from "@ssrl/replication/encrypted";
import {
  DEFAULT_OPAQUE_CATALOG_MAX_BYTES,
  DEFAULT_OPAQUE_CATALOG_MAX_DESCRIPTORS,
  DEFAULT_OPAQUE_CHANGE_MAX_BYTES,
  DEFAULT_OPAQUE_CHANGE_MAX_DESCRIPTORS,
  DEFAULT_OPAQUE_OBJECT_READ_MAX_BYTES,
  normalizeOpaqueObjectLocator,
  opaqueCatalogLimits,
  opaqueChangeLimits,
  opaqueObjectReadLimit,
} from "../src/index.js";

const epochId = normalizeVaultEpochId("urn:ssrl:vault-epoch:AAAAAAAAAAAAAAAAAAAAAA");
const opaqueKey = normalizeOpaqueReplicationTag(`hmac-sha256:${"A".repeat(43)}`);

describe("opaque replication store contracts", () => {
  it("normalizes locators using the encrypted replication validators", () => {
    expect(normalizeOpaqueObjectLocator({ epochId, opaqueKey })).toEqual({ epochId, opaqueKey });
  });

  it("uses bounded defaults and rejects invalid limits", () => {
    expect(opaqueObjectReadLimit()).toBe(DEFAULT_OPAQUE_OBJECT_READ_MAX_BYTES);
    expect(opaqueCatalogLimits({ epochId })).toEqual({
      epochId,
      maxDescriptors: DEFAULT_OPAQUE_CATALOG_MAX_DESCRIPTORS,
      maxBytes: DEFAULT_OPAQUE_CATALOG_MAX_BYTES,
    });
    expect(() => opaqueObjectReadLimit(0)).toThrow(RangeError);
    expect(() => opaqueCatalogLimits({ epochId, maxDescriptors: 0 })).toThrow(RangeError);
    expect(opaqueChangeLimits()).toEqual({
      maxDescriptors: DEFAULT_OPAQUE_CHANGE_MAX_DESCRIPTORS,
      maxBytes: DEFAULT_OPAQUE_CHANGE_MAX_BYTES,
    });
    expect(() => opaqueChangeLimits({ maxBytes: 0 })).toThrow(RangeError);
  });
});
