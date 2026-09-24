# Principal-scoped artifact blob replication v1

Policy-scoped replication metadata does not imply authorization to read or install the raw artifact bytes referenced by that metadata.

The security boundary is explicit:

```text
authorized artifact mutation metadata
        !=
authorization to read/install referenced CAS blob bytes
```

`@ssrl/replication-access` therefore adds two independent policy operations:

```text
artifact-blob:read
artifact-blob:apply
```

There is no read-to-apply, apply-to-read, or record-visibility-to-blob implication.

## Policy request binding

A blob policy request is bound to:

```text
normalized AccessPrincipal
server-configured projectionId
canonical verified artifact-mutation ReplicationRecord
record key / recordId / payload digest
RequiredArtifactBlob {
  digest
  size
  mediaTypes
}
```

The gateway normalizes the principal before policy or audit. Runtime object fields outside `AccessPrincipal`—for example bearer tokens, raw authorization headers, device credentials, or connector secrets—are discarded.

No matching policy rule remains deny-by-default.

## Outbound blob read

`readArtifactBlob()` requires:

```text
ArtifactStore
principal
projectionId
live pinned viewId
digest
optional caller maxBytes
```

The sequence is:

```text
normalize principal
  -> validate configured projectionId
  -> revalidate pinned authorization view
       principal binding
       projection binding
       lease expiry
       policyVersion
  -> find artifact upsert records in THIS authorized view that reference digest
  -> for each reference in deterministic record-key order:
       record:read
       then artifact-blob:read when record read allows
  -> enforce configured/caller byte ceiling
  -> head CAS blob
  -> read complete blob
  -> verify store metadata + expected size + SHA-256 content digest
  -> fail-closed allow audit
  -> return bytes
```

The Merkle tree only proves the mutation metadata was in the pinned authorized projection. Blob transfer reauthorizes both the record and the raw blob at transfer time.

### Non-enumerating unavailable shape

These cases intentionally share one public error:

```text
digest not referenced by the authorized projection
artifact record hidden from this projection
record:read revoked after discovery
artifact-blob:read denied
physical blob absent from the supplied ArtifactStore
```

They return:

```text
ReplicationArtifactBlobUnavailableError
"Requested replication artifact blob is unavailable"
```

The caller cannot use the blob endpoint to distinguish hidden existence from absence.

Projection expiry and policy-version revocation use the existing authorization-view error because the entire pinned authorization context is no longer valid.

## Inbound blob install

`installArtifactBlob()` is separate from artifact mutation apply.

Input:

```text
ArtifactStore target
principal
projectionId
full immutable artifact-mutation ReplicationRecord
bytes
optional caller maxBytes
```

Preflight order:

```text
normalize principal / projection
  -> enforce configured/caller byte ceiling
  -> verify immutable replication envelope + canonical artifact payload
  -> require artifact upsert with one referenced blob descriptor
  -> record:apply
  -> artifact-blob:apply
  -> verify supplied byte length + SHA-256 against authorized descriptor
  -> fail-closed allow audit
  -> ArtifactStore.putBlob(bytes, authorized mediaType)
  -> verify returned digest + size + mediaType descriptor
```

Malformed/tampered envelopes fail before policy. A denied record does not reach blob policy. Unauthorized or integrity-failing input performs no target CAS write.

The same authorized content can be installed repeatedly because the ArtifactStore owns idempotent content-addressed installation semantics.

## CAS installation is not mutation apply

Blob CAS installation and artifact-mutation append are **not one physical transaction**.

An authorized flow may therefore be:

```text
1. install verified CAS blob
2. later apply artifact mutation that references it
```

If step 2 fails or never happens, the blob may remain temporarily unreferenced until a future GC/retention process removes it.

This is deliberate. The replication-access layer does not pretend to provide an atomic transaction across filesystem/content-addressed bytes and artifact mutation metadata.

Tests explicitly prove that `installArtifactBlob()` installs the blob while leaving `ArtifactStore.snapshot().mutations` empty.

## Integrity

Outbound reads verify:

```text
head size == authorized descriptor size
read offset == 0
read complete == true
read digest metadata == authorized digest
read size metadata == authorized size
returned bytes length == authorized size
SHA-256(returned bytes) == authorized digest
```

Inbound installs verify the supplied bytes before any CAS write and verify the ArtifactStore's returned descriptor after install:

```text
digest
size
mediaType
```

A descriptor or content mismatch raises `ReplicationArtifactBlobIntegrityError`.

## Bounds

Server ceilings:

```text
maxBlobReadBytes
maxBlobApplyBytes
```

Default to 64 MiB and are themselves configuration-bounded.

A caller may provide a lower `maxBytes` but cannot raise the server ceiling. A blob whose authorized expected size exceeds the effective ceiling is rejected before transfer/write.

v1 transfers a complete blob in one operation. Chunking/resume is deliberately out of scope.

## Audit

Blob events are metadata-only:

```text
at
operation = artifact-blob.read | artifact-blob.apply
outcome
normalized subject
projectionId
optional deny code
optional record kind/key
blob digest
blob size when known
```

Events never contain:

```text
blob bytes
record payload bodies
bearer tokens
raw credential objects
```

Allow-audit is fail-closed before returning blob bytes or writing the target CAS. Denial audit is best-effort so an unavailable audit sink does not change the stable public denial shape.

## Deterministic accounting

Successful operations return local work accounting:

```ts
interface ReplicationArtifactBlobAccounting {
  referencingRecords: number;
  recordPolicyEvaluations: number;
  blobPolicyEvaluations: number;
  transferredBytes: number;
}
```

`referencingRecords` counts matching artifact records in the authorized pinned view, not global/hidden records.

The routine benchmark fixture is:

```text
64 authorized artifact mutation records
all reference the same 41-byte blob
32 pass record:read
only the final readable reference passes artifact-blob:read
```

Expected read accounting:

```text
referencingRecords       = 64
recordPolicyEvaluations  = 64
blobPolicyEvaluations    = 32
transferredBytes         = 41
```

Expected install accounting:

```text
referencingRecords       = 1
recordPolicyEvaluations  = 1
blobPolicyEvaluations    = 1
transferredBytes         = 41
```

Run:

```text
pnpm benchmark:replication:blob-access:v1
```

Elapsed time is observational only. The benchmark does not model network RTT, TLS, OAuth/JWT/DPoP verification, remote object-store behavior, or production throughput.

## Verified security cases

Tests prove:

- visible mutation metadata does not imply blob read;
- blob read does not imply blob apply;
- hidden, globally unknown, and physically absent blobs use the same public unavailable shape;
- record-read revocation after Merkle discovery blocks blob transfer;
- blob-read revocation blocks transfer independently;
- pinned projection expiry blocks transfer;
- policy-version revocation blocks transfer;
- source descriptor/content mismatch is rejected before bytes are returned;
- caller byte ceilings cannot raise server ceilings;
- denied installs write no target blob;
- malformed envelopes fail before blob policy;
- wrong bytes fail before target CAS write;
- allow-audit failure writes no target blob;
- same-digest install is idempotent;
- credential-like extra principal fields do not reach policy/audit;
- audit events contain digest/size metadata but no blob bytes or record payloads.

## Non-goals

- network transport;
- OAuth/JWT/DPoP verification;
- device enrollment or key exchange;
- end-to-end encryption;
- resumable/chunked blob transport;
- distributed garbage collection;
- atomic transaction across blob CAS + artifact mutation DB;
- private-set-intersection/confidential overlap discovery;
- automatic artifact mutation apply after blob install.
