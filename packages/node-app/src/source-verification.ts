import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

export interface SourceVerificationTicket {
  readonly generation: bigint;
}

export interface SourceVerificationStatus {
  readonly dirty: boolean;
  readonly degraded: boolean;
  readonly verified: boolean;
  readonly maxVerificationAgeMs: number;
}

export interface SourceVerificationGateOptions {
  readonly maxVerificationAgeMs: number;
  readonly monotonicNow?: () => number;
}

function monotonicTime(clock: () => number): number {
  const value = clock();
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Source verification monotonic clock must return a finite non-negative value");
  }
  return value;
}

export class SourceVerificationGate {
  readonly #maxVerificationAgeMs: number;
  readonly #monotonicNow: () => number;
  #dirtyGeneration = 1n;
  #verifiedGeneration = 0n;
  #lastVerifiedAt: number | undefined;
  #degraded = false;

  constructor(options: SourceVerificationGateOptions) {
    if (
      !Number.isSafeInteger(options.maxVerificationAgeMs)
      || options.maxVerificationAgeMs < 0
    ) {
      throw new TypeError("maxVerificationAgeMs must be a non-negative safe integer");
    }
    this.#maxVerificationAgeMs = options.maxVerificationAgeMs;
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  get optimizationEnabled(): boolean {
    return this.#maxVerificationAgeMs > 0;
  }

  markDirty(): void {
    this.#dirtyGeneration += 1n;
  }

  degrade(): void {
    this.#degraded = true;
    this.markDirty();
  }

  beginVerification(): SourceVerificationTicket | undefined {
    const now = monotonicTime(this.#monotonicNow);
    const ageExpired = this.#lastVerifiedAt === undefined
      || now < this.#lastVerifiedAt
      || now - this.#lastVerifiedAt >= this.#maxVerificationAgeMs;
    const mustVerify = this.#maxVerificationAgeMs === 0
      || this.#degraded
      || this.#verifiedGeneration < this.#dirtyGeneration
      || ageExpired;
    return mustVerify ? { generation: this.#dirtyGeneration } : undefined;
  }

  markVerified(ticket: SourceVerificationTicket): void {
    if (ticket.generation > this.#dirtyGeneration) {
      throw new Error("Source verification ticket is newer than the current dirty generation");
    }
    if (ticket.generation > this.#verifiedGeneration) {
      this.#verifiedGeneration = ticket.generation;
    }
    this.#lastVerifiedAt = monotonicTime(this.#monotonicNow);
  }

  status(): SourceVerificationStatus {
    return {
      dirty: this.#verifiedGeneration < this.#dirtyGeneration,
      degraded: this.#degraded,
      verified: this.#lastVerifiedAt !== undefined,
      maxVerificationAgeMs: this.#maxVerificationAgeMs,
    };
  }
}

export interface SourceDirtyHint {
  close(): void;
}

export type SourceWatchFactory = (
  root: string,
  listener: () => void,
) => FSWatcher;

function nodeRecursiveWatch(root: string, listener: () => void): FSWatcher {
  return watch(resolve(root), { persistent: false, recursive: true }, listener);
}

export function createRecursiveFsDirtyHint(
  root: string,
  gates: readonly SourceVerificationGate[],
  watchFactory: SourceWatchFactory = nodeRecursiveWatch,
): SourceDirtyHint {
  const active = gates.filter((gate) => gate.optimizationEnabled);
  if (active.length === 0) return { close() {} };

  let watcher: FSWatcher | undefined;
  let closing = false;
  const degrade = () => {
    for (const gate of active) gate.degrade();
  };
  try {
    watcher = watchFactory(root, () => {
      for (const gate of active) gate.markDirty();
    });
    watcher.on("error", degrade);
    watcher.on("close", () => {
      if (!closing) degrade();
    });
  } catch {
    degrade();
  }

  return {
    close() {
      if (closing) return;
      closing = true;
      watcher?.close();
    },
  };
}

export interface VerifiedSourceTask {
  readonly id: string;
  readonly gate: SourceVerificationGate;
  readonly verify: () => Promise<void>;
}

export interface SourceVerificationRunResult {
  readonly verifiedSourceIds: readonly string[];
  readonly skippedSourceIds: readonly string[];
}

export class CoalescedVerifiedSourceSync {
  readonly #sources: readonly VerifiedSourceTask[];
  #inFlight: Promise<SourceVerificationRunResult> | undefined;

  constructor(sources: readonly VerifiedSourceTask[]) {
    const ids = sources.map((source) => source.id);
    if (new Set(ids).size !== ids.length) {
      throw new TypeError("Verified source ids must be unique");
    }
    this.#sources = [...sources];
  }

  async #runRound(): Promise<SourceVerificationRunResult> {
    const verifiedSourceIds: string[] = [];
    const skippedSourceIds: string[] = [];
    for (const source of this.#sources) {
      const ticket = source.gate.beginVerification();
      if (ticket === undefined) {
        skippedSourceIds.push(source.id);
        continue;
      }
      await source.verify();
      source.gate.markVerified(ticket);
      verifiedSourceIds.push(source.id);
    }
    return { verifiedSourceIds, skippedSourceIds };
  }

  async run(): Promise<SourceVerificationRunResult> {
    if (this.#inFlight !== undefined) return this.#inFlight;
    const run = this.#runRound();
    this.#inFlight = run;
    try {
      return await run;
    } finally {
      if (this.#inFlight === run) this.#inFlight = undefined;
    }
  }
}
