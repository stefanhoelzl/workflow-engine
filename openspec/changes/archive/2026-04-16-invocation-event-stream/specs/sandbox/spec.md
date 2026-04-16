## MODIFIED Requirements

### Requirement: Public API — Sandbox.run()

`Sandbox.run(name, ctx, options)` SHALL accept a `RunOptions` parameter with `invocationId: string`, `workflow: string`, `workflowSha: string`, and optional `extraMethods: MethodMap`. It SHALL forward these to the worker via the `run` message. It SHALL return `Promise<RunResult>`.

#### Scenario: Named export called with ctx and run options
- **WHEN** `sb.run("handler", payload, { invocationId: "evt_1", workflow: "deploy", workflowSha: "abc123" })` is called
- **THEN** the worker SHALL receive the invocation metadata and use it to stamp all events

#### Scenario: Missing export yields error result
- **WHEN** `sb.run("nonexistent", payload, runOptions)` is called
- **THEN** it SHALL resolve with `{ ok: false, error: { message, stack } }`

#### Scenario: extraMethods extend construction-time methods
- **WHEN** `sb.run("action", ctx, { invocationId: "evt_1", workflow: "w", workflowSha: "s", extraMethods: { extra: async () => "extra" } })` is called
- **THEN** the guest SHALL see both construction-time and extra methods as global functions

#### Scenario: extraMethods shadowing is rejected
- **WHEN** `sb.run("action", ctx, { ..., extraMethods: { emit: async () => {} } })` is called and `emit` collides with a construction-time method
- **THEN** the run SHALL throw a collision error before any message is sent to the worker

### Requirement: RunResult discriminated union

`RunResult` SHALL be `{ ok: true; result: unknown } | { ok: false; error: { message: string; stack: string } }`. It SHALL NOT contain a `logs` or `events` field — event data is delivered via `onEvent`.

#### Scenario: Successful invocation
- **WHEN** the export function returns a value
- **THEN** `run()` SHALL resolve with `{ ok: true, result: <value> }`

#### Scenario: Thrown error
- **WHEN** the export function throws
- **THEN** `run()` SHALL resolve with `{ ok: false, error: { message, stack } }`

### Requirement: Sandbox death notification

The `Sandbox` interface SHALL expose `onDied(cb: (err: Error) => void)` for worker death and `onEvent(cb: (event: InvocationEvent) => void)` for event streaming.

`onDied` behavior is unchanged from the base spec.

`onEvent` SHALL register a callback invoked on the main thread for each event the worker emits during execution. Events SHALL arrive in monotonically increasing `seq` order. If no `onEvent` callback is registered, events SHALL be silently discarded.

#### Scenario: Unexpected worker death fires onDied
- **WHEN** the worker process exits unexpectedly
- **THEN** the `onDied` callback SHALL be invoked

#### Scenario: Events stream via onEvent during execution
- **WHEN** a sandbox run executes bridge calls
- **THEN** the `onEvent` callback SHALL be called for each event as it is emitted by the worker, before `run()` resolves

#### Scenario: Events arrive in seq order
- **WHEN** multiple events are emitted during a run
- **THEN** the `onEvent` callback SHALL receive them in monotonically increasing `seq` order

#### Scenario: No callback registered
- **WHEN** events are emitted but no `onEvent` callback has been registered
- **THEN** the events SHALL be silently discarded without error

### Requirement: Worker-thread isolation

The sandbox SHALL execute guest code inside a dedicated Node `worker_threads` Worker. Each `sandbox()` call SHALL spawn exactly one worker.

The worker-main message protocol SHALL define these types:

- `init` (main → worker): carries `source`, construction-time `methodNames`, and `filename`.
- `ready` (worker → main): carries no payload.
- `run` (main → worker): carries `exportName`, `ctx`, per-run `extraNames`, `invocationId`, `workflow`, `workflowSha`.
- `request` (worker → main): carries `requestId`, `method`, `args` for a host method invocation.
- `response` (main → worker): carries `requestId`, `ok`, and either `result` or `error`.
- `event` (worker → main): carries a fully stamped `InvocationEvent`.
- `done` (worker → main): carries `{ ok: true; result: unknown } | { ok: false; error: { message; stack } }`.

#### Scenario: Dedicated worker per sandbox
- **WHEN** two sandbox instances are constructed from the same source
- **THEN** two distinct `worker_threads` Workers SHALL be spawned

#### Scenario: init/ready handshake
- **WHEN** `sandbox(source, methods)` is called
- **THEN** the main side SHALL send an `init` message and wait for `ready`

#### Scenario: Event message forwarded to onEvent
- **WHEN** the worker posts a `{ type: "event" }` message
- **THEN** the main thread SHALL forward the event to the registered `onEvent` callback

### Requirement: Host bridge runs in the worker

The bridge SHALL emit paired `system.request`/`system.response` (or `system.error`) events instead of collecting `LogEntry` arrays. Events SHALL be posted to the main thread as `{ type: "event", event }` messages.

The bridge SHALL maintain per-run state:
- `seq: number` — monotonic counter, reset per run
- `refStack: number[]` — stack of active request seqs for computing `ref`
- `invocationId`, `workflow`, `workflowSha` — set from `RunOptions` at run start

`bridge.sync()` SHALL emit `system.request` before calling the impl and `system.response`/`system.error` after. `bridge.async()` SHALL emit `system.request` synchronously when the guest calls the function and `system.response`/`system.error` when the promise resolves/rejects.

#### Scenario: Sync bridge call emits paired events
- **WHEN** a sync bridge method (e.g., `console.log`) is called
- **THEN** a `system.request` event SHALL be emitted before the impl runs, and a `system.response` or `system.error` event SHALL be emitted after

#### Scenario: Async bridge call emits paired events
- **WHEN** an async bridge method (e.g., `host.fetch`) is called
- **THEN** a `system.request` event SHALL be emitted synchronously when the guest calls the function, and `system.response`/`system.error` SHALL be emitted when the promise resolves or rejects

#### Scenario: Bridge-factory emits paired events for fetch and crypto
- **WHEN** `__hostFetch` or `crypto.subtle.digest` is called
- **THEN** paired `system.request`/`system.response` events SHALL be emitted with method names `host.fetch` and `crypto.subtle.digest` respectively

### Requirement: Trigger events emitted by worker

The worker SHALL emit `trigger.request` before calling the export function and `trigger.response` or `trigger.error` after the export resolves or rejects. These are the first and last events in any invocation.

#### Scenario: Successful trigger emits request and response
- **WHEN** a trigger handler runs successfully
- **THEN** the first event SHALL be `trigger.request` with the trigger name and input, and the last event SHALL be `trigger.response` with the handler's return value as `output`

#### Scenario: Failed trigger emits request and error
- **WHEN** a trigger handler throws
- **THEN** the first event SHALL be `trigger.request` and the last event SHALL be `trigger.error` with the serialized error

## ADDED Requirements

### Requirement: ref field semantics

For `*.request` events, `ref` SHALL be the `seq` of the calling request (`null` for `trigger.request`). For `*.response` and `*.error` events, `ref` SHALL be the `seq` of the matching `*.request` event.

#### Scenario: trigger.request has null ref
- **WHEN** a `trigger.request` event is emitted (the first event in an invocation)
- **THEN** its `ref` field SHALL be `null`

#### Scenario: Nested action.request refs its caller
- **WHEN** action A (seq=1) calls action B
- **THEN** action B's `action.request` event SHALL have `ref = 1`

#### Scenario: Response refs its matching request
- **WHEN** a `system.request` event has `seq = 4`
- **THEN** its matching `system.response` event SHALL have `ref = 4`

### Requirement: refStack computation

The bridge SHALL maintain a `refStack` (array of seq numbers) to compute `ref` values. On `*.request`: `ref = refStack.at(-1) ?? null`, then push the new seq. On `*.response` / `*.error`: `ref = refStack.pop()`.

#### Scenario: refStack produces correct nesting
- **WHEN** a trigger handler (seq=0) calls an action (seq=1) that calls fetch (seq=2)
- **THEN** the events SHALL have refs: trigger.request ref=null, action.request ref=0, system.request ref=1, system.response ref=2, action.response ref=1, trigger.response ref=0

### Requirement: Bridge method naming convention

Bridge methods SHALL use human-readable prefixed names in the event `name` field: `host.validateAction` (for `__hostCallAction`), `host.fetch` (for `__hostFetch`/`xhr.send`), `console.*` (for console methods), `crypto.*` (for Web Crypto), `performance.now`, `timers.*` (for setTimeout/setInterval/clearTimeout/clearInterval).

#### Scenario: Fetch appears as host.fetch
- **WHEN** the sandbox calls `__hostFetch`
- **THEN** the resulting `system.request`/`system.response` events SHALL have `name: "host.fetch"`

#### Scenario: Action validation appears as host.validateAction
- **WHEN** the sandbox calls `__hostCallAction`
- **THEN** the resulting `system.request`/`system.response` events SHALL have `name: "host.validateAction"`

### Requirement: __emitEvent bridge global

The worker SHALL install `__emitEvent` as a `vm.newFunction` directly on `globalThis` (NOT through `bridge.sync()` or `bridge.async()`). It SHALL accept a JSON payload with `kind`, `name`, and either `input`, `output`, or `error`. It SHALL only accept `action.*` kinds — `trigger.*` and `system.*` kinds SHALL be rejected. It SHALL stamp `id`, `seq`, `ref`, `ts`, `workflow`, and `workflowSha` from the current run context, manage the `refStack`, and post the event to the main thread.

#### Scenario: __emitEvent does not appear in event stream
- **WHEN** `__emitEvent` is called from sandbox code
- **THEN** no `system.request`/`system.response` events SHALL be generated for the `__emitEvent` call itself

#### Scenario: Only action kinds accepted
- **WHEN** `__emitEvent` is called with `kind: "system.request"`
- **THEN** it SHALL throw an error rejecting the non-action kind

#### Scenario: refStack updated correctly
- **WHEN** `__emitEvent` is called with `kind: "action.request"`
- **THEN** the current seq SHALL be pushed to the refStack, and subsequent events SHALL have `ref` pointing to it

## REMOVED Requirements

### Requirement: LogEntry structure
**Reason**: Replaced by paired `InvocationEvent` records. The single-entry `LogEntry` (method, args, status, result, error, ts, durationMs) is superseded by request/response event pairs where duration is computed from timestamp differences.
**Migration**: Consumers that read `RunResult.logs` now subscribe via `sb.onEvent()`. Each former `LogEntry` becomes two events (request + response/error).
