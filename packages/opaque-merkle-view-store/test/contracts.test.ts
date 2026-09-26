import { describe, expect, it } from "vitest";
import { OpaqueMerkleSourceCheckpointError } from "../src/index.js";

describe("opaque Merkle view store contracts", () => {
  it("exposes a typed source-checkpoint failure", () => {
    expect(new OpaqueMerkleSourceCheckpointError().name).toBe("OpaqueMerkleSourceCheckpointError");
  });
});
