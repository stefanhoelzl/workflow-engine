## 1. Bridge — Callable envelope contract

- [x] 1.1 Define `CallableResult` discriminated-union type and `CALLABLE_RESULT_BRAND` symbol (`Symbol.for("@workflow-engine/sandbox#callableResult")`) in `packages/sandbox/src/bridge.ts` (or a co-located helpers module). Brand symbol attached to envelopes via `Object.defineProperty` (non-enumerable defaults).
- [x] 1.2 Add internal `makeOkEnvelope(value)` and `makeErrEnvelope(error)` helpers that construct envelopes with stable property order `{ ok, value | error }` and the brand attached via `Object.defineProperty`. These are intent-explicit constructors used by `makeCallable.invoke`.
- [x] 1.3 Rewrite `makeCallable`'s `invoke` (`packages/sandbox/src/bridge.ts:445`) to convert `awaitGuestResult`'s rejection branch and `callGuestFn`'s `JSException` branch into envelope returns via `makeErrEnvelope`. Wrap the existing rejection-construction code with the envelope adapter; `GuestThrownError` instances become the envelope's `error` field unchanged. Engine-side rejections (`CallableDisposedError`, `marshalArg` failures, vm-disposed) keep rejecting.
- [x] 1.4 Update the `Callable` type alias in `packages/sandbox/src/plugin.ts` (or wherever it lives) to `(...args: GuestValue[]) => Promise<CallableResult>`. Re-export `CallableResult` and the brand symbol from `packages/sandbox/src/index.ts`.
- [x] 1.5 Add `isCallableResult(value): value is CallableResult` helper that tests for the brand symbol; export from the package barrel for use by pluginRequest and any future awaiting plugin.

## 2. Plugin runtime — pluginRequest auto-unwrap

- [x] 2.1 Split `pluginRequest`'s `emitError` (`packages/sandbox/src/plugin.ts:331`) into two helpers: `emitErrorFromException` (sync throw / engine-bug rejection — runs `serializeLifecycleError`) and `emitErrorFromEnvelope` (envelope error — passes the `error` field through unchanged).
- [x] 2.2 Modify `pluginRequest`'s async resolve handler (`packages/sandbox/src/plugin.ts:357`) to detect `isCallableResult(value)` first. On envelope: branch by `envelope.ok`, emit response or error close, return the envelope. **Never rethrow on envelope-error.** Non-envelope values continue through the existing emit-response path.
- [x] 2.3 Verify the rejection branch on `pluginRequest`'s `.then(_, errFn)` still rethrows for non-envelope errors (engine bugs). The branch only fires for actual rejections from the wrapped `fn()`'s promise; envelope-errors are resolutions, not rejections.

## 3. SDK — `__sdk.dispatchAction` migration

- [x] 3.1 Rewrite the dispatcher handler at `packages/sdk/src/sdk-support/index.ts:145` to inspect the envelope: replace `const raw = await handler(input as GuestValue);` with `const result = await handler(input as GuestValue); if (!result.ok) throw result.error; const raw = result.value;`. The thrown `GuestThrownError` flows back through the surrounding `buildHandler` closure (sanitizeForGuest, R-12) unchanged.
- [x] 3.2 Update the comment block at lines 152–157 that describes the handler's flow to reflect the envelope inspection.

## 4. Test migration — bridge & callable-reentry

- [x] 4.1 Audit `packages/sandbox/src/callable-reentry.test.ts` for `await expect(callable(...)).rejects.toThrow(...)` and `try { await callable(...) } catch` patterns. Migrate guest-throw assertions to `expect((await callable(...)).ok).toBe(false)` and inspect `.error.{name,message,stack}`. Engine-bug assertions (`CallableDisposedError`) keep `.rejects` shape.
- [x] 4.2 Audit `packages/sandbox/src/bridge-install-descriptor.test.ts` for the same pattern; migrate identically.
- [x] 4.3 Run `grep -rn "callable.*rejects\|await callable\|callable()" packages/sandbox/src/*.test.ts packages/sandbox-stdlib/src/**/*.test.ts` to surface any other tests that need migration; update each.
- [x] 4.4 Verify `packages/sdk/src/sdk-support/sdk-support.test.ts` tests for action-handler throws still pass; if any assertion used the rejection-path mechanism directly, migrate to envelope inspection at the dispatchAction site.

## 5. F-3 regression coverage

- [x] 5.1 Add a test in `packages/sandbox-stdlib/src/timers/timers.test.ts` named "F-3: deferred setTimeout throw does not kill worker": guest schedules `setTimeout(() => { throw new Error("late") }, 0)` then awaits a 50ms timer; assert run resolves with `{ ok: true, ... }`, assert one `system.error` event with `name === "setTimeout"` and `error.message === "late"`, assert sandbox's subsequent `run()` succeeds (worker survival).
- [x] 5.2 Add a companion test for `setInterval`: schedule an interval that throws on every tick, await 100ms, assert multiple paired `system.request` / `system.error` events, assert run resolves OK, assert worker alive.
- [x] 5.3 Add a test asserting the brand symbol is non-enumerable on returned envelopes — `Object.getOwnPropertyNames(envelope).length` matches the visible keys, `Object.getOwnPropertySymbols` shows the brand, and `JSON.stringify(envelope)` does not surface the brand.
- [x] 5.4 Add a test asserting `CallableDisposedError` still rejects (does not surface as envelope) — invoke `callable()` after `callable.dispose()`, expect `.rejects.toThrow(CallableDisposedError)`.

## 6. Spec & security documentation

- [x] 6.1 Add a new R-13 section to `SECURITY.md` §2 immediately after R-12, framed as the symmetric pair under the boundary-opacity umbrella. Rationale calls out audit forgery as primary attacker gain and cold-start CPU amplification as secondary. Cross-reference R-4 (cleanup ordering) with a one-line note.
- [x] 6.2 Update `SECURITY.md` §2 R-4 with a one-line cross-reference to R-13.
- [x] 6.3 Add an "Upgrade notes" entry to `CLAUDE.md` covering the Callable contract change. Include the migration recipe for both Pattern 1 (fire-and-forget under ctx.request — no source change, inherited via auto-unwrap) and Pattern 2 (explicit await — `if (!result.ok) throw result.error;` + bind `result.value`). Note that workflow authors see no change.
- [x] 6.4 Verify the spec deltas merge cleanly into `openspec/specs/sandbox/spec.md`, `openspec/specs/sandbox-stdlib/spec.md`, `openspec/specs/sdk/spec.md` — run `pnpm exec openspec validate --change callable-envelope-contract` to catch any header-mismatch on the MODIFIED requirement.

## 7. Validation & dev verification

- [x] 7.1 `pnpm validate` passes (lint, check, test). Type-checker errors at any forgotten Callable call site are expected and must be addressed individually.
- [x] 7.2 `pnpm test:wpt` passes — sandbox-stdlib touches require the WPT compliance suite.
- [x] 7.3 `pnpm dev --random-port --kill` boots; stdout contains `Dev ready on http://localhost:<port> (tenant=dev)`.
- [x] 7.4 `POST /auth/local/signin` (form: `user=local`) → 302 + `session` cookie. Health-check `/dashboard/local/demo` with that cookie → 200; HTML contains a `runDemo` trigger row.
- [x] 7.5 Trigger a `manualTrigger` named `fail` (the existing demo failure path) to verify `action.error` / `trigger.error` events still flow correctly with the envelope contract in place. The `fail` trigger's body throws synchronously, exercising the F-2 rethrow path; ensure it still produces the expected error shape on the dashboard.
- [x] 7.6 Construct a probe workflow (or extend `demo.ts` temporarily during testing) that schedules `setTimeout(() => { throw }, 0)` and verify in `.persistence/` that `system.error` events fire under the timer's frame and the run completes successfully. Revert any demo.ts probe before commit.
- [x] 7.7 Kill the dev process tree at end of task.

## 8. Audit-trail symmetry follow-up (tracked, NOT in this change)

- [x] 8.1 Document in this change's archive notes that `serializeLifecycleError` (`packages/sandbox/src/plugin.ts:251`) continues to drop `.name` and most structured own-properties for non-envelope error paths. The audit trail therefore carries strictly less information for host-dispatcher errors (`FetchError`, `MailError`, `SqlError`, validator errors via `trigger.ts:57`) than what `sanitizeForGuest` propagates to the guest VM.
- [x] 8.2 File a follow-up OpenSpec change titled "audit-trail-error-symmetry" (or equivalent) that widens `serializeLifecycleError` to copy `GuestSafeError` own-properties uniformly. Out of scope for F-3 because it touches every existing `prefix.error` event in the codebase. Capture as a TODO in the next sprint or backlog item.
