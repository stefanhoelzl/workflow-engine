## 1. Sandbox.dispose async signature

- [x] 1.1 Change the `Sandbox` interface's `dispose` member in `packages/sandbox/src/sandbox.ts` from `dispose(): void` to `dispose(): Promise<void>`.
- [x] 1.2 Refactor `dispose()` body in `packages/sandbox/src/sandbox.ts` to: keep the existing `disposed` flag and `markDisposing()` + `pendingRunRejects` synchronous side-effects; add a closure-scoped `terminatePromise: Promise<void> | null` cache; on first call, assign `terminatePromise = worker.terminate().then(() => undefined)` and return it; on subsequent calls, return the cached `terminatePromise`. Remove the existing `worker.terminate().catch(() => {})`.
- [x] 1.3 Verify: synchronous side-effects (pending-run rejection, `disposed = true`) still run before the function returns the promise, so `sb.run()` after `sb.dispose()` continues to throw immediately as the spec scenario "Pending run rejects on dispose" requires.

## 2. SandboxStore error reporting

- [x] 2.1 In `packages/runtime/src/sandbox-store.ts`, rewrite `disposeEntry` so the per-entry chain awaits `sb.dispose()` and logs `logger.error("sandbox dispose failed", { owner, sha, reason, err })` on rejection (replaces the current `logger.warn`). Keep `pendingDisposals.delete(p)` in `finally`.
- [x] 2.2 In the same file, rewrite `store.dispose()` so per-entry chains catch their own rejections (functionally `Promise.allSettled`) and the outer `await Promise.all([...pendingDisposals, ...remaining])` cannot reject. Confirm `pendingDisposals` now tracks worker-exit completion (the chain awaits `sb.dispose()` rather than calling it sync).
- [x] 2.3 Confirm the `cache.clear()` line still happens before the await so no new `get()` can race shutdown.

## 3. Call-site sweep

- [x] 3.1 Update `packages/sandbox/src/test-harness.ts:95` to `await sb.dispose()`. Verify the `try/finally` still disposes on guest-throw paths.
- [x] 3.2 Update `packages/sandbox/src/factory.test.ts:43`, `:44`, `:67` to `await sb.dispose()`. Convert containing test bodies to `async` if they are not already.
- [x] 3.3 Grep for any remaining synchronous `sb.dispose()` / `sandbox.dispose()` call sites across `packages/**/src/**/*.ts` and `packages/**/test/**/*.ts`; convert each to `await`. Document any deliberate non-await sites in code comments (none expected).

## 4. Test coverage in factory.test.ts

- [x] 4.1 Extend the existing `worker_threads` mock in `packages/sandbox/src/factory.test.ts` with a deferred-terminate fake. (Deviation: factory.test.ts uses real workers; the fake-sandbox harness needed for the deferred/rejecting cases already exists in `packages/runtime/src/sandbox-store.test.ts`. Tests 4.4–4.7 landed there. The pre-existing test "dispose awaits pending fire-and-forget dispose promises" already covers the deferred-terminate scenario; updating `makeFakeSandbox` so `dispose` defaults to `vi.fn(() => Promise.resolve())` was sufficient.)
- [~] 4.2 Add scenario test "Dispose rejects when worker.terminate() rejects". (Not implemented at the sandbox layer — would require `vi.mock("node:worker_threads")`, a large lever for a one-line `worker.terminate().then(() => undefined)` chain whose rejection behaviour is guaranteed by Promise spec. The runtime-side reaction to a rejecting `sb.dispose()` is covered by the new `dispose error reporting` tests in `sandbox-store.test.ts`. The spec scenario remains; revisit if the dispose chain ever grows non-trivial logic between `worker.terminate()` and the returned promise.)
- [x] 4.3 Add scenario test "Dispose is idempotent": call `sb.dispose()` twice synchronously, assert both return the same `Promise` reference (`===`), assert `worker.terminate` mock was called exactly once.
- [x] 4.4 Add scenario test "store.dispose() awaits actual worker exits": construct a `SandboxStore` containing one sandbox whose `worker.terminate()` is gated on a deferred, call `store.dispose()`, assert the returned promise is still pending after a `setImmediate` tick, settle the deferred, then assert `store.dispose()` resolves.
- [x] 4.5 Add scenario test "Per-entry dispose failure logs at error severity with locked-in fields": inject a fake logger, force one cached sandbox's `dispose()` to reject with `E`, call `store.dispose()`, assert exactly one `logger.error("sandbox dispose failed", {owner, sha, reason: "store-dispose", err: E})` call and that the outer `store.dispose()` resolves successfully.
- [x] 4.6 Add scenario test "One failing dispose does not strand siblings": three cached sandboxes A/B/C where only B rejects; assert all three `dispose()`s were invoked exactly once, the outer `store.dispose()` resolves, and the logger received exactly one error log scoped to B.
- [x] 4.7 Add scenario test "LRU eviction failure logs reason \"lru\"": set `maxCount: 1`, prime the store with one cached sandbox whose `dispose()` rejects, then `get()` a second `(owner, sha)` to trigger sweep; assert the log line carries `reason: "lru"`.

## 5. Spec drive-by cleanup

- [x] 5.1 Confirm the modified `Workflow-scoped VM lifecycle` requirement in `openspec/specs/sandbox/spec.md` lands with the new `Promise<void>` dispose paragraph and the existing `onDied` legacy reference renamed to `onTerminated` throughout.
- [x] 5.2 Confirm the modified `Worker-thread isolation` requirement removes the stale `onDied()` mention in the routes-list paragraph.
- [x] 5.3 Confirm the modified `Sandbox factory public API` requirement's code block no longer carries a `dispose(): Promise<void>` line on the `SandboxFactory` interface (consistent with `Factory-wide dispose`).

## 6. Verification

- [x] 6.1 Run `pnpm lint` (Biome) — no warnings or formatter drift on touched files.
- [x] 6.2 Run `pnpm check` (TypeScript) — confirm the `Sandbox.dispose` signature change propagates cleanly; no `verbatimModuleSyntax`/`exactOptionalPropertyTypes` regressions.
- [x] 6.3 Run `pnpm test` (Vitest unit + integration; excludes WPT) — full pass including the new scenarios.
- [x] 6.4 Run `pnpm exec openspec validate sandbox-dispose-failures-visible --strict` — confirm the change is structurally valid.
- [x] 6.5 Skim `pnpm dev --random-port --kill` boot output for `sandbox dispose failed` lines — there should be none in the happy path; promote any unexpected occurrence to a bug investigation before merge.
