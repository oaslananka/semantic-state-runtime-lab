# Authoritative Markdown Ingestion v1

This is the first real local raw-content ingestion path through the SSRL data plane:

```text
local Markdown vault
    ↓ authoritative full scan
structured SourceChange receipts
    ↓
semantic projection ───────────────┐
raw artifact projection            │
    ↓                              │
Artifact Plane (exact bytes)       │
    ↓                              │
Semantic State Store ◄─────────────┘
    ↓ durable semantic change feed
incremental Context Capsules
```

The design is intentionally correctness-first. It does **not** claim that a portable filesystem watcher is a durable incremental log.

## Why full scan is authoritative

Node's `fs.watch()` documentation still warns that watcher behavior is not completely consistent across platforms, can be unreliable or impossible on NFS/SMB and virtualized host filesystems, and does not guarantee a filename on every event. Watch events may be useful later as wake-up or dirty hints, but v1 never treats them as replay truth.

Every synchronization round therefore starts with:

```text
incremental request
    -> reset-required
    -> authoritative full generation
```

The ingestion engine's existing full-generation sweep discovers deletions.

## Source identity

A Markdown source resource is identified by the root-relative POSIX path:

```text
Projects/Atlas.md
```

The connector never persists an absolute local filesystem path in the provider payload or artifact metadata.

v1 does not infer universal entity identity from a path. The deployment supplies:

```ts
entityIdForExternalId(externalId): EntityId
```

This lets a product decide whether a rename means a new entity identity, a stable externally mapped identity, or something else.

## Deterministic authoritative inventory

The scanner:

- recursively enumerates `.md` regular files only;
- sorts every directory entry and final resource order deterministically;
- excludes symbolic links from authoritative inventory;
- emits root-relative POSIX external IDs;
- computes `revision = sha256(exact raw bytes)`;
- computes a deterministic full checkpoint from sorted `[externalId, revision]` pairs;
- fails early when `maxFiles` is exceeded;
- checks remaining `maxRawBytes` against file size before reading and verifies the actual byte count after reading.

An unchanged byte-identical inventory therefore produces the same checkpoint and source change IDs.

The adapter still performs the full scan on the next round. Stable checkpoint identity is replay/accounting information, not a promise that the filesystem was not rescanned.

The adapter can optionally receive an explicit `externalIds` inventory. By default this scopes the scan to those IDs. Deployments that treat the configured root as a closed authoritative namespace can also enable `rejectUnlistedExternalIds`; then any additional Markdown file fails the scan instead of being silently ignored. The local Node Context Plane uses this strict mode.

## Full-scan pagination

A multi-page full scan captures one in-memory session:

```text
scan once
  -> frozen sorted entries
  -> frozen final checkpoint
  -> page 1
  -> continuation
  -> page 2...
```

Directory mutations between pages do not alter the structured changes already captured in that session.

Continuations are deliberately not durable. A process restart loses the session and the ingestion engine safely restarts the active full generation from the beginning.

Starting a new full scan expires abandoned sessions so the adapter does not retain unbounded stale inventory snapshots.

## Structured payload boundary

`MarkdownIngestionPayload` contains only manifest-configured readable frontmatter fields:

```ts
interface MarkdownIngestionPayload {
  values: Readonly<Record<string, StateValue>>;
}
```

It does not contain:

- Markdown body text;
- complete source text;
- `Uint8Array`/Buffer;
- absolute filesystem paths;
- unmapped frontmatter.

That keeps provider receipts and mapped semantic plans compact and avoids duplicating personal raw content into the ingestion-state database.

## Strict decoding

Semantic frontmatter parsing requires valid UTF-8. Invalid byte sequences fail with `InvalidMarkdownEncodingError`; they are not replacement-decoded into silently altered semantic input.

The raw Artifact Plane does not normalize text. BOM, CRLF, Unicode, body text, and all other bytes round-trip exactly.

## Semantic projection

For the selected manifest entity mapping, each configured readable field with a value becomes one deterministic observation slot.

Observation identity derives from:

```text
externalId
content revision
a canonical field name
external field path
```

Observation provenance uses:

```text
provider = connector manifest id
externalId = relative Markdown path
revision = exact content digest
```

A missing mapped field is intentionally omitted from the desired projection. The generic ingestion engine then retracts the previous slot target. No Markdown-specific retraction algorithm exists.

v1 does not generate relations or aliases automatically.

## Exact raw artifact projection

The artifact mapper rereads the source file immediately before returning bytes and recomputes the revision.

If the file was changed, removed, replaced by a symlink, or otherwise no longer matches the captured source revision, the mapper throws `StaleMarkdownIngestionSourceError` and the round stops before artifact mutation, semantic append, resource projection, or checkpoint advancement.

The mapper returns:

```text
bytes     exact Uint8Array
mediaType text/markdown
title     basename only
sourceUri omitted
```

The generic artifact-aware ingestion saga then performs content-addressed blob install and immutable artifact mutation persistence.

## Symlinks and path containment

Authoritative enumeration skips symlink entries, including symlinks that point inside the root.

Artifact reread validates the requested external ID, root containment, `lstat()` regular-file shape, and resolved path containment before reading.

This prevents normal path traversal and observed symlink substitution from becoming source identity. v1 does not claim to provide an OS-level adversarial filesystem sandbox against a separate malicious process winning a pathname TOCTOU race; stronger hostile-filesystem isolation would require lower-level handle-relative primitives beyond this connector contract.

## Delete and rename semantics

Deletion is discovered by the generic full-generation unseen-resource sweep.

For a removed Markdown path:

- current semantic slots are retracted;
- a live raw artifact receives an artifact delete mutation;
- the historical entity/assertions/artifact versions remain auditable.

A rename is therefore:

```text
old path -> delete
new path -> upsert
```

There is no automatic rename correlation in v1.

## Restart behavior

The full-scan continuation is ephemeral, but all effect state is durable:

- source receipts and mapped plans: SQLite ingestion state;
- semantic assertions/retractions: SQLite Semantic State Store;
- raw versions: Local Artifact Store;
- semantic change cursor: Semantic State Store;
- context capsule checkpoint: capsule cache implementation.

The end-to-end test closes and reopens ingestion, semantic, and artifact stores between rounds. The same semantic feed continues into the normal Context Capsule worker; there is no connector-specific materializer path.

## Verified end-to-end lifecycle

The real filesystem test covers:

1. seed two nested Markdown notes;
2. authoritative sync into SQLite ingestion state + Semantic State Store + Local Artifact Store;
3. exact BOM/CRLF/body byte verification from CAS;
4. structured frontmatter verification in semantic state and capsule;
5. raw private body absence from source receipt and mapped plan;
6. close/reopen all durable stores;
7. edit one note's body/frontmatter and remove one mapped frontmatter field;
8. verify one new artifact upsert, one new observation, and prior semantic-slot retractions while the unchanged note causes no artifact/semantic mutation;
9. close/reopen again;
10. delete the other file and verify artifact delete + semantic retraction;
11. verify capsule refresh from the ordinary semantic change feed;
12. rename test verifies delete(old path) + upsert(new path);
13. scan-to-artifact race aborts before artifact mutation, semantic append, projection, or checkpoint advancement.

Separate adversarial tests cover symlinks, invalid UTF-8, deleted-after-scan files, expired continuations, explicit external-ID scoping, strict unlisted-file failure, `maxFiles`, and `maxRawBytes`.

## Performance benchmark

Run:

```bash
pnpm build
pnpm benchmark:markdown:v1
```

The deterministic workload creates 100 and 1,000 small synthetic Markdown notes and measures:

```text
recursive enumeration
+ exact byte reads
+ SHA-256
+ strict UTF-8 decode
+ YAML/frontmatter parsing
+ configured field extraction
```

A local 2026-09-24 run measured approximately:

| Notes | Raw bytes | Pages | Scan/parse time |
| ---: | ---: | ---: | ---: |
| 100 | 19,812 | 1 | 59 ms |
| 1,000 | 200,112 | 8 | 262 ms |

These timings are observational, hardware/filesystem dependent, and dominated by small-file overhead. They are **not** a production latency SLO or evidence that full scans scale to very large vaults.

The benchmark also verifies that a second byte-identical scan yields the same checkpoint.

## Non-goals

v1 does not add:

- `fs.watch()` as a durable cursor;
- Obsidian UI/plugin integration;
- arbitrary binary source files;
- PDF/OCR/chunk extraction;
- relation inference;
- alias lifecycle redesign;
- entity tombstones;
- artifact ACL/MCP serving;
- streaming blob ingestion;
- automatic rename correlation;
- cloud filesystem synchronization.

## Next architectural step

Raw bytes now exist durably and correctly, but they must **not** be exposed wholesale to every agent.

The next product-risk layer should be artifact access policy + scoped resource serving:

```text
agent/task identity
  -> policy
  -> bounded artifact resource/range
  -> provenance + audit
```

That boundary matters more than adding another connector because the Artifact Plane can contain the user's most sensitive unstructured data.
