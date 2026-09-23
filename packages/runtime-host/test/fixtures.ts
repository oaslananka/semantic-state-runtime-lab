import type {
  AuthorityRule,
  ExternalBinding,
  StateValue,
} from "@ssrl/core";
import {
  InMemoryStateProvider,
  type StateProvider,
} from "@ssrl/runtime";
import {
  InMemoryEntityRuntimeCatalog,
} from "../src/index.js";

export const entityId = "entity://project/atlas" as const;

function field(
  canonical: string,
  external: string,
  writable: boolean,
): ExternalBinding["fields"][number] {
  return {
    canonical,
    external,
    readable: true,
    writable,
  };
}

export function binding(
  provider: string,
  writable: boolean,
  includeSecret = false,
): ExternalBinding {
  return {
    entityId,
    provider,
    externalId: `${provider}-atlas`,
    fields: [
      field("Project.deadline", "deadline", writable),
      ...(includeSecret
        ? [field("Project.secret", "secret", writable)]
        : []),
    ],
  };
}

function authority(
  provider: string,
  includeSecret: boolean,
): readonly AuthorityRule[] {
  return [
    {
      property: "Project.deadline",
      strategy: { kind: "provider", provider },
    },
    ...(includeSecret
      ? [{
        property: "Project.secret",
        strategy: { kind: "provider" as const, provider },
      }]
      : []),
  ];
}

export function catalog(
  options: {
    readonly authorityProvider?: string | null;
    readonly includeSecret?: boolean;
  } = {},
): InMemoryEntityRuntimeCatalog {
  const includeSecret = options.includeSecret === true;
  const authorityProvider = options.authorityProvider === undefined
    ? "primary"
    : options.authorityProvider;

  return new InMemoryEntityRuntimeCatalog([{
    entityId,
    bindings: [
      binding("primary", false, includeSecret),
      binding("replica", true, includeSecret),
    ],
    ...(authorityProvider === null
      ? {}
      : { authority: authority(authorityProvider, includeSecret) }),
  }]);
}

export interface ProviderFixtureOptions {
  readonly now?: () => string;
  readonly primaryValues?: Readonly<Record<string, StateValue>>;
  readonly replicaValues?: Readonly<Record<string, StateValue>>;
}

export function providers(options: ProviderFixtureOptions = {}) {
  const now = options.now ?? (() => "2026-09-24T00:00:00Z");
  const primary = new InMemoryStateProvider(
    "primary",
    [{
      externalId: "primary-atlas",
      values: options.primaryValues ?? { deadline: "2026-11-20" },
    }],
    now,
  );
  const replica = new InMemoryStateProvider(
    "replica",
    [{
      externalId: "replica-atlas",
      values: options.replicaValues ?? { deadline: "2026-11-15" },
    }],
    now,
  );
  return { primary, replica };
}

export function registry(...items: StateProvider[]) {
  return {
    providers: new Map(items.map((provider) => [provider.id, provider])),
  };
}

export function countingProvider(delegate: StateProvider): {
  readonly provider: StateProvider;
  readonly count: () => number;
} {
  let calls = 0;
  return {
    provider: {
      id: delegate.id,
      observe: (externalBinding) => delegate.observe(externalBinding),
      async apply(mutation) {
        calls += 1;
        await delegate.apply(mutation);
      },
    },
    count: () => calls,
  };
}
