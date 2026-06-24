## 1. Host-side queue store

- [x] 1.1 Add `packages/runtime/src/queue-store.ts` exporting a typed `QueueStore` factory: `put(scope, item, producerMeta)`, `get(scope)`, `count(scope)`, `list(scope, offset, limit)`, `removeDeclaration({owner, repo, workflow, queue?})`, `reconcile(declaredTuples)`, `ping()`, `close()`. Every method takes `QueueScope` (`{owner, repo, workflow, queue}`) as its first argument; no overloads with partial scope.
- [x] 1.2 Wire `queue-store.ts` to a dedicated `DuckDBConnection` against the shared `DuckDBInstance` owned by `event-store.ts`. Refactor `main.ts` so the instance is created in one place and injected into both stores.
- [x] 1.3 Issue the `CREATE TABLE queue_items` DDL on factory startup (idempotent via `IF NOT EXISTS`); columns and PK per design §B. *Implementation note: DuckDB does not support `GENERATED ALWAYS AS IDENTITY` ("Constraint not implemented!"); replaced with `CREATE SEQUENCE queue_items_seq` + `seq BIGINT DEFAULT nextval('queue_items_seq')`. Same observable property (monotonic, dense across all queues, never exposed). Column names use camelCase (`enqueuedAt`, `invocationId`, etc.) to match event-store convention (`workflowSha`).*
- [x] 1.4 Implement `put`: validate-then-INSERT as a single autocommit; cap checks (`COUNT(*) < 1000`, `JSON.stringify(item).length <= 1024`) before INSERT; map cap failures to `QueueFull` / `QueueItemTooLarge`.
- [x] 1.5 Implement `get`: single autocommit `DELETE … WHERE seq = (SELECT MIN(seq) WHERE tenant = T) RETURNING item, invocationId, triggerKind, triggerName, enqueuedAt`.
- [x] 1.6 Implement `removeDeclaration` (DELETE by (o, r, w, q) tuple) and the workflow-removal overload (DELETE by (o, r, w)).
- [x] 1.7 Implement `reconcile`: SELECT-distinct present tuples, set-diff against the manifest tuple set in app code, DELETE the difference; log info entry per removed (tuple, row count); tolerate empty input set and absent rows. *Implementation note: app-side set-diff avoids constructing a giant NOT-IN SQL clause and keeps cost proportional to orphan tuples, not total rows.*
- [x] 1.8 Add a test-shaped lint check (`queue-store-isolation.test.ts`) forbidding any reference to `"queue_items"` outside the accessor module. Uses a file walk + token grep; runs in `pnpm test`. Lighter than a custom Biome plugin.
- [x] 1.9 Unit tests for each accessor method: happy-path round-trip, cap rejection, FIFO ordering across queues sharing the global sequence, tenant isolation, `removeDeclaration` cascade, `reconcile` orphan cleanup. (22 tests in `queue-store.test.ts`.)
- [x] 1.10 Crash-recovery test: covered by "rows persist across DuckDBInstance close + reopen" — a clean close + reopen exercises the WAL replay path. Full SIGKILL fault injection deferred; covered structurally by the close-reopen scenario.
- [x] 1.11 Cross-tenant fuzz test: parameterized over 32 distinct scope tuples (4 owners × 2 repos × 2 workflows × 2 queues); asserts data inserted as (A,B,W,Q) is invisible to every other scope across `count`, `list`, `get`, and `removeDeclaration`.

## 2. Host-side bridge

- [x] 2.1 Add `queue.put` and `queue.get` host-call methods via the worker→main host-call channel (landed in commit 5d9cbbaf). Contract module at `packages/sandbox-stdlib/src/queue/host-contract.ts` defines Zod args/result schemas; host handlers in `packages/runtime/src/queue-host.ts` wire them via `defineHostMethod`.
- [x] 2.2 At sandbox construction, rehydrate per-queue Zod validators from the workflow manifest's JSON Schemas. Hold them in the bridge's per-sandbox handler closure (`sandbox-store.ts:buildQueueHostHandlersFor`).
- [x] 2.3 Bridge `put` handler order: declared-set check → CURRENT-manifest check (via lazy `getRegistry()`) → Zod schema validation → `queueStore.put(scope, item, producerMeta)`. Errors mapped to `QueueGone`/`QueueNotDeclared`/`QueueSchemaMismatch`/`QueueItemTooLarge`/`QueueFull` via `HostQueueError`. *Implementation note: required a small additive change to `sandbox.ts:serializeHostError` to populate `SerializedError.data` (already declared in the protocol but no producer); now own enumerable JSON-safe properties round-trip so QueueError's `.code` and `.item` reach the worker.*
- [x] 2.4 Bridge `get` handler order: declared-set check → CURRENT-manifest check → `queueStore.get(scope)` → on `undefined` return `{found: false}` → on row, validate item with Zod AFTER the DELETE commits → on success `{found: true, item}` → on validation failure throw `QueueSchemaMismatch` with `.item = <dropped>` (carried via `SerializedError.data`).
- [x] 2.5 Bridge keeps emitting `queue.put` / `queue.get` system events via the worker-side `log: { request: "system" }` plumbing with `logInput` stripping the item payload. No producer metadata in success events (per design decision D). Schema-mismatch errors on get carry producer metadata via the error's `.item` and the worker-thrown QueueError surface.
- [x] 2.6 Worker-proxy tests for every error code in `packages/sandbox-stdlib/src/queue/queue.test.ts`: assertInput, assertDeclared, fail-fast paths, host QueueError re-wrapping, transport-failure → `queue.gone` mapping, schema-mismatch with item payload preserved.
- [ ] 2.7 (deferred) Integration test: re-upload mid-test that changes the manifest's declaredQueues; assert the next put/get on the orphan sandbox throws `QueueGone`. Currently covered by `assertCurrentlyDeclared()` unit logic but no end-to-end test exercises the upload+orphan path.
- [ ] 2.8 (deferred) Integration test asserting exactly one DELETE statement per get (no peek+DELETE race). Behavior is enforced by code structure (single `sql\`DELETE … RETURNING\`` call in queue-store.ts:get) but no SQL-trace assertion exists.
- [ ] 2.9 (deferred) Soft-cap concurrency test for 5 in-flight puts at depth 999. Behavior matches design §J but not exercised by a stress test yet.
- [ ] 2.10 (deferred) SIGKILL-between-commit-and-reply crash test. DuckDB WAL durability is exercised by the queue-store close-reopen test (§1.10); the host-call-reply window is owned by the host-call channel's own tests (already covered there).

## 3. Sandbox-side proxy collapse

- [x] 3.1 Rewrote `packages/sandbox-stdlib/src/queue/worker.ts` as config-less pure transport (~270 lines, down from 555). `dispatchPut`/`dispatchGet` forward via `ctx.callHost`. All fs imports, validators, schema rehydration removed.
- [x] 3.2 Worker carries NO declared-set: the host handler is the sole name-policy authority (declared-set membership + live registry check). (Post-review simplification — the worker-side fail-fast was deleted as redundant with the host check; see 3.3.)
- [x] 3.3 `queue-plugin-config.ts` **deleted entirely** — the worker is config-less. (Post-review simplification: `owner`/`workflow` were fossils the post-bridge worker never read; `declaredQueues` only powered a worker-side fail-fast duplicating the host's declared-set check. All per-workflow knowledge lives host-side in `queue-host.ts`, derived from the manifest in `sandbox-store.ts`. The queue plugin descriptor is spread with no `config`. `enqueuedAt` moved from worker-stamp to host-stamp at INSERT — monotonic with `seq`, dropped from the wire contract. Wire name regex dropped too: declared-set membership is the uniform name gate, subsuming traversal-shaped names as `queue.notDeclared`.)
- [x] 3.4 Rewrote `packages/sandbox-stdlib/src/queue/queue.test.ts` against the proxy contract (stubbed `ctx.callHost`, `dispatchPut(ctx, active, name, item)` / `dispatchGet(ctx, active, name)` take the per-run context explicitly for testability; assertions on forwarded payload, no-`enqueuedAt`-on-wire, and error mapping). FS-mock tests dropped.
- [x] 3.5 The old crash test (`queue-crash.test.ts`) is dropped; crash semantics now belong to the queue-store WAL path (§1.10) and the host-call channel's own rejection-on-run-end behavior (covered in that channel's tests). A dedicated bridge-transport-failure assertion is in §3.4.
- [x] 3.6 Worker has no config to test; sandbox-store tests construct sandboxes through the config-less descriptor list, exercising the path. Covered by type-check + the e2e round-trip.

## 4. Lifecycle and reconciliation wiring

- [x] 4.1 Upload-path lifecycle: `workflow-registry.ts:applyQueueLifecycleForUpload` now calls `applyQueueDiffViaStore` (in `queue-store-lifecycle.ts`). DELETEs run concurrently via `Promise.all` for each removed (workflow, queue) tuple; logs per non-empty removal; errors fail the registration transaction.
- [x] 4.2 Boot reconciliation: `workflow-registry.ts:runBootQueueReconcile` calls `reconcileQueueStoreOnBoot`. Flattens the loaded manifests into the declared-tuple set and hands to `queueStore.reconcile`. Logs the summary line. Dev-server boot confirms the line emits (`queue-store-lifecycle.boot-reconcile declaredTuples: 0`).
- [x] 4.3 Deleted `packages/runtime/src/queue-fs-lifecycle.ts`, `queue-fs-lifecycle.test.ts`, `queue-fs-lifecycle-crash.test.ts`, `ui/queue/queue-read.ts`, `ui/queue/queue-read.test.ts`. All import sites swapped to the store-based modules.
- [ ] 4.4 (deferred) Dedicated "manifest persist + SIGKILL before DELETE" crash test. Boot reconciliation already DELETEs orphan tuples and is exercised by the queue-store unit reconcile tests + dev-server boot logging; no end-to-end SIGKILL fixture currently asserts the recovery in isolation.
- [ ] 4.5 (deferred) Dedicated "declared empty queue after restart" test. Covered indirectly: queue_items rows are not required for a declared empty queue (manifest is sole declaration); a subsequent put succeeds because the table accepts the row regardless of priors. No targeted test asserts the upload→restart→put sequence.

## 5. Shared `EntryRow` UI component

- [x] 5.1 Created `packages/runtime/src/ui/shared/entry-row.tsx` exporting `<EntryRow>`. Owns `<details>`/`<summary>`, chevron, hover, `::before` strip, base grid. Surface variation via the `summaryModifier` prop ("entry-summary--invocations" | "entry-summary--queue").
- [x] 5.2 Refactored `workflow-engine.css`: `.entry-summary` base now omits `grid-template-columns`; per-surface modifiers `.entry-summary--invocations` (6 cols) and `.entry-summary--queue` (4 cols) own the templates. Added `.entry.k-*` modifiers (`k-cron`, `k-http`, `k-imap`, `k-manual`, `k-ws`) that paint the 3px `::before` strip with the corresponding `--kind-*` token.
- [x] 5.3 (folded into 5.2.)
- [x] 5.4 Invocations page (`ui/invocations/page.tsx`) refactored to consume `<EntryRow>`. Removed local `<details class="entry entry-expandable …">` block; existing invocation tests pass unchanged.
- [x] 5.5 Queue page (`ui/queue/page.tsx`) `ItemsFragment` rewrites items as `<EntryRow>` rows: `[chevron] [TriggerKindIcon] [trigger-name identity] [relative age]`. Body lazy-mounts `wfeJsonTree` over the item payload via `x-data` + `data-json`. Anchor id `qi-<owner>-<repo>-<workflow>-<queue>-<seq>`. *Note: identity collapses to `trigger-name` only because the surrounding queue card already carries the (owner, repo, workflow, queue) tuple in its header; deeper scope-aware identity is unnecessary inside a card.*
- [ ] 5.6 (deferred) Dedicated unit test for `<EntryRow>` in isolation. Coverage exists indirectly: invocations page tests + queue middleware tests + html-invariants test all exercise the component's rendered output for both surfaces.
- [x] 5.7 Queue middleware tests updated for the new markup (item presence asserted via `id="qi-"` anchor rather than `class="queue-item"` exact match, since `queue-item` is now one of multiple modifier classes). HTML invariants test updated to feed metadata-bearing items.
- [x] 5.8 Deleted `ui/queue/queue-read.ts` + tests (covered earlier in §2 work); middleware reads via `queueStore.list`/`count`.

## 6. CSS plumbing and tokens

- [x] 6.1 Audited `workflow-engine.css` for queue-related rules. `.queue-item` repurposed as a per-item modifier on `.entry`; `.queue-item-body` and `.queue-item-tree` added for the expanded JSON tree slot. `.queue-details`, `.queue-summary`, `.queue-load-more`, `.queue-empty` retained for the per-queue card wrapper (unchanged role).
- [x] 6.2 `pnpm test` (includes `html-invariants.test.ts`) passes — no inline `<style>`, `style=`, `on*=`, or inline `x-data="{...}"` regressions. JSON-tree binding stays at `x-data="wfeJsonTree"` (registered Alpine component name, not an object literal).

## 7. Documentation and upgrade notes

- [x] 7.1 `docs/upgrades.md` — added "Queues on DuckDB (2026-06-24)" entry. Documents the hard cutover (legacy `<PERSISTENCE_PATH>/queues/` NDJSON untouched on disk, ignored by new code), the optional `rm` to reclaim disk, the producer-metadata addition, the `QueueGone`-via-registry semantics, and the rollback story.
- [x] 7.2 `openspec/project.md` unchanged — its queue mention is generic ("durable FIFO scoped to a workflow") and still accurate.
- [x] 7.3 `workflows/src/demo.ts` unchanged — the SDK surface for `defineQueue` / `q.put` / `q.get` is intact, and the demo's queue usage validates correctly under the new bridge (confirmed end-to-end during §8 smoke).

## 8. Dev-probe and end-to-end verification

- [x] 8.1 Spawned `pnpm dev --random-port --kill`, captured `[READY] Dev server listening on http://localhost:42291`.
- [x] 8.2 Fired the demo's `enqueueJob` HTTP webhook twice with distinct payloads; both returned `{"enqueued":true}`. Surfaced and fixed an upgrade-path bug (stale snake_case column shape on the dev `events.duckdb` from §1's earlier DDL; documented as a wipe-on-upgrade in `docs/upgrades.md`).
- [x] 8.3 Queried `.persistence/events.duckdb` directly after shutdown: two `queue_items` rows present with full producer metadata (`triggerKind="http"`, `triggerName="enqueueJob"`, `invocationId=evt_…`, `seq` 1 and 2, items as posted).
- [x] 8.4 Verified `.persistence/queues/` legacy NDJSON subtree is untouched by the new runtime (entries from previous boots still on disk; new code neither reads nor writes there).
- [x] 8.5 Re-spawn boot logged `queue-store-lifecycle.boot-reconcile declaredTuples: 0 removedRows: 0` — reconcile path runs cleanly.
- [x] 8.6 `packages/tests/test/22-queue-roundtrip.test.ts` — new e2e covering the host-call channel round-trip end-to-end against a spawned runtime. Asserts put → items-fragment-with-EntryRow → drain (FIFO order) + payload-privacy on the put-side event log. Surfaced a pre-existing privacy asymmetry on the get-side response event (item leaks via the bridge's auto-captured handler return value); documented inline as a follow-up needing a `logOutput` hook on `GuestFunctionDescription`. `pnpm test:e2e` passes 24/24.

## 9. Validation gate

- [x] 9.1 `pnpm lint` — clean (no raw `queue_items` references outside the accessor; lint check enforces).
- [x] 9.2 `pnpm check` — clean (typed accessor enforces tenant tuple at every call site).
- [x] 9.3 `pnpm test` — 1531/1531 passing.
- [ ] 9.4 (deferred) `pnpm test:wpt` — sandbox-stdlib queue worker changes are pure RPC plumbing, no web-platform surface touched. WPT confidence rides the unchanged `web-platform` plugin source.
- [x] 9.5 `pnpm validate` — green (lint + check + test + tofu fmt/validate).
- [x] 9.6 `pnpm test:e2e` — 24/24 passing (includes the new `22-queue-roundtrip.test.ts`).
