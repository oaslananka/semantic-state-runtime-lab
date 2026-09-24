import { describe, expect, it } from "vitest";
import { normalizeAccessPrincipal } from "../src/index.js";

describe("access principal", () => {
  it("normalizes scopes deterministically without credential material", () => {
    expect(normalizeAccessPrincipal({
      subject: " user:alice ",
      scopes: ["artifact:read", "state:read", "artifact:read"],
    })).toEqual({
      subject: "user:alice",
      scopes: ["artifact:read", "state:read"],
    });
  });

  it("rejects empty identity fields", () => {
    expect(() => normalizeAccessPrincipal({ subject: " ", scopes: [] })).toThrow(/subject/);
    expect(() => normalizeAccessPrincipal({ subject: "user:alice", scopes: [""] })).toThrow(/scope/);
  });
});
