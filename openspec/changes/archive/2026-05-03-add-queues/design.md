## Context

Workflow code today has no engine-supplied way to persist a small piece of data between invocations of the same workflow. The runtime serializes invocations per workflow (per-workflow `runQueue`), the EventStore archives lifecycle events for forensics, and `StorageBackend` is engine-internal — none surface to author code. Authors who want a producer trigger to hand work to a consumer trigger inside the same workflow have to externalise the state via the `sql` plugin (BYO Postgres) or via outbound `fetch`. The first request from authors using the platform has been a small durable queue.

Constraints that shape the design:

- Single-instance, single-writer deployment (one Quadlet unit per env). No coordination plane.
- Per-workflow `runQueue` already serializes invocations of one workflow.
- Sandbox boundary: untrusted JS in QuickJS WASM; only declared bridge surfaces are reachable.
- Existing system-bridge plugins (`sql`, `mail`, `fetch`) install a locked-outer + frozen-inner global per `SECURITY.md` §2 R-2. New plugins must follow the same pattern and update §2 inventories.
- DuckLake-backed EventStore is OLAP-shaped and append-only; queues are OLTP-shaped (small mutating set, frequent DELETE).
- Build pipeline discovers SDK primitives by brand symbol on exported values; non-exported primitives are invisible to the build.

## Goals / Non-Goals

**Goals:**

- A first-class `defineQueue({name, schema})` SDK primitive symmetric with `action`, `httpTrigger`, `cronTrigger`, `manualTrigger`.
- FIFO, at-most-once `get`, with a hard durability contract: a successful `put` survives SIGKILL / power loss; a successful `get` durably removes the item before returning.
- Schema validation on both `put` and `get`, so persisted items are always typed at both ends.
- Per-workflow scope. No cross-workflow / cross-tenant queues in v1.
- Bounded resource use: 1 KB per item, 1k items per queue. Predictable disk footprint, predictable archive volume.
- Atomic with workflow upload: declared queues exist on disk after upload returns 200; removed queues are gone.
- Zero new runtime dependencies.
- Zero new `R-` rule in `SECURITY.md`. The plugin slots cleanly into the existing system-bridge framework.

**Non-Goals:**

- Visibility timeout, ack/nack, or dead-letter sub-queues. Ruled out by the at-most-once choice; the engine has a "no retry in v1" stance for invocations and the queue contract mirrors that.
- Cross-workflow, cross-(owner, repo), or global queues. The "sealed unit per workflow" invariant stays.
- Push semantics / `queueTrigger`. Authors drain via `cron` or any other trigger; no engine-driven worker model.
- Inspection / admin operations (`peek`, `clear`, `size`). Author API is exactly `{put, get}`.
- Dynamic queue creation. Queues are declared at module top level and discovered at build time.
- Per-queue cap overrides. Engine-wide caps only.
- Schema-fingerprint upload-time gates. Schema mismatches surface lazily on `get`.
- Multi-instance coordination. The single-writer deployment contract eliminates the problem.

## Decisions

### Decision 1: Storage format — hand-rolled NDJSON, one file per queue

**Choice.** One UTF-8 file per queue at `<root>/queues/<owner>/<repo>/<workflow>/<queueName>.ndjson`. Each line is one `JSON.stringify`'d item terminated by `\n`. `put` appends a line. `get` reads the file, pops the first non-empty line, writes the remainder to a tmpfile, fsyncs, renames over the original, fsyncs the parent dir.

**Alternatives considered:**

- **Single DuckDB table for all queues** in `<root>/queues.duckdb`. Reuses an existing dependency and gives O(log n) atomic FIFO. Wrong workload shape: DuckDB is OLAP-tuned and queues are DELETE-heavy. Adds a process-lifetime catalog handle, startup wiring, SIGTERM CHECKPOINT, schema migration concerns. With the 1 KB × 1k caps the maximum file size is 1 MB — DuckDB's scaling advantages are immaterial.
- **One DuckDB-backed table inside `events.duckdb`.** Would couple queue durability to event-store schema migrations. Worst tradeoffs of both.
- **One file per item** (`<…>/<queueName>/<id>.json`). No file rewrites on `get`, but each `get` is `readdir + open + unlink` and FIFO requires sorting filenames. Awkward atomicity story.
- **Single big NDJSON for all queues.** Every `get` rewrites a multi-MB log. Worst of both worlds.
- **Embedded KV (`classic-level`, `lmdb-js`).** Adds a native module and complicates the container image for a feature that is not on a hot path.
- **Persistent-queue libraries (`better-queue`, `node-persistent-queue`).** Wrong shape — they assume retry/worker semantics we excluded — or thin wrappers that pull in `sqlite3`.

**Rationale.** At the chosen caps, max queue size is 1 MB; typical is far smaller. The implementation collapses to ~50 LOC of `node:fs/promises`. tmpfile + `rename(2)` gives transactional atomicity without a database. Per-workflow `runQueue` makes intra-process locking unnecessary; the single-instance deployment makes inter-process locking unnecessary. The cost — up to ~1 MB of write per `get` against a full queue — sits well below realistic SSD limits and is bounded by the 1k cap.

### Decision 2: Durability — fsync per `put` and per `get` rename

**Choice.** Every successful `put` performs `fsync(fd)` on the appended file before returning. Every successful `get` performs `fsync(tmpfd)` after writing the remainder, `rename(tmp, path)` for atomic swap, and `fsync(parentDir)` so the rename itself reaches durable media. Both ops return only after their fsyncs land.

**Alternatives considered:**

- **No fsync, rely on kernel writeback.** Matches the rest of the engine (`StorageBackend.write` does not fsync; EventStore's DuckLake fsyncs only on commit). Loses up to ~30 s of puts on SIGKILL / power loss with no signal to the author — a successful `put` could silently evaporate.
- **Periodic fsync from a `QueueStore` lifecycle component.** Reintroduces the startup-wiring + SIGTERM-drain code path the NDJSON choice was designed to eliminate.
- **`fdatasync` instead of `fsync`.** Marginal speedup, no semantic change for our case (we care about both data and metadata being durable). Skip.

**Rationale.** Queues are the only engine primitive whose entire value proposition is cross-invocation durability. Other engine state losses on SIGKILL are "loud" — they affect an in-flight invocation that hadn't completed. A queue item silently disappearing after a successful `put` returned would be a contract violation. The cost (~1–5 ms per op on consumer SSD, lower on NVMe) is acceptable for the advertised semantic. Authors needing higher throughput can use `__sql` for that workload; queues do one job and do it durably.

### Decision 3: API surface — `{put, get}` only, no inspection

**Choice.** `defineQueue({name?, schema})` returns a brand-tagged `Queue<T>` with exactly two members: `put(item: T) => Promise<void>` and `get() => Promise<T | undefined>`. No `size`, `peek`, or `clear`. Empty queue returns `undefined` from `get` (no exception). `name` is optional: when omitted, the build pipeline derives it from the export identifier (mirroring `action`/`*Trigger` name-derivation); when provided, the explicit value wins.

**Alternatives considered:**

- **Add `size()`** for smart drain loops. Authors who care can call `get` until it returns `undefined`. Adding `size` invites drift between depth and data (a TOCTOU race against subsequent puts in the same invocation), and we explicitly excluded inspection ops to keep the bridge surface minimal.
- **Add `peek()`** for "look but don't take" workflows. Tempts authors into broken patterns where they peek, decide, and then get — racing the same item with itself across a re-fired trigger. With at-most-once semantics, peek-then-get is strictly worse than get-then-process.
- **Add `dequeueMany(n)`** for bridge-cost amortisation. Each bridge call is JSON round-trip + worker hop, ~0.5 ms baseline. At the 1k cap a full drain is ~500 ms of bridge overhead — acceptable for v1; revisit if profiling shows it hurts.
- **Throw `QueueEmpty` on empty `get`.** Forces try/catch for control flow against the codebase's general style.

**Rationale.** The smallest possible surface that supports the producer/consumer use case the feature exists to enable. Every additional method is one more thing to spec, threat-model, and version.

### Decision 4: Identity — `(owner, repo, workflow, queueName)`, persists across re-uploads

**Choice.** A queue is identified by the tuple `(owner, repo, workflow, queueName)`. The workflow `sha` is **not** part of the identity. Re-uploading the same workflow with a new bundle keeps the data. Removing the `defineQueue` declaration from the source removes the queue (its file is unlinked atomically with the upload).

**Alternatives considered:**

- **Identity includes `workflow.sha`.** Each re-upload starts from an empty queue. Defeats the cross-invocation persistence goal.
- **Persist forever; never auto-drop.** Unbounded growth from forgotten queues, no operator UI to prune.
- **One grace upload between declaration removal and physical drop.** Adds a `dormant_since_sha` lifecycle and a non-obvious window for recovery. Symmetric with how the rest of the engine handles workflow rename/removal (no grace) is simpler.

**Rationale.** Symmetric with how `defineWorkflow` rename/removal is treated today (no grace, atomic with upload). Authors who want to rename a queue without losing data must drain old → fill new across two deploys; this is a known and documented limitation.

### Decision 5: Schema validation — both ends; `get`-mismatch drops bad item

**Choice.** Schemas are derived to JSON Schema at build time and compiled to Ajv validators on the host main thread (mirroring `host-call-action`). On `put`, the host validates the item before writing; failure → `QueueSchemaMismatch` thrown to the guest, item not persisted. On `get`, the host validates the popped item against the **current** schema; failure → the bad item is **dropped from the queue** (already removed by the rename), and a `QueueSchemaMismatch` is thrown carrying the dropped item in the error payload so the author can recover it from the corresponding `system.error name="queue.get"` event.

**Alternatives considered:**

- **Validate only on `put`; trust on `get`.** Cheaper, but a schema regression silently surfaces deep inside action code.
- **Reject upload if persisted items don't fit the new schema.** Strongest guarantee, biggest deploy friction; would require reading every queue at upload time.
- **Move bad items to a dead-letter sub-queue.** Defers the problem; meaningful only with peek/size which we excluded.
- **Throw on `get`-mismatch but keep the bad item at head.** Poison queue — every subsequent `get` hits the same bad item.

**Rationale.** Drop-on-mismatch keeps the queue draining; carrying the dropped item in the error payload preserves it for forensic recovery via the standard `system.error` event channel. No new admin ops needed.

### Decision 6: Caps — 1 KB per item, 1k items per queue

**Choice.** Per-item size is measured on the encoded JSON byte length and capped at 1 KB. Per-queue depth is capped at 1k items. Violations are typed errors: `QueueItemTooLarge` and `QueueFull`.

**Alternatives considered:**

- **256 KB / 100k items.** Matches typical webhook payload size class. Allows queues to ship data, not just coordination tokens; risk of misuse as a primary store.
- **Author-declared per-queue caps with engine-level hard ceiling.** More flexibility, more knobs to learn.
- **No caps in v1.** Matches "resource limits deferred" stance from `project.md` for some surfaces; but queues are durable state that grows monotonically without a drain — a runaway producer fills the disk silently.

**Rationale.** Tight caps express the design intent: queues are for **small coordination state**, not for shipping payload-shaped data. Authors with bigger items use `__sql` or external storage. The tight bound also caps the per-drain event volume at ≤2k events, keeping the `system.*` event archive bounded.

### Decision 7: Plugin location — `sandbox-stdlib`, runtime-injected config

**Choice.** The queue plugin lives in `packages/sandbox-stdlib/src/queue/`, parallel to `sql` and `mail`. The runtime composes it in `sandbox-store.ts` and injects a config carrying `{owner, repo, workflow, queuesRoot, declaredQueues, validators}`.

**Alternatives considered:**

- **`packages/runtime/src/plugins/queue/`** (parallel to `host-call-action`, `secrets`). Initially seemed warranted because queues need per-sandbox runtime-computed state. But the composition pattern `{ ...plugin, config: <runtime-built> }` works identically for stdlib plugins — `secretsPlugin` and `hostCallActionPlugin` happen to live in `runtime/plugins/` by convention, not by structural necessity. Putting queues in runtime would mean creating a second precedent for "plugin lives in runtime" without a real driver.
- **A new `@workflow-engine/queues` package.** Clean boundary at the cost of more workspace ceremony for a feature that sits in the same conceptual bucket as `sql`/`mail`.

**Rationale.** Queues are an author-facing capability the same way `sql` is. The plugin worker's only job is "given a base path and queue name, do FIFO NDJSON ops". Path policy, upload-time atomic create/drop, and boot reconciliation live in `workflow-registry` — not in the plugin. Path policy is upload concern; the plugin is sandbox concern. The split is clean.

### Decision 8: Eager file create at upload — file exists ⇔ queue declared

**Choice.** The upload transaction creates an empty file for every newly-declared queue (`open(path, 'a') + close + fsync(parentDir)`) and unlinks the file for every removed queue. After upload returns 200, on disk every declared queue has a file (possibly zero-byte) and no other files exist under the workflow's queue directory.

A boot reconciliation sweep runs after `registry.recover()`: walk `<root>/queues/<owner>/<repo>/<workflow>/`, unlink any file whose name is not in the current manifest's `queues[]`, and create empty files for any declared queue whose file is missing. This covers the small SIGKILL window between manifest persistence and upload-time fs ops.

**Alternatives considered:**

- **Lazy create on first put.** Slightly cheaper upload path; on-disk view depends on usage; the boot sweep is still required for crash safety; the operator-mental-model win of "file exists ⇔ queue declared" is lost.
- **Eager create with no boot sweep.** A SIGKILL window between manifest persist and fs ops can leave orphans or missing files. The sweep is cheap (`readdir` per workflow at boot) and idempotent.

**Rationale.** The cost of eager create is ~1 ms per added queue at upload time (typically ≤ 5 added queues per upload). The operator gains a `ls`-able view of declared queues. The boot sweep is small and runs once per process start.

### Decision 9: Observability — ride existing `system.*` events, no new prefix

**Choice.** Each `put`/`get` host bridge call emits `system.request` / `system.response` (success) or `system.request` / `system.error` (failure) with `name="queue.put"` or `name="queue.get"`. No new event prefix.

**Alternatives considered:**

- **New `queue.*` event prefix.** Would add to `SECURITY.md` §2 R-7 inventory and create a parallel taxonomy to `fetch.*`, `mail.*`, `sql.*` — but those were consolidated into `system.*` already (per `core/src/index.ts` comment: "consolidated the previous distinct `fetch.*`, `mail.*`, `sql.*`, `timer.*`, `console.*`, `wasi.*`, and `uncaught-error` kinds into the `system.*` family"). Adding `queue.*` would walk that consolidation back.
- **No events at all.** Loses audit and failure observability for an operation that crosses the bridge.

**Rationale.** Bounded volume (≤ 2k events per drain given 1k-item cap), stays inside the consolidated `system.*` family, no new R-rule needed. Disambiguation via `name` field is the established pattern.

### Decision 10: SECURITY.md — no new R-rule, additive deltas only

**Choice.** Update `SECURITY.md` §1 isolation invariants table (one new row for queue file paths), §2 globals surface inventory (one new entry for `__queue`), §2 threats table (T-Q1 path traversal, T-Q2 symlinks, T-Q3 storage DoS, T-Q4 TOCTOU), §2 mitigations list, and the §2 "Adding a system-bridge plugin" enumeration. No new R-rule; the queue plugin complies with R-1 (private by default), R-2 (locked internals), R-4 (per-run cleanup — no per-run state), R-5 (`ctx.emit` only), R-7 (`system.*` reserved prefix), R-13 (guest→host opacity), R-14 (globals enumerated).

**Mitigation specifics:**

- **T-Q1 path traversal via queue name.** Build-time regex `^[a-z][a-zA-Z0-9]*$` (the action/trigger identifier regex) AND host-bridge re-validation as defense in depth. The plugin path is `<queuesRoot>/<owner>/<repo>/<workflow>/<queueName>.ndjson` where `queuesRoot`, `owner`, `repo`, `workflow` come from sandbox-scoped frozen config (never from guest input).
- **T-Q2 symlink attacks.** All `open()` calls inside the queue plugin use `O_NOFOLLOW` (Linux). Operator is also forbidden from planting symlinks under `<root>/queues/` — runtime owns the subtree.
- **T-Q3 storage DoS.** Hard caps enforced at the bridge before any disk write.
- **T-Q4 TOCTOU on tmpfile rename.** Tmpfile names include a `crypto.randomUUID()` suffix. The single-writer deployment contract + per-workflow `runQueue` eliminate races structurally; the UUID is belt-and-braces against future relaxation of either invariant.

## Risks / Trade-offs

- **fsync cost on full drain.** [A workflow draining 1k items pays ~2k fsyncs ≈ 2–10 s on consumer SSD.] → Acceptable for the durability contract; per-workflow `runQueue` caps the throughput to what one workflow can do anyway. NVMe with PLP cuts this dramatically. If profiling shows real workloads hurt, a future change could add `dequeueMany(n)` to amortise fsync over a batch.
- **Rename-loses-data footgun.** [Authors who rename `defineQueue({name: "X"})` to `defineQueue({name: "Y"})` get an upload diff of "drop X, create Y" — data in X is gone.] → Document in `design.md` and the queue capability spec; surface in build-time output as a build *info* (not warning, since the rename may be intentional).
- **Boot sweep walks the queues subtree.** [On a large multi-tenant deployment with many workflows, the sweep does one `readdir` per workflow.] → Cheap (<10 ms per workflow on a warm cache); runs once per process start. If it ever becomes a hot path, switch to a manifest-driven sweep (only walk directories whose manifest is loaded) instead of a filesystem walk.
- **Schema regression silently surfaces only on `get`.** [A workflow re-deployed with an incompatible schema will throw `QueueSchemaMismatch` per old item; if the queue is large, every drain throws until the queue is empty.] → Documented behavior; the dropped item is recoverable via `system.error` event payload. Authors with strong needs can detect manifest-vs-data mismatch out-of-band by reading the file directly (operator concern, not a v1 spec deliverable).
- **No size visibility.** [Authors can't tell how full a queue is from inside or outside.] → Operators can `wc -l` the file; authors can't. If dashboard visibility becomes important, a future `dashboard` capability spec change can add a per-workflow queues panel reading `wc -l` host-side without expanding the bridge surface.
- **Bridge cost per op.** [Each put/get is one bridge crossing ≈ 0.5 ms baseline + fsync time.] → Tolerable for v1. Batch ops are a deliberately deferred optimisation.

## Migration Plan

- **Deployment.** No data migration. Existing tenants do not rebuild or re-upload. Adding `defineQueue` to a workflow requires a re-upload (standard SDK-surface use). The `<root>/queues/` directory is created lazily by the first upload that declares any queue.
- **Boot sweep tolerance.** First boot on an existing deployment finds no `<root>/queues/` directory; the sweep treats the missing directory as "no queues anywhere" and continues. No errors.
- **Upgrade order.** No coordination with infra/Tofu; no schema migration; no DuckDB catalog migration. The change is a code-only upgrade: deploy the new image, podman-auto-update rotates, the next upload that declares a queue creates the file.
- **Rollback.** Rolling back to a pre-queues image leaves any `<root>/queues/` files on disk untouched. They are inert; no process touches them. Rolling forward again resumes where the data left off (modulo any puts/gets that didn't happen during the rollback window).
- **Definition-of-done implications.** `pnpm validate` includes `pnpm test` (unit + integration) which will gain queue tests; `pnpm test:wpt` is unaffected; no infra plan delta.
