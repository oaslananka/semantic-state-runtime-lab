import { describe, expect, it } from "vitest";
import {
  diffReplicationDescriptors,
  replicationRecordFingerprint,
  replicationRecordKey,
  type ReplicationRecordDescriptor,
  type ReplicationRecordKind,
} from "../src/index.js";
import {
  buildPrefixMerkleIndex,
  prefixMerkleLeafIdForKey,
  restorePrefixMerkleIndex,
} from "../src/merkle.js";
import {
  BoundedReconciliationSession,
  FrozenPrefixMerkleView,
  InMemoryReconciliationEndpoint,
  InMemoryReconciliationViewRegistry,
  InvalidReconciliationCursorError,
  ReconciliationBudgetExceededError,
  ReconciliationLimitError,
  StaleReconciliationViewError,
  type ReconciliationEndpoint,
  type ReconciliationLeafCursor,
  type ReconciliationResult,
  type ReconciliationSessionOptions,
} from "../src/sync.js";

const kind = "semantic-observation" as const;
const payloadDigest = `sha256:${"a".repeat(64)}`;

async function descriptor(
  recordId: string,
  digest = payloadDigest,
  recordKind: ReplicationRecordKind = kind,
  payloadBytes = 1,
): Promise<ReplicationRecordDescriptor> {
  const key = replicationRecordKey(recordKind, recordId);
  return {
    key,
    kind: recordKind,
    recordId,
    payloadDigest: digest,
    fingerprint: await replicationRecordFingerprint(key, digest),
    payloadBytes,
  };
}

async function descriptors(
  count: number,
  start = 0,
  recordKind: ReplicationRecordKind = kind,
): Promise<ReplicationRecordDescriptor[]> {
  const result: ReplicationRecordDescriptor[] = [];
  const batchSize = 1_000;
  for (let offset = 0; offset < count; offset += batchSize) {
    const length = Math.min(batchSize, count - offset);
    result.push(...await Promise.all(Array.from({ length }, (_, index) => (
      descriptor(`sync-${String(start + offset + index).padStart(8, "0")}`, payloadDigest, recordKind)
    ))));
  }
  return result;
}

async function sameLeafDescriptors(count: number): Promise<{
  readonly leafId: number;
  readonly descriptors: readonly ReplicationRecordDescriptor[];
}> {
  let target: number | undefined;
  const result: ReplicationRecordDescriptor[] = [];
  for (let ordinal = 0; result.length < count; ordinal += 1) {
    const recordId = `hot-${String(ordinal).padStart(8, "0")}`;
    const key = replicationRecordKey(kind, recordId);
    const leafId = await prefixMerkleLeafIdForKey(key, 8);
    if (target === undefined) target = leafId;
    if (leafId !== target) continue;
    result.push({
      key,
      kind,
      recordId,
      payloadDigest,
      fingerprint: await replicationRecordFingerprint(key, payloadDigest),
      payloadBytes: 1,
    });
  }
  return { leafId: target!, descriptors: result };
}

interface SessionFixture {
  readonly localView: FrozenPrefixMerkleView;
  readonly remoteRegistry: InMemoryReconciliationViewRegistry;
  readonly remoteEndpoint: InMemoryReconciliationEndpoint;
  readonly remoteViewId: string;
  readonly session: BoundedReconciliationSession;
}

async function sessionFixture(
  localDescriptors: readonly ReplicationRecordDescriptor[],
  remoteDescriptors: readonly ReplicationRecordDescriptor[],
  options: ReconciliationSessionOptions = {},
): Promise<SessionFixture> {
  const [localIndex, remoteIndex] = await Promise.all([
    buildPrefixMerkleIndex(localDescriptors, { prefixBits: 8 }),
    buildPrefixMerkleIndex(remoteDescriptors, { prefixBits: 8 }),
  ]);
  const localView = await FrozenPrefixMerkleView.open(localIndex);
  const remoteRegistry = new InMemoryReconciliationViewRegistry();
  const remoteView = await remoteRegistry.open(remoteIndex);
  const remoteEndpoint = new InMemoryReconciliationEndpoint(remoteRegistry);
  const remoteViewId = remoteView.info().viewId;
  const session = await BoundedReconciliationSession.start(
    localView,
    remoteEndpoint,
    remoteViewId,
    options,
  );
  return { localView, remoteRegistry, remoteEndpoint, remoteViewId, session };
}

function comparableResult(result: ReconciliationResult) {
  return {
    localOnly: result.localOnly,
    remoteOnly: result.remoteOnly,
    collisions: result.collisions,
  };
}

function flatComparable(
  local: readonly ReplicationRecordDescriptor[],
  remote: readonly ReplicationRecordDescriptor[],
) {
  const diff = diffReplicationDescriptors(local, remote);
  return {
    localOnly: diff.localOnly,
    remoteOnly: diff.remoteOnly,
    collisions: diff.collisions,
  };
}

describe("bounded reconciliation views", () => {
  it("pins node responses to an immutable root even when the live index mutates", async () => {
    const base = await descriptors(32);
    const live = await buildPrefixMerkleIndex(base, { prefixBits: 8 });
    const view = await FrozenPrefixMerkleView.open(live);
    const before = view.info();
    const rootResponse = view.nodeHashes([{ level: 8, index: 0 }]);
    const extra = await descriptor("live-after-view");
    const extraLeaf = await prefixMerkleLeafIdForKey(extra.key, 8);

    await live.add(extra);

    expect(live.rootDigest).not.toBe(before.rootDigest);
    expect(view.info()).toEqual(before);
    expect(rootResponse).toEqual({
      viewId: before.viewId,
      rootDigest: before.rootDigest,
      nodes: [{ level: 8, index: 0, hash: before.rootDigest }],
    });
    const page = await view.leafPage({ leafId: extraLeaf, maxDescriptors: 128, maxBytes: 65_536 });
    expect(page.descriptors.map((value) => value.key)).not.toContain(extra.key);
    expect(page.rootDigest).toBe(before.rootDigest);
    expect(page.viewId).toBe(before.viewId);
  });

  it("bounds node queries and fails closed for invalid tree references", async () => {
    const index = await buildPrefixMerkleIndex(await descriptors(4), { prefixBits: 8 });
    const view = await FrozenPrefixMerkleView.open(index);

    expect(() => view.nodeHashes(
      [{ level: 8, index: 0 }, { level: 7, index: 0 }, { level: 7, index: 1 }],
      { maxNodeRefs: 2 },
    )).toThrow(ReconciliationLimitError);
    expect(() => view.nodeHashes([{ level: 9, index: 0 }])).toThrow(/Merkle level/);
    expect(() => view.nodeHashes([{ level: 0, index: 256 }])).toThrow(/outside level/);
  });

  it("pages a hot leaf deterministically under descriptor and byte limits", async () => {
    const hot = await sameLeafDescriptors(20);
    const index = await buildPrefixMerkleIndex(hot.descriptors, { prefixBits: 8 });
    const view = await FrozenPrefixMerkleView.open(index);
    const seen: ReplicationRecordDescriptor[] = [];
    let cursor: ReconciliationLeafCursor | undefined;
    let pages = 0;

    do {
      const page = await view.leafPage({
        leafId: hot.leafId,
        ...(cursor === undefined ? {} : { cursor }),
        maxDescriptors: 3,
        maxBytes: 65_536,
      });
      expect(page.descriptors.length).toBeLessThanOrEqual(3);
      expect(page.estimatedBytes).toBeLessThanOrEqual(65_536);
      expect(page.viewId).toBe(view.info().viewId);
      expect(page.rootDigest).toBe(view.info().rootDigest);
      expect(page.descriptors.every((value) => !Object.hasOwn(value, "payload"))).toBe(true);
      seen.push(...page.descriptors);
      cursor = page.nextCursor;
      pages += 1;
      if (page.completed) expect(cursor).toBeUndefined();
    } while (cursor !== undefined);

    expect(pages).toBe(7);
    expect(seen.map((value) => value.key)).toEqual(
      [...hot.descriptors].sort((left, right) => left.key.localeCompare(right.key)).map((value) => value.key),
    );

    const first = await view.leafPage({ leafId: hot.leafId, maxDescriptors: 3, maxBytes: 65_536 });
    const replay = await view.leafPage({ leafId: hot.leafId, maxDescriptors: 3, maxBytes: 65_536 });
    expect(replay).toEqual(first);
    const byteBounded = await view.leafPage({
      leafId: hot.leafId,
      maxDescriptors: 20,
      maxBytes: 700,
    });
    expect(byteBounded.descriptors.length).toBeGreaterThan(0);
    expect(byteBounded.descriptors.length).toBeLessThan(20);
    expect(byteBounded.estimatedBytes).toBeLessThanOrEqual(700);
    expect(byteBounded.completed).toBe(false);
    await expect(view.leafPage({
      leafId: hot.leafId,
      maxDescriptors: 1,
      maxBytes: 64,
    })).rejects.toBeInstanceOf(ReconciliationLimitError);
  });

  it("rejects tampered and cross-view leaf cursors", async () => {
    const hot = await sameLeafDescriptors(8);
    const index = await buildPrefixMerkleIndex(hot.descriptors, { prefixBits: 8 });
    const firstView = await FrozenPrefixMerkleView.open(index);
    const secondView = await FrozenPrefixMerkleView.open(index);
    const firstPage = await firstView.leafPage({
      leafId: hot.leafId,
      maxDescriptors: 2,
      maxBytes: 65_536,
    });
    if (firstPage.nextCursor === undefined) throw new Error("expected page cursor");
    const cursor = firstPage.nextCursor;
    const replacement = cursor.endsWith("0") ? "1" : "0";
    const tampered = `${cursor.slice(0, -1)}${replacement}` as ReconciliationLeafCursor;

    await expect(firstView.leafPage({ leafId: hot.leafId, cursor: tampered }))
      .rejects.toBeInstanceOf(InvalidReconciliationCursorError);
    await expect(secondView.leafPage({ leafId: hot.leafId, cursor }))
      .rejects.toBeInstanceOf(InvalidReconciliationCursorError);
  });

  it("expires views explicitly instead of silently rebasing them", async () => {
    const index = await buildPrefixMerkleIndex(await descriptors(2), { prefixBits: 8 });
    const registry = new InMemoryReconciliationViewRegistry();
    const view = await registry.open(index);
    const id = view.info().viewId;

    expect(registry.get(id).info()).toEqual(view.info());
    expect(registry.expire(id)).toBe(true);
    expect(() => registry.get(id)).toThrow(StaleReconciliationViewError);
  });
});


describe("bounded reconciliation sessions", () => {
  it("completes equal roots after view/root comparison with zero node or leaf requests", async () => {
    const base = await descriptors(256);
    const fixture = await sessionFixture(base, [...base].reverse());

    expect(fixture.session.complete).toBe(true);
    expect(fixture.session.result()).toEqual({
      localOnly: [],
      remoteOnly: [],
      collisions: [],
      counters: {
        steps: 0,
        remoteNodeQueries: 0,
        remoteNodeHashes: 0,
        remoteLeafPages: 0,
        remoteLeafDescriptors: 0,
        remoteLeafBytes: 0,
      },
    });
  });

  it("matches flat v0 for 100k + one record and 100k 10+10 deltas", async () => {
    const base = await descriptors(100_000);
    const localIndex = await buildPrefixMerkleIndex(base, { prefixBits: 8 });
    const localView = await FrozenPrefixMerkleView.open(localIndex);
    const registry = new InMemoryReconciliationViewRegistry();
    const endpoint = new InMemoryReconciliationEndpoint(registry);

    const oneExtra = await descriptor("sync-one-extra");
    const oneIndex = await restorePrefixMerkleIndex(localIndex.snapshot());
    await oneIndex.add(oneExtra);
    const oneRemote = await registry.open(oneIndex);
    const oneSession = await BoundedReconciliationSession.start(
      localView,
      endpoint,
      oneRemote.info().viewId,
      { maxLeafDescriptors: 256 },
    );
    const oneResult = await oneSession.runToCompletion(localView, endpoint);
    expect(comparableResult(oneResult)).toEqual(flatComparable(base, [...base, oneExtra]));
    expect(oneResult.remoteOnly).toEqual([oneExtra.key]);

    const extras = await descriptors(10, 1_000_000);
    const remoteDescriptors = [...base.slice(10), ...extras];
    const remoteIndex = await buildPrefixMerkleIndex(remoteDescriptors, { prefixBits: 8 });
    const deltaRemote = await registry.open(remoteIndex);
    const deltaSession = await BoundedReconciliationSession.start(
      localView,
      endpoint,
      deltaRemote.info().viewId,
      { maxLeafDescriptors: 256 },
    );
    const deltaResult = await deltaSession.runToCompletion(localView, endpoint);
    expect(comparableResult(deltaResult)).toEqual(flatComparable(base, remoteDescriptors));
    expect(deltaResult.localOnly).toHaveLength(10);
    expect(deltaResult.remoteOnly).toHaveLength(10);
  }, 120_000);

  it("matches flat collision semantics and fails on same-digest inconsistent metadata", async () => {
    const local = await descriptors(64);
    const divergent = await descriptor(local[7]!.recordId, `sha256:${"b".repeat(64)}`);
    const remote = [...local];
    remote[7] = divergent;
    const collisionFixture = await sessionFixture(local, remote, { maxLeafDescriptors: 8 });
    const collision = await collisionFixture.session.runToCompletion(
      collisionFixture.localView,
      collisionFixture.remoteEndpoint,
    );
    expect(comparableResult(collision)).toEqual(flatComparable(local, remote));
    expect(collision.collisions).toHaveLength(1);

    const inconsistent = {
      ...local[7]!,
      payloadBytes: local[7]!.payloadBytes + 1,
    };
    const inconsistentRemote = [...local];
    inconsistentRemote[7] = inconsistent;
    const invalidFixture = await sessionFixture(local, inconsistentRemote, { maxLeafDescriptors: 8 });
    await expect(invalidFixture.session.runToCompletion(
      invalidFixture.localView,
      invalidFixture.remoteEndpoint,
    )).rejects.toThrow(/inconsistent descriptor metadata/);
  });

  it("returns the same delta across different node batches and leaf page sizes", async () => {
    const local = await descriptors(512);
    const extras = await descriptors(12, 20_000);
    const remote = [...local.slice(12), ...extras];
    const narrow = await sessionFixture(local, remote, {
      maxNodeRefsPerStep: 1,
      maxLeafDescriptors: 1,
      maxLeafBytes: 65_536,
    });
    const wide = await sessionFixture(local, remote, {
      maxNodeRefsPerStep: 64,
      maxLeafDescriptors: 19,
      maxLeafBytes: 65_536,
    });

    const narrowResult = await narrow.session.runToCompletion(narrow.localView, narrow.remoteEndpoint);
    const wideResult = await wide.session.runToCompletion(wide.localView, wide.remoteEndpoint);
    expect(comparableResult(narrowResult)).toEqual(comparableResult(wideResult));
    expect(comparableResult(wideResult)).toEqual(flatComparable(local, remote));
  });

  it("serializes and resumes mid-tree and mid-leaf with the same final delta", async () => {
    const local = await descriptors(600);
    const extras = await descriptors(8, 30_000);
    const remote = [...local.slice(8), ...extras];
    const tree = await sessionFixture(local, remote, { maxLeafDescriptors: 3 });

    await tree.session.step(tree.localView, tree.remoteEndpoint);
    expect(tree.session.complete).toBe(false);
    expect(tree.session.counters().remoteLeafPages).toBe(0);
    const treeEncoded = tree.session.encode();
    const treeRestored = await BoundedReconciliationSession.restore(treeEncoded);
    expect(treeRestored.encode()).toBe(treeEncoded);
    const treeResult = await treeRestored.runToCompletion(tree.localView, tree.remoteEndpoint);
    expect(comparableResult(treeResult)).toEqual(flatComparable(local, remote));

    const hot = await sameLeafDescriptors(48);
    const hotLocal = hot.descriptors.slice(0, 40);
    const hotRemote = hot.descriptors.slice(8);
    const leaf = await sessionFixture(hotLocal, hotRemote, { maxLeafDescriptors: 2 });
    while (!leaf.session.complete && leaf.session.counters().remoteLeafPages === 0) {
      await leaf.session.step(leaf.localView, leaf.remoteEndpoint);
    }
    expect(leaf.session.complete).toBe(false);
    expect(leaf.session.counters().remoteLeafPages).toBeGreaterThan(0);
    const leafEncoded = leaf.session.encode();
    const leafRestored = await BoundedReconciliationSession.restore(leafEncoded);
    const leafResult = await leafRestored.runToCompletion(leaf.localView, leaf.remoteEndpoint);
    expect(comparableResult(leafResult)).toEqual(flatComparable(hotLocal, hotRemote));
  });

  it("fails typed when a pinned remote view expires during a session", async () => {
    const local = await descriptors(64);
    const remote = [...local, await descriptor("stale-extra")];
    const fixture = await sessionFixture(local, remote);
    expect(fixture.remoteRegistry.expire(fixture.remoteViewId)).toBe(true);

    await expect(fixture.session.step(fixture.localView, fixture.remoteEndpoint))
      .rejects.toBeInstanceOf(StaleReconciliationViewError);
  });

  it("enforces caller step and pending-work budgets", async () => {
    const local = await descriptors(128);
    const remote = [...local, await descriptor("budget-extra")];
    const steps = await sessionFixture(local, remote, { maxSteps: 1 });
    await steps.session.step(steps.localView, steps.remoteEndpoint);
    await expect(steps.session.step(steps.localView, steps.remoteEndpoint))
      .rejects.toBeInstanceOf(ReconciliationBudgetExceededError);

    const pending = await sessionFixture(local, remote, { maxPendingNodes: 1 });
    await expect(pending.session.step(pending.localView, pending.remoteEndpoint))
      .rejects.toBeInstanceOf(ReconciliationLimitError);
  });

  it("matches flat v0 for mixed semantic and artifact descriptor fixtures", async () => {
    const local = [
      await descriptor("entity-1", payloadDigest, "semantic-entity"),
      await descriptor("observation-1", payloadDigest, "semantic-observation"),
      await descriptor("artifact-1", payloadDigest, "artifact-mutation"),
      await descriptor("artifact-2", payloadDigest, "artifact-mutation"),
    ];
    const remote = [
      local[0]!,
      local[2]!,
      await descriptor("relation-remote", payloadDigest, "semantic-relation"),
      await descriptor("artifact-remote", payloadDigest, "artifact-mutation"),
    ];
    const fixture = await sessionFixture(local, remote, { maxLeafDescriptors: 2 });
    const result = await fixture.session.runToCompletion(fixture.localView, fixture.remoteEndpoint);

    expect(comparableResult(result)).toEqual(flatComparable(local, remote));
  });

  it("fails closed when an endpoint returns node metadata for another root", async () => {
    const local = await descriptors(64);
    const remote = [...local, await descriptor("tampered-response-extra")];
    const fixture = await sessionFixture(local, remote);
    const real = fixture.remoteEndpoint;
    const tampered: ReconciliationEndpoint = {
      viewInfo(viewId) {
        return real.viewInfo(viewId);
      },
      nodeHashes(viewId, refs, options) {
        const response = real.nodeHashes(viewId, refs, options);
        return { ...response, rootDigest: `sha256:${"f".repeat(64)}` };
      },
      leafPage(viewId, options) {
        return real.leafPage(viewId, options);
      },
    };

    await expect(fixture.session.step(fixture.localView, tampered))
      .rejects.toBeInstanceOf(StaleReconciliationViewError);
  });
});
