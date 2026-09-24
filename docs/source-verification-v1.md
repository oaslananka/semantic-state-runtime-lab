# Source verification hints v1

The local Context Plane must answer two competing requirements:

1. source truth must remain authoritative; and
2. unchanged queries must not repeatedly pay an O(files + bytes) Markdown scan.

v1 solves this with a **verification gate**. Filesystem notifications are dirty/wake-up hints only. They never become semantic truth or an ingestion cursor.

```text
fs.watch hint / max-age expiry / startup
                ↓
        source verification gate
                ↓ when verification required
      authoritative Markdown full scan
                ↓
     existing ingestion + retractions
                ↓
       semantic state / capsules
```

## Why a watcher is not truth

Node 24 supports recursive `fs.watch()` on Linux, but Node documents important caveats:

- watcher behavior is not fully consistent across platforms;
- the API can be unreliable or unavailable on NFS/SMB and virtualized host filesystems;
- callback filenames are not guaranteed;
- Linux/macOS inode behavior can miss later activity on a delete-and-recreate path.

References:

- https://nodejs.org/download/release/v24.20.0/docs/api/fs.html#fswatchfilename-options-listener

Chokidar can normalize event shape, atomic writes, recursive watching, and polling behavior, but it still builds on filesystem notification/stat mechanisms. SSRL does not need normalized file events because it never applies event payloads directly. A single hint only means "verify the source again". Adding Chokidar in v1 would therefore add dependency/behavior surface without replacing the authoritative scan.

Reference:

- https://github.com/paulmillr/chokidar

## Verification gate

Each configured authoritative `(provider, externalType)` source owns a `SourceVerificationGate`.

The gate tracks:

```text
dirtyGeneration
verifiedGeneration
lastVerifiedAt (monotonic runtime clock)
degraded
maxVerificationAgeMs
```

A fresh process starts dirty and unverified.

Before a full verification begins, the gate captures the current dirty generation in a ticket. Only after the authoritative scan succeeds is that ticket marked verified.

If a filesystem event arrives during the scan:

```text
scan ticket generation = G
event increments dirty generation to G+1
scan succeeds and verifies only through G
source remains dirty
next access verifies again
```

A failed scan never advances the verified generation.

## Bounded missed-event recovery

Even a watcher that appears healthy is not trusted indefinitely.

When `maxVerificationAgeMs > 0`, an otherwise clean source is forced through another authoritative scan once the monotonic verification age reaches that bound.

This provides bounded recovery when a filesystem notification was silently missed.

The clock is runtime-monotonic time (`performance.now()` by default), not semantic `recordedAt`/valid time.

## Conservative default

`context.sourceVerificationMaxAgeMs` is a non-negative safe integer.

```json
{
  "context": {
    "sourceVerificationMaxAgeMs": 60000
  }
}
```

Semantics:

```text
0      -> optimization disabled; authoritative scan on every access
> 0    -> watcher dirty hints + forced scan at max age
```

The default is **0**.

That is intentionally conservative. Enabling a positive value is an explicit performance/freshness tradeoff. If a watcher misses an event, source state may remain unverified until the max-age deadline; it does not remain stale indefinitely.

This runtime tuning value is not included in persistent source-topology identity. Changing it does not require a fresh semantic/ingestion store.

## Degraded mode

If recursive watch setup throws, or an established watcher later emits an error or closes unexpectedly, all gates attached to that root enter permanent degraded mode for the process lifetime.

Degraded behavior is:

```text
every access -> authoritative full scan
```

There is no silent fallback to "assume clean".

Intentional runtime shutdown closes watchers idempotently and is not considered degradation.

## Root granularity

The implementation creates one recursive `fs.watch` handle per distinct configured root and attaches all source gates under that root.

A hint marks all configured source mappings sharing that root dirty. The event filename/type is deliberately ignored.

This may perform more verification than a path-sensitive watcher, but it preserves the key safety property: event interpretation cannot bypass the connector's authoritative inventory, configured external-ID allowlist, or deletion sweep.

Separate roots remain isolated. A dirty event in the primary root does not rescan a clean replica root.

## Request integration

Both local access paths share the same coalesced source verifier:

```text
MCP context.compile ─┐
                     ├─> CoalescedVerifiedSourceSync
artifact list/read ──┘
```

For each access round:

1. dirty/expired/degraded sources run their existing authoritative `IngestionEngine.sync()` path;
2. clean unexpired sources are skipped;
3. concurrent callers share the same in-flight verification round;
4. after synchronization, the existing capsule/context or artifact gateway serves the request.

No filesystem event mutates semantic state directly.

## Restart semantics

Watcher state is intentionally in-memory only.

A process restart starts every gate dirty/unverified even when the durable semantic store and Context Capsule cache are warm. The first access therefore verifies each configured source before serving context.

This avoids persisting a false assertion that "nothing changed while the process was stopped".

## Delete and rename behavior

Dirty hints do not alter source semantics.

After an edit, delete, or rename hint, the next verification is the same authoritative scan used without watchers. Existing ingestion behavior still decides the result:

- missing configured resources participate in the full-generation unseen-resource sweep and generate semantic/artifact retractions;
- unconfigured Markdown inside a strict authoritative root still fails closed;
- source revision and raw artifact race checks remain unchanged.

The watcher cannot whitelist, rename-correlate, or directly retract anything.

## Measured local benchmark

Run:

```bash
pnpm build
pnpm benchmark:markdown:v1
```

On the MSI development host on 2026-09-24, the synthetic benchmark measured:

| Notes | Raw bytes | Authoritative scan | Dirty-hint verify | 25 clean gate accesses | Mean clean gate access |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 19,812 | 59.89 ms | 40.52 ms | 0.122 ms | 0.0049 ms |
| 1,000 | 200,112 | 255.81 ms | 224.30 ms | 0.030 ms | 0.0012 ms |
| 10,000 | 2,021,112 | 2,577.61 ms | 1,864.12 ms | 0.027 ms | 0.0011 ms |

For every case:

- the initial/dirty verification performed the real full scan;
- a burst of 25 clean accesses performed **zero additional Markdown scans**;
- an explicit dirty hint triggered exactly one additional authoritative verification;
- the byte-identical authoritative checkpoint remained stable.

These timings are observational and filesystem/hardware dependent. The clean numbers measure the verification-gate path, not complete `context.compile` latency, MCP transport, retrieval, or model latency. No production SLA is implied.

## Verified failure cases

Tests cover:

- startup begins dirty and verifies before serving context;
- clean source skip within max age;
- max-age forced verification;
- event arriving during an in-flight scan remains dirty;
- failed verification retries on next access;
- watcher setup failure -> degraded always-scan;
- established watcher error -> degraded always-scan;
- unexpected watcher close -> degraded always-scan;
- intentional/idempotent watcher close does not degrade;
- separate-root dirty isolation;
- concurrent request coalescing;
- edit and delete hints trigger authoritative rescan and existing retraction semantics;
- process restart verifies every source again;
- changing max-age does not create persistent source-topology drift.

## Non-goals

v1 does not add:

- watcher events as durable source cursors;
- direct event-to-semantic mutation;
- filename/event-type interpretation;
- polling as the primary correctness path;
- network filesystem correctness claims;
- remote webhook/subscription infrastructure;
- a generic connector subscription protocol;
- background daemon/event queue;
- debounce/atomic-write inference.

The next connector/subscription layer can reuse the same architectural rule: notification channels may wake ingestion, but only provider-specific authoritative evidence/checkpoints may advance semantic truth.
