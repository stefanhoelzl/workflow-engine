## MODIFIED Requirements

### Requirement: Safe globals — timers

The sandbox SHALL expose `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval` implemented inside the worker using the worker's own Node timer APIs. Timer callbacks SHALL be invoked inside the QuickJS context with `executePendingJobs` pumped after each callback.

Timers that the guest registers during a `run()` invocation SHALL be tracked by the worker. When the guest's exported function resolves or throws (i.e., `run()` is about to report `done`), the worker SHALL clear every such pending timer before posting `done`. Timers SHALL NOT leak across runs.

This is a deliberate behavioral change from the prior in-process implementation, where timers persisted across runs. The new semantics eliminate cross-run callback leakage (e.g., a `setTimeout(() => emit(...), N)` that would have fired during a later run against the wrong event context).

**Event emission.** Each timer global SHALL produce `InvocationEvent`s on the bridge as defined by the "Timer event kinds" requirement below:

- `setTimeout` / `setInterval` calls SHALL emit a `timer.set` event at the call site, with `ref` equal to the active stack-parent.
- When a callback fires, the worker SHALL emit `timer.request` (with `ref: null`), push its `seq` onto the bridge's ref-stack for the callback duration so that any nested events take it as parent, invoke the callback inside QuickJS, and on return emit `timer.response` (for normal completion, with `output` set to `vm.dump(returnValue)` when serialisable) or `timer.error` (when the callback throws).
- `timer.error` SHALL NOT promote to `trigger.error` or terminate the invocation; `setInterval` timers SHALL continue firing after an errored tick.
- Explicit `clearTimeout` / `clearInterval` calls that target a pending timer SHALL emit `timer.clear` with `ref` equal to the active stack-parent. Calls targeting unknown or already-disposed ids SHALL emit no event.

**Ordering at run finalisation.** The worker's `handleRun` path in `worker.ts` SHALL be arranged such that `timers.clearActive()` runs BEFORE the terminal `trigger.response` or `trigger.error` event for the run is emitted. `clearActive()` SHALL emit one `timer.clear` event per pending timer (with `ref: null`, matching the system-initiated convention) before disposing the callbacks. The terminal trigger event SHALL be emitted after `clearActive()` completes, so that auto-clear events land in the archive flushed on that terminal event.

#### Scenario: setTimeout callback fires during its originating run

- **GIVEN** guest code `await new Promise(resolve => setTimeout(() => resolve(42), 0))`
- **WHEN** the run completes
- **THEN** the callback SHALL have executed inside QuickJS
- **AND** the resulting promise SHALL resolve with `42`

#### Scenario: Timers registered but not awaited are cleared on run end

- **GIVEN** guest code that calls `setTimeout(() => emit("late", {}), 5000)` without awaiting anything
- **WHEN** the exported function returns
- **THEN** the worker SHALL clear that timer before posting `done`
- **AND** no `emit` RPC SHALL be posted to the main side after `done`

#### Scenario: setTimeout call emits timer.set with stack-parent ref

- **GIVEN** a trigger handler running at stack-parent `seq: 1`
- **WHEN** the guest calls `setTimeout(cb, 250)` and receives `timerId = 7`
- **THEN** the worker SHALL emit a `timer.set` event with `name: "setTimeout"`, `input: { delay: 250, timerId: 7 }`, and `ref: 1`

#### Scenario: Firing callback produces request/response pair with correct nesting

- **GIVEN** a pending `setTimeout` with `timerId: 7`
- **WHEN** the Node timer fires and the callback returns `"ok"`
- **THEN** the worker SHALL emit `timer.request` with `ref: null` and `input: { timerId: 7 }`, push that event's `seq` onto the bridge ref-stack for the callback duration, and after the callback returns emit `timer.response` with `ref` equal to the request's `seq`, `input: { timerId: 7 }`, and `output: "ok"`

#### Scenario: Throwing callback emits timer.error and does not fail the invocation

- **GIVEN** guest code `setTimeout(() => { throw new Error("boom") }, 0)` inside a trigger handler that otherwise returns `{ status: 202 }`
- **WHEN** the callback runs and throws
- **THEN** the worker SHALL emit a `timer.error` carrying `error.message: "boom"` and `input: { timerId: <id> }`
- **AND** the trigger SHALL terminate with `trigger.response` carrying `{ status: 202 }`, not `trigger.error`

#### Scenario: Auto-cleared timer produces timer.clear before trigger.response

- **GIVEN** a trigger handler that registers `setInterval(cb, 100)` producing `timerId: 9` and returns immediately
- **WHEN** the run completes
- **THEN** `timers.clearActive()` SHALL emit a `timer.clear` with `name: "clearInterval"`, `input: { timerId: 9 }`, and `ref: null`
- **AND** that `timer.clear` event SHALL appear at a lower `seq` than the `trigger.response` event in the invocation's archive file

#### Scenario: Explicit clearInterval emits timer.clear with stack-parent ref

- **GIVEN** a trigger handler at stack-parent `seq: 1` with a pending `setInterval` that produced `timerId: 9`
- **WHEN** the guest calls `clearInterval(9)`
- **THEN** the worker SHALL emit a `timer.clear` with `name: "clearInterval"`, `input: { timerId: 9 }`, and `ref: 1`

#### Scenario: clearTimeout on unknown id emits no event

- **GIVEN** no pending timer with `timerId: 42`
- **WHEN** the guest calls `clearTimeout(42)`
- **THEN** the worker SHALL NOT emit any `timer.clear` event

## ADDED Requirements

### Requirement: Timer event kinds

The sandbox's timer globals SHALL extend the `InvocationEvent` discriminated union with five new `kind` values: `timer.set`, `timer.request`, `timer.response`, `timer.error`, `timer.clear`. These events SHALL be produced by the sandbox worker during an invocation and SHALL flow through the existing persistence and event-store pipeline without requiring any new consumer, column, or storage path.

Each timer event SHALL populate the common `InvocationEvent` fields: `id`, `seq`, `ref`, `ts`, `workflow`, `workflowSha`. The `name` field SHALL be one of `"setTimeout"`, `"setInterval"`, `"clearTimeout"`, `"clearInterval"` as specified per kind below. Timer events SHALL populate the `input`, `output`, and `error` fields as specified per kind.

**`timer.set`** — emitted whenever guest code calls `setTimeout` or `setInterval`. Carries:

- `name`: `"setTimeout"` for `setTimeout` calls, `"setInterval"` for `setInterval` calls.
- `ref`: active stack-parent `seq`, or `null` if no frame is active.
- `input`: `{ delay: number, timerId: number }`.
- No `output`, no `error`.

**`timer.request`** — emitted immediately before the host invokes a guest timer callback. Carries:

- `name`: inherited from the originating `timer.set`.
- `ref`: `null` (system-initiated).
- `input`: `{ timerId: number }`.
- No `output`, no `error`.

The emitter SHALL push the event's `seq` onto the bridge ref-stack before calling into QuickJS so that any nested events emitted during the callback take this `seq` as their `ref`. The emitter SHALL pop the ref-stack before emitting the paired `timer.response` or `timer.error`.

**`timer.response`** — emitted when a guest timer callback returns normally. Carries:

- `name`: inherited from the originating `timer.set`.
- `ref`: `seq` of the paired `timer.request` event.
- `input`: `{ timerId: number }`.
- `output`: the callback's return value, marshalled via `vm.dump(...)`. If the return value is not JSON-serialisable, `output` SHALL be omitted rather than causing emission to fail.
- No `error`.

**`timer.error`** — emitted when a guest timer callback throws. Carries:

- `name`: inherited from the originating `timer.set`.
- `ref`: `seq` of the paired `timer.request` event.
- `input`: `{ timerId: number }`.
- `error`: `{ message: string, stack: string }`.
- No `output`.

`timer.error` SHALL NOT promote to `trigger.error` and SHALL NOT end the invocation. For `setInterval` timers, subsequent ticks SHALL continue to fire until the timer is cleared.

**`timer.clear`** — emitted when a timer is disposed, either by explicit guest call (`clearTimeout` / `clearInterval` on a pending id) or automatically by the worker's run-finalisation path. Carries:

- `name`: `"clearTimeout"` for `setTimeout`-created timers; `"clearInterval"` for `setInterval`-created timers. Applies uniformly regardless of whether the disposal was explicit or automatic.
- `ref`: for explicit clears, the active stack-parent. For automatic invocation-end clears, `null`.
- `input`: `{ timerId: number }`.
- No `output`, no `error`.

A `timer.clear` event SHALL NOT be emitted for a `clearTimeout` / `clearInterval` call that targets an unknown or already-disposed id.

#### Scenario: Discriminated union accepts all five new kinds

- **GIVEN** a parser validating an `InvocationEvent` against the zod discriminated union
- **WHEN** an event with `kind` in `{timer.set, timer.request, timer.response, timer.error, timer.clear}` is parsed
- **THEN** parsing SHALL succeed and the parsed object SHALL retain the discriminant

#### Scenario: Unknown timer kinds are rejected

- **GIVEN** the zod discriminated union for `InvocationEvent`
- **WHEN** an event with `kind: "timer.tick"` (not in the enumerated set) is parsed
- **THEN** parsing SHALL fail with a zod discrimination error

#### Scenario: Non-serialisable return value emits timer.response without output

- **GIVEN** a guest callback for `timerId: 7` that returns a value `vm.dump` cannot serialise
- **WHEN** the callback completes normally
- **THEN** the bridge SHALL emit a `timer.response` with `input: { timerId: 7 }` and no `output` field

#### Scenario: Interval continues after an errored tick

- **GIVEN** a `setInterval(cb, 10)` whose first tick throws
- **WHEN** the first tick fires and emits `timer.error`
- **THEN** the host SHALL NOT call `clearInterval` on that timer
- **AND** subsequent ticks SHALL produce further `timer.request` / `timer.response` or `timer.error` pairs until the handler returns or the guest clears the timer

### Requirement: Timer events correlate via `timerId`

All five timer event kinds SHALL carry `timerId` in their `input` field. Correlation across the family — linking a `timer.request` to its originating `timer.set`, linking a `timer.clear` to the timer it disposed, etc. — SHALL rely on matching `timerId` values across events within a single invocation. The event schema SHALL NOT carry `targetSetSeq`, `setRef`, or any other seq-pointer field for timer correlation; the `ref` field SHALL retain its single meaning of "active stack parent or null for system-initiated."

Within a single invocation, `timerId` values SHALL be unique across all `timer.set` events. The implementation MAY rely on the Node.js-provided timer id, which is monotonic within the process lifetime and is not reused while the timer is pending. If a future implementation choice breaks that uniqueness, the implementation SHALL mint its own monotonic counter rather than change the event schema.

#### Scenario: All timer events for one timer share a timerId

- **GIVEN** a `setTimeout` call producing `timerId: 7`, its firing callback, and an explicit `clearTimeout(7)` call
- **WHEN** the full event stream is collected
- **THEN** every emitted `timer.set`, `timer.request`, `timer.response` or `timer.error`, and `timer.clear` for that timer SHALL have `input.timerId === 7`

#### Scenario: Two concurrent timers are distinguishable by timerId

- **GIVEN** two `setTimeout` calls with distinct ids `7` and `11` pending concurrently
- **WHEN** the event stream is filtered by `input.timerId`
- **THEN** filtering by `timerId: 7` SHALL yield only the events for the first timer
- **AND** filtering by `timerId: 11` SHALL yield only the events for the second timer

### Requirement: `ref = null` marks system-initiated events

The `ref` field on any `InvocationEvent` produced by the sandbox SHALL have one of three meanings, determined uniformly across kinds:

1. If the event is paired with a prior request (`trigger.response`, `trigger.error`, `action.response`, `action.error`, `system.response`, `system.error`, `timer.response`, `timer.error`), `ref` SHALL be the `seq` of that request.
2. If the event is a side effect emitted by guest code while executing inside a handler or callback, `ref` SHALL be the `seq` of the active stack-parent frame.
3. If the event is system-initiated (i.e., it has no prior stack — the runtime produced it without any guest call being on the stack), `ref` SHALL be `null`.

Category 3 covers `trigger.request` (runtime delivered the trigger), `timer.request` (runtime fired the callback), and automatic-invocation-end `timer.clear` events. No other category 3 cases exist at present.

#### Scenario: trigger.request has ref=null

- **GIVEN** a fresh invocation
- **WHEN** the executor emits `trigger.request`
- **THEN** the event's `ref` SHALL be `null`

#### Scenario: timer.request has ref=null regardless of outer stack

- **GIVEN** a `setTimeout` whose callback fires while the trigger handler is awaiting an unrelated `fetch`
- **WHEN** the host Node timer fires and the bridge emits `timer.request`
- **THEN** the event's `ref` SHALL be `null`
- **AND** the `ref` SHALL NOT be the trigger's `seq` even though the trigger handler is still notionally active

#### Scenario: Events emitted inside a firing callback take timer.request as stack parent

- **GIVEN** a `timer.request` event at `seq: 15` has been emitted and pushed onto the ref-stack
- **WHEN** the guest callback calls `ctx.emit("child", {})`, producing an `action.request` event at `seq: 16`
- **THEN** the `action.request` event SHALL have `ref: 15`
