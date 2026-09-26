import { readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { generateVaultEpoch, type VaultEpoch } from "@ssrl/e2e";
import { OpaqueMerkleSourceCheckpointError } from "@ssrl/opaque-merkle-view-store";
import type {
  OpaqueDescriptorCatalogRequest,
  OpaqueDescriptorChangeRequest,
  OpaqueObjectLocator,
  OpaqueObjectReadOptions,
  OpaqueReplicationObjectStore,
} from "@ssrl/opaque-replication-store";
import { LocalOpaqueReplicationStore } from "@ssrl/storage-local-opaque-replication";
import {
  createReplicationRecord,
  type ReplicationRecord,
} from "@ssrl/replication";
import {
  encryptReplicationRecord,
  type EncryptedReplicationObject,
  type OpaqueReplicationDescriptor,
} from "@ssrl/replication/encrypted";
import {
  buildOpaquePrefixMerkleIndex,
  opaquePrefixMerkleLeafId,
} from "@ssrl/replication/opaque-merkle";
import {
  FrozenOpaquePrefixMerkleView,
  InvalidReconciliationCursorError,
  OpaqueBoundedReconciliationSession,
} from "@ssrl/replication/opaque-sync";
import { temporalObservationJson } from "@ssrl/state-store";
import {
  CorruptOpaqueMerkleViewStoreError,
  SQLiteOpaqueMerkleViewStore,
} from "../src/index.js";

const roots: string[] = [];
const project = "entity://project/opaque-sql-merkle-secret" as const;

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function record(id: string, value = id): Promise<ReplicationRecord> {
  return createReplicationRecord({
    kind: "semantic-observation",
    recordId: id,
    payload: temporalObservationJson({
      id,
      entityId: project,
      property: "Project.privateStatus",
      value,
      source: { provider: "sql-merkle-test", externalId: id, revision: id },
      validFrom: "2026-09-01T00:00:00Z",
      recordedAt: "2026-09-01T00:00:00Z",
    }),
  });
}

async function encrypted(
  epoch: VaultEpoch,
  id: string,
  value = id,
): Promise<EncryptedReplicationObject> {
  return encryptReplicationRecord({
    epochId: epoch.epochId,
    epochSecret: epoch.secret,
    record: await record(id, value),
  });
}

async function install(
  store: LocalOpaqueReplicationStore,
  epoch: VaultEpoch,
  ids: readonly string[],
): Promise<EncryptedReplicationObject[]> {
  const values: EncryptedReplicationObject[] = [];
  for (const id of ids) {
    const object = await encrypted(epoch, id, `secret-${id}`);
    await store.install(object);
    values.push(object);
  }
  return values;
}

async function installCollidingLeafPair(
  store: LocalOpaqueReplicationStore,
  epoch: VaultEpoch,
): Promise<{ readonly leafId: number; readonly objects: readonly EncryptedReplicationObject[] }> {
  const firstByLeaf = new Map<number, EncryptedReplicationObject>();
  for (let index = 0; index < 1024; index += 1) {
    const object = await encrypted(epoch, `cursor-${index}`, `secret-cursor-${index}`);
    const leafId = await opaquePrefixMerkleLeafId(object.descriptor.opaqueKey, 8);
    const previous = firstByLeaf.get(leafId);
    if (previous !== undefined) {
      await store.install(previous);
      await store.install(object);
      return { leafId, objects: [previous, object] };
    }
    firstByLeaf.set(leafId, object);
  }
  throw new Error("failed to find an 8-bit Merkle leaf collision");
}

async function catalog(
  store: LocalOpaqueReplicationStore,
  epoch: VaultEpoch,
): Promise<OpaqueReplicationDescriptor[]> {
  const descriptors: OpaqueReplicationDescriptor[] = [];
  let cursor: Awaited<ReturnType<typeof store.descriptorPage>>["nextCursor"];
  while (true) {
    const page = await store.descriptorPage({
      epochId: epoch.epochId,
      ...(cursor === undefined ? {} : { cursor }),
      maxDescriptors: 4096,
      maxBytes: 8 * 1024 * 1024,
    });
    descriptors.push(...page.descriptors);
    cursor = page.nextCursor ?? cursor;
    if (!page.hasMore) break;
    if (page.nextCursor === undefined) throw new Error("catalog page did not advance");
  }
  return descriptors;
}

async function derived(
  source: OpaqueReplicationObjectStore,
  root: string,
): Promise<SQLiteOpaqueMerkleViewStore> {
  return SQLiteOpaqueMerkleViewStore.open({
    path: join(root, "derived.sqlite"),
    source,
    prefixBits: 8,
    sourcePageDescriptors: 64,
    sourcePageBytes: 1024 * 1024,
  });
}

function sourceFacade(store: LocalOpaqueReplicationStore, counters: { catalogs: number; changes: number }): OpaqueReplicationObjectStore {
  return {
    install: (object) => store.install(object),
    descriptor: (locator: OpaqueObjectLocator) => store.descriptor(locator),
    readObject: (locator: OpaqueObjectLocator, options?: OpaqueObjectReadOptions) => (
      store.readObject(locator, options)
    ),
    descriptorPage: (request: OpaqueDescriptorCatalogRequest) => {
      counters.catalogs += 1;
      return store.descriptorPage(request);
    },
    descriptorChangesAfter: (request?: OpaqueDescriptorChangeRequest) => {
      counters.changes += 1;
      return store.descriptorChangesAfter(request);
    },
  };
}

describe("SQLiteOpaqueMerkleViewStore", () => {
  it("bootstraps multiple epochs to roots/nodes/leaves identical to full in-memory indexes", async () => {
    const sourceRoot = await tempRoot("ssrl-opaque-source-");
    const derivedRoot = await tempRoot("ssrl-opaque-derived-");
    const source = new LocalOpaqueReplicationStore({ root: sourceRoot });
    const epochA = generateVaultEpoch();
    const epochB = generateVaultEpoch();
    await install(source, epochB, ["b-3", "b-1", "b-2"]);
    await install(source, epochA, ["a-4", "a-1", "a-3", "a-2"]);
    const viewStore = await derived(source, derivedRoot);

    const catchUp = await viewStore.catchUp();
    expect(catchUp).toEqual({ bootstrapped: true, pages: 1, descriptorsRead: 7, descriptorsInserted: 7 });

    for (const epoch of [epochA, epochB]) {
      const descriptors = await catalog(source, epoch);
      const expected = await buildOpaquePrefixMerkleIndex(descriptors, { prefixBits: 8, epochId: epoch.epochId });
      const view = await viewStore.openView(epoch.epochId);
      expect(view.rootDigest).toBe(expected.rootDigest);
      expect(view.recordCount).toBe(expected.recordCount);
      expect((await viewStore.nodeHashes(view.viewId, [{ level: 8, index: 0 }])).nodes[0]?.hash)
        .toBe(expected.rootDigest);
      for (const leaf of expected.snapshot().nonEmptyLeaves) {
        const page = await viewStore.leafPage(view.viewId, {
          leafId: leaf.leafId,
          maxDescriptors: 1024,
          maxBytes: 256 * 1024,
        });
        expect(page.descriptors).toEqual(leaf.descriptors);
        expect(page.completed).toBe(true);
      }
    }
    viewStore.close();
    source.close();
  });

  it("produces the same bootstrap roots independent of source install order", async () => {
    const epoch = generateVaultEpoch();
    const objects = await Promise.all(["o-a", "o-b", "o-c", "o-d", "o-e"].map((id) => encrypted(epoch, id)));
    const roots = await Promise.all([tempRoot("ssrl-order-source-a-"), tempRoot("ssrl-order-source-b-"), tempRoot("ssrl-order-derived-a-"), tempRoot("ssrl-order-derived-b-")]);
    const first = new LocalOpaqueReplicationStore({ root: roots[0]! });
    const second = new LocalOpaqueReplicationStore({ root: roots[1]! });
    for (const object of objects) await first.install(object);
    for (const object of [...objects].reverse()) await second.install(object);
    const firstDerived = await derived(first, roots[2]!);
    const secondDerived = await derived(second, roots[3]!);

    const firstView = await firstDerived.openView(epoch.epochId);
    const secondView = await secondDerived.openView(epoch.epochId);
    expect(secondView.rootDigest).toBe(firstView.rootDigest);
    expect(secondView.recordCount).toBe(firstView.recordCount);
    firstDerived.close();
    secondDerived.close();
    first.close();
    second.close();
  });

  it("updates only incrementally while matching a full rebuild and preserves an older frozen view", async () => {
    const sourceRoot = await tempRoot("ssrl-incremental-source-");
    const derivedRoot = await tempRoot("ssrl-incremental-derived-");
    const source = new LocalOpaqueReplicationStore({ root: sourceRoot });
    const epoch = generateVaultEpoch();
    await install(source, epoch, Array.from({ length: 24 }, (_, index) => `base-${index}`));
    const viewStore = await derived(source, derivedRoot);
    const before = await viewStore.openView(epoch.epochId);
    const countDb = new DatabaseSync(join(derivedRoot, "derived.sqlite"));
    const beforeNodeCount = Number((countDb.prepare(
      "SELECT COUNT(*) AS count FROM opaque_merkle_node_versions",
    ).get() as { count: number | bigint }).count);
    countDb.close();
    const added = (await install(source, epoch, ["incremental-new"]))[0]!;

    const catchUp = await viewStore.catchUp();
    expect(catchUp.bootstrapped).toBe(false);
    expect(catchUp.descriptorsRead).toBe(1);
    expect(catchUp.descriptorsInserted).toBe(1);
    const afterCountDb = new DatabaseSync(join(derivedRoot, "derived.sqlite"));
    const afterNodeCount = Number((afterCountDb.prepare(
      "SELECT COUNT(*) AS count FROM opaque_merkle_node_versions",
    ).get() as { count: number | bigint }).count);
    afterCountDb.close();
    expect(afterNodeCount - beforeNodeCount).toBe(9);
    const after = await viewStore.openView(epoch.epochId);
    const expected = await buildOpaquePrefixMerkleIndex(await catalog(source, epoch), { prefixBits: 8, epochId: epoch.epochId });
    expect(after.rootDigest).toBe(expected.rootDigest);
    expect(after.recordCount).toBe(25);
    expect(before.rootDigest).not.toBe(after.rootDigest);
    expect((await viewStore.viewInfo(before.viewId)).rootDigest).toBe(before.rootDigest);

    const leafId = await opaquePrefixMerkleLeafId(added.descriptor.opaqueKey, 8);
    const frozenPage = await viewStore.leafPage(before.viewId, { leafId, maxDescriptors: 1024, maxBytes: 256 * 1024 });
    expect(frozenPage.descriptors.some((descriptor) => descriptor.opaqueKey === added.descriptor.opaqueKey)).toBe(false);
    const currentPage = await viewStore.leafPage(after.viewId, { leafId, maxDescriptors: 1024, maxBytes: 256 * 1024 });
    expect(currentPage.descriptors.some((descriptor) => descriptor.opaqueKey === added.descriptor.opaqueKey)).toBe(true);
    viewStore.close();
    source.close();
  });

  it("resumes from the persisted source checkpoint after reopen without reprocessing descriptors", async () => {
    const sourceRoot = await tempRoot("ssrl-resume-source-");
    const derivedRoot = await tempRoot("ssrl-resume-derived-");
    const source = new LocalOpaqueReplicationStore({ root: sourceRoot });
    const epoch = generateVaultEpoch();
    await install(source, epoch, ["resume-a", "resume-b", "resume-c"]);

    const first = await derived(source, derivedRoot);
    const bootstrap = await first.catchUp();
    expect(bootstrap.descriptorsInserted).toBe(3);
    first.close();

    const counters = { catalogs: 0, changes: 0 };
    const reopened = await derived(sourceFacade(source, counters), derivedRoot);
    const resumed = await reopened.catchUp();
    expect(resumed).toEqual({
      bootstrapped: false,
      pages: 1,
      descriptorsRead: 0,
      descriptorsInserted: 0,
    });
    expect(counters).toEqual({ catalogs: 0, changes: 1 });
    expect((await reopened.openView(epoch.epochId)).recordCount).toBe(3);
    reopened.close();
    source.close();
  });

  it("replays safely when derived data committed but the source checkpoint is rewound", async () => {
    const sourceRoot = await tempRoot("ssrl-replay-source-");
    const derivedRoot = await tempRoot("ssrl-replay-derived-");
    const source = new LocalOpaqueReplicationStore({ root: sourceRoot });
    const epoch = generateVaultEpoch();
    await install(source, epoch, ["first"]);
    const firstCursor = (await source.descriptorChangesAfter()).nextCursor;
    if (firstCursor === undefined) throw new Error("expected first cursor");
    const viewStore = await derived(source, derivedRoot);
    await viewStore.catchUp();
    await install(source, epoch, ["second"]);
    await viewStore.catchUp();
    viewStore.close();

    const db = new DatabaseSync(join(derivedRoot, "derived.sqlite"));
    db.prepare("UPDATE opaque_merkle_source_state SET cursor=? WHERE singleton=1").run(firstCursor);
    db.close();

    const reopened = await derived(source, derivedRoot);
    const replay = await reopened.catchUp();
    expect(replay.descriptorsRead).toBe(1);
    expect(replay.descriptorsInserted).toBe(0);
    expect((await reopened.openView(epoch.epochId)).recordCount).toBe(2);
    reopened.close();
    source.close();
  });

  it("fails closed when a persisted checkpoint is replayed against another source store", async () => {
    const sourceRootA = await tempRoot("ssrl-source-a-");
    const sourceRootB = await tempRoot("ssrl-source-b-");
    const derivedRoot = await tempRoot("ssrl-source-derived-");
    const epoch = generateVaultEpoch();
    const first = new LocalOpaqueReplicationStore({ root: sourceRootA });
    const second = new LocalOpaqueReplicationStore({ root: sourceRootB });
    await install(first, epoch, ["first-source"]);
    await install(second, epoch, ["second-source"]);
    const viewStore = await derived(first, derivedRoot);
    await viewStore.catchUp();
    viewStore.close();

    const wrong = await derived(second, derivedRoot);
    await expect(wrong.catchUp()).rejects.toBeInstanceOf(OpaqueMerkleSourceCheckpointError);
    wrong.close();
    first.close();
    second.close();
  });

  it("binds an empty derived store to its source before the first descriptor exists", async () => {
    const sourceRoot = await tempRoot("ssrl-empty-bind-source-");
    const otherRoot = await tempRoot("ssrl-empty-bind-other-");
    const derivedRoot = await tempRoot("ssrl-empty-bind-derived-");
    const source = new LocalOpaqueReplicationStore({ root: sourceRoot });
    const first = await derived(source, derivedRoot);
    const bootstrap = await first.catchUp();
    expect(bootstrap.descriptorsRead).toBe(0);
    first.close();
    source.close();

    const other = new LocalOpaqueReplicationStore({ root: otherRoot });
    const reopened = await derived(other, derivedRoot);
    await expect(reopened.catchUp()).rejects.toBeInstanceOf(OpaqueMerkleSourceCheckpointError);
    reopened.close();
    other.close();
  });

  it("opens an empty epoch with the exact deterministic empty Merkle root", async () => {
    const sourceRoot = await tempRoot("ssrl-empty-source-");
    const derivedRoot = await tempRoot("ssrl-empty-derived-");
    const source = new LocalOpaqueReplicationStore({ root: sourceRoot });
    const epoch = generateVaultEpoch();
    const viewStore = await derived(source, derivedRoot);
    const view = await viewStore.openView(epoch.epochId);
    const expected = await buildOpaquePrefixMerkleIndex([], { prefixBits: 8, epochId: epoch.epochId });

    expect(view.recordCount).toBe(0);
    expect(view.rootDigest).toBe(expected.rootDigest);
    expect((await viewStore.nodeHashes(view.viewId, [{ level: 8, index: 0 }])).nodes[0]?.hash)
      .toBe(expected.rootDigest);
    expect(await viewStore.leafPage(view.viewId, { leafId: 0 })).toEqual({
      viewId: view.viewId,
      rootDigest: view.rootDigest,
      leafId: 0,
      descriptors: [],
      estimatedBytes: 2,
      completed: true,
    });
    viewStore.close();
    source.close();
  });

  it("binds leaf cursors to view, root, leaf, and secret", async () => {
    const sourceRoot = await tempRoot("ssrl-cursor-source-");
    const derivedRoot = await tempRoot("ssrl-cursor-derived-");
    const source = new LocalOpaqueReplicationStore({ root: sourceRoot });
    const epoch = generateVaultEpoch();
    const collision = await installCollidingLeafPair(source, epoch);
    const viewStore = await derived(source, derivedRoot);
    const firstView = await viewStore.openView(epoch.epochId);
    const expected = await buildOpaquePrefixMerkleIndex(
      collision.objects.map((object) => object.descriptor),
      { prefixBits: 8, epochId: epoch.epochId },
    );
    const hot = expected.snapshot().nonEmptyLeaves.find((leaf) => leaf.leafId === collision.leafId);
    if (hot === undefined || hot.recordCount !== 2) throw new Error("expected colliding leaf pair");
    const first = await viewStore.leafPage(firstView.viewId, { leafId: hot.leafId, maxDescriptors: 1, maxBytes: 256 * 1024 });
    if (first.nextCursor === undefined) throw new Error("expected leaf cursor");
    const cursor = first.nextCursor;
    const secondView = await viewStore.openView(epoch.epochId);

    await expect(viewStore.leafPage(secondView.viewId, { leafId: hot.leafId, cursor }))
      .rejects.toBeInstanceOf(InvalidReconciliationCursorError);
    await expect(viewStore.leafPage(firstView.viewId, { leafId: (hot.leafId + 1) % 256, cursor }))
      .rejects.toBeInstanceOf(InvalidReconciliationCursorError);
    const last = cursor.at(-1);
    if (last === undefined) throw new Error("missing cursor char");
    const forged = `${cursor.slice(0,-1)}${last === "A" ? "B" : "A"}` as typeof cursor;
    await expect(viewStore.leafPage(firstView.viewId, { leafId: hot.leafId, cursor: forged }))
      .rejects.toBeInstanceOf(InvalidReconciliationCursorError);

    const afterKey = first.descriptors[0]?.opaqueKey;
    if (afterKey === undefined) throw new Error("missing cursor after-key descriptor");
    const db = new DatabaseSync(join(derivedRoot, "derived.sqlite"));
    db.prepare(`
      DELETE FROM opaque_merkle_descriptors
      WHERE epoch_id=? AND opaque_key=?
    `).run(epoch.epochId, afterKey);
    db.close();
    await expect(viewStore.leafPage(firstView.viewId, { leafId: hot.leafId, cursor }))
      .rejects.toBeInstanceOf(InvalidReconciliationCursorError);
    viewStore.close();
    source.close();
  });

  it("is consumable by the existing bounded opaque reconciliation session unchanged", async () => {
    const sourceRoot = await tempRoot("ssrl-session-source-");
    const derivedRoot = await tempRoot("ssrl-session-derived-");
    const source = new LocalOpaqueReplicationStore({ root: sourceRoot });
    const epoch = generateVaultEpoch();
    const shared = await install(source, epoch, Array.from({ length: 32 }, (_, index) => `shared-${index}`));
    const remoteExtra = await install(source, epoch, ["remote-a", "remote-b", "remote-c"]);
    const localIndex = await buildOpaquePrefixMerkleIndex(shared.map((object) => object.descriptor), { prefixBits: 8, epochId: epoch.epochId });
    const localView = await FrozenOpaquePrefixMerkleView.open(localIndex);
    const viewStore = await derived(source, derivedRoot);
    const remoteView = await viewStore.openView(epoch.epochId);
    const session = await OpaqueBoundedReconciliationSession.start(localView, viewStore, remoteView.viewId, { maxLeafDescriptors: 2 });
    const result = await session.runToCompletion(localView, viewStore);

    expect(result.localOnly).toEqual([]);
    expect(result.remoteOnly).toEqual(remoteExtra.map((object) => object.descriptor.opaqueKey).toSorted((a,b)=>a.localeCompare(b)));
    expect(result.collisions).toEqual([]);
    viewStore.close();
    source.close();
  });

  it("does not call the full descriptor catalog on steady-state openView", async () => {
    const sourceRoot = await tempRoot("ssrl-bounded-source-");
    const derivedRoot = await tempRoot("ssrl-bounded-derived-");
    const real = new LocalOpaqueReplicationStore({ root: sourceRoot });
    const epoch = generateVaultEpoch();
    await install(real, epoch, Array.from({ length: 50 }, (_, index) => `bounded-${index}`));
    const counters = { catalogs: 0, changes: 0 };
    const source = sourceFacade(real, counters);
    const viewStore = await derived(source, derivedRoot);
    await viewStore.openView(epoch.epochId);
    const afterBootstrap = { ...counters };
    await viewStore.openView(epoch.epochId);

    expect(counters.catalogs).toBe(0);
    expect(afterBootstrap.catalogs).toBe(0);
    expect(counters.changes - afterBootstrap.changes).toBe(1);
    viewStore.close();
    real.close();
  });

  it("fails closed on corrupted derived descriptor and node rows", async () => {
    const sourceRoot = await tempRoot("ssrl-corrupt-source-");
    const derivedRoot = await tempRoot("ssrl-corrupt-derived-");
    const source = new LocalOpaqueReplicationStore({ root: sourceRoot });
    const epoch = generateVaultEpoch();
    await install(source, epoch, ["corrupt-one"]);
    const viewStore = await derived(source, derivedRoot);
    const view = await viewStore.openView(epoch.epochId);
    viewStore.close();

    const db = new DatabaseSync(join(derivedRoot, "derived.sqlite"));
    db.prepare("UPDATE opaque_merkle_descriptors SET descriptor_json=?").run(JSON.stringify({ broken: true }));
    db.close();
    const reopened = await derived(source, derivedRoot);
    const leaf = await opaquePrefixMerkleLeafId((await catalog(source, epoch))[0]!.opaqueKey, 8);
    await expect(reopened.leafPage((await reopened.openView(epoch.epochId)).viewId, { leafId: leaf }))
      .rejects.toThrow();
    reopened.close();

    const nodeDb = new DatabaseSync(join(derivedRoot, "derived.sqlite"));
    nodeDb.prepare("UPDATE opaque_merkle_node_versions SET hash='plaintext-bad-hash' WHERE level=0").run();
    nodeDb.close();
    const nodeStore = await derived(source, derivedRoot);
    const nodeView = await nodeStore.openView(epoch.epochId);
    await expect(nodeStore.nodeHashes(nodeView.viewId, [{ level: 0, index: leaf }]))
      .rejects.toBeInstanceOf(CorruptOpaqueMerkleViewStoreError);
    nodeStore.close();

    const headDb = new DatabaseSync(join(derivedRoot, "derived.sqlite"));
    headDb.prepare(`
      UPDATE opaque_merkle_epoch_heads
      SET root_digest=?
      WHERE epoch_id=?
    `).run(`sha256:${"f".repeat(64)}`, epoch.epochId);
    headDb.close();
    const headStore = await derived(source, derivedRoot);
    await expect(headStore.openView(epoch.epochId))
      .rejects.toBeInstanceOf(CorruptOpaqueMerkleViewStoreError);
    headStore.close();
    source.close();
  });

  it("stores only opaque relay metadata and no fixture plaintext identity/value", async () => {
    const sourceRoot = await tempRoot("ssrl-leak-source-");
    const derivedRoot = await tempRoot("ssrl-leak-derived-");
    const source = new LocalOpaqueReplicationStore({ root: sourceRoot });
    const epoch = generateVaultEpoch();
    await source.install(await encrypted(epoch, "secret-record-identity", "ultra-secret-value"));
    const viewStore = await derived(source, derivedRoot);
    await viewStore.catchUp();
    viewStore.close();
    source.close();

    const bytes = await readFile(join(derivedRoot, "derived.sqlite"));
    const physical = bytes.toString("latin1");
    expect(physical).not.toContain("secret-record-identity");
    expect(physical).not.toContain("ultra-secret-value");
    expect(physical).not.toContain(project);
    expect(physical).not.toContain("Project.privateStatus");
    expect(physical).not.toContain("sql-merkle-test");
  });
});
