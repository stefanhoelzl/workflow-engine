# Sandbox Specification

## Purpose

Execute workflow action code inside an isolated QuickJS WASM context with a minimal, auditable host-bridge surface. This capability is the single strongest isolation boundary in the system (see `/SECURITY.md §2`).
## Requirements
### Requirement: Sandbox package

The system SHALL provide a workspace package `@workflow-engine/sandbox` at `packages/sandbox`. The package SHALL ship TypeScript source directly (no build step), mirroring the conventions of `@workflow-engine/sdk` and `@workflow-engine/vite-plugin`. The package SHALL depend on `quickjs-wasi`; these dependencies SHALL NOT be direct dependencies of `@workflow-engine/runtime`.

#### Scenario: Package exists as a workspace member

- **GIVEN** the monorepo at `packages/`
- **WHEN** a developer runs `pnpm install`
- **THEN** `packages/sandbox` SHALL be discovered as a workspace package
- **AND** its `package.json` SHALL declare `name: "@workflow-engine/sandbox"`

#### Scenario: Runtime imports from the sandbox package

- **GIVEN** `packages/runtime` as a consumer
- **WHEN** inspecting `packages/runtime/package.json`
- **THEN** it SHALL declare `"@workflow-engine/sandbox": "workspace:*"` as a dependency
- **AND** runtime source files SHALL import via `@workflow-engine/sandbox`, not via relative paths into another package

### Requirement: Public API — sandbox() factory

The sandbox package SHALL export a `sandbox(opts)` async factory that returns a `Sandbox` instance whose guest execution runs inside a dedicated `worker_threads` worker.

```ts
function sandbox(opts: {
  source: string;
  plugins: Plugin[];
  filename?: string;
  memoryLimit?: number;
  interruptHandler?: () => boolean;
}): Promise<Sandbox>
```

The factory SHALL:

1. Spawn a fresh `worker_threads` Worker using the package-bundled entrypoint.
2. Serialize each plugin into a descriptor `{ name, source, config?, dependsOn? }` where `source` is a pre-bundled ESM source string (loaded inside the worker via `data:text/javascript;base64,<...>` import) produced by the `sandboxPlugins()` vite transform at build time, and `config` is JSON-serializable data.
3. Send the worker an `init` message carrying `source`, `pluginDescriptors`, `filename`, `memoryLimit`, and `interruptHandler` (if any).
4. Inside the worker: topo-sort plugins by `dependsOn`, instantiate QuickJS WASM with WASI imports routed to mutable hook slots, invoke each plugin's `worker(ctx, deps, config)` in topo order to collect `PluginSetup`s, install `guestFunctions` as `vm.newFunction` bindings, populate `wasiHooks` slots, then run boot phases 2 (plugin sources), 3 (delete private descriptor globals), 4 (user source).
5. Wait for the worker to reply with `ready` confirming all phases completed.
6. Return a `Sandbox` object whose `run()`, `dispose()`, and `onEvent()` calls are routed to the worker.

The factory SHALL NOT accept `methods`, `onEvent`, `logger`, or `fetch` top-level options. All of these are plugin-level concerns.

The returned promise SHALL NOT resolve until the worker has reported `ready`. Any failure in phases 0-4 SHALL cause the worker to post `init-error`, dispose the VM, and `process.exit(0)`; the promise SHALL reject with the serialized error.

#### Scenario: Factory signature

- **GIVEN** a valid source string and a plugin list
- **WHEN** `sandbox({ source, plugins: [createWebPlatformPlugin(), createFetchPlugin(), ...] })` is called
- **THEN** the returned promise SHALL resolve with a `Sandbox` exposing `run`, `dispose`, and `onEvent`

#### Scenario: Construction rejects on plugin collision

- **GIVEN** two plugins in the composition both declaring `name: "timers"`
- **WHEN** `sandbox(...)` is called
- **THEN** the returned promise SHALL reject before any worker init completes
- **AND** the error SHALL identify the colliding plugin name

#### Scenario: Construction rejects on unsatisfied dependsOn

- **GIVEN** a plugin with `dependsOn: ["nonexistent"]` in the composition
- **WHEN** `sandbox(...)` is called
- **THEN** the returned promise SHALL reject
- **AND** the error SHALL identify the missing dependency

#### Scenario: Non-serializable plugin config rejected

- **GIVEN** a plugin descriptor whose `config` contains a function or class instance
- **WHEN** `sandbox(...)` is called
- **THEN** the returned promise SHALL reject with a serialization error identifying the offending config path

### Requirement: Public API — Sandbox.run()

The `Sandbox.run(exportName, input)` method SHALL execute a guest export inside the VM and return a promise resolving to a `RunResult`: `{ ok: true, output: unknown } | { ok: false, error: SerializedError }`. The run primitive SHALL NOT accept or interpret runtime-engine metadata (tenant, workflow, workflowSha, invocationId). Metadata stamping is the caller's responsibility via `sb.onEvent` interception.

The run primitive SHALL execute:
1. Invoke each plugin's `onBeforeRunStarted({ name: exportName, input })` in topo order. Preserve refStack state if the plugin returns truthy; truncate the plugin's pushes if falsy/void.
2. `await vm.callFunction(exportHandle, undefined, input)`.
3. Build the `RunResult`.
4. Invoke each plugin's `onRunFinished(result, runInput)` in reverse topo order. Events emitted here SHALL stamp with the refStack state from step 1.
5. Truncate refStack back to pre-run depth.
6. Return the `RunResult`.

Events emitted during the run SHALL flow to the main thread via `{type: "event", event}` worker messages. The event SHALL carry `id, seq, ref, ts, at, kind, name, input?, output?, error?` but SHALL NOT carry tenant/workflow/workflowSha/invocationId (the caller adds these in `onEvent`).

#### Scenario: Run stamping excludes runtime metadata

- **GIVEN** any event emitted during a run
- **WHEN** the main thread receives the `{type: "event"}` message
- **THEN** the event SHALL have `id, seq, ref, ts, at, kind, name, input?, output?, error?` fields
- **AND** the event SHALL NOT have `tenant`, `workflow`, `workflowSha`, or `invocationId` fields

### Requirement: RunResult discriminated union

The `run()` method SHALL return `Promise<RunResult>` where:

```ts
type RunResult =
  | { ok: true;  result: unknown;                       logs: LogEntry[] }
  | { ok: false; error: { message: string; stack: string }; logs: LogEntry[] }
```

The method SHALL NOT throw for errors raised inside the sandbox; errors SHALL be returned as values. The method MAY throw for host-side programming errors (e.g., sandbox already disposed).

The `logs` array SHALL contain all bridge and console log entries pushed during this run, in chronological order. The `result` field on success SHALL be the JSON-serialized return value of the invoked export (`undefined` serializes to absent).

#### Scenario: Successful invocation

- **GIVEN** a sandbox whose export resolves to `{ status: "ok" }`
- **WHEN** `sb.run("action", ctx)` resolves
- **THEN** the result SHALL be `{ ok: true, result: { status: "ok" }, logs: [...] }`

#### Scenario: Thrown error

- **GIVEN** a sandbox whose export throws `new Error("boom")`
- **WHEN** `sb.run("action", ctx)` resolves
- **THEN** the result SHALL be `{ ok: false, error: { message: "boom", stack: "..." }, logs: [...] }`

#### Scenario: Rejected promise

- **GIVEN** a sandbox whose export returns a promise that rejects with `new Error("fail")`
- **WHEN** `sb.run("action", ctx)` resolves
- **THEN** the result SHALL be `{ ok: false, error: { message: "fail", stack: "..." }, logs: [...] }`

### Requirement: LogEntry structure

The sandbox SHALL define `LogEntry`:

```ts
interface LogEntry {
  method: string
  args: unknown[]
  status: "ok" | "failed"
  result?: unknown
  error?: string
  ts: number
  durationMs?: number
}
```

Every host-bridged method call (construction-time method, `__hostFetch`, crypto operation) SHALL push an entry before returning. Console calls (`console.log`, `.info`, `.warn`, `.error`, `.debug`) SHALL push entries with `method: "console.<level>"`. The log buffer SHALL be cleared at the start of each `run()` call and SHALL NOT persist across runs.

#### Scenario: Log buffer is per-run

- **GIVEN** a sandbox where `sb.run("a", ...)` produced 3 log entries
- **WHEN** `sb.run("b", ...)` is called
- **THEN** the `b` run's `RunResult.logs` SHALL NOT contain any entries from the `a` run

#### Scenario: Failed bridge logs a failed entry

- **GIVEN** a host method that throws
- **WHEN** the sandbox invokes it
- **THEN** a `LogEntry` with `status: "failed"` and a populated `error` SHALL be pushed

### Requirement: JSON-only host/sandbox boundary

All arguments and return values crossing the host/sandbox boundary via consumer-provided `methods` SHALL be JSON-serializable. The sandbox SHALL serialize host values to JSON when passing into the VM and SHALL deserialize VM values into host-native JSON values when returning.

The sandbox SHALL NOT expose host object references, closures, proxies, or any host-identity-carrying value to consumer methods.

#### Scenario: Consumer methods receive JSON args

- **GIVEN** a consumer method `f: async (x) => ...`
- **AND** guest code calls `f({ a: 1, b: [2, 3] })`
- **THEN** `f` SHALL receive `{ a: 1, b: [2, 3] }` as a plain JSON value (not a QuickJSHandle)

#### Scenario: Consumer methods return JSON results

- **GIVEN** a consumer method that returns `{ status: 200 }`
- **WHEN** guest code calls it
- **THEN** guest code SHALL observe the return value as a plain object with a numeric `status` field

### Requirement: Isolation — no Node.js surface

The sandbox SHALL install no Node.js-specific globals. Node core modules (fs, net, http, process, etc.) SHALL NOT be reachable from guest code. All guest-visible globals SHALL come from: (a) web-platform polyfills installed by the web-platform plugin, (b) WASM-native WHATWG APIs (URL, TextEncoder, TextDecoder, crypto, atob, btoa, structuredClone), (c) public-descriptor guest functions registered by plugins (fetch, setTimeout, console.*, reportError). The sandbox core SHALL install nothing directly on `globalThis`.

#### Scenario: Node core modules absent

- **GIVEN** any composition of plugins (including full runtime stack)
- **WHEN** user source evaluates `typeof require, typeof process, typeof Buffer`
- **THEN** all three SHALL be `"undefined"`
- **AND** `import("fs")` or dynamic import of any Node module SHALL fail

### Requirement: Source evaluated as IIFE script

The sandbox SHALL evaluate `source` as a script (not an ES module) using `vm.evalCode(source, filename)`. The source SHALL be an IIFE bundle produced by the vite-plugin with `format: "iife"`. Named exports SHALL be accessible from the IIFE's global namespace object via `vm.getProp(vm.global, IIFE_NAMESPACE)`, where `IIFE_NAMESPACE` is the shared constant exported from `@workflow-engine/core`. The sandbox SHALL NOT accept the namespace as a parameter, option, or worker-message field — it is a compile-time constant imported directly by the sandbox implementation.

When a `run(name, ctx)` call names an export that is not present on the IIFE namespace object, the sandbox SHALL resolve with a `RunResult` of shape `{ ok: false, error: { message, stack }, logs }` whose `message` identifies the missing export by its requested name and does NOT include the namespace identifier. Example: `export 'handler' not found in workflow bundle`.

#### Scenario: Named export handler

- **GIVEN** a source bundled as an IIFE that exposes `handler` on its namespace object
- **WHEN** `sb.run("handler", ctx)` is called
- **THEN** the `handler` function SHALL be extracted from the namespace and called

#### Scenario: Bundled IIFE with dependencies

- **GIVEN** a workflow bundle that includes npm packages resolved by vite-plugin, output as IIFE
- **WHEN** the sandbox evaluates the bundled script
- **THEN** evaluation SHALL succeed and named exports SHALL be callable

#### Scenario: Missing export error message omits namespace identifier

- **GIVEN** a sandbox whose bundle does not export `"missing"`
- **WHEN** `sb.run("missing", {})` is called
- **THEN** the returned `RunResult.error.message` SHALL name `"missing"` as the requested export
- **AND** the message SHALL NOT include the literal namespace identifier (e.g. no `__wfe_exports__`, no `__wf_*`, no `__workflowExports`)

### Requirement: Workflow-scoped VM lifecycle

The sandbox SHALL hold a single QuickJS VM instance inside its worker for its lifetime. The VM SHALL NOT be disposed between `run()` calls. Module-level state and installed globals SHALL persist across `run()`s within the same sandbox instance.

The sandbox SHALL expose `dispose()` which terminates the worker. Termination SHALL reject any pending `run()` promise with a disposal error. After `dispose()`, subsequent `run()` calls SHALL throw. Pending in-flight bridge RPC calls from the worker at termination time SHALL be abandoned on the worker side; any side effect they triggered on the main side (e.g., an `emit` that already derived a child event) remains committed.

The sandbox SHALL expose `onDied(cb)` which registers a single callback to be invoked when the underlying worker terminates unexpectedly (WASM-level trap, uncaught worker-JS error, abnormal exit). `onDied` SHALL NOT fire as a result of a normal `dispose()` call. At most one callback SHALL be invoked per sandbox instance — subsequent registrations after death SHALL fire the callback synchronously with the recorded death error.

Consumers of the sandbox are responsible for lifecycle: a new sandbox SHALL be constructed per workflow module load, and the sandbox SHALL be disposed on workflow reload/unload. `SandboxFactory` is the supported orchestrator for this; see the `sandbox-factory` capability.

#### Scenario: State persists across runs within a workflow

- **GIVEN** a sandbox whose source has `let count = 0; export function tick(ctx) { return ++count; }`
- **WHEN** `sb.run("tick", {})` is called three times
- **THEN** the three `result` values SHALL be 1, 2, 3

#### Scenario: Dispose releases QuickJS resources

- **GIVEN** a sandbox instance
- **WHEN** `sb.dispose()` is called
- **THEN** the underlying worker SHALL be terminated
- **AND** subsequent `sb.run(...)` calls SHALL throw
- **AND** `onDied` SHALL NOT fire as a result of this dispose

#### Scenario: Cross-sandbox isolation preserved

- **GIVEN** two sandbox instances constructed from different sources
- **WHEN** both execute concurrently
- **THEN** module-level state in one sandbox SHALL NOT be observable from the other
- **AND** the two workers SHALL be distinct `worker_threads` Workers

#### Scenario: Unexpected worker death fires onDied

- **GIVEN** a sandbox with an `onDied` callback registered
- **WHEN** the worker terminates due to a WASM-level trap or uncaught worker-JS error
- **THEN** the registered callback SHALL be invoked with an `Error` describing the failure
- **AND** any pending `run()` promise SHALL reject with that error

#### Scenario: Pending run rejects on dispose

- **GIVEN** a sandbox with an in-flight `run()` promise
- **WHEN** `sb.dispose()` is called before the worker posts `done`
- **THEN** the pending `run()` promise SHALL reject with a disposal error

### Requirement: Safe globals — console

Console (log, info, warn, error, debug) SHALL be installed by the `createConsolePlugin()` from `@workflow-engine/sandbox-stdlib`. Each method SHALL emit a `console.<method>` leaf event with `input: [args...]`. The `console` object SHALL be installed as a writable, configurable global per WebIDL.

#### Scenario: console.log emits a leaf

- **GIVEN** guest code calls `console.log("hello", { x: 1 })`
- **WHEN** the call returns
- **THEN** a leaf event with kind `console.log` and `input: ["hello", { x: 1 }]` SHALL be emitted

### Requirement: Safe globals — timers

Timers (setTimeout, setInterval, clearTimeout, clearInterval) SHALL be installed by the `createTimersPlugin()` from `@workflow-engine/sandbox-stdlib`. Each SHALL be a public guest function descriptor (writable, configurable per WebIDL). `setTimeout` and `setInterval` SHALL emit a `timer.set` leaf event at scheduling time. `clearTimeout` and `clearInterval` SHALL emit a `timer.clear` leaf event. When a scheduled timer fires host-side, the plugin SHALL wrap the captured callable invocation in `ctx.request("timer", name, { input: { timerId } }, () => callable())`, producing `timer.request`/`timer.response`/`timer.error` around the callback. Unfired timers still live at run end SHALL be cleared by the plugin's `onRunFinished` hook via the same code path as guest-initiated `clearTimeout`, emitting a `timer.clear` event for each.

#### Scenario: setTimeout emits timer.set and wraps callback with timer.request/response

- **GIVEN** guest code calls `setTimeout(cb, 100)` and the timer fires
- **WHEN** observing the event stream
- **THEN** `timer.set` SHALL be emitted at scheduling time (leaf, with `{ delay, timerId }`)
- **AND** `timer.request` SHALL be emitted when the timer fires (createsFrame, with `{ timerId }`)
- **AND** the captured callable SHALL run
- **AND** `timer.response` SHALL be emitted with `closesFrame: true` after callable returns

#### Scenario: Unfired timer cleared at run end

- **GIVEN** `setTimeout(cb, 30000)` scheduled during a run that completes in 1s
- **WHEN** the run ends
- **THEN** the plugin's `onRunFinished` SHALL clear the host timer and emit `timer.clear`
- **AND** the timer's callable SHALL be disposed
- **AND** no callback SHALL fire during subsequent runs against the same sandbox

### Requirement: Safe globals — performance.now

The sandbox SHALL expose `performance.now()` via the QuickJS performance intrinsic, which reads time through the WASI `clock_time_get` syscall with `clockId = CLOCK_MONOTONIC`. The worker's `CLOCK_MONOTONIC` override SHALL return `(performance.now() × 1_000_000 ns) − anchorNs` where `anchorNs` is the sandbox's monotonic anchor, which is re-set at every `bridge.setRunContext`. Guest `performance.now()` SHALL therefore start near zero at the beginning of each run and increase monotonically within that run.

#### Scenario: performance.now returns monotonically increasing values within a run

- **GIVEN** a sandbox in an active run
- **WHEN** guest code calls `performance.now()` twice in sequence
- **THEN** the second value SHALL be greater than or equal to the first value

#### Scenario: performance.now starts near zero at the start of each run

- **GIVEN** a cached sandbox that has completed a prior run
- **WHEN** a new run begins and guest code calls `performance.now()` as the first monotonic read of that run
- **THEN** the returned value SHALL be within a small epsilon of `0`

### Requirement: Safe globals — self

The sandbox SHALL expose `globalThis.self` as a reference to `globalThis` itself. The identity `self === globalThis` is preserved by reference assignment. `globalThis` additionally inherits `EventTarget.prototype` (see `Safe globals — EventTarget`), making `self instanceof EventTarget === true` and giving `self.addEventListener`/`self.removeEventListener`/`self.dispatchEvent` functional access via non-enumerable own-properties. This global is required by the WinterCG Minimum Common API for feature-detection compatibility with npm libraries.

#### Scenario: self reflects globalThis

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `self === globalThis`
- **THEN** the result SHALL be `true`

#### Scenario: self is an EventTarget

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `self instanceof EventTarget`
- **THEN** the result SHALL be `true`

#### Scenario: EventTarget methods on self are non-enumerable own-properties

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `Object.keys(globalThis)`
- **THEN** the result SHALL NOT include `addEventListener`, `removeEventListener`, or `dispatchEvent`
- **AND** `Object.getOwnPropertyNames(globalThis)` SHALL include all three

#### Scenario: self.addEventListener receives dispatched events

- **GIVEN** a listener registered via `self.addEventListener("x", cb)`
- **WHEN** guest code calls `self.dispatchEvent(new Event("x"))`
- **THEN** `cb` SHALL be invoked exactly once

### Requirement: Safe globals — navigator

The sandbox SHALL expose `globalThis.navigator` as a frozen object containing a single string property `userAgent` whose value SHALL be `` `WorkflowEngine/${VERSION}` `` where `VERSION` is the `@workflow-engine/sandbox` package version. The object SHALL carry no methods, no other properties, and SHALL be non-extensible.

#### Scenario: navigator.userAgent is a version-stamped string

- **GIVEN** a sandbox constructed from `@workflow-engine/sandbox` version X
- **WHEN** guest code reads `navigator.userAgent`
- **THEN** the value SHALL be the string `` `WorkflowEngine/${X}` ``

#### Scenario: navigator is frozen

- **GIVEN** a sandbox
- **WHEN** guest code attempts `navigator.foo = "x"` or `Object.defineProperty(navigator, "foo", …)`
- **THEN** the assignment SHALL fail (silently in non-strict or with TypeError in strict)

### Requirement: Safe globals — reportError

`reportError` SHALL be installed by the `createWebPlatformPlugin()` from `@workflow-engine/sandbox-stdlib`. The polyfill SHALL dispatch a cancelable `ErrorEvent` on `globalThis`; if not default-prevented, it SHALL forward a serialized payload to the plugin's captured private `__reportErrorHost` reference. The `__reportErrorHost` descriptor SHALL emit an `uncaught-error` leaf event. The raw `__reportErrorHost` SHALL NOT be visible to user source (auto-deleted after phase 2).

#### Scenario: Uncaught exception in microtask routes through reportError

- **GIVEN** guest code calls `queueMicrotask(() => { throw new Error("boom") })`
- **WHEN** the microtask fires
- **THEN** `reportError` SHALL be invoked with the thrown error
- **AND** an `uncaught-error` leaf event SHALL be emitted unless a listener called `preventDefault()` on the dispatched ErrorEvent

### Requirement: Safe globals — EventTarget

The sandbox SHALL expose `globalThis.EventTarget` as a WHATWG EventTarget implementation, provided by the `event-target-shim` npm package (v6.x) compiled into the sandbox polyfill IIFE. No host-bridge method is used; all listener state lives in the QuickJS heap. This global is required by the WinterCG Minimum Common API.

#### Scenario: new EventTarget() is constructible

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `new EventTarget() instanceof EventTarget`
- **THEN** the result SHALL be `true`

#### Scenario: addEventListener delivers dispatched events

- **GIVEN** a fresh `EventTarget` with a listener registered via `et.addEventListener("x", cb)`
- **WHEN** guest code calls `et.dispatchEvent(new Event("x"))`
- **THEN** `cb` SHALL be invoked with an `Event` whose `type === "x"` and whose `target === et` and `currentTarget === et`

#### Scenario: once option auto-removes the listener after first dispatch

- **GIVEN** a listener registered via `et.addEventListener("x", cb, { once: true })`
- **WHEN** `et.dispatchEvent(new Event("x"))` is called twice
- **THEN** `cb` SHALL be invoked exactly once

#### Scenario: signal option auto-removes the listener on signal abort

- **GIVEN** a listener registered via `et.addEventListener("x", cb, { signal })`
- **WHEN** `signal` aborts and then `et.dispatchEvent(new Event("x"))` is called
- **THEN** `cb` SHALL NOT be invoked

#### Scenario: dispatchEvent re-entrancy uses a listener snapshot

- **GIVEN** a listener that calls `et.addEventListener("x", otherCb)` for a new listener during dispatch
- **WHEN** the current dispatch completes
- **THEN** `otherCb` SHALL NOT be invoked for the current dispatch (it becomes eligible for the next dispatch)

### Requirement: Safe globals — Event

The sandbox SHALL expose `globalThis.Event` as a constructible class from the same `event-target-shim` source. All guest-constructed Events SHALL have `isTrusted === false`.

#### Scenario: Event constructor accepts type and init dictionary

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `new Event("x", { cancelable: true, bubbles: true })`
- **THEN** the result SHALL have `type === "x"`, `cancelable === true`, `bubbles === true`, `isTrusted === false`, `defaultPrevented === false`

#### Scenario: preventDefault honors cancelable flag

- **GIVEN** a cancelable Event being dispatched
- **WHEN** a listener calls `event.preventDefault()`
- **THEN** `dispatchEvent` SHALL return `false` and `event.defaultPrevented` SHALL be `true`

#### Scenario: preventDefault on non-cancelable Event has no effect

- **GIVEN** a non-cancelable Event
- **WHEN** a listener calls `event.preventDefault()`
- **THEN** `event.defaultPrevented` SHALL remain `false`

#### Scenario: stopImmediatePropagation prevents subsequent listeners

- **GIVEN** two listeners for the same event type
- **WHEN** the first listener calls `event.stopImmediatePropagation()`
- **THEN** the second listener SHALL NOT be invoked

### Requirement: Safe globals — ErrorEvent

The sandbox SHALL expose `globalThis.ErrorEvent` as a constructible class extending `Event`, with readonly `message`, `filename`, `lineno`, `colno`, and `error` properties initialised from the constructor init dictionary. ErrorEvent is dispatched by the evolved `reportError` shim and by the `queueMicrotask` wrap.

#### Scenario: ErrorEvent carries error and message

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `new ErrorEvent("error", { error: new Error("boom"), message: "boom" })`
- **THEN** the result SHALL have `type === "error"`, `error.message === "boom"`, `message === "boom"`, and `isTrusted === false`

### Requirement: Safe globals — AbortController

The sandbox SHALL expose `globalThis.AbortController` as a hand-written pure-JS class whose `signal` property is a fresh `AbortSignal` instance. `abort(reason?)` SHALL set `signal.aborted === true`, record the reason (defaulting to `new DOMException("signal is aborted without reason", "AbortError")` when none given), and dispatch an `abort` Event on the signal. Subsequent `abort()` calls SHALL be no-ops.

#### Scenario: new AbortController().signal is an AbortSignal instance

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `new AbortController().signal`
- **THEN** the result SHALL be an `AbortSignal` instance whose `aborted === false`

#### Scenario: abort(reason) sets aborted and reason, dispatches abort event

- **GIVEN** an `AbortController` with a listener on `controller.signal`
- **WHEN** guest code calls `controller.abort(new Error("test"))`
- **THEN** `controller.signal.aborted` SHALL be `true`, `controller.signal.reason.message === "test"`, and the listener SHALL have been invoked exactly once

#### Scenario: abort without reason uses DOMException AbortError

- **GIVEN** a fresh `AbortController`
- **WHEN** guest code calls `controller.abort()`
- **THEN** `controller.signal.reason` SHALL be a `DOMException` with `name === "AbortError"`

#### Scenario: abort is idempotent

- **GIVEN** an `AbortController` that has already been aborted
- **WHEN** guest code calls `controller.abort(anotherReason)`
- **THEN** `controller.signal.reason` SHALL remain the original reason and no additional `abort` Event SHALL fire

### Requirement: Safe globals — AbortSignal

The sandbox SHALL expose `globalThis.AbortSignal` as a hand-written class extending `EventTarget`. Instances SHALL expose `aborted`, `reason`, and `throwIfAborted()`. The class SHALL provide three static factories: `AbortSignal.abort(reason?)`, `AbortSignal.timeout(ms)`, and `AbortSignal.any(signals)`. Direct instantiation via `new AbortSignal()` is permitted but only useful for subclassing — `AbortController` is the normal construction path. `AbortSignal.timeout` uses the allowlisted `setTimeout` bridge; no new host surface is introduced.

#### Scenario: throwIfAborted throws the stored reason

- **GIVEN** an aborted signal with `reason === someError`
- **WHEN** guest code calls `signal.throwIfAborted()`
- **THEN** the call SHALL throw exactly `someError`

#### Scenario: AbortSignal.abort(reason) returns a pre-aborted signal

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `AbortSignal.abort(new Error("x"))`
- **THEN** the result SHALL have `aborted === true` and `reason.message === "x"`

#### Scenario: AbortSignal.timeout(ms) aborts after the delay with TimeoutError

- **GIVEN** `const s = AbortSignal.timeout(50)`
- **WHEN** 50ms elapse
- **THEN** `s.aborted` SHALL be `true` and `s.reason` SHALL be a `DOMException` with `name === "TimeoutError"`

#### Scenario: AbortSignal.any composes; aborts when any input aborts

- **GIVEN** three signals `a`, `b`, `c` and `const composite = AbortSignal.any([a, b, c])`
- **WHEN** `b` aborts with reason `R`
- **THEN** `composite.aborted === true` and `composite.reason === R`

#### Scenario: AbortSignal.any returns a pre-aborted signal when any input is already aborted

- **GIVEN** signal `a` that is already aborted with reason `R`
- **WHEN** guest code evaluates `AbortSignal.any([a, b])`
- **THEN** the returned signal SHALL already have `aborted === true` and `reason === R`

### Requirement: Safe globals — DOMException

The sandbox SHALL expose `globalThis.DOMException` as provided natively by the `quickjs-wasi` WASM extension (no polyfill). DOMException SHALL construct with `(message, name)` and provide `name` and `message` properties; instances SHALL satisfy `instanceof Error` and `instanceof DOMException`. DOMException is consumed by `AbortController`/`AbortSignal` for default abort and timeout reasons.

#### Scenario: DOMException is a constructible function

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `typeof DOMException`
- **THEN** the result SHALL be `"function"`

#### Scenario: DOMException instances carry name and message

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `const e = new DOMException("oops", "AbortError")`
- **THEN** `e.name === "AbortError"`, `e.message === "oops"`, `e instanceof Error === true`, `e instanceof DOMException === true`

### Requirement: Guest-side microtask exception routing

The sandbox SHALL wrap `globalThis.queueMicrotask` so that an exception thrown by the queued callback is caught and forwarded to `globalThis.reportError(err)`. This routes microtask errors through the same `ErrorEvent`/`__reportError` pipeline as any other reported error.

#### Scenario: exception in microtask dispatches ErrorEvent to global listener

- **GIVEN** a listener registered via `self.addEventListener("error", handler)`
- **WHEN** guest code calls `queueMicrotask(() => { throw new Error("boom"); })` and the microtask drains
- **THEN** `handler` SHALL be invoked with an `ErrorEvent` whose `error.message === "boom"`

#### Scenario: reportError is a no-op when no host bridge was provided

- **GIVEN** a sandbox constructed without a `__reportError` entry in `methods`
- **WHEN** guest code calls `reportError(new Error("oops"))`
- **THEN** the call SHALL complete without throwing
- **AND** no host-side capture SHALL occur

### Requirement: WebCrypto surface

The sandbox SHALL expose the W3C WebCrypto API: `crypto.randomUUID`, `crypto.getRandomValues`, and the `crypto.subtle` surface (`digest`, `importKey`, `exportKey`, `sign`, `verify`, `encrypt`, `decrypt`, `generateKey`, `deriveBits`, `deriveKey`, `wrapKey`, `unwrapKey`).

WebCrypto SHALL be implemented by the WASM crypto extension running natively inside the QuickJS WASM context. A JS shim SHALL wrap all `crypto.subtle` methods to return Promises (via `Promise.resolve()`) for compatibility with the standard WebCrypto API.

`crypto.subtle.exportKey` SHALL support `"raw"`, `"pkcs8"`, and `"spki"` formats. `"jwk"` format SHALL NOT be supported in this version.

#### Scenario: crypto globals available

- **GIVEN** a sandbox
- **WHEN** guest code invokes `crypto.randomUUID()`, `crypto.getRandomValues(new Uint8Array(16))`, and `await crypto.subtle.digest("SHA-256", data)`
- **THEN** each call SHALL return a result consistent with the W3C WebCrypto specification

#### Scenario: crypto.subtle methods return Promises

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `const p = crypto.subtle.digest("SHA-256", data); typeof p.then`
- **THEN** the result SHALL be `"function"` (the return value is a Promise)

#### Scenario: JWK export is not supported

- **GIVEN** a sandbox
- **WHEN** guest code calls `crypto.subtle.exportKey("jwk", key)`
- **THEN** the call SHALL reject with an error indicating unsupported format

### Requirement: Key material lives in WASM

`CryptoKey` objects inside the sandbox SHALL be native WASM crypto extension objects backed by PSA key handles in the WASM linear memory. Key material SHALL NOT cross the host/guest boundary. No opaque reference store SHALL be used for crypto keys.

The `CryptoKey` object SHALL expose read-only properties: `type`, `algorithm`, `extractable`, `usages`.

#### Scenario: CryptoKey metadata is readable

- **GIVEN** a CryptoKey generated inside the sandbox
- **WHEN** guest code reads `key.type`, `key.algorithm`, `key.extractable`, `key.usages`
- **THEN** the values SHALL match the generation parameters

#### Scenario: Non-extractable key cannot be exported

- **GIVEN** a CryptoKey with `extractable: false`
- **WHEN** guest code calls `crypto.subtle.exportKey(...)` on it
- **THEN** the operation SHALL reject

### Requirement: Security context

The implementation SHALL conform to the threat model documented at `/SECURITY.md §2 Sandbox Boundary`. This capability is the single strongest isolation boundary in the system; any change to the public API, installed globals, host bridges, or VM lifecycle is a change to that boundary.

The QuickJS WASM isolation remains the primary guest/host boundary. Moving the host-bridge layer into a `worker_threads` worker does not alter the set of globals exposed to the guest and does not add a new Node.js surface visible to guest code. The worker is an implementation-level isolation layer for the host-bridge code itself, not a guest-visible change.

Changes to this capability that introduce new threats, weaken or remove a documented mitigation, change the VM lifecycle posture, alter what crosses the boundary, add a new global, or conflict with the rules in `/SECURITY.md §2` MUST update `/SECURITY.md §2` in the same change proposal. The worker-isolation change itself SHALL update `/SECURITY.md §2` to note the new execution topology (host-bridge runs in a worker isolate; only `emit` and other per-run main-side host methods cross the worker↔main boundary).

The implementation SHALL additionally conform to the tenant isolation invariant documented at `/SECURITY.md §1 "Tenant isolation invariants"` (I-T2). The sandbox is the load-bearing enforcement point for I-T2 on invocation-event writes: the `tenant` field stamped on every emitted `InvocationEvent` SHALL derive from the workflow's registration context (passed into the sandbox at construction by the host) and SHALL NOT be writable or influenceable by guest code. Any change that exposes a new host-bridge method through which guest code could observe, override, or forge the `tenant` field on emitted events breaks I-T2.

All lifecycle and security guarantees about the sandbox — VM construction, disposal, isolation, allowlisted globals, key-material containment — SHALL be codified in this capability spec rather than in consumer specs. Consumer specs (scheduler, context, workflow-loading, sdk) SHALL describe only how they use the sandbox's public API, not the sandbox's internal guarantees.

#### Scenario: Change alters sandbox boundary

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change affects entry points, installed globals, mitigations, residual risks, or rules enumerated in `/SECURITY.md §2`, or the tenant-stamping behaviour that upholds `/SECURITY.md §1 "Tenant isolation invariants"`
- **THEN** the proposal SHALL include the corresponding updates to `/SECURITY.md §2` and/or `/SECURITY.md §1`
- **AND** the updates SHALL be reviewed before the change is archived

#### Scenario: Change is orthogonal to the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change does not affect any item enumerated in `/SECURITY.md §2` or the tenant-isolation invariant in `/SECURITY.md §1`
- **THEN** no update to `/SECURITY.md` is required
- **AND** the proposal SHALL note that threat-model alignment was checked

### Requirement: Worker-thread isolation

The sandbox SHALL execute guest code inside a dedicated Node `worker_threads` Worker. The QuickJS runtime and context SHALL live in that worker. The main thread retains only the thin Sandbox proxy that routes `run()`, `dispose()`, and `onDied()` to the worker and services per-run RPC requests (`request` / `response`) from it.

Each `sandbox()` call SHALL spawn exactly one worker. Workers SHALL NOT be shared across sandbox instances. The worker entrypoint SHALL be a package-shipped file at `dist/worker.js` resolved by the main side via `new URL('./worker.js', import.meta.url)`.

The worker↔main message protocol SHALL define exactly these types:

- `init` (main → worker): carries `source`, construction-time `methodNames`, and `filename`.
- `ready` (worker → main): carries no payload; SHALL NOT be sent if initialization fails.
- `run` (main → worker): carries `exportName` and `ctx`. All host methods available to the guest during a run are the ones registered at init from `methodNames`; no per-run method list is carried.
- `request` (worker → main): carries `requestId`, `method`, `args` for a host method invocation.
- `response` (main → worker): carries `requestId`, `ok`, and either `result` or `error`.
- `done` (worker → main): carries the `RunResult` payload for a completed run.

`requestId` SHALL be unique per (worker, direction) to correlate concurrent in-flight host-method RPCs. All message payloads SHALL be structured-cloneable; non-cloneable values (functions, class instances, Promises) are disallowed by construction.

#### Scenario: Dedicated worker per sandbox

- **GIVEN** two sandbox instances constructed from the same source
- **WHEN** both are constructed
- **THEN** two distinct `worker_threads` Workers SHALL be spawned
- **AND** no state SHALL be shared between them at the worker level

#### Scenario: init/ready handshake

- **GIVEN** `sandbox(source, methods)` is called
- **WHEN** the worker spawns
- **THEN** the main side SHALL send exactly one `init` message with `source`, `Object.keys(methods)`, and optional `filename`
- **AND** the worker SHALL load QuickJS, install built-in and construction-time globals, evaluate `source`, and reply with a `ready` message
- **AND** `sandbox(...)` SHALL NOT resolve before `ready` arrives

#### Scenario: Non-cloneable RPC arg is rejected

- **GIVEN** a host method registered via `methods` whose caller passes a function as an argument (e.g., guest code calls `someMethod(() => {})`)
- **WHEN** the worker attempts to post a `request` message
- **THEN** the call SHALL fail inside the worker before `request` is posted
- **AND** the guest SHALL see a rejected promise carrying the serialization error

### Requirement: Sandbox death notification

The sandbox SHALL expose an `onDied(cb)` method that registers a callback to be invoked once when the underlying worker terminates unexpectedly. Unexpected termination includes any `worker.on("exit")` with a non-zero exit code and any `worker.on("error")` event raised outside of a controlled `dispose()`.

The callback SHALL receive an `Error` whose `message` describes the cause (worker exit code, uncaught worker-JS error message, or a synthetic descriptor if the worker exited without an error payload).

`onDied` SHALL NOT fire as a result of `dispose()`. If `onDied` is called after the worker has already died, the callback SHALL fire synchronously with the recorded death error. Only one callback SHALL be registered per sandbox; subsequent registrations SHALL replace the prior one.

#### Scenario: Worker exit triggers onDied

- **GIVEN** a sandbox with an `onDied` spy callback registered
- **WHEN** the worker emits an `exit` event with a non-zero code (e.g., because a WASM trap aborted the process)
- **THEN** the callback SHALL be invoked once with an `Error` whose message mentions the exit code

#### Scenario: Worker error event triggers onDied

- **GIVEN** a sandbox with an `onDied` spy callback registered
- **WHEN** the worker emits an `error` event carrying a thrown `TypeError`
- **THEN** the callback SHALL be invoked once with an `Error` carrying the original `TypeError`'s message

#### Scenario: Dispose does not trigger onDied

- **GIVEN** a live sandbox with an `onDied` spy callback registered
- **WHEN** `sb.dispose()` is called
- **THEN** the `onDied` callback SHALL NOT be invoked

#### Scenario: onDied registered after death fires immediately

- **GIVEN** a sandbox whose worker has already exited unexpectedly
- **AND** no prior `onDied` callback was registered at the time of death
- **WHEN** `sb.onDied(cb)` is called
- **THEN** `cb` SHALL be invoked synchronously with the recorded death error

### Requirement: Host bridge runs in the worker

The host-bridge implementation (`bridge-factory.ts`, `globals.ts`, and related `b.sync` / `b.async` surfaces and their `impl` functions) SHALL execute inside the worker isolate. The main thread SHALL implement only:

1. The `request`/`response` router for per-run and construction-time host methods that close over main-side state (e.g., the `emit` closure that calls `EventSource.derive` uses `event` and `action.name` captured by the scheduler).
2. Lifecycle management (spawn, terminate, `onDied` dispatch).

Host-bridge logging is auto-captured by `bridge-factory.ts` and flows back to the main side inside `RunResult.logs`. No additional main-side logging wrappers are required for fetch / crypto / console / performance / timers.

#### Scenario: Bridge-factory logs include fetch and crypto

- **GIVEN** guest code that invokes `fetch("https://example.com")` and `crypto.subtle.digest(...)` during a run
- **WHEN** the run completes
- **THEN** `RunResult.logs` SHALL contain `LogEntry` records for both calls, captured by the bridge-factory layer inside the worker

#### Scenario: Host-side emit closure runs on main

- **GIVEN** a sandbox running an action whose guest code calls `await emit("child", payload)`
- **WHEN** the worker posts a `request` for the `emit` method
- **THEN** the main side SHALL invoke the scheduler's per-run `emit` closure (which calls `source.derive(event, type, payload, action.name)`)
- **AND** SHALL reply with a `response` that resolves the guest's pending promise

### Requirement: Sandbox factory public API

The sandbox package SHALL export a `createSandboxFactory({ logger })` factory that returns a `SandboxFactory` instance.

```ts
interface SandboxFactory {
  create(source: string, options?: SandboxOptions): Promise<Sandbox>
  dispose(): Promise<void>
}

function createSandboxFactory(opts: { logger: Logger }): SandboxFactory
```

The `SandboxFactory` SHALL be a construction primitive: it SHALL create new `Sandbox` instances on every `create` call and SHALL NOT cache instances by source. Tenant-scoped sandbox reuse SHALL be provided by a runtime-owned `SandboxStore` (see the `sandbox-store` capability), not by the factory.

#### Scenario: Factory is exported from the sandbox package

- **GIVEN** the monorepo at `packages/sandbox`
- **WHEN** a consumer imports from `@workflow-engine/sandbox`
- **THEN** `createSandboxFactory` and the `SandboxFactory` type SHALL be exported as named exports

#### Scenario: Factory accepts a logger

- **GIVEN** a consumer with an injected logger compatible with the project's `Logger` interface
- **WHEN** `createSandboxFactory({ logger })` is called
- **THEN** the returned factory SHALL retain a reference to that logger for all operational log output

#### Scenario: Every create constructs a new Sandbox

- **GIVEN** a factory
- **WHEN** `factory.create(source)` is called twice with the same source
- **THEN** the factory SHALL invoke `sandbox(source, {}, options)` twice
- **AND** SHALL resolve to two distinct `Sandbox` instances

### Requirement: Factory-wide dispose

The factory SHALL expose a `dispose(): Promise<void>` method that disposes every `Sandbox` instance it has created (and not yet itself disposed) and clears its internal tracking set. After `dispose()`, calls to `create(source)` SHALL resume creating fresh sandboxes as normal.

#### Scenario: Dispose tears down all created sandboxes

- **GIVEN** a factory that has created `N` `Sandbox` instances, none of which have been individually disposed
- **WHEN** `factory.dispose()` is called
- **THEN** each tracked instance SHALL have `dispose()` invoked on it
- **AND** the internal tracking set SHALL be empty after the call resolves

#### Scenario: Create after dispose spawns fresh

- **GIVEN** a factory whose `dispose()` has resolved
- **WHEN** `factory.create(source)` is called for any source
- **THEN** the factory SHALL invoke `sandbox(source, {}, ...)` to construct a new instance

### Requirement: Factory operational logging

The factory SHALL emit operational log entries via its injected logger for the following lifecycle events:

- `info` when a new `Sandbox` is created: include a stable source identifier (e.g. a short hash) and the construction duration in milliseconds.
- `info` when a `Sandbox` is disposed: include the source identifier and the disposal trigger (`"factory.dispose"`).

Operational log entries SHALL NOT be merged into `RunResult.logs`; the per-run bridge log stream remains guest-only.

#### Scenario: Creation is logged

- **GIVEN** a factory with an injected logger spy
- **WHEN** `factory.create(source)` resolves
- **THEN** the logger SHALL receive a single `info` call carrying a source identifier and a `durationMs` field

#### Scenario: Factory-wide disposal is logged

- **GIVEN** a factory with tracked sandboxes and an injected logger spy
- **WHEN** `factory.dispose()` is called and resolves
- **THEN** the logger SHALL receive one `info` call per disposed sandbox carrying the source identifier and `reason: "factory.dispose"`

### Requirement: Consumer lifecycle ownership

Consumers of the sandbox are responsible for lifecycle: a new sandbox SHALL be constructed per workflow module load, and the sandbox SHALL be disposed on process shutdown. Tenant-scoped sandbox reuse and the decision of when to build a new sandbox SHALL be owned by the runtime-level `SandboxStore` (see the `sandbox-store` capability); consumers SHOULD depend on `SandboxStore` rather than `SandboxFactory` directly.

#### Scenario: Store is the documented consumer

- **GIVEN** a runtime consumer that needs to dispatch trigger handlers
- **WHEN** it needs a `Sandbox` for a `(tenant, workflow)` pair
- **THEN** it SHALL obtain the sandbox via `SandboxStore.get(tenant, workflow, bundleSource)`
- **AND** it SHALL NOT call `SandboxFactory.create` directly

### Requirement: Action call host wiring

The runtime SHALL register `__hostCallAction` per-workflow at sandbox construction time by passing it in `methods` to `sandbox(source, methods, options)`. The host implementation SHALL look up the called action by name in the workflow's manifest, validate the input against the JSON Schema from the manifest, audit-log the invocation, and return. The host SHALL NOT invoke the handler --- dispatch is performed by the runtime-appended dispatcher shim inside the sandbox.

The runtime SHALL append JS source to the workflow bundle (evaluated after the bundle IIFE) that runs as an IIFE and performs the following operations in order:

1. Capture `globalThis.__hostCallAction` into a closure-local variable.
2. Capture `globalThis.__emitEvent` into a closure-local variable.
3. Install `globalThis.__dispatchAction` via `Object.defineProperty` with `value: dispatch`, `writable: false`, `configurable: false`, where `dispatch(name, input, handler, outputSchema)` uses only the closure-captured references to emit `action.*` events, validate input via the captured host bridge, invoke the handler in-sandbox, and validate the handler's return via the output schema.
4. `delete globalThis.__hostCallAction` and `delete globalThis.__emitEvent`.

After this IIFE completes, guest code SHALL NOT be able to read, reassign, or delete `globalThis.__dispatchAction` — the only legal use is to call it.

#### Scenario: Unknown action name throws

- **GIVEN** a workflow whose manifest does not contain an action named `"missing"`
- **WHEN** the dispatcher's captured `__hostCallAction("missing", input)` reference is invoked
- **THEN** the host SHALL throw an error indicating the action is not declared in the manifest

#### Scenario: Dispatcher cannot be replaced by guest

- **GIVEN** a sandbox whose dispatcher shim has evaluated
- **WHEN** guest code attempts `globalThis.__dispatchAction = myFn`
- **THEN** the assignment SHALL be rejected (TypeError in strict mode, silent no-op in sloppy mode)
- **AND** subsequent action calls SHALL continue to route through the original dispatcher

#### Scenario: Dispatcher cannot be deleted by guest

- **GIVEN** a sandbox whose dispatcher shim has evaluated
- **WHEN** guest code attempts `delete globalThis.__dispatchAction`
- **THEN** the delete SHALL be rejected (TypeError in strict mode, `false` in sloppy mode)
- **AND** subsequent action calls SHALL continue to route through the original dispatcher

### Requirement: Memory limit configuration

The sandbox factory SHALL accept an optional `memoryLimit` number (in bytes) in the options parameter. When provided, the sandbox SHALL pass it to `QuickJS.create({ memoryLimit })`. Guest code that exceeds the limit SHALL trigger an out-of-memory error inside the QuickJS context.

#### Scenario: Memory limit enforced

- **GIVEN** a sandbox created with `{ memoryLimit: 1024 * 1024 }` (1 MB)
- **WHEN** guest code attempts to allocate memory exceeding 1 MB
- **THEN** the allocation SHALL fail with an error inside the QuickJS context
- **AND** the run SHALL return `{ ok: false, error: { message: ... } }`

#### Scenario: No memory limit by default

- **GIVEN** a sandbox created without a memoryLimit option
- **WHEN** guest code allocates memory
- **THEN** the default WASM linear memory limits SHALL apply

### Requirement: Interrupt handler configuration

The sandbox factory SHALL accept an optional `interruptHandler` function in the options parameter. When provided, the sandbox SHALL pass it to `QuickJS.create({ interruptHandler })`. The handler SHALL be called periodically during execution. If it returns `true`, execution SHALL be interrupted.

#### Scenario: Execution interrupted by handler

- **GIVEN** a sandbox created with an interrupt handler that returns `true` after 10000 calls
- **WHEN** guest code runs an infinite loop
- **THEN** execution SHALL be interrupted
- **AND** the run SHALL return `{ ok: false, error: { message: ... } }`

#### Scenario: No interrupt handler by default

- **GIVEN** a sandbox created without an interruptHandler option
- **WHEN** guest code runs a long computation
- **THEN** execution SHALL proceed without interruption

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

### Requirement: WASI clock_time_get override

The sandbox worker SHALL install a WASI `clock_time_get` override at QuickJS VM creation. For `CLOCK_REALTIME` the override SHALL return `BigInt(Date.now()) * 1_000_000n` nanoseconds (pass-through to the host wall clock). For `CLOCK_MONOTONIC` the override SHALL return `(BigInt(Math.trunc(performance.now() * 1_000_000)) - bridge.anchorNs())` where `bridge.anchorNs()` returns the bridge-owned monotonic anchor defined in the "Monotonic clock anchor lifecycle" requirement.

While a run context is active (i.e. `bridge.getRunContext()` returns non-null), each invocation of the override SHALL emit one InvocationEvent with `kind = "system.call"`, `name = "wasi.clock_time_get"`, `input = { clockId: "REALTIME" | "MONOTONIC" }`, and `output = { ns: <number> }`. Invocations that fire without a run context (VM initialization, WASI libc init, guest source evaluation before the first run) SHALL NOT emit events.

#### Scenario: Realtime read passes through and emits event during a run

- **GIVEN** a running sandbox with no clock controls
- **WHEN** guest code inside an active run invokes `Date.now()`
- **THEN** the returned value SHALL approximate the host wall-clock time at call time
- **AND** one `system.call` event with `name = "wasi.clock_time_get"`, `input.clockId = "REALTIME"`, and `output.ns` matching the returned value times `1_000_000` SHALL be emitted

#### Scenario: Monotonic read is anchored to the current run

- **GIVEN** a running sandbox
- **WHEN** guest code inside an active run invokes `performance.now()` as the first monotonic read of that run
- **THEN** the returned value SHALL be within a small epsilon of `0`
- **AND** a subsequent `performance.now()` later in the same run SHALL return a strictly greater non-negative value

#### Scenario: Pre-run clock reads do not emit events

- **GIVEN** a sandbox whose `handleInit` has completed but `handleRun` has not started
- **WHEN** any WASI `clock_time_get` read fires (including QuickJS PRNG seeding or workflow source IIFE construction)
- **THEN** no InvocationEvent SHALL be emitted for that read

### Requirement: WASI random_get override

The sandbox worker SHALL install a WASI `random_get` override at QuickJS VM creation. The override SHALL delegate to the host's `crypto.getRandomValues` to fill the requested region of WASM linear memory.

While a run context is active, each invocation SHALL emit one InvocationEvent with `kind = "system.call"`, `name = "wasi.random_get"`, `input = { bufLen: <number> }`, and `output = { bufLen: <number>, sha256First16: <hex> }` where `sha256First16` is the lowercase hex encoding of the first 16 bytes of `SHA-256(bytes)` and `bytes` are the entropy bytes returned to the guest.

The event SHALL NOT carry the returned entropy bytes in any form. Invocations without an active run context SHALL NOT emit events.

#### Scenario: Entropy read passes through and emits event during a run

- **GIVEN** a running sandbox
- **WHEN** guest code inside an active run invokes `crypto.getRandomValues(new Uint8Array(32))`
- **THEN** the buffer SHALL be filled with cryptographically random bytes from the host
- **AND** one `system.call` event with `name = "wasi.random_get"`, `input.bufLen = 32`, `output.bufLen = 32`, and `output.sha256First16` being a 32-character lowercase hex string SHALL be emitted

#### Scenario: Raw entropy bytes are never logged

- **GIVEN** a running sandbox
- **WHEN** any `wasi.random_get` event is emitted
- **THEN** the event payload SHALL NOT contain a field holding the raw returned bytes under any name
- **AND** the only fingerprint present SHALL be `output.sha256First16`

#### Scenario: Pre-run entropy reads do not emit events

- **GIVEN** a sandbox whose `handleInit` has completed but `handleRun` has not started
- **WHEN** any WASI `random_get` read fires (including WASI libc init)
- **THEN** no InvocationEvent SHALL be emitted for that read

### Requirement: WASI fd_write capture routed to sandbox Logger

The sandbox worker SHALL install a WASI `fd_write` override at QuickJS VM creation. The override SHALL decode the written bytes as UTF-8, line-buffer per file descriptor, and SHALL NOT pass bytes through to the host's `process.stdout` or `process.stderr`. On each completed line the worker SHALL post a `WorkerToMain` message `{ type: "log", level: "debug", message: "quickjs.fd_write", meta: { fd: <number>, text: <line-without-newline> } }`.

The main-thread sandbox handler SHALL route incoming `log` messages by invoking `logger[level](message, meta)` on the injected `Logger` (when `SandboxOptions.logger` is set). When no `Logger` has been injected, the main thread SHALL silently discard the message.

`fd_write` bytes SHALL NOT be emitted as InvocationEvents under any circumstance.

#### Scenario: Engine diagnostic is routed to injected Logger at debug level

- **GIVEN** a sandbox constructed with an injected `Logger` spy
- **WHEN** the WASI `fd_write` override is invoked with bytes representing `"some diagnostic\n"` on fd 2
- **THEN** the logger's `debug` method SHALL be called exactly once with `"quickjs.fd_write"` and `meta = { fd: 2, text: "some diagnostic" }`
- **AND** no InvocationEvent SHALL be emitted for the write

#### Scenario: fd_write traffic is silently dropped when no Logger is provided

- **GIVEN** a sandbox constructed without a `logger` option
- **WHEN** the WASI `fd_write` override is invoked with any bytes
- **THEN** no call to any logger method SHALL occur
- **AND** the host process `stdout` and `stderr` SHALL receive no bytes from this write
- **AND** no InvocationEvent SHALL be emitted

### Requirement: system.call event kind contract

The `@workflow-engine/core` package SHALL export `"system.call"` as a variant of `EventKind`. A `system.call` InvocationEvent SHALL carry both `input` and `output` in the same record and SHALL NOT have a paired counterpart event. It SHALL be a leaf in the invocation call tree — emitting a `system.call` SHALL NOT push or pop entries on the sandbox bridge's reference stack.

The event's `ref` field SHALL be `refStack.at(-1) ?? null`. The event's `seq` field SHALL be obtained from the bridge's next-seq counter. The event's `name` field SHALL identify the source (e.g. `"wasi.clock_time_get"`, `"wasi.random_get"`). Consumers that branch on `kind` SHALL treat `"system.call"` as an additive variant.

#### Scenario: system.call is emitted as a single record

- **GIVEN** a running sandbox
- **WHEN** a WASI clock or random read fires during an active run
- **THEN** exactly one InvocationEvent with `kind = "system.call"` SHALL be emitted for that read
- **AND** no `"system.response"` or `"system.error"` event SHALL be emitted with a matching `ref`

#### Scenario: system.call inherits call-site context via ref

- **GIVEN** a running sandbox whose guest code calls `__hostFetch` and inside the host `fetch` implementation a WASI `clock_time_get` fires
- **WHEN** the events are inspected
- **THEN** the `system.request` event for `host.fetch` SHALL have `seq = S`
- **AND** the `system.call` event for `wasi.clock_time_get` SHALL have `ref = S`
- **AND** the matching `system.response` event for `host.fetch` SHALL also have `ref = S`

### Requirement: Monotonic clock anchor lifecycle

The sandbox SHALL maintain a single mutable monotonic anchor shared by the `CLOCK_MONOTONIC` branch of the WASI `clock_time_get` override and every `InvocationEvent` emission site. The anchor SHALL live in a single cell held on `wasiState` and accessed by the bridge via `bridge.anchorNs()` / `bridge.tsUs()` / `bridge.resetAnchor()`:

- `bridge.resetAnchor()` — overwrites the cell with `BigInt(Math.trunc(performance.now() * 1_000_000))`.
- `bridge.anchorNs()` — returns the cell's current BigInt nanoseconds value.
- `bridge.tsUs()` — returns `Math.round((performance.now() - Number(anchorNs)/1_000_000) * 1000)` as an integer Number.

The anchor cell SHALL be seeded via an initial `perfNowNs()` read BEFORE `QuickJS.create()` is invoked, so the WASI monotonic clock returns small values during VM initialization. This prevents QuickJS from caching a large reference internally for `performance.now()` on its first read. The anchor SHALL then be re-seeded via `bridge.resetAnchor()` each time `bridge.setRunContext` is called for a new run.

Guest reads of `performance.now()` across reruns of a cached sandbox SHALL therefore start near zero at the beginning of every run, regardless of how much wall-clock time has elapsed between runs. The anchor source read by the WASI clock and by event `ts` fields SHALL be the same cell, so host-side events and WASI-exposed monotonic readings never drift against each other.

Note: QuickJS captures its own `performance.now()` reference internally on first read (during VM init). As a consequence, guest `performance.now()` readings are offset by the VM-init-to-run-start gap (a few milliseconds) relative to the current host-side event `ts`. Both values remain small (sub-second for realistic runs) and monotonic within a run; they do not need to be byte-identical.

#### Scenario: Monotonic resets between runs on a cached sandbox

- **GIVEN** a cached sandbox that has completed one run in which `performance.now()` reached value V1
- **WHEN** a second run begins via `sandbox.run(...)`
- **AND** guest code in the second run invokes `performance.now()` as the first monotonic read
- **THEN** the returned value SHALL be within a small epsilon of `0`
- **AND** SHALL be strictly less than V1

#### Scenario: WASI monotonic clock and event ts are both run-anchored

- **GIVEN** a sandbox run in progress
- **WHEN** guest code reads `performance.now()` and the runtime immediately thereafter emits an InvocationEvent
- **THEN** the guest's reading (in ms) SHALL have absolute value under one second
- **AND** the event's `ts` (in µs) SHALL be greater than or equal to zero and under one second in magnitude
- **AND** the WASI monotonic clock override and `bridge.tsUs()` SHALL read their anchor from the same underlying cell

### Requirement: Event `at` and `ts` fields sourced from the bridge

Every InvocationEvent emitted by the sandbox during an active run SHALL carry two time fields populated at emission time:

- `at: string` — `new Date().toISOString()` captured at emission.
- `ts: number` — `bridge.tsUs()` captured at emission (integer µs since the current run's anchor).

All three emission sites — `installEmitEvent` for action events, `emitTriggerEvent` for trigger events, and the bridge's internal `buildEvent` for system events — SHALL populate these fields from the same helpers. Neither field SHALL be derived by a VM round-trip; both are computed on the host side at the moment of emission.

#### Scenario: Action event carries at and ts

- **GIVEN** a guest that calls `ctx.emit("did-thing", { ... })` during a run
- **WHEN** the resulting `action.request` InvocationEvent is observed
- **THEN** it SHALL carry a non-empty `at` string parseable as an ISO 8601 date
- **AND** it SHALL carry an integer `ts` value greater than or equal to zero

#### Scenario: System event carries at and ts

- **GIVEN** a guest whose execution triggers a bridge `system.request` event
- **WHEN** the event is observed
- **THEN** it SHALL carry the same `at` / `ts` shape as action events
- **AND** `ts` SHALL be less than or equal to the `ts` of the corresponding `system.response`

#### Scenario: Trigger terminal event ts exceeds trigger.request ts

- **GIVEN** a completed sandbox run
- **WHEN** the `trigger.request` event has `ts = T_req` and the terminal `trigger.response` (or `trigger.error`) has `ts = T_term`
- **THEN** `T_term >= T_req` SHALL hold
- **AND** `T_term - T_req` SHALL equal the sandbox-observable execution duration in microseconds

### Requirement: SandboxOptions accepts an injected Logger

The `SandboxOptions` type exported from the sandbox package SHALL accept an optional `logger?: Logger` field. When present, the sandbox SHALL route incoming `WorkerToMain { type: "log" }` messages to that logger by invoking `logger[level](message, meta)`. When absent, the sandbox SHALL silently discard `log` messages.

The sandbox factory SHALL pass its own injected `Logger` to each sandbox it constructs via this option. Direct consumers of `sandbox()` MAY omit the option; omission SHALL NOT be an error.

#### Scenario: Factory propagates its Logger into constructed sandboxes

- **GIVEN** a `SandboxFactory` constructed with an injected Logger spy
- **WHEN** `factory.create(source)` resolves
- **AND** the resulting sandbox's WASI `fd_write` override fires with any decoded line
- **THEN** the factory's injected Logger SHALL receive the corresponding `debug` call

#### Scenario: Direct sandbox() call without a logger is valid

- **GIVEN** a direct `sandbox(source, methods)` call with no `options.logger`
- **WHEN** any `WorkerToMain { type: "log" }` message arrives from the worker
- **THEN** the main-thread handler SHALL discard the message without throwing

### Requirement: Sandbox Logger interface supports debug level

The `Logger` interface exposed at `packages/sandbox/src/factory.ts` SHALL define methods `info`, `warn`, `error`, and `debug`, each with signature `(message: string, meta?: Record<string, unknown>) => void`. The `debug` method SHALL be used by the sandbox to route `fd_write` traffic. Other internal usages MAY continue to use `info` and `warn` as before.

#### Scenario: Debug method is part of the Logger contract

- **GIVEN** any test or production construction of `SandboxFactory`
- **WHEN** the factory calls `logger.debug(msg, meta)` on its injected logger
- **THEN** the injected implementation SHALL handle the call without throwing

### Requirement: Safe globals — URLPattern

The sandbox SHALL expose `globalThis.URLPattern` as a WHATWG URLPattern implementation, provided by the `urlpattern-polyfill` npm package (exact version pinned in `packages/sandbox/package.json`) and compiled into the sandbox polyfill IIFE via the `sandboxPolyfills()` Vite plugin. No host-bridge method is used; all pattern state lives in the QuickJS heap. This global is required by the WinterCG Minimum Common API.

The polyfill's own `index.js` self-installs the class on `globalThis` behind a feature-detect guard (`if (!globalThis.URLPattern) globalThis.URLPattern = URLPattern;`) when the `virtual:sandbox-polyfills` IIFE runs. Adding `URLPattern` to `RESERVED_BUILTIN_GLOBALS` in `packages/sandbox/src/index.ts` SHALL make the name collide at sandbox-construction time if a host passes `extraMethods: { URLPattern: … }`, matching every other shim-installed global.

#### Scenario: URLPattern is a constructible function

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `typeof URLPattern`
- **THEN** the result SHALL be `"function"`
- **AND** `new URLPattern("/foo") instanceof URLPattern` SHALL evaluate to `true`

#### Scenario: URLPattern.exec returns named groups for a matching URL

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `new URLPattern({ pathname: "/users/:id" }).exec({ pathname: "/users/42" })`
- **THEN** the result SHALL be a match object whose `pathname.groups.id === "42"`

#### Scenario: URLPattern.test returns false for a non-matching URL

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `new URLPattern({ pathname: "/users/:id" }).test({ pathname: "/posts/42" })`
- **THEN** the result SHALL be `false`

#### Scenario: Host extraMethods cannot shadow URLPattern

- **GIVEN** a sandbox factory invoked with `extraMethods: { URLPattern: someHostFn }`
- **WHEN** sandbox construction runs the reserved-globals collision check
- **THEN** construction SHALL throw with a message naming `URLPattern` as a reserved global

### Requirement: Safe globals — fetch

The sandbox SHALL expose `globalThis.fetch` as a WHATWG-compatible `fetch` function installed via `Object.defineProperty` with `writable: false, configurable: false, enumerable: true`. The implementation SHALL be the pure-JS fetch shim compiled into the sandbox polyfill IIFE from `packages/sandbox/src/polyfills/fetch.ts`, which routes all calls through the `__hostFetch` bridge captured at init time. The shim SHALL accept `(input, init?)` where `input` is a `RequestInfo | URL` and SHALL return a `Promise<Response>`. Request bodies SHALL be drained to a UTF-8 string before crossing the host bridge; streaming and binary bodies SHALL be decoded as UTF-8 via the `Body` mixin's `.text()` method. The `Request.signal` property SHALL be preserved on the guest `Request` per spec but SHALL NOT be propagated to the host bridge in this revision of the sandbox.

Egress policy (scheme allowlist, DNS resolution, IP blocklist, redirect handling, timeout, error shape, observability) SHALL be governed by the `Hardened outbound fetch` requirement. The guest-facing shim itself performs no validation beyond normalizing input to the bridge wire format.

The `fetch` global SHALL be non-writable and non-configurable. Guest assignment `globalThis.fetch = myFn` SHALL throw a `TypeError` in strict mode or be silently ignored in sloppy mode; in neither case SHALL subsequent `fetch()` calls route to the guest-provided function.

#### Scenario: fetch is a non-writable function

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `typeof fetch`
- **THEN** the result SHALL be `"function"`
- **AND** `Object.getOwnPropertyDescriptor(globalThis, 'fetch').writable` SHALL be `false`
- **AND** `Object.getOwnPropertyDescriptor(globalThis, 'fetch').configurable` SHALL be `false`

#### Scenario: fetch accepts a Request object as input

- **GIVEN** a sandbox and a guest-constructed `new Request("https://example.com", { method: "POST", body: "x" })`
- **WHEN** guest code calls `fetch(req)`
- **THEN** the underlying bridge call SHALL receive the method, URL, headers, and drained body from that Request
- **AND** the returned Response SHALL be a constructible WHATWG `Response`

#### Scenario: Guest cannot replace fetch

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `globalThis.fetch = () => "pwned"` in strict mode
- **THEN** a `TypeError` SHALL be thrown
- **AND** subsequent `fetch("https://example.com")` calls SHALL route to the shim installed at init time

### Requirement: Safe globals — Request

The sandbox SHALL expose `globalThis.Request` as a hand-rolled WHATWG-compatible `Request` class compiled into the sandbox polyfill IIFE from `packages/sandbox/src/polyfills/request.ts`. The class SHALL support construction via `new Request(input, init?)` where `input` is `RequestInfo | URL` and `init` is a `RequestInit`-shaped dictionary. The class SHALL mix in the shared `Body` mixin from `packages/sandbox/src/polyfills/body-mixin.ts`, providing `.text()`, `.json()`, `.arrayBuffer()`, `.blob()`, `.formData()`, and `.bytes()` body-consumer methods, plus the `bodyUsed` boolean and `body` `ReadableStream` accessors. `Request.signal` SHALL be an `AbortSignal` stored per spec (not propagated to the host bridge). No host bridge SHALL back this class — all state lives in the QuickJS heap.

#### Scenario: Request is constructible

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `new Request("https://example.com", { method: "POST", body: "x" })`
- **THEN** the returned object SHALL be an instance of `Request`
- **AND** its `method` SHALL be `"POST"`
- **AND** its `url` SHALL be `"https://example.com/"`

#### Scenario: Request body can be read as text

- **GIVEN** a `new Request("https://example.com", { method: "POST", body: "hello" })`
- **WHEN** guest code awaits `req.text()`
- **THEN** the result SHALL be `"hello"`
- **AND** `req.bodyUsed` SHALL be `true`

### Requirement: Safe globals — Response

The sandbox SHALL expose `globalThis.Response` as a hand-rolled WHATWG-compatible `Response` class compiled into the sandbox polyfill IIFE from `packages/sandbox/src/polyfills/response.ts`. The class SHALL support construction via `new Response(body?, init?)` with body types `null | string | Blob | ArrayBuffer | TypedArray | URLSearchParams | FormData | ReadableStream`. The class SHALL mix in the shared `Body` mixin, providing the same body-consumer surface as `Request`. Static factories `Response.error()`, `Response.redirect(url, status?)`, and `Response.json(data, init?)` SHALL be present. The class SHALL expose `status`, `statusText`, `ok`, `type`, `url`, `redirected`, and `headers` accessors per spec. A `.clone()` method SHALL produce a body-independent copy. No host bridge SHALL back this class.

#### Scenario: Response is constructible

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `new Response("hello", { status: 201 })`
- **THEN** the returned object SHALL be an instance of `Response`
- **AND** its `status` SHALL be `201`
- **AND** its `ok` SHALL be `true`
- **AND** `await res.text()` SHALL be `"hello"`

#### Scenario: Response.json produces a JSON response

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `Response.json({ a: 1 })`
- **THEN** the result SHALL be a `Response` with `headers.get("content-type")` equal to `"application/json"`
- **AND** `await res.json()` SHALL deep-equal `{ a: 1 }`

### Requirement: Safe globals — Blob

The sandbox SHALL expose `globalThis.Blob` as the WHATWG `Blob` implementation from the `fetch-blob` npm package (pinned major version 4, pinned in `packages/sandbox/package.json`) compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/blob.ts`. No host bridge SHALL be used; all blob state lives in the QuickJS heap and does not outlive one sandbox run. `Blob` SHALL support the spec constructor, `.size`, `.type`, `.slice()`, `.stream()`, `.arrayBuffer()`, `.text()`, and `.bytes()`.

`Blob.stream()` SHALL return a `ReadableStream<Uint8Array>` created via `globalThis.ReadableStream`; the `blob.ts` polyfill runs after `streams.ts` has installed that global, and the `fetch-blob` top-level `if (!globalThis.ReadableStream)` fallback that dynamic-imports `node:stream/web` SHALL be stripped by the vite plugin's polyfill transform to keep the bundle IIFE-compatible.

#### Scenario: Blob is constructible

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `new Blob(["hello"], { type: "text/plain" })`
- **THEN** the returned object SHALL be an instance of `Blob`
- **AND** its `size` SHALL be `5`
- **AND** its `type` SHALL be `"text/plain"`

#### Scenario: Blob can be read as text

- **GIVEN** `const b = new Blob(["a", "b", "c"])`
- **WHEN** guest code awaits `b.text()`
- **THEN** the result SHALL be `"abc"`

### Requirement: Safe globals — File

The sandbox SHALL expose `globalThis.File` as the `File` subclass from `fetch-blob/file.js` compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/blob.ts`. `File` SHALL extend `Blob` and add `.name`, `.lastModified`, and `.webkitRelativePath` accessors per spec.

#### Scenario: File extends Blob

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `const f = new File(["x"], "a.txt", { type: "text/plain", lastModified: 1000 })`
- **THEN** `f instanceof File` SHALL be `true`
- **AND** `f instanceof Blob` SHALL be `true`
- **AND** `f.name` SHALL be `"a.txt"`
- **AND** `f.lastModified` SHALL be `1000`

### Requirement: Safe globals — FormData

The sandbox SHALL expose `globalThis.FormData` as the `FormData` implementation from the `formdata-polyfill` npm package (pinned major version 4, pinned in `packages/sandbox/package.json`) compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/form-data.ts`. The polyfill depends on `globalThis.Blob` and `globalThis.File` being installed first. No host bridge is used. `FormData` SHALL support `.append()`, `.set()`, `.get()`, `.getAll()`, `.has()`, `.delete()`, `.entries()`, `.keys()`, `.values()`, and iteration.

#### Scenario: FormData supports append and get

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `const fd = new FormData(); fd.append("k", "v"); fd.get("k")`
- **THEN** the result SHALL be `"v"`

#### Scenario: FormData accepts File entries

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `const fd = new FormData(); fd.append("f", new File(["x"], "a.txt")); fd.get("f").name`
- **THEN** the result SHALL be `"a.txt"`

### Requirement: Safe globals — ReadableStream / WritableStream / TransformStream

The sandbox SHALL expose `globalThis.ReadableStream`, `globalThis.WritableStream`, and `globalThis.TransformStream` as the implementations from the `web-streams-polyfill` npm package (pinned major version 4, pinned in `packages/sandbox/package.json`) compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/streams.ts`. Alongside these three base classes, the sandbox SHALL also expose `ReadableByteStreamController`, `ReadableStreamBYOBReader`, `ReadableStreamBYOBRequest`, `ReadableStreamDefaultController`, `ReadableStreamDefaultReader`, `TransformStreamDefaultController`, `WritableStreamDefaultController`, and `WritableStreamDefaultWriter` — all pulled from the same ponyfill export. No host bridge is used.

`ReadableStream.prototype.tee()`, `ReadableStream.prototype.pipeTo()`, `ReadableStream.prototype.pipeThrough()`, and `ReadableStream.prototype.getReader({ mode: "byob" })` SHALL be supported. `TransformStream` SHALL accept a custom `transformer` with `start`, `transform`, and `flush` callbacks.

#### Scenario: ReadableStream can be read via a default reader

- **GIVEN** a sandbox
- **WHEN** guest code runs `const s = new ReadableStream({ start(c) { c.enqueue("a"); c.close(); } }); const r = s.getReader(); await r.read()`
- **THEN** the read result SHALL have `{ value: "a", done: false }`
- **AND** a subsequent `r.read()` SHALL resolve with `{ value: undefined, done: true }`

#### Scenario: TransformStream chains readable and writable

- **GIVEN** a sandbox
- **WHEN** guest code constructs `const ts = new TransformStream({ transform(chunk, c) { c.enqueue(chunk.toUpperCase()); } })` and writes `"a"` through it
- **THEN** reading from `ts.readable` SHALL yield `"A"`

### Requirement: Safe globals — Queuing strategies

The sandbox SHALL expose `globalThis.ByteLengthQueuingStrategy` and `globalThis.CountQueuingStrategy` as the implementations from `web-streams-polyfill`, compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/streams.ts`. Both classes SHALL be constructible with `{ highWaterMark: number }` and SHALL expose the spec-required `size()` method.

#### Scenario: CountQueuingStrategy returns size 1

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `new CountQueuingStrategy({ highWaterMark: 3 }).size()`
- **THEN** the result SHALL be `1`

### Requirement: Safe globals — TextEncoderStream / TextDecoderStream

The sandbox SHALL expose `globalThis.TextEncoderStream` and `globalThis.TextDecoderStream` as hand-rolled `TransformStream` wrappers around the WASM-native `TextEncoder` / `TextDecoder`, compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/streams.ts`. `TextDecoderStream` SHALL accept `(label?, options?)` matching the `TextDecoder` constructor and SHALL expose `encoding`, `fatal`, and `ignoreBOM` accessors. Both classes SHALL expose `readable` and `writable` accessors. State SHALL be held in a module-scope `WeakMap` keyed by the instance; calling an accessor on a non-instance receiver SHALL throw a `TypeError("Illegal invocation")`.

#### Scenario: TextDecoderStream decodes streamed UTF-8

- **GIVEN** a sandbox
- **WHEN** guest code pipes the bytes `[0x68, 0x69]` through a `new TextDecoderStream()`
- **THEN** reading from its `readable` SHALL yield `"hi"`

### Requirement: Safe globals — CompressionStream / DecompressionStream

The sandbox SHALL expose `globalThis.CompressionStream` and `globalThis.DecompressionStream` as pure-JS `TransformStream` wrappers around the streaming compressors from the `fflate` npm package, compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/compression.ts`. The `format` constructor argument SHALL accept exactly `"gzip"` (RFC 1952), `"deflate"` (RFC 1950 zlib), and `"deflate-raw"` (RFC 1951 raw); any other value SHALL throw a `TypeError`. Chunks written to the writable side MUST be `BufferSource` (`ArrayBuffer` or `ArrayBufferView`); non-BufferSource chunks and chunks backed by `SharedArrayBuffer` SHALL reject with a `TypeError`. `DecompressionStream` SHALL report `TypeError` on additional input received after the compressed stream terminated and on flush when no input was received or the input did not terminate.

#### Scenario: Unsupported compression format throws

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `new CompressionStream("brotli")`
- **THEN** a `TypeError` SHALL be thrown naming the supported formats

#### Scenario: gzip round-trip

- **GIVEN** a sandbox
- **WHEN** guest code compresses UTF-8 bytes for `"hello"` through `new CompressionStream("gzip")` and pipes the output through `new DecompressionStream("gzip")`
- **THEN** the final decoded bytes SHALL equal the original UTF-8 bytes for `"hello"`

### Requirement: Safe globals — Observable

The sandbox SHALL expose `globalThis.Observable` and `globalThis.Subscriber`, and SHALL patch `EventTarget.prototype.when`, using the `observable-polyfill` npm package (pinned major version 0.0.29, pinned in `packages/sandbox/package.json`) compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/observable.ts`. The polyfill SHALL be force-applied via the `/fn` entry point to bypass upstream browser-context detection (the sandbox is not a browser context because `globalThis.Window` is `undefined`). The polyfill depends on already-allowlisted globals: `EventTarget`, `AbortController`, `AbortSignal`, `Promise`, and `queueMicrotask`. No host bridge is used.

#### Scenario: Observable is constructible

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `typeof Observable`
- **THEN** the result SHALL be `"function"`
- **AND** `new Observable(subscriber => subscriber.complete()) instanceof Observable` SHALL be `true`

#### Scenario: EventTarget.prototype.when returns an Observable

- **GIVEN** a sandbox and `const et = new EventTarget()`
- **WHEN** guest code evaluates `et.when("custom") instanceof Observable`
- **THEN** the result SHALL be `true`

### Requirement: Safe globals — scheduler

The sandbox SHALL expose `globalThis.scheduler` as a `Scheduler` instance, plus `globalThis.TaskController`, `globalThis.TaskSignal`, and `globalThis.TaskPriorityChangeEvent`, using the `scheduler-polyfill` npm package (pinned major version 1.3, pinned in `packages/sandbox/package.json`) compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/scheduler.ts`. The polyfill is a side-effect import that self-installs on `globalThis` when `scheduler` is absent. The implementation SHALL fall back to `setTimeout` (already allowlisted) because `MessageChannel` and `requestIdleCallback` are absent; this fallback SHALL be transparent to guest code. No host bridge is used.

`scheduler.postTask(callback, options?)` SHALL accept `priority` of `"user-blocking" | "user-visible" | "background"` and SHALL accept `signal` as an `AbortSignal` or `TaskSignal`. `scheduler.yield()` SHALL return a `Promise<void>` that resolves on the next macrotask.

#### Scenario: scheduler.postTask returns a Promise

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `scheduler.postTask(() => 42) instanceof Promise`
- **THEN** the result SHALL be `true`
- **AND** awaiting the promise SHALL yield `42`

### Requirement: Safe globals — structuredClone

The sandbox SHALL expose `globalThis.structuredClone` as a pure-JS implementation compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/structured-clone.ts`. The polyfill SHALL use the `@ungap/structured-clone` npm package to run the WHATWG structured-clone algorithm, overriding the quickjs-wasi native implementation that drops wrapper objects, sparse-array length, and non-index array properties. The shim SHALL throw a `DataCloneError` `DOMException` for non-cloneable inputs (matching spec) and SHALL reject any non-empty `transfer` option with `DataCloneError` because QuickJS does not support `ArrayBuffer` detachment. Errors thrown from user code during serialization (e.g., throwing getters) SHALL propagate unchanged.

#### Scenario: Deep clone of nested object

- **GIVEN** a sandbox and `const src = { a: [1, { b: "x" }] }`
- **WHEN** guest code evaluates `const c = structuredClone(src); c.a[1].b`
- **THEN** the result SHALL be `"x"`
- **AND** `c !== src` SHALL be `true`
- **AND** `c.a !== src.a` SHALL be `true`

#### Scenario: Transfer option throws DataCloneError

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `structuredClone({}, { transfer: [new ArrayBuffer(8)] })`
- **THEN** a `DOMException` with `name === "DataCloneError"` SHALL be thrown

### Requirement: Safe globals — queueMicrotask

The sandbox SHALL expose `globalThis.queueMicrotask` as a wrapper that routes uncaught exceptions from the callback through `reportError` (which dispatches an `ErrorEvent` on `globalThis`), compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/microtask.ts`. The wrapper SHALL delegate to the native implementation for argument validation (non-callable `cb` SHALL throw a `TypeError` whose message and constructor match the native behaviour).

#### Scenario: Uncaught microtask exception routes through reportError

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `queueMicrotask(() => { throw new Error("boom"); })`
- **THEN** within one microtask, `globalThis.dispatchEvent` SHALL be invoked with an `ErrorEvent` whose `error.message` is `"boom"`
- **AND** the uncaught exception SHALL NOT crash the guest

#### Scenario: Non-callable input throws TypeError

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `queueMicrotask(null)`
- **THEN** a `TypeError` SHALL be thrown by the native implementation

### Requirement: Safe globals — indexedDB

The sandbox SHALL expose `globalThis.indexedDB` as an in-memory `IDBFactory` and SHALL expose the WebIDL interface classes `IDBFactory`, `IDBDatabase`, `IDBTransaction`, `IDBObjectStore`, `IDBIndex`, `IDBCursor`, `IDBCursorWithValue`, `IDBKeyRange`, `IDBRequest`, `IDBOpenDBRequest`, and `IDBVersionChangeEvent`. The implementation SHALL be the `fake-indexeddb` npm package compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/indexed-db.ts`; class names from `fake-indexeddb` (prefixed `FDB`) SHALL be rewritten to the WebIDL prefix `IDB` on `globalThis`. State SHALL live in a module singleton that does not outlive one sandbox run — each QuickJS VM gets a fresh module evaluation, so databases are ephemeral per-invocation. No host bridge is used; no data is persisted to disk.

The polyfill depends on `globalThis.structuredClone`. A `DOMException`-wrapping polyfill in `packages/sandbox/src/polyfills/idb-domexception-fix.ts` SHALL run before `indexed-db.ts` so `fake-indexeddb`'s subclass-`throw new DataError()` calls surface as plain `DOMException` instances. `instanceof Event` / `instanceof EventTarget` checks on `FDB`-sourced events are NOT guaranteed due to `event-target-shim` prototype conflicts; WPT subtests asserting those checks remain skipped.

#### Scenario: indexedDB is an IDBFactory

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `indexedDB instanceof IDBFactory`
- **THEN** the result SHALL be `true`

#### Scenario: Database opens and persists for the run

- **GIVEN** a sandbox
- **WHEN** guest code opens `indexedDB.open("db", 1)` with an `upgradeneeded` handler that creates an object store `"s"`, then (in a separate transaction) puts `{k:"v"}` and reads it back by key
- **THEN** the read SHALL resolve with `{k:"v"}`

### Requirement: Safe globals — User Timing (performance.mark / measure)

The sandbox SHALL extend `globalThis.performance` with `mark(name, options?)`, `measure(name, startOrOptions?, endMark?)`, `clearMarks(name?)`, `clearMeasures(name?)`, `getEntries()`, `getEntriesByType(type)`, and `getEntriesByName(name, type?)`, and SHALL expose the classes `globalThis.PerformanceEntry`, `globalThis.PerformanceMark`, and `globalThis.PerformanceMeasure`. The implementation SHALL be the pure-JS User Timing Level 3 polyfill compiled into the sandbox polyfill IIFE via `packages/sandbox/src/polyfills/user-timing.ts`, built on top of the native `performance.now` provided by the quickjs-wasi monotonic-clock extension. Timeline buffers SHALL be in-process arrays scoped to the VM lifetime. `PerformanceObserver` is NOT in scope.

The `detail` option on `mark()` and `measure()` SHALL be deep-cloned via `structuredClone` at entry-creation time (so subsequent mutations by the caller do not affect the stored entry). Invalid arguments (negative `startTime`, unresolvable mark name, `duration` conflicting with both `start` and `end`) SHALL throw a `TypeError` or `SyntaxError` `DOMException` per spec.

#### Scenario: mark records entry with startTime

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `const m = performance.mark("x"); m.name`
- **THEN** the result SHALL be `"x"`
- **AND** `m.entryType` SHALL be `"mark"`
- **AND** `m.startTime` SHALL be a number greater than or equal to zero

#### Scenario: measure between two named marks

- **GIVEN** a sandbox with `performance.mark("a"); performance.mark("b");`
- **WHEN** guest code evaluates `const m = performance.measure("ab", "a", "b"); m.entryType`
- **THEN** the result SHALL be `"measure"`
- **AND** `m.duration` SHALL be a non-negative number

#### Scenario: Unknown mark reference throws

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `performance.measure("m", "nope")`
- **THEN** a `DOMException` with `name === "SyntaxError"` SHALL be thrown

### Requirement: Hardened outbound fetch

The sandbox SHALL route outbound HTTP from `__hostFetch` through a hardened fetch implementation provided by `packages/sandbox/src/hardened-fetch.ts`. `hardenedFetch` SHALL be used as the default value of `SandboxOptions.fetch` whenever the caller omits an explicit override; a single process-wide `undici.Agent` instance SHALL back all sandboxes and SHALL be lazily created on first use. The `ipaddr.js` and `undici` npm packages SHALL be declared as explicit direct dependencies of `packages/sandbox/package.json`.

For every outbound request (initial URL and each redirect hop), `hardenedFetch` SHALL apply the following pipeline in order:

1. **Scheme allowlist.** The request URL's scheme SHALL be one of `http`, `https`, or `data`. Any other scheme SHALL throw `FetchBlockedError("bad-scheme", …)`. Any port number is permitted on http/https. `data:` URLs short-circuit steps 2–6 entirely: they carry no network component (the URL IS the payload per RFC 2397), so there is no DNS resolution, no TCP connection, and no SSRF or exfiltration vector. `data:` URLs SHALL be resolved by undici's native `fetch()` handler, which performs base64 decoding and content-type parsing per spec.

2. **DNS resolution.** The hostname SHALL be resolved via `dns.lookup(host, { all: true })`, returning the complete set of A and AAAA records without any caching layer introduced by this module.

3. **Address normalization.** Each returned address SHALL be parsed via `ipaddr.js`. IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) SHALL be unwrapped via `ipaddr.js` and re-classified as IPv4 before the blocklist check. IPv6 zone identifiers (`fe80::1%eth0` and similar) SHALL cause `FetchBlockedError("zone-id", …)`; zone IDs are meaningful only for link-local addresses which are blocked regardless.

4. **IANA special-use blocklist.** If any normalized address falls inside any of the following CIDRs, `hardenedFetch` SHALL throw `FetchBlockedError("private-ip", …)` without attempting the connection:

   - IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4`, `240.0.0.0/4`, `255.255.255.255/32`.
   - IPv6: `::1/128`, `::/128`, `fe80::/10`, `fc00::/7`, `100::/64`.

   The check SHALL fail-closed: if **any** returned address is in the blocklist, the entire request SHALL be refused — no attempt SHALL be made to pick a public address from the set.

5. **IP-bound connection.** The TCP connection SHALL be opened by passing the resolved IP address directly to the socket. For HTTPS, the TLS `servername` SHALL be the original hostname (preserving SNI and cert validation). For HTTP, the `Host` header SHALL remain the original hostname. No second DNS lookup SHALL occur between validation and connection — the resolved address set reached in step 2 is the address set used in step 5.

6. **Manual redirect handling.** Requests SHALL be issued with `redirect: "manual"`. On a 3xx response carrying a `Location` header, `hardenedFetch` SHALL parse the new URL against the previous URL, re-run the full pipeline (steps 1–5) on the resolved URL, and re-issue the request. The redirect chain SHALL be capped at **5 hops**; exceeding the cap SHALL throw `FetchBlockedError("redirect-to-private", …)` (or another reason if the subsequent hop fails validation). Cross-origin redirects SHALL strip the `Authorization` header before re-issuing.

7. **Timeout.** The total wall-clock time per top-level `fetch` call SHALL be capped at **30 seconds** via `AbortSignal.timeout(30000)`, composed with any caller-supplied `AbortSignal` via `AbortSignal.any([…])`. Exceeding either signal SHALL cancel the request.

**Error surface.** `hardenedFetch` SHALL export a `FetchBlockedError` class extending `Error` with a `reason` field of type `"bad-scheme" | "private-ip" | "redirect-to-private" | "zone-id"`. The main-thread `forwardFetch` handler in `packages/sandbox/src/index.ts` SHALL catch errors from the underlying fetch call, discriminate `FetchBlockedError`, and emit a pino warn log (see **Observability** below).

When the hardened default is in use (no `SandboxOptions.fetch` override was supplied), the handler SHALL sanitize the error reply returned to the worker to exactly `{ name: "TypeError", message: "fetch failed", stack: "" }` for every failure mode (policy block, DNS failure, TCP/TLS error, timeout, `AbortError`). Guest code SHALL NOT be able to distinguish a policy block from an unrelated network failure via the error object visible to it.

When a caller supplies `SandboxOptions.fetch` as a test override, the handler SHALL NOT sanitize: the raw error thrown by the custom fetch SHALL be serialized and delivered to the guest unchanged, so test-authored mocks can exercise specific error-path assertions. Custom overrides are a test-only surface; the security invariant (guest cannot probe private networks) holds because the caller of `sandbox(...)` with a custom fetch is not running adversarial workflow code.

**Observability.** When the main-thread `forwardFetch` handler catches a failure and a `SandboxOptions.logger` was injected at sandbox construction, the handler SHALL emit a warn-level log with message `"sandbox.fetch.blocked"` and meta fields `{ invocationId, tenant, workflow, workflowSha, url, reason }`. The `invocationId`, `tenant`, `workflow`, and `workflowSha` fields SHALL come from the enriched `__hostFetchForward` envelope sent by the worker (the worker already holds these from the `run` init message). The `reason` field SHALL be one of `"bad-scheme"`, `"private-ip"`, `"redirect-to-private"`, `"zone-id"`, or `"network-error"` (the last being a catch-all for non-`FetchBlockedError` failures). The URL field SHALL be the request URL at the point of failure (for redirect-to-private, the offending `Location` URL).

**No new invocation-event kind.** `hardenedFetch` failures SHALL NOT emit a new `InvocationEvent` kind. The existing `system.request host.fetch` event (with the URL captured in `input`) and the existing `system.error host.fetch` event (with the sanitized `TypeError`) SHALL continue to be emitted by the bridge-factory unchanged. The block reason SHALL appear only in the pino warn log.

**Test override.** A caller that passes a custom `SandboxOptions.fetch` SHALL bypass `hardenedFetch` entirely. Custom fetch implementations MAY throw `FetchBlockedError` to exercise the sanitization and logging paths; they MAY also throw any other error to exercise the network-error path.

#### Scenario: Private IPv4 address is blocked

- **GIVEN** a sandbox constructed without overriding `options.fetch`
- **AND** the hostname `internal.local` resolves to `10.0.0.1`
- **WHEN** guest code calls `fetch("http://internal.local/foo")`
- **THEN** the fetch SHALL reject with a `TypeError` whose `message` is `"fetch failed"`
- **AND** no TCP connection SHALL be opened to `10.0.0.1`
- **AND** if `options.logger` was provided, a warn log `"sandbox.fetch.blocked"` SHALL be emitted with `reason: "private-ip"`

#### Scenario: Cloud metadata endpoint is blocked

- **GIVEN** a sandbox constructed without overriding `options.fetch`
- **WHEN** guest code calls `fetch("http://169.254.169.254/latest/meta-data")`
- **THEN** the fetch SHALL reject with `TypeError("fetch failed")`
- **AND** the ops warn log SHALL record `reason: "private-ip"` and the full URL

#### Scenario: IPv4-mapped IPv6 address is blocked after unwrap

- **GIVEN** a sandbox
- **AND** the hostname `spoof.example` resolves to `::ffff:169.254.169.254`
- **WHEN** guest code calls `fetch("http://spoof.example/")`
- **THEN** the fetch SHALL reject with `TypeError("fetch failed")`
- **AND** the warn log SHALL record `reason: "private-ip"`

#### Scenario: IPv6 zone identifier is rejected

- **GIVEN** a sandbox
- **WHEN** guest code calls `fetch("http://[fe80::1%eth0]/")`
- **THEN** the fetch SHALL reject with `TypeError("fetch failed")`
- **AND** the warn log SHALL record `reason: "zone-id"`

#### Scenario: Non-http/https/data scheme is rejected

- **GIVEN** a sandbox
- **WHEN** guest code calls `fetch("file:///etc/passwd")` or `fetch("ftp://example.com/")`
- **THEN** the fetch SHALL reject with `TypeError("fetch failed")`
- **AND** the warn log SHALL record `reason: "bad-scheme"`

#### Scenario: data: URL resolves inline without network egress

- **GIVEN** a sandbox
- **WHEN** guest code calls `fetch("data:text/plain,hello")`
- **THEN** the fetch SHALL resolve with a `Response` whose `status` is `200`
- **AND** the response body SHALL be `"hello"`
- **AND** no DNS lookup or TCP connection SHALL be performed
- **AND** no `sandbox.fetch.blocked` warn log SHALL be emitted

#### Scenario: Redirect to private address is blocked

- **GIVEN** a sandbox
- **AND** `https://public.example/` responds `302 Location: http://127.0.0.1/admin`
- **WHEN** guest code calls `fetch("https://public.example/")`
- **THEN** the redirect SHALL be followed manually with validation re-run
- **AND** the fetch SHALL reject with `TypeError("fetch failed")`
- **AND** the warn log SHALL record `reason: "redirect-to-private"` and `url: "http://127.0.0.1/admin"`

#### Scenario: Redirect cap blocks runaway chains

- **GIVEN** a sandbox
- **AND** a redirect chain of 6 hops, all to public addresses
- **WHEN** guest code calls `fetch("https://chain.example/")`
- **THEN** the fetch SHALL reject with `TypeError("fetch failed")` after 5 hops

#### Scenario: Public hostname resolves to mixed private and public addresses

- **GIVEN** a sandbox
- **AND** `dual.example` resolves to `[203.0.113.10, 8.8.8.8]`
- **WHEN** guest code calls `fetch("https://dual.example/")`
- **THEN** the fetch SHALL reject with `TypeError("fetch failed")` because the first address is in the IANA blocklist (TEST-NET-3)
- **AND** no connection SHALL be attempted to either address

#### Scenario: Request exceeds 30s timeout

- **GIVEN** a sandbox
- **AND** a public server that never responds
- **WHEN** guest code calls `fetch("https://slow.example/")`
- **THEN** within 30 seconds the fetch SHALL reject with `TypeError("fetch failed")`
- **AND** the warn log SHALL record `reason: "network-error"`

#### Scenario: Test override bypasses hardenedFetch

- **GIVEN** a sandbox constructed with `options.fetch = (url, init) => new Response("ok")`
- **WHEN** guest code calls `fetch("http://127.0.0.1/")`
- **THEN** the custom fetch SHALL receive the URL
- **AND** the returned `Response` body SHALL be `"ok"`
- **AND** no policy block SHALL fire

#### Scenario: hardenedFetch is the default when options.fetch is omitted

- **GIVEN** `sandbox(source, methods)` called without `options.fetch`
- **WHEN** the sandbox-package default is installed on the main-thread forwardFetch handler
- **THEN** subsequent guest `fetch(url)` calls SHALL route through `hardenedFetch`
- **AND** a single process-wide `undici.Agent` SHALL be shared across all sandboxes

#### Scenario: Reason is not visible to guest code

- **GIVEN** a sandbox where `fetch("http://127.0.0.1/")` is about to be blocked
- **WHEN** guest code catches the rejection
- **THEN** the caught error SHALL be `TypeError`
- **AND** `err.message` SHALL be `"fetch failed"`
- **AND** the string `"private-ip"` SHALL NOT appear in `err.message`, `err.stack`, or any enumerable property on `err`

### Requirement: Plugin composition per sandbox

The sandbox SHALL accept a `plugins: Plugin[]` array at construction. Plugins SHALL be topo-sorted by `dependsOn` (cycles throw, unsatisfied dependencies throw). Plugin `worker()` functions SHALL execute in topo order; `onRunFinished` SHALL execute in reverse topo order. Plugin name collisions and guest-function name collisions SHALL throw at construction time. (Detailed plugin contract: see sandbox-plugin capability.)

#### Scenario: Topo order

- **GIVEN** plugins A (dependsOn B), B (no deps), C (dependsOn A)
- **WHEN** the sandbox is constructed
- **THEN** `worker()` calls SHALL happen in order: B, A, C
- **AND** each `deps` parameter SHALL contain the exports of its declared dependencies

### Requirement: Plugin-installed guest functions via descriptors

Guest-callable host bindings SHALL be installed exclusively via plugin-declared `guestFunctions` descriptors, not via a separate `methods` option on the factory. Each descriptor's `handler` runs worker-side. Args are marshaled per descriptor `args` spec (including `Guest.callable()` which produces a `Callable` with `.dispose()`). Result is marshaled per descriptor `result` spec. `log` controls per-call event emission (default `{ request: name }`). `public` (default false) controls visibility after phase 2.

#### Scenario: public: false auto-deleted

- **GIVEN** a descriptor `{ name: "__privateFunc", handler: ... }` with no `public` field
- **WHEN** phase-2 plugin-source evaluation completes
- **THEN** `globalThis.__privateFunc` SHALL be deleted
- **AND** user source SHALL see `typeof globalThis.__privateFunc === "undefined"`

### Requirement: Boot phase sequence

The sandbox SHALL execute boot in phases:

- **Phase 0**: Load plugin worker modules; topo-sort; instantiate WASM with WASI imports (mutable hook slots).
- **Phase 1**: For each plugin in topo order, invoke `plugin.worker(ctx, deps, config)`; register `guestFunctions` via `vm.newFunction`; populate `wasiHooks` slots; store `source`, `exports`, hooks.
- **Phase 2**: For each plugin in topo order, `vm.evalCode(plugin.source, "<plugin:${name}>")`. Plugin IIFEs capture private bindings into closures.
- **Phase 3**: For each guest function descriptor with `public !== true`, `delete globalThis[name]`.
- **Phase 4**: `vm.evalCode(userSource, filename)`.

Any failure at any phase SHALL dispose the VM, post `init-error`, `process.exit(0)` the worker.

#### Scenario: Phase 3 deletes private globals

- **GIVEN** a plugin with descriptors `{ name: "fetch", public: true }` and `{ name: "$internal", public: false }`
- **WHEN** phase 3 runs
- **THEN** `globalThis.fetch` SHALL remain accessible
- **AND** `globalThis["$internal"]` SHALL be deleted

### Requirement: WASI override dispatch via plugin hooks

The sandbox SHALL instantiate WASI imports with mutable callback slots for `clockTimeGet`, `randomGet`, and `fdWrite`. Plugin setup SHALL populate these slots via the `wasiHooks` field. Each WASI override SHALL compute the default value (real clock, real random, line-buffered decoded text), invoke the registered hook (if any) with `{ args..., defaultNs | defaultBytes | text }`, and use the hook's return value (`{ ns }` or `{ bytes }`) as override if present, else the default. Hooks run on the worker thread; hook-invoked `ctx.emit` calls produce worker-stamped events. Only one plugin MAY register each hook key; collisions throw at sandbox construction. WASI calls firing before any plugin's `worker()` has populated the slot SHALL use the default value and emit nothing. (Detailed plugin contract: see sandbox-plugin capability.)

#### Scenario: Hook collision throws

- **GIVEN** two plugins each registering `wasiHooks.clockTimeGet`
- **WHEN** sandbox is constructed
- **THEN** construction SHALL throw naming the colliding plugin names

#### Scenario: Observation does not override

- **GIVEN** a plugin with `clockTimeGet: ({ label, defaultNs }) => { ctx.emit(...); /* no return */ }`
- **WHEN** guest triggers a WASI clock call
- **THEN** `defaultNs` SHALL be returned to WASM unchanged
- **AND** a leaf event MAY have been emitted with the plugin's declared kind

#### Scenario: Override replaces result

- **GIVEN** a plugin with `clockTimeGet: () => ({ ns: 0n })`
- **WHEN** guest triggers a WASI clock call
- **THEN** `0n` SHALL be returned to WASM in place of the real clock value

