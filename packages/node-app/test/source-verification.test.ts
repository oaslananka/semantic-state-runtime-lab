import { afterEach, describe, expect, it } from "vitest";
import { watch, type FSWatcher } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CoalescedVerifiedSourceSync,
  SourceVerificationGate,
  createRecursiveFsDirtyHint,
} from "../src/source-verification.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for filesystem dirty hint");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("source verification hints", () => {
  it("skips a clean source until verification age expires", async () => {
    let now = 0;
    let scans = 0;
    const gate = new SourceVerificationGate({
      maxVerificationAgeMs: 1_000,
      monotonicNow: () => now,
    });
    const sync = new CoalescedVerifiedSourceSync([{
      id: "primary",
      gate,
      async verify() { scans += 1; },
    }]);

    expect((await sync.run()).verifiedSourceIds).toEqual(["primary"]);
    expect(scans).toBe(1);
    now = 999;
    expect((await sync.run()).skippedSourceIds).toEqual(["primary"]);
    expect(scans).toBe(1);
    now = 1_000;
    expect((await sync.run()).verifiedSourceIds).toEqual(["primary"]);
    expect(scans).toBe(2);
  });

  it("retains a dirty event that arrives during an in-flight verification", async () => {
    let scans = 0;
    const gate = new SourceVerificationGate({ maxVerificationAgeMs: 60_000 });
    const sync = new CoalescedVerifiedSourceSync([{
      id: "primary",
      gate,
      async verify() {
        scans += 1;
        if (scans === 1) gate.markDirty();
      },
    }]);

    await sync.run();
    expect(gate.status().dirty).toBe(true);
    await sync.run();
    expect(scans).toBe(2);
    expect(gate.status().dirty).toBe(false);
  });

  it("keeps a failed verification dirty so the next access retries", async () => {
    let scans = 0;
    const gate = new SourceVerificationGate({ maxVerificationAgeMs: 60_000 });
    const sync = new CoalescedVerifiedSourceSync([{
      id: "primary",
      gate,
      async verify() {
        scans += 1;
        if (scans === 1) throw new Error("scan failed");
      },
    }]);

    await expect(sync.run()).rejects.toThrow(/scan failed/);
    expect(gate.status().dirty).toBe(true);
    await sync.run();
    expect(scans).toBe(2);
    expect(gate.status().dirty).toBe(false);
  });

  it("degraded mode verifies on every access", async () => {
    let scans = 0;
    const gate = new SourceVerificationGate({ maxVerificationAgeMs: 60_000 });
    const sync = new CoalescedVerifiedSourceSync([{
      id: "primary",
      gate,
      async verify() { scans += 1; },
    }]);
    await sync.run();
    gate.degrade();
    await sync.run();
    await sync.run();
    expect(scans).toBe(3);
    expect(gate.status().degraded).toBe(true);
  });

  it("marks only the dirty source for verification and coalesces concurrent runs", async () => {
    let primary = 0;
    let replica = 0;
    const primaryGate = new SourceVerificationGate({ maxVerificationAgeMs: 60_000 });
    const replicaGate = new SourceVerificationGate({ maxVerificationAgeMs: 60_000 });
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let blockPrimary = false;
    const sync = new CoalescedVerifiedSourceSync([
      {
        id: "primary",
        gate: primaryGate,
        async verify() {
          primary += 1;
          if (blockPrimary) await blocked;
        },
      },
      {
        id: "replica",
        gate: replicaGate,
        async verify() { replica += 1; },
      },
    ]);
    await sync.run();
    primaryGate.markDirty();
    blockPrimary = true;
    const first = sync.run();
    const second = sync.run();
    release!();
    await Promise.all([first, second]);

    expect(primary).toBe(2);
    expect(replica).toBe(1);
  });

  it("uses recursive fs.watch only as a dirty hint", async () => {
    const root = await mkdtemp(join(tmpdir(), "ssrl-watch-hint-"));
    roots.push(root);
    const gate = new SourceVerificationGate({ maxVerificationAgeMs: 60_000 });
    const initial = gate.beginVerification();
    expect(initial).toBeDefined();
    gate.markVerified(initial!);
    const hint = createRecursiveFsDirtyHint(root, [gate]);
    try {
      await writeFile(join(root, "note.md"), "# changed\n", "utf8");
      await waitFor(() => gate.status().dirty || gate.status().degraded);
      expect(gate.beginVerification()).toBeDefined();
    } finally {
      hint.close();
    }
  });

  it("degrades permanently when an established watcher later emits an error", async () => {
    const root = await mkdtemp(join(tmpdir(), "ssrl-watch-error-"));
    roots.push(root);
    const gate = new SourceVerificationGate({ maxVerificationAgeMs: 60_000 });
    const initial = gate.beginVerification();
    gate.markVerified(initial!);
    let watcher: FSWatcher | undefined;
    const hint = createRecursiveFsDirtyHint(root, [gate], (watchedRoot, listener) => {
      watcher = watch(watchedRoot, { persistent: false, recursive: true }, listener);
      return watcher;
    });
    try {
      watcher!.emit("error", new Error("synthetic watcher failure"));
      expect(gate.status()).toMatchObject({ degraded: true, dirty: true });
      const ticket = gate.beginVerification();
      expect(ticket).toBeDefined();
      gate.markVerified(ticket!);
      expect(gate.beginVerification()).toBeDefined();
    } finally {
      hint.close();
    }
  });

  it("degrades on an unexpected watcher close but not on intentional lifecycle close", async () => {
    const unexpectedRoot = await mkdtemp(join(tmpdir(), "ssrl-watch-close-unexpected-"));
    const intentionalRoot = await mkdtemp(join(tmpdir(), "ssrl-watch-close-intentional-"));
    roots.push(unexpectedRoot, intentionalRoot);

    const unexpectedGate = new SourceVerificationGate({ maxVerificationAgeMs: 60_000 });
    const unexpectedTicket = unexpectedGate.beginVerification();
    unexpectedGate.markVerified(unexpectedTicket!);
    let unexpectedWatcher: FSWatcher | undefined;
    const unexpectedHint = createRecursiveFsDirtyHint(
      unexpectedRoot,
      [unexpectedGate],
      (watchedRoot, listener) => {
        unexpectedWatcher = watch(watchedRoot, { persistent: false, recursive: true }, listener);
        return unexpectedWatcher;
      },
    );
    unexpectedWatcher!.close();
    await waitFor(() => unexpectedGate.status().degraded);
    expect(unexpectedGate.status().degraded).toBe(true);
    unexpectedHint.close();

    const intentionalGate = new SourceVerificationGate({ maxVerificationAgeMs: 60_000 });
    const intentionalTicket = intentionalGate.beginVerification();
    intentionalGate.markVerified(intentionalTicket!);
    const intentionalHint = createRecursiveFsDirtyHint(intentionalRoot, [intentionalGate]);
    intentionalHint.close();
    intentionalHint.close();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(intentionalGate.status()).toMatchObject({ degraded: false, dirty: false });
  });

  it("falls back to degraded always-verify mode when watch setup fails", async () => {
    const gate = new SourceVerificationGate({ maxVerificationAgeMs: 60_000 });
    const initial = gate.beginVerification();
    gate.markVerified(initial!);
    const hint = createRecursiveFsDirtyHint(
      join(tmpdir(), "synthetic-watch-failure"),
      [gate],
      () => { throw new Error("watch unavailable"); },
    );
    try {
      expect(gate.status().degraded).toBe(true);
      expect(gate.beginVerification()).toBeDefined();
    } finally {
      hint.close();
    }
  });
});
