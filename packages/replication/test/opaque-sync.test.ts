import { describe, expect, it } from "vitest";
import { generateVaultEpoch } from "@ssrl/e2e";
import { temporalObservationJson } from "@ssrl/state-store";
import { createReplicationRecord, type ReplicationRecord } from "../src/index.js";
import {
  opaqueReplicationRecordDescriptor,
  type OpaqueReplicationDescriptor,
} from "../src/encrypted.js";
import {
  buildOpaquePrefixMerkleIndex,
  OpaqueReplicationEpochMismatchError,
} from "../src/opaque-merkle.js";
import {
  FrozenOpaquePrefixMerkleView,
  InMemoryOpaqueReconciliationEndpoint,
  InMemoryOpaqueReconciliationViewRegistry,
  InvalidReconciliationCursorError,
  OpaqueBoundedReconciliationSession,
  StaleReconciliationViewError,
  type OpaqueReconciliationResult,
  type ReconciliationSessionOptions,
} from "../src/opaque-sync.js";

const project = "entity://project/opaque-sync" as const;

async function record(id: string, value = id): Promise<ReplicationRecord> {
  return createReplicationRecord({
    kind: "semantic-observation",
    recordId: id,
    payload: temporalObservationJson({
      id,
      entityId: project,
      property: "Project.private",
      value,
      source: { provider: "opaque-sync-test", externalId: id, revision: id },
      validFrom: "2026-09-01T00:00:00Z",
      recordedAt: "2026-09-01T00:00:00Z",
    }),
  });
}

async function descriptor(
  epoch: ReturnType<typeof generateVaultEpoch>,
  id: string,
  value = id,
): Promise<OpaqueReplicationDescriptor> {
  return opaqueReplicationRecordDescriptor({
    epochId: epoch.epochId,
    epochSecret: epoch.secret,
    record: await record(id, value),
  });
}

async function descriptors(
  epoch: ReturnType<typeof generateVaultEpoch>,
  count: number,
  start = 0,
): Promise<OpaqueReplicationDescriptor[]> {
  const result: OpaqueReplicationDescriptor[] = [];
  for (let offset = 0; offset < count; offset += 128) {
    const length = Math.min(128, count - offset);
    result.push(...await Promise.all(Array.from({ length }, (_, index) => {
      const ordinal = start + offset + index;
      return descriptor(epoch, `opaque-sync-${String(ordinal).padStart(6, "0")}`, `secret-${ordinal}`);
    })));
  }
  return result;
}

async function fixture(
  local: readonly OpaqueReplicationDescriptor[],
  remote: readonly OpaqueReplicationDescriptor[],
  options: ReconciliationSessionOptions = {},
) {
  const [localIndex, remoteIndex] = await Promise.all([
    buildOpaquePrefixMerkleIndex(local, { prefixBits: 8 }),
    buildOpaquePrefixMerkleIndex(remote, { prefixBits: 8 }),
  ]);
  const localView = await FrozenOpaquePrefixMerkleView.open(localIndex);
  const remoteRegistry = new InMemoryOpaqueReconciliationViewRegistry();
  const remoteView = await remoteRegistry.open(remoteIndex);
  const remoteEndpoint = new InMemoryOpaqueReconciliationEndpoint(remoteRegistry);
  const session = await OpaqueBoundedReconciliationSession.start(
    localView,
    remoteEndpoint,
    remoteView.info().viewId,
    options,
  );
  return {
    localView,
    remoteRegistry,
    remoteView,
    remoteEndpoint,
    session,
  };
}

function resultComparable(result: OpaqueReconciliationResult) {
  return {
    localOnly: result.localOnly,
    remoteOnly: result.remoteOnly,
    collisions: result.collisions,
  };
}

describe("opaque bounded reconciliation", () => {
  it("reconciles same-epoch deltas using only opaque keys", async () => {
    const epoch = generateVaultEpoch();
    const shared = await descriptors(epoch, 64);
    const localExtra = await descriptors(epoch, 4, 10_000);
    const remoteExtra = await descriptors(epoch, 5, 20_000);
    const runtime = await fixture(
      [...shared, ...localExtra],
      [...shared, ...remoteExtra],
      { maxLeafDescriptors: 3 },
    );
    const result = await runtime.session.runToCompletion(runtime.localView, runtime.remoteEndpoint);

    expect(result.localOnly).toEqual(
      localExtra.map((item) => item.opaqueKey).toSorted((a, b) => a.localeCompare(b)),
    );
    expect(result.remoteOnly).toEqual(
      remoteExtra.map((item) => item.opaqueKey).toSorted((a, b) => a.localeCompare(b)),
    );
    expect(result.collisions).toEqual([]);
    expect(result.counters.remoteNodeQueries).toBeGreaterThan(0);
  });

  it("pages opaque leaf descriptors deterministically under descriptor and byte limits", async () => {
    const epoch = generateVaultEpoch();
    const source = await descriptors(epoch, 1_024);
    const index = await buildOpaquePrefixMerkleIndex(source, { prefixBits: 8 });
    const snapshot = index.snapshot();
    const leaf = snapshot.nonEmptyLeaves
      .toSorted((left, right) => right.recordCount - left.recordCount)[0];
    if (leaf === undefined || leaf.recordCount < 3) throw new Error("expected a populated opaque leaf");
    const view = await FrozenOpaquePrefixMerkleView.open(index);
    const seen: OpaqueReplicationDescriptor[] = [];
    let cursor: Awaited<ReturnType<typeof view.leafPage>>["nextCursor"];
    do {
      const page = await view.leafPage({
        leafId: leaf.leafId,
        ...(cursor === undefined ? {} : { cursor }),
        maxDescriptors: 2,
        maxBytes: 1_024,
      });
      expect(page.descriptors.length).toBeLessThanOrEqual(2);
      expect(page.estimatedBytes).toBeLessThanOrEqual(1_024);
      seen.push(...page.descriptors);
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    expect(seen.map((item) => item.opaqueKey)).toEqual(
      leaf.descriptors.map((item) => item.opaqueKey),
    );
    const serialized = JSON.stringify(seen);
    expect(serialized).not.toContain("opaque-sync-");
    expect(serialized).not.toContain("secret-");
    expect(serialized).not.toContain('"payloadDigest"');
    expect(serialized).not.toContain('"recordId"');
  });

  it("serializes and resumes mid-session with the same final opaque delta", async () => {
    const epoch = generateVaultEpoch();
    const base = await descriptors(epoch, 320);
    const extras = await descriptors(epoch, 10, 30_000);
    const local = base;
    const remote = [...base.slice(7), ...extras];
    const runtime = await fixture(local, remote, { maxLeafDescriptors: 2 });

    await runtime.session.step(runtime.localView, runtime.remoteEndpoint);
    expect(runtime.session.complete).toBe(false);
    const encoded = runtime.session.encode();
    expect(encoded).not.toContain("opaque-sync-");
    expect(encoded).not.toContain("secret-");
    expect(encoded).not.toContain('"payloadDigest"');
    const restored = await OpaqueBoundedReconciliationSession.restore(encoded);
    expect(restored.encode()).toBe(encoded);

    const result = await restored.runToCompletion(runtime.localView, runtime.remoteEndpoint);
    expect(result.localOnly).toEqual(
      base.slice(0, 7).map((item) => item.opaqueKey).toSorted((a, b) => a.localeCompare(b)),
    );
    expect(result.remoteOnly).toEqual(
      extras.map((item) => item.opaqueKey).toSorted((a, b) => a.localeCompare(b)),
    );
  });

  it("reports same opaque key with divergent content as a collision, never LWW", async () => {
    const epoch = generateVaultEpoch();
    const [left, right] = await Promise.all([
      descriptor(epoch, "collision", "active1"),
      descriptor(epoch, "collision", "paused1"),
    ]);
    const runtime = await fixture([left], [right]);
    const result = await runtime.session.runToCompletion(runtime.localView, runtime.remoteEndpoint);

    expect(result.localOnly).toEqual([]);
    expect(result.remoteOnly).toEqual([]);
    expect(result.collisions).toEqual([{
      epochId: epoch.epochId,
      opaqueKey: left.opaqueKey,
      localContentTag: left.opaqueContentTag,
      remoteContentTag: right.opaqueContentTag,
    }]);
  });

  it("rejects cross-epoch sessions before any reconciliation work", async () => {
    const firstEpoch = generateVaultEpoch();
    const secondEpoch = generateVaultEpoch();
    const localIndex = await buildOpaquePrefixMerkleIndex(
      await descriptors(firstEpoch, 4),
      { prefixBits: 8 },
    );
    const remoteIndex = await buildOpaquePrefixMerkleIndex(
      await descriptors(secondEpoch, 4),
      { prefixBits: 8 },
    );
    const localView = await FrozenOpaquePrefixMerkleView.open(localIndex);
    const registry = new InMemoryOpaqueReconciliationViewRegistry();
    const remoteView = await registry.open(remoteIndex);
    const endpoint = new InMemoryOpaqueReconciliationEndpoint(registry);

    await expect(OpaqueBoundedReconciliationSession.start(
      localView,
      endpoint,
      remoteView.info().viewId,
    )).rejects.toBeInstanceOf(OpaqueReplicationEpochMismatchError);
  });

  it("fails typed when a pinned remote opaque view expires", async () => {
    const epoch = generateVaultEpoch();
    const local = await descriptors(epoch, 32);
    const remote = [...local, await descriptor(epoch, "stale-extra")];
    const runtime = await fixture(local, remote);
    expect(runtime.remoteRegistry.expire(runtime.remoteView.info().viewId)).toBe(true);

    await expect(runtime.session.step(runtime.localView, runtime.remoteEndpoint))
      .rejects.toBeInstanceOf(StaleReconciliationViewError);
  });

  it("rejects a leaf cursor from another frozen opaque view", async () => {
    const epoch = generateVaultEpoch();
    const source = await descriptors(epoch, 1_024);
    const index = await buildOpaquePrefixMerkleIndex(source, { prefixBits: 8 });
    const leaf = index.snapshot().nonEmptyLeaves
      .toSorted((left, right) => right.recordCount - left.recordCount)[0];
    if (leaf === undefined || leaf.recordCount < 2) throw new Error("expected populated leaf");
    const first = await FrozenOpaquePrefixMerkleView.open(index);
    const second = await FrozenOpaquePrefixMerkleView.open(index);
    const page = await first.leafPage({
      leafId: leaf.leafId,
      maxDescriptors: 1,
      maxBytes: 1_024,
    });
    if (page.nextCursor === undefined) throw new Error("expected leaf cursor");

    await expect(second.leafPage({
      leafId: leaf.leafId,
      cursor: page.nextCursor,
      maxDescriptors: 1,
      maxBytes: 1_024,
    })).rejects.toBeInstanceOf(InvalidReconciliationCursorError);
  });

  it("keeps public opaque reconciliation objects free of plaintext replication metadata", async () => {
    const epoch = generateVaultEpoch();
    const source = await descriptors(epoch, 16);
    const index = await buildOpaquePrefixMerkleIndex(source, { prefixBits: 8 });
    const view = await FrozenOpaquePrefixMerkleView.open(index);
    const info = view.info();
    const leaf = index.snapshot().nonEmptyLeaves[0];
    if (leaf === undefined) throw new Error("expected leaf");
    const page = await view.leafPage({ leafId: leaf.leafId, maxDescriptors: 4, maxBytes: 4_096 });
    const serialized = JSON.stringify({ info, page });

    expect(serialized).toContain(epoch.epochId);
    expect(serialized).not.toContain("opaque-sync-");
    expect(serialized).not.toContain("secret-");
    expect(serialized).not.toContain(project);
    expect(serialized).not.toContain('"kind"');
    expect(serialized).not.toContain('"recordId"');
    expect(serialized).not.toContain('"payloadDigest"');
    expect(serialized).not.toContain('"payload"');
    expect(serialized).not.toContain('"ciphertext"');
  });

  it("produces the same result after repeated bounded steps as one runToCompletion", async () => {
    const epoch = generateVaultEpoch();
    const shared = await descriptors(epoch, 96);
    const localExtra = await descriptors(epoch, 3, 50_000);
    const remoteExtra = await descriptors(epoch, 4, 60_000);
    const first = await fixture([...shared, ...localExtra], [...shared, ...remoteExtra], {
      maxNodeRefsPerStep: 2,
      maxLeafDescriptors: 1,
    });
    const second = await fixture([...shared, ...localExtra], [...shared, ...remoteExtra], {
      maxNodeRefsPerStep: 2,
      maxLeafDescriptors: 1,
    });

    while (!first.session.complete) await first.session.step(first.localView, first.remoteEndpoint);
    const one = resultComparable(first.session.result());
    const two = resultComparable(
      await second.session.runToCompletion(second.localView, second.remoteEndpoint),
    );
    expect(one).toEqual(two);
  });
});
