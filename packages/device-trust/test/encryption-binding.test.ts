import { describe, expect, it } from "vitest";
import { generateX25519KeyPair } from "@ssrl/e2e";
import {
  encryptionKeyIdentity,
  normalizeTrustedEncryptionKeyBinding,
  trustedEncryptionKeyBindingJson,
} from "../src/encryption-binding.js";

const principal = { subject: "user:alice", scopes: ["replication"] } as const;

describe("trusted encryption key binding", () => {
  it("binds an exact X25519 JWK thumbprint to a device signing generation", async () => {
    const pair = await generateX25519KeyPair();
    const binding = await normalizeTrustedEncryptionKeyBinding({
      subjectKind: "device-signing-key",
      subjectKeyId: "urn:ietf:params:oauth:jwk-thumbprint:sha-256:signing",
      deviceId: "device:phone",
      principal,
      encryptionKeyId: pair.keyId,
      publicKeyJwk: pair.publicKeyJwk,
      boundAt: "2026-09-25T03:00:00+03:00",
    });

    expect(binding.encryptionKeyId).toBe(pair.keyId);
    expect(binding.publicKeyJwk).toEqual(pair.publicKeyJwk);
    expect(binding.boundAt).toBe("2026-09-25T00:00:00.000Z");
  });

  it("binds a recovery encryption key to one recovery generation", async () => {
    const pair = await generateX25519KeyPair();
    const binding = await normalizeTrustedEncryptionKeyBinding({
      subjectKind: "recovery-credential",
      subjectKeyId: "recovery-signing-key",
      recoveryGeneration: 3,
      principal,
      encryptionKeyId: pair.keyId,
      publicKeyJwk: pair.publicKeyJwk,
      boundAt: "2026-09-25T00:00:00Z",
    });

    expect(binding.subjectKind).toBe("recovery-credential");
    if (binding.subjectKind !== "recovery-credential") throw new Error("expected recovery binding");
    expect(binding.recoveryGeneration).toBe(3);
  });

  it("rejects private/wrong-curve X25519 public inputs and mismatched thumbprints", async () => {
    const pair = await generateX25519KeyPair();
    await expect(encryptionKeyIdentity(pair.privateKeyJwk)).rejects.toThrow(/X25519 public JWK/);
    await expect(encryptionKeyIdentity({
      kty: "OKP",
      crv: "Ed25519",
      x: pair.publicKeyJwk.x,
    })).rejects.toThrow(/X25519 public JWK/);
    await expect(normalizeTrustedEncryptionKeyBinding({
      subjectKind: "device-signing-key",
      subjectKeyId: "signing",
      deviceId: "device:phone",
      principal,
      encryptionKeyId: "urn:ietf:params:oauth:jwk-thumbprint:sha-256:wrong",
      publicKeyJwk: pair.publicKeyJwk,
      boundAt: "2026-09-25T00:00:00Z",
    })).rejects.toThrow(/does not match/);
  });

  it("serializes equivalent device bindings canonically", async () => {
    const pair = await generateX25519KeyPair();
    const first = await trustedEncryptionKeyBindingJson({
      subjectKind: "device-signing-key",
      subjectKeyId: "signing-key",
      deviceId: "device:phone",
      principal: { subject: "user:alice", scopes: ["replication", "context:read"] },
      encryptionKeyId: pair.keyId,
      publicKeyJwk: pair.publicKeyJwk,
      boundAt: "2026-09-25T03:00:00+03:00",
    });
    const second = await trustedEncryptionKeyBindingJson({
      subjectKind: "device-signing-key",
      subjectKeyId: "signing-key",
      deviceId: "device:phone",
      principal: { subject: "user:alice", scopes: ["context:read", "replication"] },
      encryptionKeyId: pair.keyId,
      publicKeyJwk: pair.publicKeyJwk,
      boundAt: "2026-09-25T00:00:00Z",
    });

    expect(second).toBe(first);
    expect(first).not.toContain('"d"');
  });
});
