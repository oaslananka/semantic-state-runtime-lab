# Connector contract v0

The connector contract describes semantic capabilities independently from transport.

## Design goals

- A connector declares what canonical entity types and properties it can represent.
- Read/write capability is explicit at both connector and field level.
- Revision and idempotency support are discoverable before execution.
- Authority is a hint, not an implicit global truth rule.
- Transport details such as MCP, HTTP, OAuth, webhooks, or vendor SDK calls stay outside canonical semantics.
- The contract must be implementable from TypeScript, Rust, Go, Python, or another language.

## Representation

The normative machine-readable shape for v0 is JSON Schema Draft 2020-12 at:

`schemas/connector-manifest-0.1.schema.json`

The TypeScript package `@ssrl/connector-sdk` is the first language binding, not the standard itself.

## Capability model

A connector advertises provider-wide support for:

- read
- write
- observe
- subscribe
- revision semantics: none, opaque, or monotonic
- idempotency: none or keyed

Each entity mapping then binds canonical property paths to external field paths and declares read/write access plus an optional authority hint.

## Incremental ingestion is a separate contract

`ConnectorManifest` describes capabilities and canonical field mappings. It does not define provider pagination, replay, checkpoint expiry, full-resync generations, or source deletion semantics.

Those reliability semantics live in `@ssrl/ingestion` and `docs/connector-ingestion-v1.md`. A connector may implement both the state-provider contract and the incremental-source contract, but neither is forced to masquerade as the other.

## Non-goals

v0 does not define network transport, authentication, retries, webhook payloads, provider-specific API calls, universal ontologies, or distributed transaction semantics.

Physical-device integration may later map compatible concepts to W3C WoT affordances, but this contract does not depend on the current WoT 2.0 draft.
