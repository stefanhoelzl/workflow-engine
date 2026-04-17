## Why

Guest workflows can call `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval` inside the QuickJS sandbox, but those calls produce no `InvocationEvent`s today. The comment at `packages/sandbox/src/globals.ts:34-39` rationalised this as "guest timer use is rare," but the consequence is that callback errors are silently swallowed (`globals.ts:52`), and archived invocations give no trace of which timers fired, when, or what their effects caused. This is a real observability gap: a timer that schedules an action has its action events in the archive but no parent linking those actions back to the timer — so a reader can't explain why they happened. The new `timer.*` event family closes that gap.

## What Changes

- Add five new `InvocationEvent` kinds: `timer.set`, `timer.request`, `timer.response`, `timer.error`, `timer.clear`. All five are emitted from inside the sandbox worker during an invocation and flow through the existing pending/archive persistence pipeline with no new consumers.
- Every timer event carries `timerId` in its `input` payload; correlation across the family is by `timerId` alone (no seq-pointer fields). Within an invocation, `timerId` is unique because it comes from the Node-level timer id.
- Adopt the convention that `ref = null` on a non-paired event means "system-initiated". This already holds for `trigger.request`; it extends to `timer.request` (runtime fires the callback) and to `timer.clear` events produced by automatic invocation-end cleanup. Explicit `clearTimeout`/`clearInterval` calls retain normal stack-parent `ref` semantics.
- `timer.request` pushes its own `seq` as the active stack-parent for the duration of the guest callback, so any nested action/system/timer events emitted inside the callback reference it as `ref`.
- Callback errors emit a `timer.error` event and are non-fatal; they SHALL NOT promote to `trigger.error` or otherwise end the invocation. `setInterval` continues firing after an errored tick.
- Reorder `worker.ts`'s terminal-path so `timers.clearActive()` (which now emits a `timer.clear` per disposed timer with `ref = null`) runs **before** the `trigger.response` / `trigger.error` emission. Archive flush already triggers on that terminal event, so this ordering guarantees every auto-clear lands in the archive.
- Rename the bridge's private `buildSystemEvent` helper to `buildEvent` and expose it on the `Bridge` interface, so `globals.ts` can construct events without duplicating the run-context / field wiring. The helper is already generic over `kind`; only the name and visibility change.
- Delete the stale "emit no events for now" comment at `globals.ts:34-39` and document the new emission contract in its place.
- **BREAKING**: The ordering change in `worker.ts` is observable: `trigger.response` now arrives after any `timer.clear` events for the same invocation. Consumers that assume `trigger.response` is the last event in an invocation's stream (there are none today — persistence flushes the archive *on* that event, so late-arriving events would already be lost) would need to adjust. Flagged BREAKING because event-stream ordering is part of the observable contract.

## Capabilities

### New Capabilities

None. All new behaviour lives inside the existing `sandbox` capability.

### Modified Capabilities

- `sandbox`: The existing "Safe globals — timers" requirement gains event-emission obligations (timer globals emit `timer.*` events via the bridge; `clearActive()` emits per-timer `timer.clear` events before `done` is posted) and a run-finalisation ordering rule (clears precede the terminal trigger event so they land in the archive). The capability also gains three new requirements that document the contract emitted at the sandbox boundary: the five `timer.*` event kinds and their payload shapes, the `timerId` correlation rule (no seq-pointer fields, `timerId` is the sole cross-temporal link), and the `ref = null` system-initiated convention generalised from its existing use on `trigger.request` to also cover `timer.request` and automatic `timer.clear` events.

## Impact

**Affected code**:
- `packages/core/src/index.ts` — extend the `EventKind` / `InvocationEvent` zod discriminated union with five new kinds.
- `packages/sandbox/src/bridge-factory.ts` — rename `buildSystemEvent` → `buildEvent`, expose on `Bridge` interface.
- `packages/sandbox/src/globals.ts` — instrument the four timer globals; extend `TimerCleanup` so `clearActive()` can emit `timer.clear` events via the bridge; replace the stale comment.
- `packages/sandbox/src/worker.ts` — reorder so `clearActive()` runs before the terminal `emitTriggerEvent(...)` call in `handleRun`.

**Unchanged**:
- Persistence, event-store, logging consumer. Timer events pass through the existing pipeline as ordinary `InvocationEvent`s; DuckDB columns already match; archive flush behaviour is unchanged (still fires on `trigger.response` / `trigger.error`).
- Dashboard and all UI surfaces. Timer events are event-stream-only in v1; they appear in the archive JSON and DuckDB `events` table but are not surfaced on any UI.

**Security**:
- No change to the sandbox boundary. No new globals exposed to the guest, no new Node.js surface introduced. The `ref = null` convention is internal to the event schema. `/SECURITY.md §2` does not need an update — the sandbox globals listed there (`setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`) are the same set; only their observable side-effects inside the event stream change.

**Explicitly out of scope**:
- Host scheduler / durable timers / cross-invocation wakeups.
- UI changes (dashboard badges, event timelines).
- Callback source capture (e.g. `callback.toString()`).
- Structured-logging changes (timer events stay out of the logging consumer, as action/system events already do).
