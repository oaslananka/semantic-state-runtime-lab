# Artifact Access Gateway v1

The Artifact Access Gateway is the policy boundary between raw personal evidence and any agent/protocol that wants to read it.

```text
Artifact Plane (raw immutable bytes)
        ↓
Artifact Catalog (opaque URI index)
        ↓
Artifact Access Gateway
  identity + policy + bounds + audit
        ↓
MCP / HTTP / robot / mobile adapters
```

The gateway is deliberately protocol-neutral. MCP is one projection, not the security model.

## Core security invariant

Two statements are non-negotiable:

```text
opaque URI != authorization capability
CAS digest != authorization capability
```

A caller that knows an `ssrl://artifact/resource/...`, `ssrl://artifact/version/...`, or blob digest receives no permission from possession alone.

Authorization is evaluated against the **resource/version** being accessed.

This matters because CAS deduplication can make two resources point at the same blob:

```text
allowed resource ─┐
                  ├─ sha256:same-bytes
denied resource  ─┘
```

Permission on the allowed resource never transfers to the denied resource.

## Neutral principal

`@ssrl/access` now owns the transport-neutral actor model:

```ts
interface AccessPrincipal {
  subject: string;
  scopes: readonly string[];
}

type AccessDecision =
  | { effect: "allow" }
  | { effect: "deny"; code: string };
```

`RuntimePrincipal` / `RuntimeAccessDecision` remain compatible aliases in `@ssrl/runtime-host`.

Credentials are intentionally absent. OAuth tokens, JWTs, cookies, API keys, DPoP material, and provider claims belong at an authenticated transport boundary that maps them into an `AccessPrincipal`.

## Artifact catalog

Raw `ArtifactStore` still owns blobs and immutable mutations.

`ArtifactCatalog` is a separate backend-neutral lookup contract:

```text
listArtifactResources(cursor, limit)
artifactResourceByUri(uri)
artifactVersionByUri(uri)
```

The catalog may reveal internal `ArtifactResourceIdentity` only to trusted in-process components such as the access gateway. Public descriptors do not contain:

```text
sourceKey
externalType
externalId
sourceUri
blob digest
```

### LocalArtifactStore schema v2

The local backend adds rebuildable indexes:

```text
artifact_catalog_meta
artifact_resource_index
artifact_version_index
```

A real v1 -> v2 migration:

1. creates a persistent catalog identity;
2. deterministically backfills resource URI indexes from existing mutation identities;
3. deterministically backfills version URI indexes from canonical immutable mutations;
4. updates the component-scoped schema marker.

The immutable mutation log remains source of truth. URI indexes are derived acceleration structures.

Exact mutation replay also verifies/repairs missing derived URI index rows. A conflicting index fails closed.

## Catalog cursor

`ArtifactCatalogCursor` is opaque to consumers and store-bound.

The local cursor contains:

```text
persistent catalog identity
+ encoded last opaque resource URI
```

A cursor from another database, malformed cursor, or cursor pointing at a resource URI that this catalog never emitted is rejected.

Listing order is deterministic by opaque resource URI.

v1 catalog pagination is not a frozen snapshot. A concurrent insertion whose URI sorts before an already-consumed cursor may appear only in a later fresh enumeration. This is acceptable for resource discovery; artifact history itself remains immutable/bitemporal.

## Policy requests

The gateway policy sees trusted internal context:

```text
principal
operation = metadata | read
target = current | version
opaque public URI
internal resource identity
resolved immutable upsert mutation
optional requested byte range
```

The policy can therefore express source/resource-specific rules without exposing those identifiers to the client.

When a policy is configured:

```text
missing principal -> deny
undefined policy decision -> deny
```

A gateway with no policy is an explicitly trusted in-process surface and must not be exposed directly to untrusted remote callers.

## Listing

`gateway.list()` walks the indexed catalog and resolves each resource at the requested:

```text
validAt
knownAt
```

Only currently-present artifacts can enter the public list.

Each present resource receives a `metadata` policy decision before public metadata is emitted.

The public descriptor contains only:

```ts
interface ArtifactResourceDescriptor {
  uri: string;          // opaque current-resource URI
  versionUri: string;   // opaque immutable version URI
  mediaType: string;
  size: number;
  title?: string;
  effectiveAt: string;
  recordedAt: string;
}
```

Denied resources are skipped, not returned with redacted source identities.

Because denied entries may dominate a catalog, v1 also has a bounded `maxCatalogScansPerList` guard.

## Current vs historical/version read

A current-resource URI is resolved bitemporally at `validAt` / `knownAt`.

If the current state is deleted or absent, read returns not-found semantics.

An immutable version URI resolves directly to its upsert mutation and receives a separate policy decision:

```text
current access allow/deny
!=
historical version access allow/deny
```

This prevents a caller from using old immutable versions merely because current access was once permitted.

## Authorization before sensitive range errors

The gateway validates request shape first, but a resolved resource's policy decision occurs before returning blob-size-dependent errors.

For example, an unauthorized caller does not learn that a denied resource is 20 MiB because the request returned `too large` instead of `denied`.

After allow:

```text
validate offset/end against blob size
apply caller byte ceiling
apply server byte ceiling
take the smaller ceiling
read exact range
```

The gateway never silently truncates.

## Bounded reads

The gateway has a server-owned `maxReadBytes`.

A caller may optionally supply a smaller `maxBytes`, but never a larger effective budget:

```text
effective max = min(server max, caller max)
```

A full read whose remaining bytes exceed the effective cap throws `ArtifactReadTooLargeError`.

Protocol-neutral range reads use:

```text
offset
length
```

and return exact verified bytes from the Artifact Store.

## Audit seam

An optional `ArtifactAccessEventSink` receives:

```text
timestamp
subject
operation
target
opaque public URI
allow/deny outcome
policy code on deny
offset + byteCount after successful read
```

It never receives raw bytes, credentials, sourceKey, externalId, sourceUri, or blob digest.

v1 does not prescribe a durable audit backend.

## MCP Resources projection

`@ssrl/mcp-server` can now be composed with an `ArtifactAccessGateway`.

The MCP adapter receives the already-established composition principal. It does not inspect MCP `clientInfo` to derive authorization.

Two resource templates are registered:

```text
ssrl://artifact/resource/sha256/{fingerprint}
ssrl://artifact/version/sha256/{fingerprint}
```

Only current resources participate in `resources/list`.

Immutable `versionUri` values are returned in the gateway descriptor and can be read directly when authorized, but are not duplicated into resource listing.

`ssrl://artifact/blob/...` is deliberately not registered as an MCP resource template.

### Text and binary

For `text/*`:

```text
strict UTF-8 success -> TextResourceContents
strict UTF-8 failure -> BlobResourceContents
```

There is no replacement decoding.

Non-text media types are returned as exact base64 `BlobResourceContents`.

### MCP byte cap

MCP has its own `maxResourceBytes` which can only narrow the gateway cap.

`resources/read` in v1 serves full content only. Oversized artifacts fail with a sanitized protocol error rather than being truncated.

Range access remains available through the protocol-neutral gateway. A future dedicated range tool or HTTP Range adapter can reuse the same policy request rather than encoding offset/length into canonical resource URIs.

### Listing limit

The current high-level TypeScript SDK `ResourceTemplate` listing callback does not carry a caller pagination cursor through to the template callback when aggregating `resources/list`.

Therefore v1 MCP uses a bounded complete-list rule:

```text
<= maxListedResources -> return complete policy-filtered list
> maxListedResources  -> sanitized error
```

It never returns a partial list that looks complete.

The underlying `ArtifactCatalog` remains cursor-paginated for protocol adapters that support pagination directly.

### Cache posture

For MCP 2026-07-28 resource reads, SSRL declares:

```ts
{ ttlMs: 0, cacheScope: "private" }
```

Even immutable version bytes use the conservative hint in v1 because access authorization can be revoked independently from content immutability.

The existing in-memory/stdio SDK test harness speaks the legacy handshake, so the v1 test suite asserts the registered cache-hint constant rather than claiming modern-wire serialization coverage. Modern Streamable HTTP composition is a later integration test.

## Error posture

MCP maps authorization denial and unknown artifact URIs to resource-not-found semantics and removes policy/source identifiers from client-visible errors.

Oversized reads produce one generic MCP read-limit message.

Unexpected internal errors produce one generic artifact-read/listing failure message.

## Verified cases

Tests cover:

- missing principal with policy configured;
- no matching policy rule defaults to deny;
- policy-filtered listing;
- no source identity in public descriptors;
- same digest on allowed + denied resources does not transfer permission;
- current delete vs historical immutable version;
- separate version authorization;
- authorization before blob-size/range error disclosure;
- server byte cap and caller-only narrowing;
- exact range bytes;
- audit record privacy;
- trusted in-process no-policy mode;
- indexed URI lookup and v1 -> v2 catalog migration;
- cursor reopen/foreign/unknown rejection;
- derived-index repair on idempotent replay;
- MCP policy-filtered list;
- current and version MCP reads;
- strict UTF-8 text vs base64 blob;
- direct blob URI rejection;
- sanitized deny/not-found/oversize errors;
- MCP list overflow fail-closed;
- MCP self-reported client name has no authorization effect;
- existing `state.plan` / `state.apply` MCP tests unchanged.

## Non-goals

v1 does not implement:

- OAuth/JWT verification;
- Streamable HTTP deployment;
- signed/capability URLs;
- public/shared caches;
- artifact writes through MCP;
- streaming multi-megabyte MCP bodies;
- range-in-resource-URI conventions;
- durable audit storage;
- document extraction/OCR/chunking;
- cloud multi-tenant authorization.

## Next step

The next security/product checkpoint is authenticated remote composition:

```text
verified transport auth
   -> AccessPrincipal
   -> RuntimeHost + ArtifactAccessGateway
   -> stateless Streamable HTTP MCP requests
```

That layer should also prove modern 2026-07-28 cache hints and per-request principal mapping on the wire.
