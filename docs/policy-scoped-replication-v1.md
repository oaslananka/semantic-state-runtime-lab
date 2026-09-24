# Policy-scoped replication v1

Replication authorization is part of the replicated **projection**, not a filter applied after a global Merkle tree is built.

A global root, global record count, internal branch hash, or leaf descriptor can reveal that private data exists or changed even when payload bytes are never transferred. v1 therefore constructs a different Merkle projection for each authorized principal/projection context.

```text
full immutable local records
        ↓ bounded verification/deduplication
principal + server-configured projectionId
        ↓ projection:read policy on full records
allowed full records only
        ↓ descriptors only
PrefixMerkleIndex
        ↓ frozen pinned view
root / count / node hashes / leaf descriptors
```

No unauthorized record participates in the tree that the principal sees.

## Package boundary

`@ssrl/replication-access` depends on:

- `@ssrl/access` for normalized authenticated actor identity;
- `@ssrl/replication` for immutable records, descriptors, Merkle/session contracts and existing apply semantics.

It deliberately does not parse OAuth tokens, JWTs, DPoP proofs, device keys or custom capability signatures.

`AccessPrincipal` remains:

```ts
interface AccessPrincipal {
  subject: string;
  scopes: readonly string[];
}
```

The gateway normalizes it before policy evaluation or audit emission. Extra runtime object fields such as bearer/device credential material are discarded.

## Policy operations

The policy sees the canonical full `ReplicationRecord` server-side plus immutable metadata.

```text
projection:read  may this record participate in this projection's Merkle tree?
record:read      may this full envelope be transferred out now?
record:apply     may this full incoming envelope be applied locally?
```

Read and write are independent. There is no read=>apply or apply=>read implication.

When policy returns no decision, the gateway uses deny-by-default:

```text
no matching rule -> deny / no-matching-policy-rule
```

## Projection IDs are server configured

`ReplicationAccessGateway` receives `projectionIds` at construction.

A request cannot invent a new predicate by supplying an arbitrary projection ID. Unknown IDs fail before source scanning or policy evaluation.

A projection ID is a logical sync scope such as:

```text
personal
shared-family
work-device
```

The policy may use the ID as part of its rule evaluation, but the client cannot install policy logic through it.

## Policy before Merkle construction

`openProjection()`:

1. normalizes the principal;
2. validates the configured projection ID;
3. bounds source-record count before hashing/policy work;
4. validates/deduplicates immutable replication records;
5. bounds policy evaluation count;
6. evaluates `projection:read` on every unique full record;
7. enforces the maximum allowed projection size;
8. converts **only allowed records** to descriptors;
9. builds the Prefix Merkle index;
10. freezes a reconciliation view.

The root/count therefore commit exactly to the authorized descriptor set.

Tests prove:

- Alice and Bob can have different roots/counts over the same global store;
- adding Bob-only records does not change Alice's fresh root;
- adding an Alice-authorized record does change Alice's fresh root;
- Alice's root equals a clean PrefixMerkleIndex built directly from Alice's allowed descriptors;
- source ordering does not change the root;
- an empty authorized projection has the normal empty-tree root and count zero;
- semantic and artifact descriptors can coexist without changing the replication wire descriptor format.

## Pinned authorization context

A frozen Merkle `viewId` is protocol state, **not** authorization.

The gateway stores server-side binding:

```text
normalized subject
normalized scopes
projectionId
policyVersion
expiresAt
authorized immutable record map
```

Every `viewInfo`, `nodeHashes`, `leafPage`, and record-transfer call rechecks:

- same normalized principal;
- same configured projection ID;
- authorization lease not expired;
- current policyVersion still equals the pinned version.

Expiry or policy-version change fails before returning hash/descriptor output. A resumed reconciliation must open a fresh authorized view.

Two views may have identical roots while belonging to different projection IDs; the access gateway still treats them as different authorization contexts.

## Merkle responses remain payload-free

Existing reconciliation protocol shapes are reused unchanged:

```text
ReconciliationViewInfo
MerkleNodeHashResponse
ReconciliationLeafPage
ReplicationRecordDescriptor
```

They contain roots, counts, hashes and immutable descriptors, but not record payloads or authentication credentials.

A dedicated test serializes node and leaf responses for a record containing a secret value and proves neither the secret nor canonical payload appears.

## Full record transfer

`readRecords()` requires:

```text
principal
projectionId
pinned viewId
requested descriptor keys
```

For each requested key:

1. the view's authorization lease/binding is rechecked;
2. the key must have belonged to the pinned authorized projection;
3. `record:read` is evaluated again at transfer time;
4. count and serialized-envelope byte bounds are enforced;
5. only then can the full envelope be returned.

This supports policy revocation between discovery and payload transfer.

### Non-enumerating failure

A globally existing key that was outside the principal's projection and a globally nonexistent key both produce:

```text
ReplicationRecordUnavailableError
"Requested replication record is unavailable"
```

The transfer path does not consult the global record set to distinguish the cases.

Deny-audit infrastructure failures are prevented from changing this public denial shape.

## Inbound apply

`applySemantic()` and `applyArtifacts()` are separate from read authorization.

The preflight order is:

```text
count bound
  -> canonical record integrity verification
  -> byte bound
  -> record:apply policy for EVERY record
  -> allow-audit preflight for EVERY record
  -> existing immutable store apply
```

Consequences:

- malformed/tampered records fail before policy sees them;
- one denied record rejects the entire requested batch before mutation;
- audit-sink failure on an allow event rejects the batch before mutation;
- existing state/artifact collision and idempotency semantics remain authoritative;
- read-only principals do not gain write permission;
- explicit writers can apply authorized semantic/artifact batches.

The access layer does not reimplement store collision semantics.

## Artifact blobs

Authorization of an `artifact-mutation` replication record does **not** authorize raw artifact blob bytes.

v1 transfers/applies immutable mutation metadata only through this gateway. Blob reads remain behind the existing artifact access/store boundary. There is no shortcut equivalent to:

```text
mutation visible => blob readable
```

## Bounds

v1 enforces configurable ceilings for:

- source records scanned;
- allowed projection records;
- projection policy evaluations;
- record-transfer count;
- record-transfer serialized envelope bytes;
- apply-record count;
- apply serialized envelope bytes;
- authorization lease duration.

Caller-provided lower bounds may tighten transfer/apply operations but cannot raise server ceilings.

## Audit

Optional events contain metadata only:

```text
time
operation
outcome
normalized subject
projectionId
optional deny code
optional record kind/key
```

No record payload, bearer token, device secret or raw credential object is copied into events.

Allow audit is fail-closed before outbound payload return / inbound mutation where relevant. Denial/view-invalid audit failures do not replace the stable public typed denial.

## Deterministic accounting benchmark

`pnpm benchmark:replication:access:v1` creates a local synthetic fixture:

```text
5,000 immutable source records
allow every 5th record
1,000 descriptor authorized projection
64 record transfers
```

The benchmark verifies deterministic accounting:

```text
sourceRecordsScanned = 5,000
projection policyEvaluations = 5,000
allowedDescriptors = 1,000
rootRecordCount = 1,000
record:read evaluations = 64
```

It also reports serialized envelope bytes for the transfer fixture.

Elapsed milliseconds are observational only. The fixture makes no network, credential-verification, TLS, RTT, storage-I/O or policy-cache performance claim.

## Non-goals

v1 does not add:

- OAuth/JWT/DPoP verification;
- custom signed capabilities;
- device enrollment/key rotation;
- HTTP/WebSocket transport;
- end-to-end encryption;
- peer discovery/NAT traversal;
- private-set-intersection/confidential overlap discovery;
- distributed policy storage;
- CRDT merge;
- physical deletion propagation;
- replication blob transfer authorization.

## Security invariant

The important rule is concise:

> A principal reconciles hashes and descriptors only for the same records it was authorized to project before the Merkle tree existed, and full read/apply is independently reauthorized at the point of transfer or mutation.
