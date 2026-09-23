import { describe, expect, it } from "vitest";
import type {
  AuthorityRule,
  ExternalBinding,
  StateValue,
} from "@ssrl/core";
import { InMemoryEventJournal } from "@ssrl/journal";
import {
  InMemoryStateProvider,
  ReconciliationPlanDriftError,
  type StateProvider,
} from "@ssrl/runtime";
import {
  InMemoryEntityRuntimeCatalog,
  RuntimeAccessDeniedError,
  RuntimeHost,
  type RuntimeAccessPolicy,
  type RuntimePrincipal,
} from "../src/index.js";

const entityId = "entity://project/atlas" as const;
const alice: RuntimePrincipal = {
  subject: "user:alice",
  scopes: ["state:read", "state:write"],
};
const reader: RuntimePrincipal = {
  subject: "user:reader",
  scopes: ["state:read"],
};

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

function binding(
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

function authority(provider = "primary", includeSecret = false): readonly AuthorityRule[] {
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

function catalog(
  options: {
    readonly authorityProvider?: string;
    readonly includeSecret?: boolean;
  } = {},
): InMemoryEntityRuntimeCatalog {
  const includeSecret = options.includeSecret === true;
  return new InMemoryEntityRuntimeCatalog([{
    entityId,
    bindings: [
      binding("primary", false, includeSecret),
      binding("replica", true, includeSecret),
    ],
    authority: authority(options.authorityProvider ?? "primary", includeSecret),
  }]);
}

function providers(
  primaryValues: Readonly<Record<string, StateValue>>,
  replicaValues: Readonly<Record<string, StateValue>>,
) {
  const now = () => "2026-09-24T00:00:00Z";
  const primary = new InMemoryStateProvider(
    "primary",
    [{ externalId: "primary-atlas", values: primaryValues }],
    now,
  );
  const replica = new InMemoryStateProvider(
    "replica",
    [{ externalId: "replica-atlas", values: replicaValues }],
    now,
  );
  return { primary, replica };
}

function registry(...providers: StateProvider[]) {
  return {
    providers: new Map(providers.map((provider) => [provider.id, provider])),
  };
}

function scopePolicy(
  writeEnabled: () => boolean = () => true,
): RuntimeAccessPolicy {
  return {
    evaluate(request) {
      if (request.kind === "operation") {
        const required = request.operation === "plan" ? "state:read" : "state:write";
        return request.principal.scopes.includes(required)
          ? { effect: "allow" }
          : { effect: "deny", code: `missing-${required}` };
      }

      if (request.kind === "field") {
        if (request.operation === "read") {
          if (!request.principal.scopes.includes("state:read")) {
            return { effect: "deny", code: "missing-state:read" };
          }
          if (
            request.canonicalProperty === "Project.secret"
            && !request.principal.scopes.includes("secret:read")
          ) {
            return { effect: "deny", code: "secret-read-denied" };
          }
          return { effect: "allow" };
        }

        if (
          !writeEnabled()
          || !request.principal.scopes.includes("state:write")
        ) {
          return { effect: "deny", code: "write-denied" };
        }
        if (
          request.canonicalProperty === "Project.secret"
          && !request.principal.scopes.includes("secret:write")
        ) {
          return { effect: "deny", code: "secret-write-denied" };
        }
        return { effect: "allow" };
      }

      return request.principal.scopes.includes("state:write")
        ? { effect: "allow" }
        : { effect: "deny", code: "proposal-write-denied" };
    },
  };
}

describe("RuntimeHost access policy", () => {
  it("lets a read-only principal see allowed state without receiving writable mutations", async () => {
    const state = providers(
      { deadline: "2026-11-20" },
      { deadline: "2026-11-15" },
    );
    const host = new RuntimeHost({
      catalog: catalog(),
      registry: registry(state.primary, state.replica),
      accessPolicy: scopePolicy(),
    });

    const proposal = await host.plan(entityId, reader);

    expect(proposal.plan.canonical.properties["Project.deadline"]?.value)
      .toBe("2026-11-20");
    expect(proposal.plan.mutations).toHaveLength(0);
    expect(proposal.status).toBe("noop");
  });

  it("does not leak a denied field value into the proposal or journal", async () => {
    const state = providers(
      { deadline: "2026-11-20", secret: "TOP-SECRET" },
      { deadline: "2026-11-15", secret: "old-secret" },
    );
    const journal = new InMemoryEventJournal();
    const host = new RuntimeHost({
      catalog: catalog({ includeSecret: true }),
      registry: registry(state.primary, state.replica),
      accessPolicy: scopePolicy(),
      journal,
      now: () => "2026-09-24T00:05:00Z",
    });

    const proposal = await host.plan(entityId, alice);
    const serialized = JSON.stringify({
      proposal,
      events: await journal.eventsForEntity(entityId),
    });

    expect(proposal.plan.canonical.properties["Project.secret"]).toBeUndefined();
    expect(serialized).not.toContain("TOP-SECRET");
    expect(serialized).not.toContain("old-secret");
  });

  it("turns write-permission revocation between plan and apply into pre-write drift", async () => {
    let writeEnabled = true;
    const state = providers(
      { deadline: "2026-11-20" },
      { deadline: "2026-11-15" },
    );
    let applyCalls = 0;
    const replica: StateProvider = {
      id: state.replica.id,
      observe: (externalBinding) => state.replica.observe(externalBinding),
      async apply(mutation) {
        applyCalls += 1;
        await state.replica.apply(mutation);
      },
    };
    const host = new RuntimeHost({
      catalog: catalog(),
      registry: registry(state.primary, replica),
      accessPolicy: scopePolicy(() => writeEnabled),
    });

    const proposal = await host.plan(entityId, alice);
    expect(proposal.status).toBe("ready");

    writeEnabled = false;
    await expect(host.apply(entityId, proposal.digest, alice))
      .rejects.toBeInstanceOf(ReconciliationPlanDriftError);

    expect(applyCalls).toBe(0);
    expect(state.replica.read("replica-atlas").deadline).toBe("2026-11-15");
  });

  it("rejects a valid digest presented by a principal without apply permission", async () => {
    const state = providers(
      { deadline: "2026-11-20" },
      { deadline: "2026-11-15" },
    );
    let applyCalls = 0;
    const replica: StateProvider = {
      id: state.replica.id,
      observe: (externalBinding) => state.replica.observe(externalBinding),
      async apply(mutation) {
        applyCalls += 1;
        await state.replica.apply(mutation);
      },
    };
    const host = new RuntimeHost({
      catalog: catalog(),
      registry: registry(state.primary, replica),
      accessPolicy: scopePolicy(),
    });

    const proposal = await host.plan(entityId, alice);

    await expect(host.apply(entityId, proposal.digest, reader))
      .rejects.toMatchObject({
        name: "RuntimeAccessDeniedError",
        code: "missing-state:write",
      } satisfies Partial<RuntimeAccessDeniedError>);
    expect(applyCalls).toBe(0);
  });

  it("never lets policy widen a source binding that is read-only", async () => {
    const state = providers(
      { deadline: "old-primary" },
      { deadline: "canonical-replica" },
    );
    const allowAll: RuntimeAccessPolicy = {
      evaluate: () => ({ effect: "allow" }),
    };
    const host = new RuntimeHost({
      catalog: catalog({ authorityProvider: "replica" }),
      registry: registry(state.primary, state.replica),
      accessPolicy: allowAll,
    });

    const proposal = await host.plan(entityId, alice);

    expect(proposal.plan.canonical.properties["Project.deadline"]?.value)
      .toBe("canonical-replica");
    expect(proposal.plan.mutations).toHaveLength(0);
  });

  it("records only the principal subject, not scopes, in durable journal evidence", async () => {
    const state = providers(
      { deadline: "2026-11-20" },
      { deadline: "2026-11-15" },
    );
    const journal = new InMemoryEventJournal();
    const principal: RuntimePrincipal = {
      subject: "user:alice",
      scopes: ["state:read", "state:write", "oauth-token-like-secret"],
    };
    const host = new RuntimeHost({
      catalog: catalog(),
      registry: registry(state.primary, state.replica),
      accessPolicy: scopePolicy(),
      journal,
      now: () => "2026-09-24T00:05:00Z",
    });

    const proposal = await host.plan(entityId, principal);
    const result = await host.apply(entityId, proposal.digest, principal);
    const events = await journal.eventsForRun(result.journalRunId!);
    const serialized = JSON.stringify(events);

    expect(events.every((event) => event.actor?.subject === "user:alice")).toBe(true);
    expect(serialized).not.toContain("oauth-token-like-secret");
    expect(serialized).not.toContain("state:write");
  });

  it("denies requests by default when a policy has no matching rule", async () => {
    const state = providers(
      { deadline: "2026-11-20" },
      { deadline: "2026-11-15" },
    );
    const host = new RuntimeHost({
      catalog: catalog(),
      registry: registry(state.primary, state.replica),
      accessPolicy: { evaluate: () => undefined },
    });

    await expect(host.plan(entityId, alice)).rejects.toMatchObject({
      name: "RuntimeAccessDeniedError",
      code: "no-matching-policy-rule",
    } satisfies Partial<RuntimeAccessDeniedError>);
  });
});
