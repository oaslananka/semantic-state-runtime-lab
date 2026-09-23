import {
  valuesEqual,
  type ExternalBinding,
  type ExternalSnapshot,
  type Mutation,
  type StateValue,
} from "@ssrl/core";
import type { StateProvider } from "./runtime.js";

interface MutableRecord {
  readonly externalId: string;
  readonly values: Record<string, StateValue | undefined>;
  revision: number;
}

export interface InMemorySeed {
  readonly externalId: string;
  readonly values: Readonly<Record<string, StateValue | undefined>>;
  readonly revision?: number;
}

export class StaleProviderStateError extends Error {
  constructor(
    readonly expected: string | undefined,
    readonly actual: string,
  ) {
    super(`Provider state changed: expected ${expected ?? "absent-value precondition"}, actual ${actual}`);
    this.name = "StaleProviderStateError";
  }
}

export class InMemoryStateProvider implements StateProvider {
  readonly id: string;
  readonly #records = new Map<string, MutableRecord>();
  readonly #now: () => string;

  constructor(
    id: string,
    seeds: readonly InMemorySeed[],
    now: () => string = () => new Date().toISOString(),
  ) {
    this.id = id;
    this.#now = now;
    for (const seed of seeds) {
      this.#records.set(seed.externalId, {
        externalId: seed.externalId,
        values: { ...seed.values },
        revision: seed.revision ?? 1,
      });
    }
  }

  #record(externalId: string): MutableRecord {
    const record = this.#records.get(externalId);
    if (record === undefined) {
      throw new Error(`Unknown record ${this.id}/${externalId}`);
    }
    return record;
  }

  #revision(record: MutableRecord): string {
    return `${this.id}:${record.revision}`;
  }

  async observe(binding: ExternalBinding): Promise<ExternalSnapshot> {
    if (binding.provider !== this.id) {
      throw new Error(`Binding provider ${binding.provider} does not match ${this.id}`);
    }
    const record = this.#record(binding.externalId);
    return {
      binding,
      revision: this.#revision(record),
      observedAt: this.#now(),
      values: { ...record.values },
    };
  }

  async apply(mutation: Mutation): Promise<void> {
    if (mutation.provider !== this.id) {
      throw new Error(`Mutation provider ${mutation.provider} does not match ${this.id}`);
    }
    const record = this.#record(mutation.externalId);
    const actualRevision = this.#revision(record);

    if (mutation.baseRevision !== undefined && mutation.baseRevision !== actualRevision) {
      throw new StaleProviderStateError(mutation.baseRevision, actualRevision);
    }

    if (mutation.baseRevision === undefined) {
      const actual = record.values[mutation.externalPath];
      const expected = mutation.previousValue;
      if (!valuesEqual(actual, expected)) {
        throw new StaleProviderStateError(undefined, actualRevision);
      }
    }

    record.values[mutation.externalPath] = mutation.nextValue;
    record.revision += 1;
  }

  mutateExternally(externalId: string, path: string, value: StateValue): void {
    const record = this.#record(externalId);
    record.values[path] = value;
    record.revision += 1;
  }

  read(externalId: string): Readonly<Record<string, StateValue | undefined>> {
    return { ...this.#record(externalId).values };
  }
}
