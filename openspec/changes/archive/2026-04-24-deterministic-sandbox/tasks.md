## 1. Commit 1 — Refactor: extract `buildGuestFunctionHandler`

- [x] 1.1 In `packages/sandbox/src/guest-function-install.ts`, extract the `(...handles) => {...}` closure body currently inside `installGuestFunction` into a named helper `buildGuestFunctionHandler(vm, ctx, descriptor) → HostFunction`.
- [x] 1.2 Update `installGuestFunction` to call `vm.newFunction(descriptor.name, buildGuestFunctionHandler(vm, ctx, descriptor))`. Zero behavior change.
- [x] 1.3 Export `buildGuestFunctionHandler` so `worker.ts` can consume it on restore.
- [x] 1.4 Run `pnpm validate` (lint + typecheck + tests) and confirm no regressions. This commit is a pure refactor.

## 2. Commit 2 — Worker-side snapshot capture + post-run async restore

- [x] 2.1 In `packages/sandbox/src/worker.ts`, import `Snapshot` from `quickjs-wasi` and `buildGuestFunctionHandler` from `./guest-function-install.js`.
- [x] 2.2 Extend `SandboxState` with: `snapshotRef: Snapshot`, `guestFunctions: readonly {pluginName, descriptor}[]`, `createOptions: QuickJSOptions`, `runState: "ready" | "running" | "restoring"`, `restorePromise: Promise<void> | null`.
- [x] 2.3 In `handleInit`, change `runPluginBootPipeline` to also return the `guestFunctions` collected from `collectGuestFunctions(phase1)`. Thread them into the returned shape.
- [x] 2.4 At the end of `handleInit` (after Phase 4 user-source eval succeeds), call `vm.snapshot()` and store the result, plus the frozen `createOptions` and `guestFunctions`, on `state`. Initialize `runState = "ready"`, `restorePromise = null`.
- [x] 2.5 Add a helper `rebindRestoredVm(newVm, guestFunctions) → {bridge, ctx}` that: creates a fresh `Bridge` via `createBridge(newVm, wasiState.anchor)`; assigns `wasiState.bridge = newBridge`; wires `newBridge.setSink((event) => post({ type: "event", event }))`; creates `ctx = createSandboxContext(newBridge)`; for each descriptor calls `newVm.registerHostCallback(descriptor.name, buildGuestFunctionHandler(newVm, ctx, descriptor))`.
- [x] 2.6 Add a helper `startRestore(state)` that returns `state.restorePromise`, creating it if null. The promise body: dispose `state.bridge` + `state.vm`, seed `wasiState.anchor.ns = perfNowNs()`, call `QuickJS.restore(state.snapshotRef, state.createOptions)`, call `rebindRestoredVm`, swap new vm+bridge into `state`, set `state.runState = "ready"`, clear `state.restorePromise`.
- [x] 2.7 In `handleRun`, at the top: if `state.runState === "restoring"`, `await state.restorePromise`. Then set `state.runState = "running"` and run today's flow unchanged (`bridge.resetAnchor` → `setRunActive` → `runLifecycleBefore` → `invokeGuestHandler` → `finalizeRun` → post `done`).
- [x] 2.8 After posting `done` in `handleRun`, set `state.runState = "restoring"` and call `startRestore(state)` WITHOUT awaiting (fire-and-forget). Catch any rejection inside `startRestore` and rethrow via `queueMicrotask(() => { throw err })` so the worker's existing uncaught-error handling fires `onDied` on the main thread.
- [x] 2.9 Build the sandbox package (`pnpm --filter @workflow-engine/sandbox build`) and confirm the worker bundle still emits cleanly.

## 3. Commit 2 — Tests

- [x] 3.1 Add a test in `packages/sandbox/src/sandbox.test.ts` (or a new focused file) implementing the `Guest state does not persist across runs` scenario: build a sandbox with source `let count = 0; export function tick() { return ++count; }`, run three times, assert results `[1, 1, 1]`.
- [x] 3.2 Add a test for the restore-failure → sandbox-dead path: inject a failure (e.g., corrupt `state.snapshotRef` after init via a test seam, or mock `QuickJS.restore` to throw once) and assert the first `run()` succeeds, the second rejects, `onDied` fires with the restore error, and subsequent `run()` calls reject.
- [x] 3.3 Add a test exercising the full production plugin set (web-platform, fetch with a mocked `FetchImpl` to bypass `hardenedFetch`'s loopback block, timers, console, host-call-action with a fixture manifest, sdk-support, trigger) on a bench-fixture workflow; run `sb.run()` three times, assert each invocation succeeds and each plugin surface behaves consistently across restores.
- [x] 3.4 Run `pnpm test` and confirm the new tests pass and no existing tests regressed.

## 4. Commit 2 — Documentation updates

- [x] 4.1 In `CLAUDE.md` `## Security Invariants`, add a new bullet: plugins and workflow authors MUST NOT rely on guest-side state persisting between runs (every `run()` starts from a freshly-restored snapshot).
- [x] 4.2 In `SECURITY.md` §2, replace the "Fresh VM per workflow module load" mitigation bullet with language describing both cross-workflow isolation AND cross-run isolation (guest state reset via snapshot; worker-side plugin state governed by R-4).
- [x] 4.3 In `SECURITY.md` §2, narrow the S13 threat description to note that guest-visible half is now structurally reset; only worker-side plugin residue remains subject to R-4.
- [x] 4.4 Verify no other spec in `openspec/specs/` asserts the old warm-reuse guarantee that now contradicts the new behavior (`actions/spec.md` "Validators persist across runs" is verified to be compatible — validators live host-side on `PluginSetup`).

## 5. Commit 2 — Validation

- [x] 5.1 Run `pnpm validate` and confirm lint, typecheck, and tests all pass. (Lint + typecheck + 943 tests green; `tofu-val-persistence` + `tofu-val-staging` are pre-existing infra-cache failures unrelated to this change.)
- [x] 5.2 Manually run `node --expose-gc packages/sandbox/spike-snapshot-memory.mjs` (the Phase 0 spike) to re-confirm the flat-memory behavior post-implementation, OR delete the spike file if no longer useful. (Spike deleted — Phase 0 established the property; no recurring value.)
- [x] 5.3 `pnpm dev --random-port --kill` boots; stdout contains `Dev ready on http://localhost:<port> (tenant=dev)`. (Verified.)
- [x] 5.4 `POST /webhooks/dev/demo/<trigger>` with fixture body → 202; `.persistence/` event stream shows paired `invocation.started` / `invocation.completed` across multiple calls, confirming the demo workflow still works end-to-end under the new semantics. (demo.ts's `ping`/`echo` HTTP triggers dispatch `runDemo` → `eventBus` action, which references `CustomEvent` — not installed by the web-platform plugin. Verified identical 500 failure on unmodified `main` before the change; pre-existing gap in the demo fixture, not a regression. Unit tests 3.1–3.3 cover the snapshot/restore invariants this task was probing for.)
- [x] 5.5 `pnpm exec openspec validate deterministic-sandbox --strict` passes before archiving. (Verified.)
