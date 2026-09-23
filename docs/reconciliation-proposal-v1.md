# State-bound reconciliation proposal v1

A proposal digest is an approval boundary for the exact external side effects a reconciliation run intends to perform. It is transport-independent.

## Digest

Algorithm label:

`sha256`

Wire form:

`sha256:<64 lowercase hex characters>`

The digest input is UTF-8 canonical JSON produced from `ssrl-reconciliation-proposal-v1` material.

The material includes:

- canonical entity ID
- ordered external mutations
- mutation provider, external ID, external path, canonical property, next value, previous value when present, and base revision when present
- unresolved conflicts and their candidate values

It deliberately excludes:

- `observedAt` wall-clock timestamps
- the display/canonical state object when it does not change the side-effect set
- journal event IDs or run IDs

The purpose is to bind approval to what will change, not to when the data happened to be re-read.

## Apply semantics

`RuntimeHost.apply(entityId, expectedDigest)` always re-observes and re-plans before any provider write.

If the newly computed digest differs, the runtime:

1. records a terminal `reconciliation.completed` event with outcome `drifted` when journaling is enabled
2. emits no `mutation.requested`
3. performs zero provider writes
4. throws `ReconciliationPlanDriftError`

If the digest still matches, provider-specific revision/precondition checks remain the final race guard between re-plan and the actual write.

This is optimistic concurrency, not a distributed lock.

## Canonical JSON

Objects are serialized with lexicographically sorted keys at every nesting level. Array order is preserved. Non-finite numbers, undefined array elements, functions, symbols, bigint values, and non-plain objects are rejected.

Mutations are sorted by provider, external ID, external path, canonical property, then canonical next value. Conflict candidates and conflicts are also deterministically sorted.

## Cross-language test vector

Canonical JSON:

```json
{"conflicts":[],"entityId":"entity://project/atlas","mutations":[{"baseRevision":"replica:7","canonicalProperty":"Project.metadata","externalId":"atlas","externalPath":"meta","nextValue":{"a":1,"b":2},"previousValue":{"a":"x","z":false},"provider":"replica"}],"schema":"ssrl-reconciliation-proposal-v1"}
```

Expected digest:

```text
sha256:be561a3b00f16ae8e1d665bb4c49654e2732c35ad107ade65b02f0f7c2051584
```

Any independent implementation of proposal v1 must reproduce that exact digest.
