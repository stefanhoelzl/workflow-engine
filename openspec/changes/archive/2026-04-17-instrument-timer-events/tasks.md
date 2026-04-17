## 1. Core package — extend event kind union

- [x] 1.1 In `packages/core/src/index.ts`, extend the `EventKind` zod enum / discriminated union with the five new kinds: `timer.set`, `timer.request`, `timer.response`, `timer.error`, `timer.clear`.
- [x] 1.2 Confirm the `InvocationEvent` discriminated-union schema accepts the new kinds with the existing `{ input?, output?, error? }` fields; no new fields needed. Verify zod `.discriminatedUnion` rejects unknown kinds (negative test).
- [x] 1.3 Run `pnpm check` and confirm no downstream type errors in runtime / sandbox packages.

## 2. Bridge — expose `buildEvent` helper

- [x] 2.1 In `packages/sandbox/src/bridge-factory.ts`, rename the private function `buildSystemEvent` to `buildEvent`. It already takes `kind` as its first parameter; only the name is historical.
- [x] 2.2 Add `buildEvent(kind, seq, ref, name, extra): InvocationEvent | null` to the `Bridge` interface (lines ~60-108) and return it from `createBridge`.
- [x] 2.3 Update the internal call sites (`emitSystemRequest` / `emitSystemResponse` / `emitSystemError`) to call `buildEvent` through the bridge surface rather than the local closure; these are smoke-test-level changes with no observable effect.
- [x] 2.4 Run `pnpm check` and `pnpm test` on the sandbox package to confirm existing tests still pass.

## 3. Sandbox globals — instrument timers

- [x] 3.1 In `packages/sandbox/src/globals.ts`, delete the stale "emit no events for now" comment at lines 34-39 and replace it with a short note documenting the new emission contract and referencing the sandbox capability's "Timer event kinds" requirement.
- [x] 3.2 Change `pendingCallbacks` from `Map<number, JSValueHandle>` to `Map<number, { cb: JSValueHandle; name: "setTimeout" | "setInterval" }>` so `clearActive()` knows which `clearTimeout` / `clearInterval` name to emit.
- [x] 3.3 In `setTimeout`'s host-function implementation: allocate a `seq` via `b.nextSeq()`, emit a `timer.set` event via `b.emit(b.buildEvent("timer.set", setSeq, b.currentRef(), "setTimeout", { input: { delay, timerId: numId } }))`. Keep the native `setTimeout` call and the return-the-id behaviour unchanged.
- [x] 3.4 Inside the native `setTimeout` callback body, before calling `vm.callFunction(cb, ...)`: allocate `reqSeq`, emit `timer.request` with `ref: null` and `input: { timerId: numId }`, then `b.pushRef(reqSeq)`.
- [x] 3.5 Wrap `vm.callFunction(cb, vm.undefined)` in try/catch. On success, marshal the returned handle via `vm.dump(ret)`, guarding against non-serialisable values (fall through to `output: undefined`), and emit `timer.response` with `ref: reqSeq` and `input: { timerId: numId }` plus `output` when defined. On throw, emit `timer.error` with `ref: reqSeq`, `input: { timerId: numId }`, and `error: { message, stack }`. In `finally`, `b.popRef()`, `pendingCallbacks.delete(numId)`, `cb.dispose()`, `vm.executePendingJobs()`.
- [x] 3.6 Apply the symmetric changes to `setInterval`. Do not `pendingCallbacks.delete(numId)` on each tick — intervals persist across fires until cleared. Keep the same request/response/error emission pattern per tick.
- [x] 3.7 In `clearTimeout`'s host-function implementation: look up the timer in `pendingCallbacks` first; if present, emit `timer.clear` with `ref: b.currentRef()`, `name: "clearTimeout"`, `input: { timerId: id }`. Then dispose the callback and call the native `clearTimeout`. If the id is unknown, emit nothing and remain a no-op.
- [x] 3.8 Apply the symmetric changes to `clearInterval`.
- [x] 3.9 Rework `clearActive()` to emit one `timer.clear` per pending entry BEFORE disposing. Each emitted event SHALL have `ref: null` and `name` matching the entry's recorded `name` (`"clearTimeout"` for `setTimeout`-created entries, `"clearInterval"` for `setInterval`-created entries).

## 4. Worker run-finalisation — reorder

- [x] 4.1 In `packages/sandbox/src/worker.ts`'s `handleRun` (around lines 447-488), hoist the terminal `emitTriggerEvent("trigger.response", ...)` / `emitTriggerEvent("trigger.error", ...)` call out of the `try` block.
- [x] 4.2 Inside the `try`, set a local `payload` variable based on whether `callGuestFunction` resolves or `fnHandle` is missing. Inside the `catch (err)`, assign `payload = { ok: false, error: serializeError(err) }`.
- [x] 4.3 In the `finally`, call `timers.clearActive()` first (so its `timer.clear` events emit now), then emit exactly one terminal trigger event chosen from `payload.ok` (either `trigger.response` carrying `payload.result` or `trigger.error` carrying `payload.error`).
- [x] 4.4 Keep the rest of the finally block (`state.currentAbort?.abort()`, `uninstallGlobals`, `bridge.clearRunContext()`) after the terminal emit, unchanged.

## 5. Tests — core-package / bridge unit tests

- [x] 5.1 Add a core-package test asserting the zod discriminated union round-trips each of the five new kinds (positive case) and rejects `kind: "timer.tick"` (negative case).
- [x] 5.2 Add a bridge unit test asserting `buildEvent` constructs events identically for the existing `system.request` / `system.response` / `system.error` paths as the old `buildSystemEvent` did (regression guard for the rename).

## 6. Tests — sandbox integration

- [x] 6.1 Add a test: guest calls `setTimeout(cb, 0)` inside a handler that awaits it; assert the event stream contains one `timer.set`, one `timer.request` with `ref: null`, one `timer.response` with `ref` equal to the request's `seq`, and that no `timer.clear` is emitted (callback self-disposed).
- [x] 6.2 Add a test: guest registers `setTimeout(cb, 5000)` fire-and-forget; assert the event stream contains `timer.set`, then a `timer.clear` with `ref: null` and `name: "clearTimeout"` emitted by `clearActive()`, and that the `timer.clear` event precedes `trigger.response` in `seq` order.
- [x] 6.3 Add a test: guest registers `setInterval(cb, 10)` whose callback throws. Assert multiple ticks emit `timer.request` + `timer.error` pairs, the interval keeps firing, and the final `timer.clear` is emitted at invocation end.
- [x] 6.4 Add a test: nested — a `setTimeout` callback calls `ctx.emit("child", {})`. Assert the resulting `action.request` event has `ref` equal to the `timer.request.seq` (stack-parent pushed for callback duration).
- [x] 6.5 Add a test: explicit `clearTimeout(id)` emitted; assert `timer.clear` with `ref` equal to the active stack-parent (the trigger's `seq`) and `name: "clearTimeout"`.
- [x] 6.6 Add a test: `clearTimeout(42)` on an unknown id emits nothing.
- [x] 6.7 Add a test for error-path ordering: trigger handler throws while a `setInterval` is pending. Assert `timer.clear` events precede the `trigger.error` event in the archive.

## 7. Tests — security / boundary

- [x] 7.1 Confirm the sandbox's exposed-globals invariant is unchanged by adding an assertion that the set of own-property names on `globalThis` after `setupGlobals()` has not grown. This is a negative test protecting the `/SECURITY.md §2` boundary.
- [x] 7.2 Confirm no guest-reachable surface was added: assert that guest code cannot access `b.buildEvent` or any new bridge helper from within the sandbox (they are host-side only). A simple guest script trying to access `__buildEvent`, `buildEvent`, or similar names SHALL resolve to `undefined`.

## 8. Documentation

- [x] 8.1 Update `globals.ts`'s inline comments to reflect the new contract (see 3.1).
- [x] 8.2 No `/SECURITY.md §2` update required (the sandbox boundary is unchanged — same globals, same host-bridge surface). Add a one-line note to the PR description confirming the threat-model alignment check was performed.
- [x] 8.3 Update the `openspec/project.md` architecture note if it enumerates event kinds (search for `trigger.request` / `action.request` references). If enumerations exist and are now stale, extend them with the timer family.

## 9. Validation

- [x] 9.1 Run `pnpm validate` (lint + format + type-check + tests) and confirm green.
- [x] 9.2 Run `pnpm exec openspec validate instrument-timer-events --strict` and confirm the change validates against the OpenSpec schema.
- [x] 9.3 Spot-check an archive file from a test run: open one `archive/{id}.json` and confirm timer events appear interleaved with trigger/action events in the expected order, with `ref: null` on the system-initiated ones.
