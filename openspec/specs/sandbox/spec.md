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

The sandbox package SHALL export a `sandbox(source, methods, options?)` async factory that returns a `Sandbox` instance whose guest execution runs inside a dedicated `worker_threads` worker.

```ts
function sandbox(
  source: string,
  methods: Record<string, (...args: unknown[]) => Promise<unknown>>,
  options?: {
    filename?: string;
    fetch?: typeof globalThis.fetch;
    clock?: (clockId: number, precision: bigint) => bigint;
    random?: (bufPtr: number, bufLen: number, memory: WebAssembly.Memory) => void;
    memoryLimit?: number;
    interruptHandler?: () => boolean;
  }
): Promise<Sandbox>
```

The factory SHALL:

1. Spawn a fresh `worker_threads` Worker using the package-bundled entrypoint resolved via `new URL('./worker.js', import.meta.url)`.
2. Send the worker an `init` message carrying `source`, the method names of `methods`, `options.filename`, and serializable representations of `options.clock`, `options.random`, `options.memoryLimit`, and `options.interruptHandler`.
3. Register per-method main-side RPC handlers so that every `method` in `methods` is callable from guest code.
4. Inside the worker, instantiate the QuickJS WASM module via `QuickJS.create()` with the provided WASI overrides, memory limit, interrupt handler, and WASM extensions (url, encoding, base64, structured-clone, headers, crypto). Install the crypto Promise shim, the built-in host bridges (console, timers, `__hostFetch`), and the construction-time methods. Evaluate `source` as an IIFE script using `vm.evalCode(source, filename)`.
5. Wait for the worker to reply with a `ready` message confirming WASM initialization and successful source evaluation.
6. Return a `Sandbox` object whose `run()`, `dispose()`, and `onDied()` calls are routed to the worker.

The returned promise SHALL NOT resolve until the worker has reported `ready`. If source evaluation fails or the worker exits during initialization, the promise SHALL reject with the underlying error and the worker SHALL be terminated before the rejection is raised.

#### Scenario: Construction evaluates source once

- **GIVEN** a valid IIFE source string
- **WHEN** `sandbox(source, {})` is called
- **THEN** the source SHALL be evaluated exactly once inside the worker at construction time
- **AND** the returned `Sandbox` object SHALL expose `run`, `dispose`, and `onDied` methods

#### Scenario: Construction rejects on source parse error

- **GIVEN** a source string with a syntax error
- **WHEN** `sandbox(source, {})` is called
- **THEN** the returned promise SHALL reject with an error describing the syntax failure
- **AND** the spawned worker SHALL be terminated before the rejection resolves

#### Scenario: Construction-time methods are installed as globals

- **GIVEN** `sandbox(source, { hello: async (n) => n * 2 })`
- **WHEN** source code inside the sandbox calls `hello(21)`
- **THEN** the guest call SHALL resolve to `42` via an RPC round-trip between the worker and the main thread

#### Scenario: Worker fails to spawn

- **GIVEN** a host environment where `new Worker(...)` throws synchronously
- **WHEN** `sandbox(source, {})` is called
- **THEN** the returned promise SHALL reject with the spawn error

### Requirement: Public API — Sandbox.run()

The `Sandbox` interface SHALL provide a `run(name, ctx, extraMethods?)` method that invokes a named export from the source module with `ctx` as the single argument.

```ts
interface Sandbox {
  run(
    name: string,
    ctx: unknown,
    extraMethods?: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<RunResult>
  dispose(): void
  onDied(cb: (err: Error) => void): void
}
```

The method SHALL:

1. Clear the run-local log buffer (performed inside the worker as part of handling the `run` message).
2. If `extraMethods` is provided, install a per-run main-side RPC handler that dispatches `request` messages for those names into `extraMethods`. Collision between an `extraMethods` key and a reserved global or a construction-time method name SHALL throw from the main side before any message is sent to the worker.
3. Post a `run` message to the worker containing `exportName: name`, `ctx` (structured-cloned), and the names of `extraMethods`. The worker SHALL install corresponding RPC-proxy globals inside the QuickJS context whose `impl` performs a postMessage round-trip to main.
4. While the worker executes the guest, service incoming `request` messages by dispatching to `extraMethods` (or to the construction-time `methods`) and replying with `response` messages. Main-side handlers SHALL be scoped to this `run()` invocation — installed before posting `run` and removed when `done` is received.
5. On `done`, resolve with the `RunResult` payload carried in the message.

Between runs, per-run RPC handlers SHALL be removed on the main side and per-run guest globals SHALL be uninstalled inside the worker. Construction-time methods installed at init time SHALL persist across runs.

Concurrent `run()` invocations on the same `Sandbox` are documented undefined behavior; the implementation is not required to detect or serialize them.

#### Scenario: Named export called with ctx

- **GIVEN** a source with `export async function onFoo(ctx) { return ctx.n * 2; }`
- **AND** a sandbox constructed from that source
- **WHEN** `sb.run("onFoo", { n: 21 })` is called
- **THEN** the returned `RunResult` SHALL be `{ ok: true, result: 42, logs: [] }`

#### Scenario: Missing export yields error result

- **GIVEN** a sandbox whose source has no `nonexistent` export
- **WHEN** `sb.run("nonexistent", {})` is called
- **THEN** the returned `RunResult` SHALL have `ok: false` with an error describing the missing export
- **AND** the worker SHALL remain alive and usable for subsequent runs

#### Scenario: extraMethods extend construction-time methods

- **GIVEN** a sandbox constructed with `methods = { base: async () => "base" }`
- **WHEN** `sb.run("action", ctx, { extra: async () => "extra" })` is called
- **THEN** the guest SHALL see both `base` and `extra` as global functions

#### Scenario: extraMethods shadowing is rejected

- **GIVEN** a sandbox constructed with `methods = { emit: async () => {} }`
- **WHEN** `sb.run("action", ctx, { emit: async () => {} })` is called
- **THEN** the run SHALL throw a collision error before any message is sent to the worker
- **AND** no log entries SHALL be recorded for this attempt

#### Scenario: extraMethods are cleared between runs

- **GIVEN** a sandbox where `sb.run("a", ctx, { extra: f1 })` has completed
- **WHEN** `sb.run("b", ctx)` is called without `extraMethods`
- **THEN** the guest SHALL NOT see `extra` as a global

#### Scenario: Concurrent extra-method requests correlate via requestId

- **GIVEN** a guest that invokes `await Promise.all([emit("a", {}), emit("b", {})])`
- **WHEN** the worker posts two `request` messages with distinct `requestId` values
- **THEN** the main side SHALL reply to each with a matching `response` carrying the same `requestId`
- **AND** the worker SHALL resolve each pending guest promise against the correct `requestId`

### Requirement: RunResult discriminated union

The `run()` method SHALL return `Promise<RunResult>` where:

```ts
type RunResult =
  | { ok: true;  result: unknown;                       logs: LogEntry[] }
  | { ok: false; error: { message: string; stack: string }; logs: LogEntry[] }
```

The method SHALL NOT throw for errors raised inside the sandbox; errors SHALL be returned as values. The method MAY throw for host-side programming errors (e.g., invalid extraMethods collision, sandbox already disposed).

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

Every host-bridged method call (construction-time method, per-run extraMethod, `__hostFetch`, crypto operation) SHALL push an entry before returning. Console calls (`console.log`, `.info`, `.warn`, `.error`, `.debug`) SHALL push entries with `method: "console.<level>"`. The log buffer SHALL be cleared at the start of each `run()` call and SHALL NOT persist across runs.

#### Scenario: Log buffer is per-run

- **GIVEN** a sandbox where `sb.run("a", ...)` produced 3 log entries
- **WHEN** `sb.run("b", ...)` is called
- **THEN** the `b` run's `RunResult.logs` SHALL NOT contain any entries from the `a` run

#### Scenario: Failed bridge logs a failed entry

- **GIVEN** a host method that throws
- **WHEN** the sandbox invokes it
- **THEN** a `LogEntry` with `status: "failed"` and a populated `error` SHALL be pushed

### Requirement: JSON-only host/sandbox boundary

All arguments and return values crossing the host/sandbox boundary via consumer-provided `methods` or `extraMethods` SHALL be JSON-serializable. The sandbox SHALL serialize host values to JSON when passing into the VM and SHALL deserialize VM values into host-native JSON values when returning.

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

The sandbox SHALL provide a hard isolation boundary. Guest code SHALL have no access to `process`, `require`, `global` (as a Node.js object), filesystem APIs, child_process, or any Node.js built-ins.

The sandbox SHALL expose only the following globals: the host methods registered via `methods` / `extraMethods`, the built-in host-bridged globals (`console`, `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `__hostFetch`, `__reportError`), the guest-side shims (`fetch`, `reportError`, `self`, `navigator`), and the globals provided by WASM extensions (`URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `atob`, `btoa`, `structuredClone`, `Headers`, `crypto`, `performance`).

Any addition to this allowlist SHALL be made in the same change proposal that amends `/SECURITY.md §2`, with a written rationale and threat assessment per surface added.

#### Scenario: Node.js globals absent

- **GIVEN** a sandbox
- **WHEN** guest code references `process`, `require`, or `fs`
- **THEN** a `ReferenceError` SHALL be thrown inside QuickJS

#### Scenario: WASM extension globals available

- **GIVEN** a sandbox
- **WHEN** guest code references `URL`, `TextEncoder`, `Headers`, `crypto`, `atob`, `structuredClone`
- **THEN** each SHALL be a defined global provided by the WASM extensions

#### Scenario: MCA shim globals available

- **GIVEN** a sandbox
- **WHEN** guest code references `self`, `navigator.userAgent`, `reportError`
- **THEN** each SHALL be a defined global provided by the sandbox init sequence

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

The sandbox SHALL expose a `console` global with methods `log`, `info`, `warn`, `error`, `debug`. Calls SHALL push a `LogEntry` with `method: "console.<level>"`, `args: [...args]`, `status: "ok"` into the run's log buffer.

#### Scenario: console.log captures

- **GIVEN** guest code `console.log("hello", 42)`
- **WHEN** the run completes
- **THEN** `RunResult.logs` SHALL contain an entry with `method: "console.log"` and `args: ["hello", 42]`

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

The sandbox SHALL expose `globalThis.self` as a reference to `globalThis` itself. The property SHALL NOT carry any capability beyond reference identity. This global is required by the WinterCG Minimum Common API for feature-detection compatibility with npm libraries.

#### Scenario: self reflects globalThis

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `self === globalThis`
- **THEN** the result SHALL be `true`

#### Scenario: self has no additional capability

- **GIVEN** a sandbox
- **WHEN** guest code inspects the keys of `self`
- **THEN** the keys SHALL match those of `globalThis`

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

The sandbox SHALL expose `globalThis.reportError(error)` as a guest-side shim that serializes the provided error into a JSON payload `{ name, message, stack?, cause? }` and invokes the `__reportError` host-bridge method. The shim SHALL NOT dispatch a local `ErrorEvent` (EventTarget is not yet shipped). The `cause` field SHALL be recursively serialized using the same schema when present.

This is a partial implementation of the WinterCG Minimum Common API `reportError` requirement; when EventTarget is shipped in a future round, the shim SHALL evolve to also `dispatchEvent(new ErrorEvent(...))` without breaking the bridge contract.

#### Scenario: reportError forwards serialized error to host

- **GIVEN** a sandbox whose `__reportError` host-side implementation captures calls
- **WHEN** guest code calls `reportError(new Error("oops"))`
- **THEN** the host implementation SHALL receive a payload with `name: "Error"`, `message: "oops"`, and a `stack` string

#### Scenario: reportError accepts non-Error values

- **GIVEN** a sandbox
- **WHEN** guest code calls `reportError("a string")`
- **THEN** the host implementation SHALL receive `{ name: "Error", message: "a string" }` (no stack)

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

### Requirement: __hostFetch bridge

The sandbox SHALL install `globalThis.__hostFetch(method, url, headers, body)` inside the worker as an async host-bridged function that performs an HTTP request using the worker's `globalThis.fetch` (or the implementation passed via `options.fetch` at construction). The response SHALL be a JSON object `{ status, statusText, headers, body }` where `body` is the response text.

`__hostFetch` is the target of the sandbox's in-worker `fetch` shim, which builds a WHATWG-compatible `fetch` on top of the bridge. The worker SHALL install `__hostFetch` before evaluating `source` so that the `fetch` shim and any user code can reference it.

In-flight `__hostFetch` requests initiated by the guest during a `run()` SHALL be threaded with an `AbortSignal` scoped to that run. When the exported function resolves or throws, the worker SHALL abort the signal before posting `done`. Outstanding requests SHALL reject inside the guest with an `AbortError`; the guest's `done` report SHALL still be delivered.

#### Scenario: __hostFetch performs GET request

- **GIVEN** guest code calls `globalThis.__hostFetch("GET", "https://example.com/data", {}, null)`
- **WHEN** the worker's `fetch` resolves with a 200 response
- **THEN** the call SHALL resolve to `{ status: 200, statusText: ..., headers: {...}, body: "..." }`

#### Scenario: __hostFetch error logged

- **GIVEN** guest code calls `globalThis.__hostFetch("GET", "https://bad.url", {}, null)`
- **AND** the worker's `fetch` rejects
- **WHEN** the run completes
- **THEN** a `LogEntry` with `status: "failed"` SHALL be present for this call

#### Scenario: In-flight fetch is aborted on run end

- **GIVEN** guest code that calls `__hostFetch("GET", "https://slow.example", {}, null)` without awaiting it
- **WHEN** the exported function returns before the response arrives
- **THEN** the worker SHALL abort the fetch's `AbortSignal` before posting `done`
- **AND** the underlying network request SHALL be cancelled

### Requirement: __reportError host bridge

The sandbox SHALL accept a `__reportError(payload)` host method via the construction-time `methods` parameter and SHALL install it as a host-bridged global accessible from the guest. The method SHALL be write-only: the host implementation SHALL return nothing (or `undefined`) and no host state SHALL flow back to the guest through this bridge. The risk class is equivalent to the existing `console.log` channel.

`__reportError` MAY be overridden per run via `sandbox.run(name, ctx, { extraMethods: { __reportError } })`; the per-run override SHALL take precedence over the construction-time method for the duration of that run.

#### Scenario: Construction-time __reportError receives calls

- **GIVEN** `sandbox(src, { __reportError: (p) => captured.push(p) })`
- **WHEN** the guest `reportError` shim calls `__reportError(...)`
- **THEN** the construction-time implementation SHALL be invoked with the payload

#### Scenario: Per-run __reportError overrides construction-time

- **GIVEN** a sandbox constructed with a construction-time `__reportError` impl
- **AND** a `sandbox.run()` call with `extraMethods: { __reportError: runOnly }`
- **WHEN** the guest calls `__reportError(...)` during that run
- **THEN** `runOnly` SHALL be invoked
- **AND** the construction-time impl SHALL NOT be invoked

#### Scenario: No host state returns to guest

- **GIVEN** a sandbox
- **WHEN** guest code calls `const r = __reportError({message: "x"})`
- **THEN** `r` SHALL be `undefined`

### Requirement: Security context

The implementation SHALL conform to the threat model documented at `/SECURITY.md §2 Sandbox Boundary`. This capability is the single strongest isolation boundary in the system; any change to the public API, installed globals, host bridges, or VM lifecycle is a change to that boundary.

The QuickJS WASM isolation remains the primary guest/host boundary. Moving the host-bridge layer into a `worker_threads` worker does not alter the set of globals exposed to the guest and does not add a new Node.js surface visible to guest code. The worker is an implementation-level isolation layer for the host-bridge code itself, not a guest-visible change.

Changes to this capability that introduce new threats, weaken or remove a documented mitigation, change the VM lifecycle posture, alter what crosses the boundary, add a new global, or conflict with the rules in `/SECURITY.md §2` MUST update `/SECURITY.md §2` in the same change proposal. The worker-isolation change itself SHALL update `/SECURITY.md §2` to note the new execution topology (host-bridge runs in a worker isolate; only `emit` and other per-run main-side host methods cross the worker↔main boundary).

All lifecycle and security guarantees about the sandbox — VM construction, disposal, isolation, allowlisted globals, key-material containment — SHALL be codified in this capability spec rather than in consumer specs. Consumer specs (scheduler, context, workflow-loading, sdk) SHALL describe only how they use the sandbox's public API, not the sandbox's internal guarantees.

#### Scenario: Change alters sandbox boundary

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change affects entry points, installed globals, mitigations, residual risks, or rules enumerated in `/SECURITY.md §2`
- **THEN** the proposal SHALL include the corresponding updates to `/SECURITY.md §2`
- **AND** the updates SHALL be reviewed before the change is archived

#### Scenario: Change is orthogonal to the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change does not affect any item enumerated in `/SECURITY.md §2`
- **THEN** no update to `/SECURITY.md §2` is required
- **AND** the proposal SHALL note that threat-model alignment was checked

### Requirement: Worker-thread isolation

The sandbox SHALL execute guest code inside a dedicated Node `worker_threads` Worker. The QuickJS runtime and context SHALL live in that worker. The main thread retains only the thin Sandbox proxy that routes `run()`, `dispose()`, and `onDied()` to the worker and services per-run RPC requests (`request` / `response`) from it.

Each `sandbox()` call SHALL spawn exactly one worker. Workers SHALL NOT be shared across sandbox instances. The worker entrypoint SHALL be a package-shipped file at `dist/worker.js` resolved by the main side via `new URL('./worker.js', import.meta.url)`.

The worker↔main message protocol SHALL define exactly these types:

- `init` (main → worker): carries `source`, construction-time `methodNames`, and `filename`.
- `ready` (worker → main): carries no payload; SHALL NOT be sent if initialization fails.
- `run` (main → worker): carries `exportName`, `ctx`, and per-run `extraNames`.
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

- **GIVEN** a host method registered via `extraMethods` whose caller passes a function as an argument (e.g., guest code calls `someMethod(() => {})`)
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

The `SandboxFactory` SHALL be the supported lifecycle owner for `Sandbox` instances. Consumers (the scheduler and equivalent orchestrators) SHOULD depend on `SandboxFactory` rather than calling `sandbox()` directly so that death monitoring and cross-call reuse behave consistently.

#### Scenario: Factory is exported from the sandbox package

- **GIVEN** the monorepo at `packages/sandbox`
- **WHEN** a consumer imports from `@workflow-engine/sandbox`
- **THEN** `createSandboxFactory` and the `SandboxFactory` type SHALL be exported as named exports

#### Scenario: Factory accepts a logger

- **GIVEN** a consumer with an injected logger compatible with the project's `Logger` interface
- **WHEN** `createSandboxFactory({ logger })` is called
- **THEN** the returned factory SHALL retain a reference to that logger for all operational log output

### Requirement: Factory lazy-cached create

The factory SHALL implement `create(source, options?)` with lazy-cached semantics keyed on `source`:

- On the first call for a given `source`, the factory SHALL invoke the package's `sandbox(source, {}, options)` constructor, register a death handler on the returned instance, store the instance in an internal `Map<string, Sandbox>`, and resolve to that instance.
- On subsequent calls for the same `source` while the cached instance is alive, the factory SHALL resolve to the cached instance without invoking `sandbox()` a second time.
- If the cached instance has died (see "Factory death monitoring and eviction") before a subsequent call, the factory SHALL spawn a fresh instance transparently and resolve to the new one.

The `options` parameter (`SandboxOptions`) SHALL be forwarded to `sandbox()` unchanged.

#### Scenario: First call for a source constructs a new Sandbox

- **GIVEN** a freshly constructed factory with no cached sandboxes
- **WHEN** `factory.create("export const run = () => 1; export { run as default }")` is called
- **THEN** the factory SHALL invoke `sandbox(source, {}, undefined)` exactly once
- **AND** the returned `Sandbox` SHALL be the value the factory resolves with
- **AND** the instance SHALL be stored in the factory's internal cache keyed on the source string

#### Scenario: Subsequent call reuses cached instance

- **GIVEN** a factory that has already resolved a `Sandbox` for a given `source`
- **AND** the cached instance has not died
- **WHEN** `factory.create(source)` is called a second time
- **THEN** the factory SHALL resolve to the same `Sandbox` reference
- **AND** the factory SHALL NOT invoke `sandbox(...)` a second time

#### Scenario: Construction-time options are forwarded

- **GIVEN** `factory.create(source, { filename: "action.js" })`
- **WHEN** the factory invokes `sandbox(...)` for the first time
- **THEN** `options.filename` SHALL be passed through to `sandbox(source, {}, { filename: "action.js" })`

### Requirement: Factory death monitoring and eviction

For every `Sandbox` the factory creates, the factory SHALL register a death callback via `sandbox.onDied(cb)`. When the callback fires, the factory SHALL:

1. Emit a `warn`-level log entry via the injected logger, including the affected source identifier and the error message.
2. Remove the dead instance from the internal cache so that a subsequent `create(source)` call spawns a fresh instance.
3. Invoke `dispose()` on the dead instance to release any residual main-side resources.

The factory SHALL NOT respawn a replacement preemptively; replacement happens lazily on the next `create(source)` for the same source.

#### Scenario: Dead sandbox is evicted

- **GIVEN** a factory with a cached `Sandbox` for a given `source`
- **WHEN** the underlying worker dies and the sandbox's `onDied` callback fires
- **THEN** the factory SHALL remove that cache entry
- **AND** the factory SHALL log a warning via its injected logger referencing `source` and the error
- **AND** a subsequent `factory.create(source)` SHALL invoke `sandbox(...)` to construct a fresh instance

#### Scenario: Factory does not preemptively respawn

- **GIVEN** a cached `Sandbox` that dies
- **WHEN** the `onDied` callback fires but no further `create(source)` call is made
- **THEN** the factory SHALL NOT spawn a replacement

### Requirement: Factory eval-failure policy

Construction errors from `sandbox(source, ...)` (e.g., the guest module's top-level evaluation throws) SHALL propagate from `factory.create(source)` as a rejected promise. The factory SHALL NOT cache the failure. A subsequent `create(source)` call SHALL retry the full construction (spawn worker, load WASM, evaluate source).

This is intentional: `action.source` is immutable for a given workflow registration, so a retry will fail identically. Simplicity is preferred over a persistent failure cache until operational need demands otherwise.

#### Scenario: Eval failure rejects create

- **GIVEN** a source string whose top-level evaluation throws
- **WHEN** `factory.create(source)` is called
- **THEN** the returned promise SHALL reject with the underlying error

#### Scenario: Retry after eval failure is allowed

- **GIVEN** `factory.create(source)` rejected on a prior call
- **WHEN** a caller invokes `factory.create(source)` again
- **THEN** the factory SHALL invoke `sandbox(...)` again
- **AND** SHALL NOT return a cached failure value

### Requirement: Factory-wide dispose

The factory SHALL expose a `dispose(): Promise<void>` method that disposes every cached `Sandbox` instance and clears the internal cache. After `dispose()`, calls to `create(source)` SHALL behave as if the factory were freshly constructed — a new `Sandbox` SHALL be created for each source on demand.

Per-source disposal is NOT exposed in this change; TTL / LRU eviction and workflow-registry-driven invalidation are explicitly deferred.

#### Scenario: Dispose tears down all cached sandboxes

- **GIVEN** a factory with `N` cached `Sandbox` instances
- **WHEN** `factory.dispose()` is called
- **THEN** each cached instance SHALL have `dispose()` invoked on it
- **AND** the internal cache SHALL be empty after the call resolves

#### Scenario: Create after dispose spawns fresh

- **GIVEN** a factory whose `dispose()` has resolved
- **WHEN** `factory.create(source)` is called for a source that was previously cached
- **THEN** the factory SHALL invoke `sandbox(source, {}, ...)` to construct a new instance

### Requirement: Factory operational logging

The factory SHALL emit operational log entries via its injected logger for the following lifecycle events:

- `info` when a new `Sandbox` is created: include `source` and the construction duration in milliseconds.
- `info` when a `Sandbox` is disposed: include `source` and the disposal trigger (`"factory.dispose"`).
- `warn` when a `Sandbox` dies unexpectedly: include `source` and the error message.

Operational log entries SHALL NOT be merged into `RunResult.logs`; the per-run bridge log stream remains guest-only.

#### Scenario: Creation is logged

- **GIVEN** a factory with an injected spy logger
- **WHEN** `factory.create(source)` resolves for a new source
- **THEN** the logger SHALL have received at least one `info` entry referencing `source` and a numeric `durationMs`

#### Scenario: Death is logged

- **GIVEN** a cached sandbox whose worker dies
- **WHEN** `onDied` fires
- **THEN** the logger SHALL receive a `warn` entry referencing `source` and the error message

### Requirement: __hostCallAction bridge global

The sandbox SHALL install a host-bridge global `__hostCallAction(actionName, input)` available to guest code. The global SHALL accept the action's name (string) and its input (JSON-serializable value). The host SHALL: validate `input` against the action's declared input JSON Schema (from the manifest); on success, emit an audit-log entry and return `undefined`. The host SHALL NOT dispatch the action's handler --- the SDK's in-sandbox callable is the sole dispatcher, via a direct JS function call in the same QuickJS context. On input-validation failure, the host SHALL throw a serializable error back into the calling guest context.

The new global SHALL be installed alongside the existing host-bridged globals (`console`, timers, `performance`, `crypto`, `__hostFetch`) at sandbox construction time. It SHALL count as one additional surface in the host-bridge JSON-marshaled boundary documented in `/SECURITY.md S2`.

#### Scenario: Action dispatched in same sandbox via SDK wrapper

- **GIVEN** a workflow with two actions `a` and `b` loaded into one sandbox
- **AND** `a`'s handler calls `await b(input)` (the SDK callable)
- **WHEN** `a` is running
- **THEN** the SDK wrapper SHALL call `__hostCallAction("b", input)` which the host handles by validating input and audit-logging
- **AND** the SDK wrapper SHALL invoke `b`'s handler via a direct JS function call in the same QuickJS context
- **AND** the SDK wrapper SHALL validate the handler's return value against `b`'s output Zod schema using the bundled Zod
- **AND** the validated result SHALL be returned to `a`'s caller

#### Scenario: Input validation failure throws into caller; handler does not run

- **GIVEN** action `b` with `input: z.object({ x: z.number() })`
- **WHEN** the SDK wrapper invokes `__hostCallAction("b", { x: "not a number" })`
- **THEN** the host SHALL throw a validation error across the bridge
- **AND** `b`'s handler SHALL NOT execute
- **AND** the calling guest code SHALL observe the error as a thrown rejection

#### Scenario: Output validation failure throws into caller

- **GIVEN** action `b` with `output: z.string()` whose handler returns `42`
- **WHEN** the SDK wrapper invokes `b(validInput)`
- **THEN** the host bridge call SHALL succeed (input is valid)
- **AND** the handler SHALL execute and return `42`
- **AND** the SDK wrapper SHALL call the output schema's `.parse(42)` which throws
- **AND** the calling guest code SHALL observe the error as a thrown rejection

#### Scenario: Action handler exception propagates as rejection

- **GIVEN** action `b` whose handler throws `new Error("boom")`
- **WHEN** the SDK wrapper invokes `b(validInput)`
- **THEN** the host bridge call SHALL succeed
- **AND** the handler SHALL throw inside the sandbox
- **AND** the SDK wrapper SHALL let the rejection propagate to the caller

#### Scenario: Bridge is JSON-marshaled

- **GIVEN** an action input crossing the bridge
- **WHEN** input crosses the host/sandbox boundary
- **THEN** values SHALL be JSON-serializable (objects, arrays, primitives, `null`)
- **AND** non-serializable values (functions, symbols, classes) SHALL produce a serialization error

### Requirement: Action call host wiring

The runtime SHALL register `__hostCallAction` per-workflow at sandbox construction time. The host implementation SHALL look up the called action by name in the workflow's manifest, validate the input against the JSON Schema from the manifest, audit-log the invocation, and return. The host SHALL NOT invoke the handler --- dispatch is performed by the SDK wrapper inside the sandbox.

#### Scenario: Unknown action name throws

- **GIVEN** a workflow whose manifest does not contain an action named `"missing"`
- **WHEN** the guest calls `__hostCallAction("missing", input)`
- **THEN** the host SHALL throw an error indicating the action is not declared in the manifest

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

