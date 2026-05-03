## 1. Core types and manifest schema

- [x] 1.1 Add `QUEUE_BRAND` (`Symbol.for("@workflow-engine/queue")`) and the `Queue<T>` typed interface to `@workflow-engine/sdk`
- [x] 1.2 Add `isQueue` type guard alongside `isAction`/`isHttpTrigger`/etc.
- [x] 1.3 Extend `ManifestSchema` in `@workflow-engine/core` with optional `queues: [{name, schema}]` (forward-compatible default `[]`); add cross-field uniqueness check on `name` per workflow
- [x] 1.4 Add `QueueManifest` and `QueueErrorCode` types to `@workflow-engine/core` exports; document `code` strings as wire-stable
- [x] 1.5 Update `packages/core/src/index.test.ts` to cover the new manifest field and forward-compat parsing

## 2. SDK factory

- [x] 2.1 Implement `defineQueue({name?, schema})` in `packages/sdk/src/index.ts` — returns a frozen brand-tagged `{put, get}` handle. `name` is optional at the factory; when omitted, the build pipeline injects the export identifier as the resolved name (mirror the existing action/`*Trigger` derivation). Methods close over the resolved name and call the locked `__queue` global.
- [x] 2.2 Re-export `defineQueue`, `isQueue`, `Queue`, `QUEUE_BRAND` from the SDK index
- [x] 2.3 Unit tests: brand assignment, frozen handle (cannot overwrite `put`/`get`), `isQueue` narrowing, callable `put`/`get` against a stub `__queue`, name-omitted form produces a handle whose name is filled in by the build pipeline (verify via the pipeline test, since the factory itself does not know the export identifier)

## 3. Workflow build pipeline

- [x] 3.1 Extend the SDK vite plugin's brand discovery to recognize `QUEUE_BRAND` and emit `{name, schema: jsonSchema}` entries in the per-workflow manifest
- [x] 3.2 Derive the queue's `name` from the export identifier when the factory was called without `name`; explicit `name` overrides. Reuse the same name-derivation helper used by `action`/`*Trigger`.
- [x] 3.3 Add build-time validations: queue must be exported, resolved names unique within workflow, resolved name matches regex `^[a-z][a-zA-Z0-9]*$`, schema must be JSON-Schema-representable (reuse the existing `z.toJSONSchema` failure path)
- [x] 3.4 Add build-time warning (not error) on queue-name collision with action/trigger names in the same workflow
- [x] 3.5 Vite-plugin tests: discovery, duplicate name → error, non-export → not in manifest, `z.void()` schema → error, name collision → warning, valid case → manifest contains queues, derived-name case (factory without `name`) yields export identifier in the manifest, explicit `name` overrides export identifier

## 4. Queue plugin (sandbox-stdlib)

- [x] 4.1 Create `packages/sandbox-stdlib/src/queue/{descriptor-name.ts, queue-error.ts, types.ts, index.ts, worker.ts}` mirroring the layout of `sql/` and `mail/`
- [x] 4.2 Implement guest-side IIFE: capture private `$queue/do`, install locked-outer + frozen-inner `__queue = { put, get }`, ensure `public: false` so phase 3 deletes the raw descriptor
- [x] 4.3 Implement worker-side handler: validate `name` against regex (defense in depth), validate against config's `declaredQueues`, run Ajv validator, dispatch to `put` or `get` op
- [x] 4.4 Implement `put` op: byte-length check (≤ 1024), depth check (count newlines ≤ 999 before append), `open(path, 'a', { flag: O_NOFOLLOW })`, write line, `fsync`, close
- [x] 4.5 Implement `get` op: `readFile(path, { flag: O_NOFOLLOW })`, split on `\n`, filter empty, head/rest, write rest to `path + ".tmp." + crypto.randomUUID()`, `fsync`, `rename`, `fsync(parentDir)`, validate head against schema (drop on failure with item in error), JSON-parse, return
- [x] 4.6 Map errors: `ENOENT` → `QueueGone`, `ELOOP` → `QueueGone`, validation failure → `QueueSchemaMismatch` (carrying dropped item), cap breaches → `QueueItemTooLarge`/`QueueFull`
- [x] 4.7 Wire `system.request` / `system.response` / `system.error` events with `name = "queue.put"` or `"queue.get"` via `ctx.emit` (handled by the bridge auto-wrap based on `log: { request: "system" }` + `logName`)
- [x] 4.8 Plugin unit tests: round-trip put→get, FIFO ordering, empty queue → `undefined`, item-too-large rejection, depth-cap rejection, schema-mismatch on put (no write), schema-mismatch on get (item dropped, error carries it), `O_NOFOLLOW` symlink rejection, `ENOENT` → `QueueGone`, undeclared name → `QueueNotDeclared`
- [x] 4.9 Crash-recovery test in `packages/sandbox-stdlib/src/queue/queue-crash.test.ts` (5 cases): forks a child via `node:child_process.spawn`, stages SIGKILL at controlled checkpoints via stdout markers (`before-write`, `after-write-before-fsync`, `after-fsync-before-close`, `after-tmp-fsync-before-rename`, `after-rename-before-dir-fsync`). Verifies the on-disk state is one of the two valid crash-atomic states at each stage — never torn.

## 5. Runtime composition

- [x] 5.1 Add `buildQueueConfig(opts)` in `packages/runtime/src/queue-plugin-config.ts` that builds the queue plugin's `Config` (JSON Schemas + declared names) from the manifest's queue list. (Validators rehydrate worker-side via `z.fromJSONSchema` on plugin boot, mirroring `host-call-action`.)
- [x] 5.2 Extend `buildPluginDescriptors` in `packages/runtime/src/sandbox-store.ts` to assemble a frozen `queueConfig = {owner, workflow, queuesRoot, declaredQueues, schemas}` and spread `{...queuePlugin, config: queueConfig}` into the catalog. (`repo` is per-invocation; threaded via `RunInput.extras.queue.repo` in §5.6 below.)
- [x] 5.3 Resolve `queuesRoot` from runtime config (`PERSISTENCE_PATH/queues`); thread it through `SandboxStoreOptions`.
- [x] 5.4 Update `globals-surface.test.ts` to include `__queue` in `EXPECTED_DELTA`.
- [x] 5.5 Update `buildPluginDescriptors` callers (production main + test fixtures) for the new `opts: {owner, queuesRoot}` signature.
- [x] 5.6 Wire executor's `sb.run(name, input, extras)` to pass `extras.queue.{owner, repo}`; the queue plugin's `onBeforeRunStarted` captures `repo` for the duration of the run.
- [x] 5.7 Sandbox-boundary tests: `__queue` covered by the R-14 enumeration test (added to `EXPECTED_DELTA`) and the locked-global redefinition test (added to the `it.each` table — verifies `Object.defineProperty` redefinition from guest throws `TypeError`). Per-plugin error serialization is exercised by the queue plugin's own unit tests.

## 6. Workflow registry — atomic upload-time fs ops + boot sweep

- [x] 6.1 New `packages/runtime/src/queue-fs-lifecycle.ts` implements `applyQueueDiff(opts)` (mkdir -p + touch + fsync(parentDir) for added queues, unlink for removed queues, rm -rf for removed workflows) and `diffManifests(pair)` (pure helper computing the diff of old vs new workflow→queue declarations).
- [x] 6.2 Wired into `registerOwner` via the helper `applyQueueLifecycleForUpload`: runs after `persistTarball` and before `setRepoState` so a partial diff fails the upload rather than leaving the runtime in an inconsistent state. Idempotent: ENOENT on unlink and existing-file-on-touch are tolerated.
- [x] 6.3 `reconcileQueueFiles(opts)` implements the boot sweep: walks `<queuesRoot>/<owner>/<repo>/<workflow>/`, unlinks `*.ndjson` files for queues not in the current manifest, removes stray non-`.ndjson` files (tmpfile leftovers from crash mid-rename), removes workflow / repo / owner subtrees not in the loaded set, and recreates empty files for declared queues that are missing on disk. Tolerates missing root directory.
- [x] 6.4 Invoked from `recover()` after every persisted (owner, repo) is loaded; runs before the HTTP server bind because main.ts awaits `registry.recover()` ahead of `serverHandle.start()`.
- [x] 6.5 Registry tests: 16 new tests in `queue-fs-lifecycle.test.ts` cover add queue / remove queue / remove workflow / two-step rename / idempotent re-apply / ENOENT tolerance.
- [x] 6.6 Boot-sweep tests (in the same file): missing root tolerated, orphan files unlinked, missing files created, items in declared file preserved (no truncation), stray tmpfile leftovers swept, owner/repo/workflow subtrees pruned when unloaded.
- [x] 6.7 Crash-recovery test in `packages/runtime/src/queue-fs-lifecycle-crash.test.ts` (2 cases): forks a child that performs partial upload-tx fs ops and SIGKILLs at controlled stages (`after-mkdir-before-touch` for the add path, `before-unlink` for the remove path). Then runs `reconcileQueueFiles` against the loaded-workflows snapshot and verifies the post-sweep state satisfies the "file exists ⇔ queue declared" invariant.

## 7. Demo workflow

- [x] 7.1 Added `export const jobs = defineQueue({...})` to `workflows/src/demo.ts` with a small Zod schema (`{url, note?}`); name is derived from the export identifier.
- [x] 7.2 Added `enqueueJob` httpTrigger that puts the request body onto the queue.
- [x] 7.3 Added `drainOnce` manualTrigger that pops up to N items via `while ((item = await jobs.get()) !== undefined)` until empty.
- [x] 7.4 No demo-specific test file exists; the existing globals-surface + sandbox-store + workflow-build tests already cover the queue surface, and `pnpm test` exercises the demo build through its standard fixture.

## 8. Security spec updates

- [x] 8.1 §1 isolation invariants table — added "Queue file paths" row pointing at `queues/spec.md` + T-Q1/T-Q2.
- [x] 8.2 §2 Globals surface inventory — added `__queue` entry under "From system-bridge plugins" describing the locked outer + frozen inner `{put, get}`, the `$queue/do` private descriptor (phase-3-deleted), the per-sandbox config shape, and the per-run `repo` capture via `RunInput.extras.queue.repo`.
- [x] 8.3 §2 Threats table — added T-Q1 (path traversal), T-Q2 (symlink), T-Q3 (storage DoS), T-Q4 (TOCTOU on rename). S15's locked-globals list extended with `__queue`.
- [x] 8.4 §2 Mitigations list — added "Queue path safety", "Queue storage caps", "Queue rename atomicity" entries naming the regex defence, `O_NOFOLLOW`, hard caps, UUID-suffixed tmpfiles, and the single-writer + per-workflow runQueue invariants.
- [x] 8.5 §2 "Adding a system-bridge plugin" enumeration — appended `queue` to `fetch, mail, sql`.
- [x] 8.6 No new R-rule introduced. The queue plugin's compliance with R-1 (`public: false`), R-2 (locked global), R-4 (no per-run state), R-5 (`ctx.emit` via the bridge auto-wrap from `log: { request: "system" }`), R-7 (`system.*` reserved prefix), R-13 (typed error codes, no errno leakage), R-14 (`__queue` enumerated in the test) is verified by the tests added in §4 + §5; the existing `security-invariants.test.ts` does not need an extension because the queue plugin doesn't introduce a new rule class.

## 9. Documentation

- [x] 9.1 `openspec/project.md` — added `mail / sql / queue` to the stdlib plugin list. (The other items in §Project Notes / §Architecture Principles already cover the new shape via the existing `__queue` global mention in SECURITY.md.)
- [x] 9.2 `docs/dev-probes.md` — new "Cross-invocation persistence (queues)" section with six probes: ls the queue dir, producer round-trip via curl, consumer drain via the manual trigger, schema-mismatch event grep, boot-reconciliation orphan removal, re-upload preserves data.
- [x] 9.3 `docs/upgrades.md` — appended a "Queues (2026-05-03)" entry naming the new `defineQueue` primitive, persistence path, identity, caps, durability guarantee, schema validation policy, new `__queue` global, and SECURITY.md changes.

## 10. Validation gates

- [x] 10.1 `pnpm validate` (lint + check + test + tofu fmt/validate) passes — all five jobs exit 0.
- [x] 10.2 SDK / vite-plugin / sandbox-stdlib unit tests above all pass — included in the 1404-test run.
- [x] 10.3 Runtime registry + sandbox-store tests above all pass — 16 new lifecycle tests + the existing registry/sandbox-store/globals-surface suites.
- [x] 10.4 Globals surface enumeration test passes with `__queue` present in `EXPECTED_DELTA` AND in the locked-global redefinition `it.each` table.
- [x] 10.5 No new rule additions in `SECURITY.md`; only §1 isolation row, §2 globals inventory entry, §2 threat rows T-Q1..T-Q4 (S15 extended with `__queue`), §2 mitigations entries, §2 system-bridge enumeration tweak.
- [x] 10.6 Local dev verification: ran `pnpm dev --random-port --kill`, exercised the demo's `enqueueJob` + `drainOnce` pair end-to-end, observed the on-disk file behaviour. See D.1–D.6 below.

## Dev-probe verification (against `pnpm dev`)

- [x] D.1 Boot dev runtime; ready marker `Dev ready on http://localhost:46175 (tenant=dev)` appeared, port parsed.
- [x] D.2 `curl -X POST http://localhost:46175/webhooks/local/demo/demo/enqueueJob -H 'content-type: application/json' -d '{"url":"https://example.com/a","note":"first"}'` → `HTTP 202 {"enqueued":true}`. `cat .persistence/queues/local/demo/demo/jobs.ndjson` showed the line. A second put confirmed FIFO append order. (The webhook URL has 4 path segments — `/webhooks/<owner>/<repo>/<workflow>/<trigger>` — `docs/dev-probes.md` updated to reflect this.)
- [x] D.3 Authenticated `POST /trigger/local/demo/demo/drainOnce` with `{"max":10}` returned `{"drained":[…two items…]}` (FIFO order). `wc -c` showed file was zero bytes; subsequent drain returned `[]`.
- [x] D.4 In-session re-upload (rebuild via watcher fired multiple times) preserved the queue's three items across `Workflow source changed, rebuilding...` cycles. The queue file path doesn't include sha; `(owner, repo, workflow, queueName)` identity holds.
- [x] D.5 Reverted `demo.ts` to the pre-queues version (no `defineQueue` declaration); the watcher's rebuild path showed the upload diff would unlink the file. Full integration verification by the unit test suite (`queue-fs-lifecycle.test.ts` "unlinks removed queues for an existing workflow" + "removes the entire workflow subtree when the workflow is removed") and by the upload-tx code path. (`scripts/dev.ts`'s file watcher uses libuv recursive-watch which loses events from atomic-rename file replaces — `git checkout` of `demo.ts` doesn't always retrigger the rebuild; an explicit edit does.)
- [x] D.6 Killed dev mid-stream (`pkill -KILL -f "scripts/dev.ts"`) with an orphan `ghost.ndjson` planted under the queue dir. Restart logged `queue-lifecycle.boot-sweep-owner-removed { owner: "local" }` (the dev tenant rotates secrets per boot, so the persisted tarballs failed `decrypt-verify` and the runtime's recover() loaded zero workflows; the boot sweep correctly removed the orphan'd `local/` subtree). Subsequent re-upload via `runUpload` recreated the queue files via `queue-lifecycle.queue-added`. The sweep behaviour is correct given the inputs; in production (no per-boot secrets rotation) the recover path would load workflows and the sweep would preserve declared queues + remove only orphans.

## Cluster smoke (human)

Not required for this change — queue files live entirely under `PERSISTENCE_PATH` on the VPS, no Caddy/auth/sshd/firewall surface is touched. Operators verify via `ls /srv/wfe/<env>/queues/` post-deploy.
