## Context

The current queues implementation is fully described in `openspec/specs/queues/spec.md`. Contents live as NDJSON files at `<PERSISTENCE_PATH>/queues/<owner>/<repo>/<workflow>/<queueName>.ndjson`, with the sandbox-stdlib worker (`packages/sandbox-stdlib/src/queue/worker.ts`, 555 lines) doing direct filesystem syscalls: `O_APPEND|O_NOFOLLOW` for puts (with `fsync` per op), tmpfile-write+`rename`+parent-dir-`fsync` for atomic-pop on gets. Lifecycle (file create on declare, unlink on remove, boot reconciliation sweep) lives in `packages/runtime/src/queue-fs-lifecycle.ts` (537 lines). The `/queue` UI reads queue files host-side with a partial-line-tolerant parser (`packages/runtime/src/ui/queue/queue-read.ts`, 104 lines).

Meanwhile, `packages/runtime/src/event-store.ts` already manages a DuckDB instance at `<persistenceRoot>/events.duckdb` via `@duckdb/node-api` and Kysely (`DuckDbDialect`). It uses batched commits via an in-memory accumulator and a retry loop. Tenant scoping is done by a runtime-checked `(owner, repo)` allow-list in `EventStore.query`.

The `/invocations` UI in `packages/runtime/src/ui/invocations/page.tsx` renders an expandable list of rows using `<details>` + a CSS grid `.entry-summary`, with a 3px left status strip (`.entry::before`). The queue UI today (`packages/runtime/src/ui/queue/page.tsx`) uses a different `<details>` shape (`.queue-details` / `.queue-summary`) that does not share styling with `/invocations`. Both surfaces mount `wfeJsonTree` for JSON rendering, which is mandated by `ui-foundation` §"shared JSON-tree".

## Goals / Non-Goals

**Goals:**

- Move queue contents into the existing `events.duckdb` database without introducing a second DuckDB file or a new dependency.
- Preserve the user-visible queue contract verbatim: `Queue<T> { put(T), get(): T | undefined }`, FIFO, at-most-once on successful pop, per-op durability ("returned ⇒ survives SIGKILL"), 1024-byte item cap, 1000-item depth cap, schema validation on put and get with bad-head drop.
- Move queue logic from the in-sandbox worker (which holds an `O_NOFOLLOW`-protected file descriptor) into the host-side bridge, shrinking the sandbox's fs-syscall surface area.
- Eliminate the filesystem-specific spec language (fsync/rename/O_NOFOLLOW/partial-line tolerance) in favor of DuckDB transaction semantics.
- Make cross-tenant queue leaks a compile-time error (typed accessor required (owner, repo, workflow, queue)) rather than a runtime allow-list (event-store style).
- Add per-item provenance metadata (`enqueued_at`, `invocation_id`, `trigger_kind`, `trigger_name`) stamped at bridge entry, visible in `/queue` UI, NOT exposed to guest code.
- Unify `/queue` and `/invocations` row rendering on one shared `EntryRow` component.

**Non-Goals:**

- Migrating existing NDJSON queue data. Hard cutover documented in `docs/upgrades.md`.
- Adding a queue-consumer trigger (new trigger kind that fires on item arrival). The open-string `trigger_kind` column makes this a future-compatible change; building the trigger itself is out of scope.
- Building a "pipeline view" UI that traces items through producer → consumer chains. Producer metadata on each row enables this; building the UI is out of scope.
- Exposing producer metadata to guest code via `get()`. The guest contract stays `Promise<T | undefined>` — branching workflow logic on provenance would create accidental coupling (see Decisions §G).
- Including producer metadata in success-path `queue.get` events (it IS included in error-path `system.error` events; see Decisions §E).
- Multi-host queue coordination. The bridge holds queue state in one process; tighter cap enforcement under concurrent puts is deferred (see Risks).

## Decisions

### A. One DuckDB instance, separate connection per concern

Queues share the existing `events.duckdb` instance owned by `event-store.ts`. The `queue-store` module opens its **own** `DuckDBConnection` against the shared `DuckDBInstance` (DuckDB allows N connections per instance; writes serialize at the storage layer). Separate connections cleanly isolate the queue's per-op autocommit semantics from event-store's accumulator/batch commit, preventing a queue put from being accidentally enrolled in an open event-store transaction. The shared instance is created in `main.ts` (where it's created today) and injected into both stores.

**Alternatives considered:**
- *Separate `queues.duckdb` file*: Splits backup/restore, doubles connection management for no clear gain. Cross-store queries (joining queue rows with the producer's invocation events) become file-spanning.
- *Per-(owner,repo,workflow) DuckDB file*: Restores filesystem-style tenant isolation but defeats the "one DB" simplicity win and explodes file count.

### B. Single `queue_items` table; manifest is sole declaration

```sql
CREATE TABLE queue_items (
  owner          VARCHAR     NOT NULL,
  repo           VARCHAR     NOT NULL,
  workflow       VARCHAR     NOT NULL,
  queue          VARCHAR     NOT NULL,
  seq            BIGINT      GENERATED ALWAYS AS IDENTITY,
  enqueued_at    TIMESTAMPTZ NOT NULL,
  invocation_id  VARCHAR     NOT NULL,
  trigger_kind   VARCHAR     NOT NULL,
  trigger_name   VARCHAR     NOT NULL,
  item           JSON        NOT NULL,
  PRIMARY KEY (owner, repo, workflow, queue, seq)
);
```

A queue's *existence* is the manifest's `declaredQueues` entry — not a row in any table. An empty declared queue has zero rows in `queue_items`. This eliminates the "missing-file from SIGKILL between manifest persist and file create" boot scenario entirely (declared empty queues don't need any row); only "orphan rows from removed declaration" remains.

`seq` uses DuckDB's global `IDENTITY` (one counter for the whole column, not per-queue). Seqs are dense across all queues but not per-queue; they're internal (never exposed to guests, never shown in UI), so density per queue doesn't matter. Strict FIFO is preserved: `IDENTITY` assigns at INSERT time in commit order.

**Alternatives considered:**
- *Table-per-queue*: maps lifecycle 1:1 to today's file-per-queue, but adds DDL on every upload and bloats DuckDB metadata for tenants with many queues.
- *Two tables (`queues` + `queue_items`)*: explicit declaration row, but the manifest is already the source of truth — duplicating creates a sync problem.
- *Per-put `MAX(seq)+1` scan*: works (bounded by depth cap), but `IDENTITY` is O(1) at no cost.
- *Per-queue `SEQUENCE`*: requires DDL on declare/drop, re-introducing the very metadata-per-queue we removed.

### C. Per-op autocommit; preserve fsync-per-op contract

Each `put` is a single autocommit `INSERT`; each `get` is a single autocommit `DELETE … RETURNING`. DuckDB autocommit semantics flush WAL with `fsync` before the statement returns, matching the spec's "returned ⇒ survives SIGKILL" contract. No batching for queue ops (unlike event-store's accumulator). Latency increases marginally (~1–3 ms per op vs ~0.5–1 ms for `appendFile`+`fsync`); imperceptible at any realistic workflow rate.

**Alternatives considered:**
- *Group-commit window*: batch puts in a 5ms window. Throughput win for hot queues at the cost of weakening durability to "last 5ms lost on power loss." Rejected to keep the spec contract verbatim.

### D. Host-side bridge; sandbox worker becomes thin proxy

```
GUEST (in sandbox)                  HOST (runtime)
─────────────────                   ──────────────
defineQueue handle                  bridge handler:
  ↓                                  ↓
worker proxy                        1. validate name ∈ declaredQueues
  RPC: {op, name, item?}            2. validate against schema (Zod)
  ↓                                 3. emit system event (op + name only)
host-call bridge ────────────────▶  4. autocommit INSERT or DELETE…RETURNING
  ↓                                 5. (get only) validate popped item
worker proxy receives reply         6. reply to bridge
  ↓
guest code receives T (get) or void (put)
```

Validators (Zod, rehydrated from JSON Schemas in the manifest) live host-side, compiled once at sandbox construction and held in the bridge's per-sandbox context. The sandbox-side proxy retains `declaredQueues` only for fail-fast on unknown names (avoids a pointless RPC round-trip).

**Alternatives considered:**
- *Worker opens DuckDB directly*: DuckDB takes a process-level file lock per writer; the sandbox is a separate process from the host. Two writer connections from two processes against the same file are not supported.
- *Worker opens DuckDB read-only*: hybrid; reads from sandbox, writes via bridge. Worst of both worlds — sandbox still needs DuckDB linked in, and the read path duplicates host SQL.

### E. Tenant-scoped accessor; raw table access forbidden

Every host-side queue access goes through a typed accessor:

```typescript
interface QueueStore {
  put(scope: QueueScope, item: unknown): Promise<void>;
  get(scope: QueueScope): Promise<PoppedRow | undefined>;
  count(scope: QueueScope): Promise<number>;
  list(scope: QueueScope, offset: number, limit: number): Promise<RowWithMeta[]>;
  removeDeclaration(scope: WorkflowQueueScope): Promise<void>;
  reconcile(declaredTuples: readonly QueueScope[]): Promise<void>;
}

interface QueueScope {
  owner: string;
  repo: string;
  workflow: string;
  queue: string;
}
```

`QueueScope` is required at compile time on every read or write; there is no overload accepting partial scope. Raw `db.selectFrom("queue_items")` is forbidden by a Biome lint rule (custom rule or pattern match). Integration test fuzzes cross-tenant visibility: data inserted as `(A, B, W, Q)` is never returned when querying as `(X, Y, W, Q)`.

This is strictly stronger than `EventStore.query`'s runtime allow-list. Justification: `SECURITY.md` §4 flags cross-(owner, repo) leaks as the "highest-impact regression class," and the filesystem-path safety net is going away.

**Alternatives considered:**
- *Runtime allow-list (event-store style)*: keeps current pattern, but a forgotten WHERE clause is still a runtime bug discovered late. The compile-time signature catches it at PR time.
- *Per-(owner,repo) DuckDB ATTACH*: restores file-like isolation, but partially regresses op simplicity (ATTACH per tenant) and re-introduces file proliferation.

### F. `QueueGone` is a manifest concept, not a DB concept

Today: orphan sandbox calls `put`/`get` → worker's `open()` returns ENOENT → `QueueGone`. The file's absence is the only signal that distinguishes "current-manifest queue" from "stale-sandbox queue."

Tomorrow: the bridge consults the workflow registry's CURRENT manifest on every `put`/`get`. The registry holds the current manifest in memory; the lookup is `manifests.get(workflowKey).declaredQueues.has(queueName)` — nanoseconds. If the queue is not in the current declared set, the bridge throws `QueueGone` without touching the DB. Orphan rows on a dropped queue (between drop and boot sweep) are invisible to gets; the registry says "gone," the bridge throws, no SELECT issued.

The sandbox's frozen `declaredQueues` (in plugin config) is **fail-fast only**: the proxy checks it to avoid a pointless RPC for a queue the sandbox never declared. The registry is the source of truth.

### G. Provenance metadata: stored, UI-visible, NOT guest-visible

`enqueued_at` (TIMESTAMPTZ), `invocation_id`, `trigger_kind` (open string), `trigger_name` are stamped on every INSERT by the bridge (which has the dispatch context — same path that stamps event-store's invocation events). These columns are visible in `/queue` UI and queryable via the tenant-scoped accessor.

The guest contract is unchanged: `get()` returns `Promise<T | undefined>` (just the item value). Exposing producer metadata to guest code would (1) break every existing put/get site (migration cost on a contract that doesn't currently exist), (2) create accidental coupling — guests could branch on `trigger_kind`, making any future trigger-kind rename a guest-visible breaking change, (3) require widening the existing item-payload privacy filter in the log pipeline. Provenance is observability data, not application data.

`trigger_kind` is an open string with no DB-level enum so a future "queue" trigger kind (when queue-consumer triggers ship) doesn't require a schema migration just to record metadata. The existing `TriggerKindIcon` already falls back to a default glyph for unknown kinds (see `packages/runtime/src/ui/icons.tsx` `kindGlyph` default branch).

`workflow_sha` is NOT stored. The sha rotates on every upload; including it would clutter rows for no operational value.

### H. `queue.put` / `queue.get` events: status quo, bridge-emitted

Today's sandbox-side worker emits these via `log: { request: "system" }` plumbing with `logInput` deliberately stripping the item payload (see `worker.ts:519-524` — author-domain content stays out of logs). The host-side bridge takes over this responsibility, emitting events with the same shape (op + name, no item payload, no producer metadata). The corresponding flamegraph nodes (`flame-icons.ts:176-179`) continue to render queue ops with kind-specific icons.

Producer metadata is intentionally NOT included in success-path `queue.get` events. It IS included in error-path `queue.get` events (see §I) because root-cause attribution is the entire point of those errors.

### I. Schema-on-get bad-item drop: DELETE-then-validate

```
TIMELINE
1. Bridge issues: DELETE FROM queue_items WHERE … RETURNING item, <metadata>
2. DuckDB COMMITs — row is gone, durable.
3. Bridge validates `item` against CURRENT schema (host-side validator).
4a. Valid    → return item to guest.
4b. Invalid  → throw QueueSchemaMismatch with payload including producer
               metadata; emit system.error with name="queue.get" carrying
               the same payload.
```

Validation MUST happen post-COMMIT, never pre-DELETE. Pre-DELETE validation would require either (a) a peek-validate-delete sequence (two statements with a race where another consumer pops the same head), or (b) a transaction with rollback on validation failure (re-delivers bad items forever — breaks at-most-once). The post-COMMIT pattern matches today's "rename atomic with bad-head drop": the row is gone whether or not it validates.

Consecutive bad heads: each `get()` drops one and throws; caller loops. Same as today — do not "drain to first valid"; that would change the observable error rate.

### J. Soft cap; documented overrun under concurrent puts

The 1000-item depth cap is checked by SELECT-COUNT-then-INSERT in autocommit. DuckDB's snapshot isolation does NOT serialize this against another concurrent put to the same queue (write-skew pattern). Under brief contention the cap may transiently overflow by the number of in-flight puts (typically 1–10 items). Items remain valid; boot reconciliation does NOT correct overruns.

Today's filesystem implementation has the same race (`worker.ts:349-358`: read-then-count-then-append with no lock between sandboxes); the current spec scenarios cover only single-writer behavior. We preserve that contract verbatim and document the soft-cap property explicitly.

**Alternatives considered:**
- *Per-(tenant tuple) in-process mutex*: trivial to add (Map of mutexes keyed by tenant tuple). Deferred because it strengthens a contract today's code doesn't make.

### K. Shared `EntryRow` component for expandable list rows

Extract today's `/invocations` row pattern into a shared component:

```
packages/runtime/src/ui/shared/entry-row.tsx
  <EntryRow statusClass="…" columns="invocations" | "queue"
            fragmentUrl="…"?>
    {chevron} {kindIcon} {identity} {…right cells}
  </EntryRow>
```

The component owns: `<details>`/`<summary>` mechanic, chevron rotation, hover state, base `.entry-summary` grid, 3px `::before` status strip. CSS modifier classes (`.entry-summary--invocations`, `.entry-summary--queue`) vary `grid-template-columns` per surface. Strip color: `/invocations` uses status (`.s-succeeded`/`.s-failed`/`.s-pending`); `/queue` uses trigger kind (`.k-cron`/`.k-http`/`.k-manual`/etc.).

Queue items render with:
- Collapsed row: `[chevron] [TriggerKindIcon] [›-separated identity, scope-aware] [relative age]`
- No JSON preview in collapsed row.
- Expanded body: `wfeJsonTree` Alpine mount (per `ui-foundation` §JSON-tree).

The `/invocations` page is refactored to use `EntryRow` in the same change. `ui-foundation` gains a new requirement mandating the component for any expandable-list-of-records surface.

### L. Upload-time row lifecycle

```
Adding a queue declaration:
  • Manifest persist completes.
  • NO queue_items row needed; the queue's "existence" is the manifest entry.

Removing a queue declaration:
  • Manifest persist completes (queue removed from declaredQueues).
  • DELETE FROM queue_items WHERE (owner,repo,workflow,queue) = T;

Removing a workflow entirely:
  • Manifest persist completes (workflow removed).
  • DELETE FROM queue_items WHERE (owner,repo,workflow) = (o,r,w);

Crash window:
  • Order: persist manifest first, then DELETE.
  • Crash after manifest persist, before DELETE: orphan rows remain;
    bridge throws QueueGone on access (manifest says gone); boot
    reconciliation DELETEs them.
  • Crash before manifest persist: nothing changed; retry on next upload.
```

### M. Boot reconciliation

Single statement, run once after `registry.recover()`:

```sql
DELETE FROM queue_items
 WHERE (owner, repo, workflow, queue) NOT IN (
   <SELECT VALUES from manifest's declared queue tuples>
 );
```

Tolerates absent `queue_items` table (treat as "no queues anywhere"). No per-file walk, no fsync, no per-(owner,repo,workflow) traversal. The "missing file from SIGKILL" scenario from today's spec has no analog — declared empty queues need no row.

## Risks / Trade-offs

[**Tenant-leak regression: SQL WHERE-clause discipline replaces filesystem path isolation**] → Mitigated by typed accessor (compile-time scope requirement on every call) + Biome lint rule forbidding raw `db.selectFrom("queue_items")` + integration fuzz test verifying cross-tenant invisibility. Stronger than today's `EventStore.query` runtime allow-list. See Decisions §E.

[**Per-op latency increases ~1-2 ms (DuckDB autocommit vs file append+fsync)**] → Acceptable at any realistic workflow rate. If hot-loop queue workloads emerge, benchmark and consider group-commit (Decisions §C). Document the latency budget in design.md (this section).

[**Connection contention with event-store under high combined write load**] → Separate connections on shared instance (Decisions §A) keep autocommit/batch boundary clean. DuckDB serializes writes automatically; under sustained load the WAL grows and checkpoint pressure rises — same risk event-store already lives with at high event rates. Bench-it-when-we-have-it; no app-level coordination needed today.

[**Soft cap under concurrent puts (transient overflow to ~1010 items)**] → Documented in Decisions §J and in the spec's "Per-queue depth cap" requirement notes. Matches today's actual behavior. Tighter enforcement available as a future addition (in-process mutex) if needed.

[**Hard cutover loses in-flight queue data on upgrade**] → Documented in `docs/upgrades.md`. Acceptable because (1) queues are work buffers, not systems-of-record, (2) typical queue contents are transient (retry jobs, pending notifications), (3) one-shot importer would add significant complexity for a one-time benefit.

[**Spec ambiguity if a future change re-introduces filesystem-style requirements**] → Removed requirements (path-traversal defense, host-side read-only inspection) are explicitly enumerated in the `queues` spec delta with reasons. A future spec change re-introducing those would need explicit justification.

[**Producer metadata in error events but not success events is an asymmetry**] → Intentional. Success-path consume events have no diagnostic role (the consumer's invocation is already in event-store); error-path consume events are the diagnostic path for schema regressions, where producer attribution is the entire point. Decisions §H + §I document the asymmetry.

## Migration Plan

**Order of operations:**

1. Build `queue-store.ts` (typed accessor, table DDL, autocommit ops, lifecycle, reconciliation). Unit tests against an in-memory DuckDB instance.
2. Build host-side bridge handlers for `queue.put` / `queue.get`. Wire validator rehydration at sandbox construction.
3. Refactor sandbox-stdlib worker to thin RPC proxy. Update plugin config shape to drop validators + queuesRoot.
4. Refactor `/invocations` page to use shared `EntryRow` component. Verify visual parity against existing snapshot/integration tests.
5. Refactor `/queue` page to use `EntryRow` + new metadata header. Replace `queue-read.ts` with SQL via accessor.
6. Wire boot reconciliation: run after `registry.recover()` in `main.ts`.
7. Wire upload-time `removeDeclaration` calls in `workflow-registry.ts` upload path. Drop `queue-fs-lifecycle.ts`.
8. Document hard cutover in `docs/upgrades.md`.
9. Spec deltas: `queues/spec.md`, `queues-ui/spec.md`, `ui-foundation/spec.md`.

**Rollback strategy:** Pre-merge gates (`pnpm validate`, e2e against `pnpm dev`) catch regressions. Post-merge: revert the PR. Hard cutover means no data conversion to undo; rolled-back code reads the old NDJSON subtree (which the upgrade did not delete — verify in step 7 that the upgrade leaves `<root>/queues/` alone, just stops reading it).

**Deployment:** Staging via `deploy-staging` on push to `main`. Verify `/queue` shows declared queues with empty count post-upgrade; verify a put followed by a get round-trips through the bridge with metadata visible in the UI; verify boot reconciliation handles an orphan-row scenario (manual: insert orphan row via SQL, restart, confirm DELETEd). Prod via `deploy-prod` on push to `release` after staging soak.

## Open Questions

None at proposal time. Implementation may surface decisions about:
- Exact Biome lint rule shape for "no raw `queue_items` table access" — pattern match vs custom rule. Decide during step 1.
- Whether `enqueued_at` in the UI row needs the existing `local-time.js` relative-time component or new formatting. Decide during step 5.

## Post-review revisions

The host-call channel (`add-host-call-channel`, landed after this design was first written) and a design review changed three decisions. The originals above are kept for history; these supersede them.

### R1 — Worker is config-less (supersedes part of §D)

§D said the worker keeps `declaredQueues` for a fail-fast on unknown names. Removed. The worker carries **no per-workflow config at all** — `owner`/`workflow` were never read post-bridge, and the fail-fast duplicated the host check. All per-workflow knowledge lives host-side, derived from the manifest in `sandbox-store`. The worker is pure transport: capture per-invocation context from `extras`, route by `op`, forward, map errors. `enqueuedAt` moved from worker-stamp to host-stamp at INSERT (monotonic with `seq`; off the wire).

### R2 — No queue-name gate; QueueGone is not a manifest concept (supersedes §F)

§F made `QueueGone` a live-registry check on every `put`/`get`. Removed entirely. Rationale: the queue name is the only guest-controlled component of the storage key (`owner`/`repo`/`workflow` are host-stamped), so **confidentiality/cross-tenant isolation does not depend on a name check** — a tampered guest can only ever address its own tenant partition. The only residual concern was availability (a tampered guest inventing unlimited names to defeat a per-queue cap), which R3 handles at the storage layer instead.

Consequences:
- The host applies **no name gate**. Schema validation runs for declared queues only (validator present); undeclared names (tampered-guest-only) are stored/returned unvalidated.
- An orphan in-flight invocation operates against its **dispatch-time manifest** — consistent with env/secrets/action-validators, which are all frozen at sandbox construction. It no longer fails with `QueueGone` when a concurrent re-upload removes the queue; its writes land in its own partition and are GC'd by boot reconciliation.
- `QueueGone` is retained only for a host-call **transport** failure (channel torn down at run-end).
- The `getRegistry` lazy closure, the `registryRef` mutable in `main.ts`, and `sandbox-store`'s dependency on `WorkflowRegistry` are all removed — there is no construction cycle, because the queue handlers never consult the live registry.

### R3 — Depth cap is workflow-wide, not per-queue (supersedes §J)

§J kept the 1000-item cap per queue. Changed to **workflow-wide** (`MAX_WORKFLOW_QUEUE_DEPTH`): the cap counts all rows for `(owner, repo, workflow)` across every queue name. This is the availability backstop that makes R2 safe — with no name gate, a per-queue cap would be defeated by name-multiplication, but a workflow-wide cap bounds total storage on the shared `events.duckdb` regardless of how many names are used. Trade-off: a workflow's queues share one budget (one queue filling blocks the others). Tenant-wide keying (drop the `workflow` predicate) is a stronger bound available as a one-line change if cross-workflow coupling per owner is preferred over per-author coupling.
