## ADDED Requirements

### Requirement: Main-side RunSequencer owns seq and ref stamping

The sandbox SHALL maintain a `RunSequencer` on the main thread (inside `sandbox.ts`). The sequencer SHALL own all event-stamping state for a run: a monotonic `seq` counter starting at `0`, a `refStack: number[]` tracking open-frame parent pointers, a `callMap: Map<callId, {openSeq, name, prefix}>` for paired open/close ref attribution, and a `runActive: boolean` gate.

The sequencer SHALL expose three methods, all called only from inside the Sandbox:

- `start(): void` — opens the active window. Sets `runActive = true`. Internal state (`seq`, `refStack`, `callMap`) SHALL already be zero/empty from prior `finish()` (or initial construction); `start` SHALL NOT zero them.
- `next(wireEvent): SandboxEvent` — assigns `seq` and `ref` based on the wire event's `type` field (see "Explicit framing via the `type` field on wire events"), updates `refStack` / `callMap`, and returns the widened `SandboxEvent` (carrying `seq`, `ref`, plus all original fields except `type` and the embedded callId).
- `finish(opts?: { closeReason: string }): SandboxEvent[]` — closes the active window. If any frames are open in `callMap`:
  - When `opts.closeReason` is provided (worker-death path): the sequencer SHALL synthesise one close `SandboxEvent` per open frame, in LIFO order, using the captured `name` and `kind`, with `ref = openSeq`, `error = { message: opts.closeReason, stack: "" }`, `ts = lastSeenTs`, `at = lastSeenAt`. The synthesised close's `kind` SHALL be derived by taking the prefix of the captured open kind up to (but not including) the first `.` and appending `.error` — e.g. `"system.request"` → `"system.error"`, `"trigger.request"` → `"trigger.error"`, `"weird-no-dot"` → `"weird-no-dot.error"`. This rule is failsafe: it produces a well-formed `<prefix>.error` kind regardless of whether the open's kind suffix follows the `.request` convention. Returns the synthesised events to the caller for forwarding through `sb.onEvent`.
  - When `opts` is omitted (plugin-bug path): the sequencer SHALL emit a `sandbox.dangling_frame` warning via the host `Logger` carrying the open-frame count and kinds, and SHALL drop the frames silently. Returns an empty array.
- After handling open frames, `finish` SHALL zero state (`seq = 0`, `refStack = []`, `callMap = {}`) and set `runActive = false`.

The sequencer SHALL be private to the Sandbox; it SHALL NOT be exposed on the public `Sandbox` interface or any other surface. No external caller (Executor, plugins, runtime) SHALL be able to call `next` / `start` / `finish` directly.

#### Scenario: start opens the window without zeroing already-zero state

- **GIVEN** a sequencer constructed (or just-finished from a prior run) with `seq=0`, `refStack=[]`, `callMap={}`, `runActive=false`
- **WHEN** `sequencer.start()` is called
- **THEN** `runActive` SHALL be `true`
- **AND** `seq`, `refStack`, and `callMap` SHALL be unchanged

#### Scenario: next stamps seq and ref for an open event

- **GIVEN** a sequencer in `runActive=true` state with `seq=5`, `refStack=[3]`, empty `callMap`
- **WHEN** `next` receives a wire event with `kind="trigger.request"`, `name="demo"`, `type={open:42}`
- **THEN** the returned SandboxEvent SHALL have `seq=5`, `ref=3`
- **AND** the sequencer SHALL increment `seq` to `6`
- **AND** `refStack` SHALL become `[3, 5]`
- **AND** `callMap[42]` SHALL be `{ openSeq: 5, name: "demo", kind: "trigger.request" }`

#### Scenario: next pairs a close to its open via the type field's callId

- **GIVEN** a sequencer with `seq=10`, `refStack=[5, 7]`, `callMap[42]={openSeq:5, name:"demo", kind:"trigger.request"}`
- **WHEN** `next` receives a wire event with `kind="trigger.response"`, `type={close:42}`
- **THEN** the returned SandboxEvent SHALL have `seq=10`, `ref=5`
- **AND** `refStack` SHALL no longer contain `5`
- **AND** `callMap[42]` SHALL be deleted

#### Scenario: finish synthesises closes for open frames on death

- **GIVEN** a sequencer with `callMap` containing two open frames: `{openSeq:0, name:"demo", kind:"trigger.request"}` for callId=1 and `{openSeq:3, name:"fetch", kind:"system.request"}` for callId=2
- **WHEN** `sequencer.finish({ closeReason: "worker terminated: memory limit exceeded" })` is called
- **THEN** the returned SandboxEvent array SHALL contain two events in LIFO order
- **AND** the first event SHALL be derived from the `system.request` open: its `kind` SHALL be `"system.error"` (prefix `"system"` + `".error"`), `ref=3`, `name="fetch"`, error message including the closeReason
- **AND** the second event SHALL be derived from the `trigger.request` open: its `kind` SHALL be `"trigger.error"` (prefix `"trigger"` + `".error"`), `ref=0`, `name="demo"`, error message including the closeReason
- **AND** after the call: `seq=0`, `refStack=[]`, `callMap={}`, `runActive=false`

#### Scenario: finish without closeReason warns on dangling frames

- **GIVEN** a sequencer with one open frame in `callMap`
- **WHEN** `sequencer.finish()` is called with no arguments
- **THEN** the host `Logger` SHALL receive a `sandbox.dangling_frame` warning carrying the open-frame count and kinds
- **AND** the returned array SHALL be empty
- **AND** state SHALL be zeroed; `runActive` SHALL be `false`

### Requirement: Explicit framing via the `type` field on wire events

Every wire event from the worker to the Sandbox SHALL carry a `type` field whose value is one of:

- `"leaf"` — a leaf event with no frame semantics.
- `{ open: CallId }` — an open event introducing a new frame; `CallId` is a worker-assigned, per-run-unique number.
- `{ close: CallId }` — a close event terminating the frame whose open carried the same `CallId`.

The Sandbox `RunSequencer.next` SHALL stamp `seq` and `ref` based on the `type` field, NOT by parsing the `kind` string:

- `"leaf"`: `ref = refStack.at(-1) ?? null`; no mutation of `refStack` or `callMap`.
- `{ open: callId }`: `ref = refStack.at(-1) ?? null`; `refStack.push(assignedSeq)`; `callMap.set(callId, {openSeq: assignedSeq, name, kind})`.
- `{ close: callId }`: look up `entry = callMap.get(callId)`. If absent, the sandbox SHALL log `sandbox.close_without_open` via the host `Logger` (level: `warn`) carrying `{kind, name, callId}` and SHALL drop the event (no stamping, no forwarding to `sb.onEvent`). Otherwise: `ref = entry.openSeq`; remove `entry.openSeq` from `refStack`; `callMap.delete(callId)`.

The `kind` string SHALL be treated as free-form metadata. The sandbox SHALL NOT inspect the `kind` for framing purposes. Suffix conventions like `*.request` / `*.response` / `*.error` are downstream consumer conventions (used by dashboards and logging filters), not load-bearing for framing.

A wire event with a `kind` ending in `.request` but `type: "leaf"` SHALL be treated as a leaf. A wire event with `kind: "user.click"` and `type: { open: 5 }` SHALL be treated as an open. The kind and the framing are independent dimensions.

#### Scenario: Framing is determined by `type`, not by kind suffix

- **GIVEN** a wire event with `kind = "trigger.request"` and `type = "leaf"`
- **WHEN** `sequencer.next` processes it
- **THEN** the event SHALL be treated as a leaf
- **AND** `refStack` and `callMap` SHALL NOT be mutated

#### Scenario: A non-conventional kind can carry framing

- **GIVEN** a wire event with `kind = "user.click"` and `type = { open: 7 }`
- **WHEN** `sequencer.next` processes it
- **THEN** the event SHALL be treated as an open
- **AND** `refStack` SHALL be pushed with the assigned seq
- **AND** `callMap[7]` SHALL be set with `{openSeq, name, kind: "user.click"}`

#### Scenario: Close without matching open is dropped with a log

- **GIVEN** a wire event with `type = { close: 99 }` and `callMap` does not contain key 99
- **WHEN** `sequencer.next` processes it
- **THEN** the host `Logger` SHALL receive a `warn`-level entry for `sandbox.close_without_open` carrying `{kind, name, callId: 99}`
- **AND** no SandboxEvent SHALL be returned to the caller for forwarding to `sb.onEvent`

### Requirement: SDK `ctx.emit` and `ctx.request` shape

The sandbox SHALL expose `ctx.emit` and `ctx.request` to plugin and guest code with the following shapes:

```ts
type CallId = number

type EmitOptions = {
  name: string                                          // required
  input?: unknown
  output?: unknown
  error?: { message: string; stack: string; issues?: unknown }
  type?: "leaf" | "open" | { close: CallId }            // default "leaf"
}

type RequestOptions = {
  name: string                                          // required
  input?: unknown
}

interface SandboxContext {
  emit(kind: string, options: EmitOptions): CallId
  request<T>(
    prefix: string,
    options: RequestOptions,
    fn: () => T | Promise<T>,
  ): T | Promise<T>
}
```

`ctx.emit` SHALL:

- For `type: "leaf"` (or `type` omitted): post a wire event with `type: "leaf"`. The returned `CallId` MAY be any value; callers SHALL ignore it.
- For `type: "open"`: assign a per-run-unique `CallId` from the worker's local counter, post a wire event with `type: { open: <assignedCallId> }`, and return the assigned CallId for the caller to pair with a future close.
- For `type: { close: callId }`: post a wire event with `type: { close: callId }` echoing the supplied id. The returned `CallId` MAY be any value; callers SHALL ignore it.

The SDK input shape (`"leaf" | "open" | { close: CallId }`) is asymmetric to the wire shape (`"leaf" | { open: CallId } | { close: CallId }`). The bridge SHALL transform `"open"` into `{ open: <assignedCallId> }` before posting to main.

`ctx.request(prefix, options, fn)` SHALL be implementable as sugar over `ctx.emit`:

1. `const callId = ctx.emit(\`${prefix}.request\`, { name: options.name, input: options.input, type: "open" })`
2. Invoke `fn()`. If sync and successful: `ctx.emit(\`${prefix}.response\`, { name, input: options.input, output: result, type: { close: callId } })`; return result.
3. If sync and throws: `ctx.emit(\`${prefix}.error\`, { name, input: options.input, error: serialized, type: { close: callId } })`; rethrow.
4. If async: attach `.then` / catch handlers that emit the response/error close and return / rethrow accordingly.

The kind strings constructed via `${prefix}.request` / `${prefix}.response` / `${prefix}.error` are conventional only; the sandbox SHALL NOT enforce that callers of `ctx.request` use these suffixes for any other purpose.

#### Scenario: Emit with default type produces a leaf

- **WHEN** plugin code calls `ctx.emit("system.call", { name: "console.log", input: { args: ["hello"] } })`
- **THEN** the worker SHALL post a wire event with `type: "leaf"`, `kind: "system.call"`, `name: "console.log"`, `input: { args: ["hello"] }`

#### Scenario: Emit with type "open" returns the assigned CallId

- **WHEN** plugin code calls `const callId = ctx.emit("trigger.request", { name: "demo", input, type: "open" })`
- **THEN** `callId` SHALL be a non-negative number
- **AND** the worker SHALL post a wire event with `type: { open: callId }`

#### Scenario: Close requires its CallId structurally

- **GIVEN** a TypeScript file calling `ctx.emit("trigger.response", { name, input, output, type: "close" })`
- **WHEN** the file is type-checked
- **THEN** type-checking SHALL fail because `"close"` is not a valid value for `type` (the valid close form is `{ close: callId }`)

#### Scenario: ctx.request wraps fn with paired emits

- **GIVEN** plugin code calls `ctx.request("system", { name: "fetch", input: { url } }, () => __hostFetch(url))` and the call resolves with value `R`
- **WHEN** the call returns
- **THEN** the worker SHALL have posted a `system.request` wire event with `type: { open: id }` for some id
- **AND** a `system.response` wire event with `type: { close: id }` echoing the same id
- **AND** the resolved value SHALL be `R`

### Requirement: Out-of-window events route to the host Logger

While `runActive=false`, any wire event arriving from the worker SHALL be logged via the host `Logger` as `sandbox.event_outside_run` (level: `warn`) carrying `{ kind, name, at }`. The event SHALL NOT be stamped, NOT be forwarded to `sb.onEvent`, and NOT be emitted to the bus. These events are infrastructure diagnostics (typically late guest async resolutions during the post-`done` worker restore window), not part of any invocation's event stream.

#### Scenario: Late guest async event is logged, not bussed

- **GIVEN** a sandbox where the most recent run has emitted `done` and `sequencer.finish()` has been called
- **AND** the worker is in the middle of its post-run restore phase
- **WHEN** the worker emits a late wire event for a guest microtask that resolved during restore
- **THEN** the host `Logger` SHALL receive a `sandbox.event_outside_run` warning
- **AND** no `SandboxEvent` SHALL be delivered to `sb.onEvent` subscribers

### Requirement: system.exception event kind contract

The `@workflow-engine/core` package SHALL export `"system.exception"` as a variant of `EventKind`. A `system.exception` InvocationEvent SHALL be a leaf in the invocation call tree — emitting one SHALL NOT push or pop entries on the refStack. It SHALL be emitted only by the `__reportErrorHost` private guest function provided by the web-platform plugin (see `sandbox-stdlib/spec.md`).

The event SHALL carry `error: { message: string, stack: string }`. It SHALL NOT carry `input` or `output`. The `name` field SHALL identify the source (typically the exception's class name, e.g. `"TypeError"`).

`system.exception` (guest had an unhandled throw, leaf, unparented) SHALL be distinct from `system.error` (host call failed, paired close of a `system.request`). Consumers branching on `kind` SHALL treat the two as semantically distinct.

#### Scenario: Microtask exception emits system.exception

- **GIVEN** guest code calls `queueMicrotask(() => { throw new TypeError("boom") })`
- **WHEN** the microtask fires and `reportError` forwards through `__reportErrorHost`
- **THEN** exactly one InvocationEvent with `kind="system.exception"` SHALL be emitted
- **AND** its `error.message` SHALL be `"boom"`

## MODIFIED Requirements

### Requirement: Host bridge runs in the worker

The host-bridge implementation (`bridge-factory.ts`, `globals.ts`, and related `b.sync` / `b.async` surfaces and their `impl` functions) SHALL execute inside the worker isolate, with the following responsibility split:

1. **Worker-side bridge state**: marshal/arg extractors, the WASI anchor cell + `tsUs()`, the per-run `callId` counter (assigned to opens, echoed on closes), the event sink that posts wire events to main, and a `runActive` boolean gate. The bridge SHALL NOT hold a `seq` counter, a `refStack`, or any framing/stack primitives. The functions `nextSeq`, `currentRef`, `pushRef`, `popRef`, `refStackDepth`, `truncateRefStackTo`, and `resetSeq` SHALL NOT exist on the bridge interface. The bridge SHALL retain `setRunActive()` and `clearRunActive()` to gate emissions: `buildEvent` SHALL be a no-op (return 0, do not post) when `runActive=false`. This worker-side gate is **load-bearing** — it suppresses emissions during init phases (Phase-4 source eval, where inlined test bodies can synchronously call host bridges with values that may be unclonable, e.g. `Symbol.for(...)`) before they reach `port.postMessage`. `setRunActive()` SHALL also reset the per-run `callId` counter to 0.
2. **Worker-side wire event shape**: the bridge SHALL post to main an `event` message whose payload carries `{kind, name, ts, at, input?, output?, error?, type}` and SHALL NOT carry `seq` or `ref`. The `type` field SHALL be one of: `"leaf"`, `{ open: CallId }`, or `{ close: CallId }`. The bridge SHALL transform the SDK-side `type: "open"` into `{ open: <assignedCallId> }` by minting a per-run-unique CallId from a worker-local counter before posting to main.
3. **Main-side request/response router** for per-run and construction-time host methods that close over main-side state.
4. **Main-side lifecycle management** (spawn, terminate, `onDied` dispatch) and the `RunSequencer` (see "Main-side RunSequencer owns seq and ref stamping").

Host-bridge logging is auto-captured by `bridge-factory.ts` and flows back to the main side inside `RunResult.logs`.

#### Scenario: Worker posts wire events without seq or ref

- **GIVEN** guest code that emits any event during a run
- **WHEN** the worker posts the corresponding `event` message to main
- **THEN** the message payload SHALL NOT contain a `seq` field
- **AND** the message payload SHALL NOT contain a `ref` field
- **AND** the message payload SHALL contain a `type` field whose value is one of `"leaf"`, `{ open: <number> }`, or `{ close: <number> }`

#### Scenario: Main stamps seq and ref before forwarding to sb.onEvent

- **GIVEN** a wire event arriving from the worker on the message handler
- **WHEN** the Sandbox's message handler processes it
- **THEN** `RunSequencer.next` SHALL be called with the wire event
- **AND** the resulting `SandboxEvent` (carrying `seq`, `ref`) SHALL be forwarded to `sb.onEvent` subscribers

#### Scenario: Bridge does not expose framing primitives

- **WHEN** any caller attempts to access `bridge.nextSeq`, `bridge.pushRef`, `bridge.popRef`, `bridge.currentRef`, `bridge.refStackDepth`, `bridge.truncateRefStackTo`, `bridge.resetSeq`, `bridge.setRunActive`, `bridge.clearRunActive`, or `bridge.runActive`
- **THEN** the property SHALL be `undefined`

### Requirement: system.call event kind contract

The `@workflow-engine/core` package SHALL export `"system.call"` as a variant of `EventKind`. A `system.call` InvocationEvent SHALL be a leaf in the invocation call tree — main-side `RunSequencer.next` SHALL NOT push or pop the refStack for a leaf event. The event MAY carry `input` and `output` in the same record. It SHALL NOT have a paired counterpart event.

The event's `ref` field SHALL be the current `refStack.at(-1) ?? null`, computed by the main-side `RunSequencer` (not the worker bridge). The event's `seq` field SHALL be obtained from the main-side sequencer's monotonic counter. The event's `name` field SHALL identify the source (e.g. `"console.log"`, `"setTimeout"`, `"crypto.randomUUID"`, `"performance.mark"`, `"wasi.clock_time_get"`, `"wasi.random_get"`).

`system.call` SHALL be the leaf-shaped variant under the `system.*` family. Consumers that branch on `kind` SHALL treat `"system.call"` as a leaf alongside `"system.exception"`.

#### Scenario: system.call is emitted as a single record

- **GIVEN** a running sandbox
- **WHEN** a fire-and-forget host call (e.g. `console.log`, a WASI clock or random read) fires during an active run
- **THEN** exactly one InvocationEvent with `kind = "system.call"` SHALL be emitted for that call
- **AND** no `system.response` or `system.error` event SHALL be emitted with a matching `ref`

#### Scenario: system.call inherits call-site context via ref

- **GIVEN** a running sandbox whose guest code calls `__hostFetch` and inside the host `fetch` implementation a WASI `clock_time_get` fires
- **WHEN** the events are inspected
- **THEN** the `system.request` event for `host.fetch` SHALL have `seq = S`
- **AND** the `system.call` event for `wasi.clock_time_get` SHALL have `ref = S`
- **AND** the matching `system.response` event for `host.fetch` SHALL also have `ref = S`

### Requirement: `ref = null` marks system-initiated events

The `ref` field on any `InvocationEvent` produced by the sandbox SHALL have one of three meanings, determined uniformly across kinds and assigned by the main-side `RunSequencer.next`:

1. If the event's `kind` ends in `.response` or `.error`, `ref` SHALL be the `seq` of the matching open event, looked up via `callId` in the sequencer's `callMap`.
2. If the event is a leaf (kind ending in neither `.request` nor `.response` nor `.error`), or is an open (kind ending in `.request`) emitted while a frame is on the refStack, `ref` SHALL be the current `refStack.at(-1) ?? null`.
3. If the event is system-initiated (no frame on the refStack at emission), `ref` SHALL be `null`.

Category 3 covers `trigger.request` (runtime delivered the trigger), `system.call` events fired during VM init / WASI libc init / phase boundaries before any guest call is on the stack, and any leaf or open emitted at the bottom of the call tree.

#### Scenario: trigger.request has ref=null

- **GIVEN** a fresh invocation with no frames open
- **WHEN** the trigger plugin emits `trigger.request`
- **THEN** the event's `ref` SHALL be `null`

#### Scenario: Events emitted inside a callback take the open frame as parent

- **GIVEN** a `system.request` event at `seq: 15` has been emitted and pushed onto the refStack
- **WHEN** the matching guest callback emits an `action.request` event
- **THEN** the `action.request` event SHALL have `ref: 15`

### Requirement: Event `at` and `ts` fields sourced from the bridge

Every InvocationEvent emitted by the sandbox during an active run SHALL carry two time fields populated at emission time on the worker side via the bridge:

- `at: string` — `new Date().toISOString()` captured at emission.
- `ts: number` — `bridge.tsUs()` captured at emission (integer µs since the current run's anchor).

These fields SHALL be populated by the worker bridge before the wire event is posted to main. The main-side `RunSequencer.next` SHALL NOT recompute or modify `at` / `ts` — it SHALL only stamp `seq` and `ref`. Synthetic close events emitted by `RunSequencer.finish({closeReason})` on worker death SHALL reuse the most recently observed `at` and `ts` values, since the bridge is no longer reachable to provide fresh ones.

This requirement preserves the stamping-boundary split: the bridge owns wall-clock and monotonic timing (`ts`, `at`); the main-side sequencer owns ordering and parent-pointer attribution (`seq`, `ref`).

#### Scenario: Bridge populates at and ts before posting to main

- **GIVEN** a guest call that triggers any `system.*` or `action.*` or `trigger.*` event
- **WHEN** the wire event leaves the worker
- **THEN** it SHALL carry a non-empty `at` string parseable as ISO 8601
- **AND** it SHALL carry an integer `ts >= 0`
- **AND** the main-side `RunSequencer.next` SHALL forward those values unchanged into the resulting `SandboxEvent`

#### Scenario: Synthetic close on death reuses last seen ts and at

- **GIVEN** a sandbox whose worker has died with one open frame remaining
- **AND** the most recent successfully-stamped event had `ts = T_last` and `at = A_last`
- **WHEN** `sequencer.finish({ closeReason })` synthesises the closing event
- **THEN** the synthetic `SandboxEvent` SHALL carry `ts = T_last` and `at = A_last`
