## MODIFIED Requirements

### Requirement: Public API — sandbox() factory

The sandbox package SHALL export a `sandbox(source, methods, options?)` async factory that returns a `Sandbox` instance whose guest execution runs inside a dedicated `worker_threads` worker.

```ts
function sandbox(
  source: string,
  methods: Record<string, (...args: unknown[]) => Promise<unknown>>,
  options?: { filename?: string; fetch?: typeof globalThis.fetch }
): Promise<Sandbox>
```

The factory SHALL:

1. Spawn a fresh `worker_threads` Worker using the package-bundled entrypoint resolved via `new URL('./worker.js', import.meta.url)`.
2. Send the worker an `init` message carrying `source`, the method names of `methods`, and `options.filename`.
3. Register per-method main-side RPC handlers so that every `method` in `methods` is callable from guest code: when the worker posts a `request` with `method` ∈ `Object.keys(methods)`, the main side invokes the corresponding host function and replies with a `response`.
4. Inside the worker, instantiate the QuickJS WASM module (shared lazily across calls inside that worker isolate), create a fresh `QuickJSRuntime` and `QuickJSContext`, install the built-in host bridges (console, timers, performance, crypto, `__hostFetch`) as in-worker implementations, install each name in `methods` as a top-level QuickJS global whose `impl` is the worker-side RPC proxy described above, and evaluate `source` as an ES module with filename `options.filename` (default `"action.js"`).
5. Wait for the worker to reply with a `ready` message confirming WASM initialization and successful source evaluation.
6. Return a `Sandbox` object whose `run()`, `dispose()`, and `onDied()` calls are routed to the worker.

The returned promise SHALL NOT resolve until the worker has reported `ready`. If source evaluation fails or the worker exits during initialization, the promise SHALL reject with the underlying error and the worker SHALL be terminated before the rejection is raised. The bootstrap is eager by design.

#### Scenario: Construction evaluates source once

- **GIVEN** a valid ES-module source string
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

### Requirement: Workflow-scoped VM lifecycle

The sandbox SHALL hold a single `QuickJSRuntime` and `QuickJSContext` inside its worker for its lifetime. The context SHALL NOT be disposed between `run()` calls. Module-level state, the internal opaque-reference store, and installed globals SHALL persist across `run()`s within the same sandbox instance.

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
- **AND** opaque-reference ids from one sandbox SHALL NOT dereference in the other
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

### Requirement: Safe globals — timers

The sandbox SHALL expose `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval` implemented inside the worker using the worker's own Node timer APIs. Timer callbacks SHALL be invoked inside the QuickJS context with `executePendingJobs` pumped after each callback.

Timers that the guest registers during a `run()` invocation SHALL be tracked by the worker. When the guest's exported function resolves or throws (i.e., `run()` is about to report `done`), the worker SHALL clear every such pending timer before posting `done`. Timers SHALL NOT leak across runs.

This is a deliberate behavioral change from the prior in-process implementation, where timers persisted across runs. The new semantics eliminate cross-run callback leakage (e.g., a `setTimeout(() => emit(...), N)` that would have fired during a later run against the wrong event context).

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

### Requirement: __hostFetch bridge

The sandbox SHALL install `globalThis.__hostFetch(method, url, headers, body)` inside the worker as an async host-bridged function that performs an HTTP request using the worker's `globalThis.fetch` (or the implementation passed via `options.fetch` at construction). The response SHALL be a JSON object `{ status, statusText, headers, body }` where `body` is the response text.

`__hostFetch` is the target of the workflow bundle's `whatwg-fetch` + `MockXhr` polyfill chain (installed by vite-plugin into workflow source). The worker SHALL install `__hostFetch` before evaluating `source` so that module-level polyfill code can reference it.

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

## ADDED Requirements

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

The host-bridge implementation (`bridge-factory.ts`, `bridge.ts`, `crypto.ts`, `globals.ts` — all of `b.sync` / `b.async` surfaces and their `impl` functions) SHALL execute inside the worker isolate. The main thread SHALL implement only:

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
