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
2. Serialize each plugin into a descriptor `{ name, workerSource, guestSource?, config?, dependsOn? }` where `workerSource` is a pre-bundled ESM source string (loaded inside the worker via `data:text/javascript;base64,<...>` import) produced by the `?sandbox-plugin` vite transform at build time, `guestSource` is an OPTIONAL pre-bundled IIFE string evaluated as top-level guest script in Phase 2, and `config` is JSON-serializable data.
3. Send the worker an `init` message carrying `source`, `pluginDescriptors`, `filename`, `memoryLimit`, and `interruptHandler` (if any).
4. Inside the worker: topo-sort plugins by `dependsOn`, instantiate QuickJS WASM with WASI imports routed to mutable hook slots, invoke each plugin's `worker(ctx, deps, config)` in topo order to collect `PluginSetup`s, install `guestFunctions` as `vm.newFunction` bindings, populate `wasiHooks` slots, then run boot phases 2 (guest sources), 3 (delete private descriptor globals), 4 (user source).
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

The sandbox SHALL install no Node.js-specific globals. Node core modules (`fs`, `net`, `http`, `process`, etc.) SHALL NOT be reachable from guest code. The sandbox core SHALL install no plugin-style host descriptors on `globalThis` — every guest-visible global comes from one of two sources:

1. **VM-level extensions** loaded by `worker.ts` into the QuickJS runtime via `extensions: [base64Extension, cryptoExtension, encodingExtension, headersExtension, structuredCloneExtension, urlExtension]` (see "VM-level web-platform surface via quickjs-wasi extensions" requirement). These provide `atob`, `btoa`, `TextEncoder`, `TextDecoder`, `Headers`, `URL`, `URLSearchParams`, native `crypto.getRandomValues`, native `crypto.subtle`, and native `DOMException`.
2. **Plugin-installed globals** from `sandbox-stdlib` (web-platform, fetch, timers, console plugins) and from runtime/sdk plugins (sdk-support installs `__sdk`; trigger and host-call-action install no guest functions; wasi-telemetry installs none). Each comes with an explicit `GuestFunctionDescription` or an in-source IIFE that runs at Phase 2.

#### Scenario: Node.js core modules unreachable

- **GIVEN** a sandbox post-init
- **WHEN** guest code evaluates `typeof require`, `typeof process`, `typeof Buffer`, `typeof global`
- **THEN** each SHALL be `"undefined"`

#### Scenario: Sandbox-core install set is documented

- **GIVEN** a production sandbox composition
- **WHEN** auditing every global installed before Phase 2 plugin source evaluation
- **THEN** the set SHALL equal the union of the VM-level extensions listed in the "VM-level web-platform surface via quickjs-wasi extensions" requirement

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

The sandbox SHALL hold a single QuickJS VM instance inside its worker for its lifetime. The VM SHALL NOT be disposed by consumers between `run()` calls. After each `run()` completes, the worker SHALL asynchronously restore the VM from a snapshot taken at end of init so that guest-visible state (`globalThis` writes, module-level `let`/`const` mutations, closures over mutable module state) from one `run()` SHALL NOT be observable by subsequent `run()`s on the same sandbox instance. The restore SHALL happen off the critical path of `run()`: the `run()` promise resolves when the guest handler completes and plugin `onRunFinished` hooks fire; the next `run()` awaits any in-flight restore before executing.

Worker-side plugin state (e.g., the timers plugin's pending-timer Map, compiled action validators held on `PluginSetup`) is NOT captured in the snapshot and SHALL persist for the sandbox's lifetime. Plugins with long-lived worker-side state SHALL continue to clean up per-run residues via `onRunFinished` per the existing plugin-runtime contract.

If `QuickJS.restore()` or host-callback rebinding fails during the async restore, the worker SHALL terminate as it would for any uncaught worker error; the main-thread `onDied` callback SHALL fire with the restore error; subsequent `run()` calls SHALL reject.

The sandbox SHALL expose `dispose()` which terminates the worker. Termination SHALL reject any pending `run()` promise with a disposal error. After `dispose()`, subsequent `run()` calls SHALL throw. Pending in-flight bridge RPC calls from the worker at termination time SHALL be abandoned on the worker side; any side effect they triggered on the main side (e.g., an `emit` that already derived a child event) remains committed.

The sandbox SHALL expose `onDied(cb)` which registers a single callback to be invoked when the underlying worker terminates unexpectedly (WASM-level trap, uncaught worker-JS error, abnormal exit, restore failure). `onDied` SHALL NOT fire as a result of a normal `dispose()` call. At most one callback SHALL be invoked per sandbox instance — subsequent registrations after death SHALL fire the callback synchronously with the recorded death error.

Consumers of the sandbox are responsible for lifecycle: a new sandbox SHALL be constructed per workflow module load, and the sandbox SHALL be disposed on workflow reload/unload. `SandboxFactory` is the supported orchestrator for this; see the `sandbox-factory` capability.

#### Scenario: Guest state does not persist across runs

- **GIVEN** a sandbox whose source has `let count = 0; export function tick(ctx) { return ++count; }`
- **WHEN** `sb.run("tick", {})` is called three times
- **THEN** the three `result` values SHALL be 1, 1, 1

#### Scenario: Dispose releases QuickJS resources

- **GIVEN** a sandbox instance
- **WHEN** `sb.dispose()` is called
- **THEN** the underlying worker SHALL be terminated
- **AND** subsequent `sb.run(...)` calls SHALL throw
- **AND** `onDied` SHALL NOT fire as a result of this dispose

#### Scenario: Cross-sandbox isolation preserved

- **GIVEN** two sandbox instances constructed from different sources
- **WHEN** both execute concurrently
- **THEN** guest-visible mutations in one sandbox SHALL NOT be observable from the other
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

#### Scenario: Restore failure marks sandbox dead

- **GIVEN** a sandbox with an `onDied` callback registered, in which the async post-run restore step throws (e.g., `QuickJS.restore` or a host-callback rebind fails)
- **WHEN** the failure is observed on the worker side
- **THEN** the registered `onDied` callback SHALL be invoked with an `Error` describing the restore failure
- **AND** subsequent `sb.run(...)` calls SHALL reject

### Requirement: Safe globals — performance.now

The sandbox SHALL expose `performance.now()` via the QuickJS performance intrinsic, which reads time through the WASI `clock_time_get` syscall with `clockId = CLOCK_MONOTONIC`. The worker's `CLOCK_MONOTONIC` override SHALL return `perfNowNs() − anchorNs` where `anchorNs` is the shared monotonic anchor (`wasiState.anchor.ns`). The anchor is seeded at worker init BEFORE `QuickJS.create` (so the cached reference that QuickJS takes for `performance.now()` starts near zero during VM init) and is re-anchored for each run by the plugin-lifecycle's `onBeforeRunStarted` hook on the trigger plugin. Guest `performance.now()` SHALL therefore start near zero at the beginning of each run and increase monotonically within that run.

#### Scenario: performance.now returns monotonically increasing values within a run

- **GIVEN** a sandbox in an active run
- **WHEN** guest code calls `performance.now()` twice in sequence
- **THEN** the second value SHALL be greater than or equal to the first

#### Scenario: performance.now starts near zero at the start of each run

- **GIVEN** a cached sandbox that has completed a prior run
- **WHEN** a new run begins and guest code calls `performance.now()` as the first monotonic read of that run
- **THEN** the returned value SHALL be within a small epsilon of `0`

### Requirement: Safe globals — DOMException

The sandbox SHALL expose `globalThis.DOMException` as the class installed by the quickjs-wasi `structuredCloneExtension` (see "VM-level web-platform surface via quickjs-wasi extensions"). The class SHALL construct with `(message, name)` and provide `name` and `message` properties; instances SHALL satisfy `instanceof Error` and `instanceof DOMException`.

The final guest-visible `DOMException` is a construct-trap `Proxy` wrapper installed by `sandbox-stdlib`'s web-platform plugin (`idb-domexception-fix.ts`) to make fake-indexeddb's subclass `throw new DataError()` land as a plain DOMException instance. See `sandbox-stdlib` for the wrapper.

#### Scenario: DOMException instances pass instanceof checks

- **GIVEN** a sandbox post-init
- **WHEN** guest code evaluates `new DOMException("oops", "DataError") instanceof DOMException` and `... instanceof Error`
- **THEN** both SHALL be `true`

#### Scenario: DOMException is consumed by AbortController / AbortSignal

- **GIVEN** an AbortController from the web-platform plugin
- **WHEN** guest code calls `controller.abort()` without an explicit reason
- **THEN** `controller.signal.reason` SHALL be a DOMException with `name === "AbortError"`

### Requirement: WebCrypto surface

The sandbox SHALL expose the native WebCrypto handles provided by the quickjs-wasi `cryptoExtension`:

- `crypto.getRandomValues(typedArray)` — synchronous CSPRNG fill.
- `crypto.subtle` — PSA-backed subtle crypto handle with digest, key generation, sign/verify, import/export, encrypt/decrypt operations.

The final guest-visible `crypto.subtle` is wrapped by `sandbox-stdlib`'s web-platform plugin (`subtle-crypto.ts`) to add argument validation, sync-to-promise wrapping (the native methods are synchronous; WHATWG SubtleCrypto returns Promises), and DOMException-name normalization. See `sandbox-stdlib` for the wrapper.

Native key material SHALL remain inside WASM linear memory; `CryptoKey` objects SHALL expose read-only `type`, `algorithm`, `extractable`, `usages` but SHALL NOT cross the host/guest boundary. No opaque reference store SHALL be used for crypto keys.

#### Scenario: getRandomValues fills buffer

- **WHEN** guest code calls `crypto.getRandomValues(new Uint8Array(32))`
- **THEN** the typed array SHALL be returned with 32 random bytes

#### Scenario: CryptoKey metadata readable

- **GIVEN** a CryptoKey generated inside the sandbox
- **WHEN** guest code reads `key.type`, `key.algorithm`, `key.extractable`, `key.usages`
- **THEN** the values SHALL match the generation parameters

#### Scenario: Non-extractable key cannot be exported

- **GIVEN** a CryptoKey with `extractable: false`
- **WHEN** guest code calls `crypto.subtle.exportKey(format, key)`
- **THEN** the promise SHALL reject

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

- **Phase 0**: Load plugin worker modules from `descriptor.workerSource` via `data:text/javascript;base64,<...>` dynamic `import()`; topo-sort; instantiate WASM with WASI imports (mutable hook slots).
- **Phase 1**: For each plugin in topo order, invoke `plugin.worker(ctx, deps, config)`; register `guestFunctions` via `vm.newFunction`; populate `wasiHooks` slots; store `exports`, hooks.
- **Phase 2**: For each plugin in topo order, if `descriptor.guestSource` is defined, `vm.evalCode(descriptor.guestSource, "<plugin:${name}>")`. Plugin IIFEs capture private bindings into closures.
- **Phase 3**: For each guest function descriptor with `public !== true`, `delete globalThis[name]`.
- **Phase 4**: `vm.evalCode(userSource, filename)`.

Any failure at any phase SHALL dispose the VM, post `init-error`, `process.exit(0)` the worker.

#### Scenario: Phase 3 deletes private globals

- **GIVEN** a plugin with descriptors `{ name: "fetch", public: true }` and `{ name: "$internal", public: false }`
- **WHEN** phase 3 runs
- **THEN** `globalThis.fetch` SHALL remain accessible
- **AND** `globalThis["$internal"]` SHALL be deleted

#### Scenario: Plugin without guestSource skips phase 2 evaluation

- **GIVEN** a plugin whose descriptor omits `guestSource`
- **WHEN** phase 2 iterates to that plugin
- **THEN** no `vm.evalCode` call SHALL be made for it
- **AND** iteration SHALL continue to the next plugin without error

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

### Requirement: VM-level web-platform surface via quickjs-wasi extensions

The sandbox core's `worker.ts` SHALL load the following six `quickjs-wasi` extensions into the QuickJS runtime at Phase 1, via the `extensions` option of `QuickJS.create()`:

| Extension | Guest-visible globals |
|---|---|
| `base64Extension` | `atob`, `btoa` |
| `encodingExtension` | `TextEncoder`, `TextDecoder` |
| `headersExtension` | `Headers` |
| `urlExtension` | `URL`, `URLSearchParams` |
| `cryptoExtension` | `crypto.getRandomValues`, `crypto.subtle` (native handle) |
| `structuredCloneExtension` | `DOMException` (native class; also provides native `structuredClone` which is overridden at Phase 2 by the stdlib web-platform plugin) |

These extensions are the ONLY guest-visible globals installed by the sandbox core before plugin source evaluation (Phase 2). Every other guest-visible global comes from a plugin in `sandbox-stdlib`, the runtime, or the SDK.

The `TextEncoderStream` / `TextDecoderStream` classes, the overriding `structuredClone`, and the wrapped forms of `crypto.subtle` / `DOMException` come from the `sandbox-stdlib` web-platform plugin at Phase 2; they are NOT VM-level.

#### Scenario: VM-level globals exist before Phase 2

- **GIVEN** a sandbox composition with NO plugins (empty `plugins: []`)
- **WHEN** post-init guest code evaluates `typeof URL`, `typeof URLSearchParams`, `typeof Headers`, `typeof TextEncoder`, `typeof TextDecoder`, `typeof atob`, `typeof btoa`, `typeof crypto.getRandomValues`, `typeof crypto.subtle`, `typeof DOMException`
- **THEN** each SHALL be `"function"` (or `"object"` for `crypto.subtle`)

#### Scenario: Adding a new VM-level global requires extending this list

- **WHEN** a future change adds a new `quickjs-wasi` extension to `createOptions.extensions` in `worker.ts`
- **THEN** this requirement's table SHALL be extended in the same change
- **AND** SECURITY.md §2 "Globals surface" SHALL be extended in the same change

### Requirement: SandboxStore provides per-`(tenant, sha)` sandbox access

The runtime SHALL provide a `SandboxStore` component that maps `(tenant, workflow.sha)` pairs to `Sandbox` instances. The store SHALL be the sole runtime-internal accessor for workflow sandboxes. The store SHALL build sandboxes lazily on the first `get` for a given key and SHALL hold them for the lifetime of the store.

```ts
interface SandboxStore {
  get(
    tenant: string,
    workflow: WorkflowManifest,
    bundleSource: string,
  ): Promise<Sandbox>;
  dispose(): void;
}
```

Different tenants with identical `workflow.sha` values SHALL get distinct sandbox instances (per `SECURITY.md §1 I-T2` — tenant isolation). Different shas within a tenant SHALL get distinct sandboxes; the old sandbox SHALL remain until `dispose()` is called.

#### Scenario: First get for a key builds a new sandbox

- **GIVEN** a freshly constructed `SandboxStore`
- **WHEN** `store.get(tenant, workflow, bundleSource)` is called for the first time
- **THEN** the store SHALL construct a new sandbox via the injected `SandboxFactory`
- **AND** retain a reference keyed on `(tenant, workflow.sha)`

#### Scenario: Subsequent get for the same key reuses the sandbox

- **GIVEN** a store with a cached sandbox for `(tenant, workflow.sha)`
- **WHEN** `store.get(tenant, workflow, bundleSource)` is called with matching tenant + sha
- **THEN** the store SHALL resolve to the same sandbox reference
- **AND** it SHALL NOT invoke the factory

#### Scenario: Different tenants with identical shas get distinct sandboxes

- **GIVEN** two tenants `A` and `B` registering workflows with byte-identical bundles
- **WHEN** `store.get("A", workflow, ...)` and `store.get("B", workflow, ...)` are both called
- **THEN** the store SHALL return two distinct sandbox instances
- **AND** module-scope mutations in `A`'s sandbox SHALL NOT be observable from `B`'s sandbox

### Requirement: SandboxStore composes the production plugin catalog

The SandboxStore SHALL compose a standard plugin catalog for every production sandbox, in a fixed order compatible with plugin `dependsOn` declarations:

```ts
plugins: [
  createWasiPlugin(runtimeWasiTelemetry),   // sandbox package (WASI routing)
  createWebPlatformPlugin(),                // sandbox-stdlib (all safe-globals)
  createFetchPlugin(),                      // sandbox-stdlib (hardenedFetch default)
  createTimersPlugin(),                     // sandbox-stdlib
  createConsolePlugin(),                    // sandbox-stdlib
  createHostCallActionPlugin({ manifest }), // runtime (Ajv validators from manifest)
  createSdkSupportPlugin(),                 // sdk (__sdk.dispatchAction)
  createTriggerPlugin(),                    // runtime (trigger.* lifecycle emission)
]
```

`runtimeWasiTelemetry` SHALL be a setup function exported by the runtime that emits `wasi.clock_time_get` / `wasi.random_get` / `wasi.fd_write` leaf events. The store SHALL NOT append any dispatcher source to the workflow bundle; the SDK's `createSdkSupportPlugin` owns dispatcher logic.

Test compositions MAY omit the trigger plugin and wasi-telemetry when a silent sandbox is desired; that concern lives at the test-fixture layer, not in the production store.

#### Scenario: Production composition loads all eight plugins

- **WHEN** a production sandbox is constructed
- **THEN** the plugin list SHALL include the eight plugins named above
- **AND** the plugin composition's topological sort SHALL be valid
- **AND** sandbox construction SHALL complete without error

#### Scenario: No dispatcher source is appended

- **GIVEN** a tenant workflow bundle
- **WHEN** the SandboxStore constructs the sandbox
- **THEN** `sandbox({source: <bundle>, plugins: [...]})` SHALL be called with `source` unmodified
- **AND** no runtime-side source SHALL be concatenated, prepended, or appended

### Requirement: SandboxStore lifetime is the process lifetime

The `SandboxStore` SHALL NOT dispose individual sandboxes during normal operation. The store SHALL provide a public `dispose()` method that disposes every cached sandbox; this method SHALL be invoked only on process shutdown. The store SHALL NOT expose any public API for per-key eviction.

Re-upload of a workflow with a new `sha` SHALL NOT dispose the old-sha sandbox. In-flight invocations dispatched to the old-sha sandbox SHALL complete against it; new invocations after re-upload SHALL dispatch to the new-sha sandbox (built on demand if not yet cached).

#### Scenario: Re-upload preserves the old sandbox

- **GIVEN** a store holding a sandbox for `(tenant, oldSha)`
- **WHEN** the same tenant re-registers the workflow with a new sha
- **THEN** the `(tenant, oldSha)` sandbox SHALL remain
- **AND** SHALL NOT be disposed

#### Scenario: In-flight invocation completes on the orphaned sandbox

- **GIVEN** an in-flight invocation dispatched to the `(tenant, oldSha)` sandbox
- **WHEN** the tenant re-uploads with a new sha before the invocation completes
- **THEN** the in-flight invocation SHALL complete against `(tenant, oldSha)`
- **AND** the next invocation post-reupload SHALL dispatch to `(tenant, newSha)`

#### Scenario: Process shutdown disposes every cached sandbox

- **GIVEN** a store holding multiple cached sandboxes
- **WHEN** `store.dispose()` is called
- **THEN** every cached sandbox SHALL have its `dispose()` called
- **AND** all references SHALL be released

### Requirement: SandboxStore factory shape

The `SandboxStore` SHALL be constructed via `createSandboxStore({ sandboxFactory, logger })`. The store SHALL delegate sandbox construction to `sandboxFactory.create(source, options)` and SHALL emit info-level log entries on cache miss (sandbox constructed).

#### Scenario: Factory delegation

- **WHEN** `createSandboxStore({sandboxFactory, logger})` is called
- **THEN** the returned store SHALL retain both dependencies
- **AND** every cache-miss `get` SHALL call `sandboxFactory.create(source, options)` exactly once

### Requirement: SandboxStore onEvent stamps runtime metadata

On every sandbox creation, the SandboxStore SHALL register an `onEvent` callback that stamps `tenant`, `workflow`, `workflowSha`, and `invocationId` onto every incoming event before forwarding it to the bus. The metadata SHALL come from the "current run" state tracked by the store (populated when `sandbox.run()` is invoked, cleared after it returns).

This stamping is the load-bearing point for `SECURITY.md §2 R-8` (tenant/workflow/workflowSha/invocationId never stamped from inside sandbox or plugin code) and `SECURITY.md §1 I-T2` (tenant isolation invariant on invocation-event writes). `meta.dispatch` is separately stamped by the executor's `sb.onEvent` widener, gated on `event.kind === "trigger.request"` per SECURITY.md §2 R-9 (scope of `cleanup-specs-content`).

#### Scenario: Metadata stamping on event forward

- **GIVEN** a sandbox emitting events during an active run
- **WHEN** any event flows from the sandbox to the store's `onEvent` callback
- **THEN** the callback SHALL attach `tenant` / `workflow` / `workflowSha` / `invocationId` from the current run context
- **AND** the stamped event SHALL reach `bus.emit`
- **AND** `tenant` SHALL match the tenant that owns the cached sandbox (invariant I-T2)


### Requirement: Sandbox exposes isActive

The `Sandbox` interface returned by `sandbox(opts)` SHALL expose a read-only `isActive: boolean` property (or getter) that returns `true` iff a `run()` call is currently in flight against the sandbox, and `false` otherwise. The value SHALL be `true` synchronously from the moment `run()` is invoked until the moment its returned promise settles; it SHALL be `false` at every other time, including between runs and after `dispose()`.

This property exists so that out-of-band callers (e.g. a cache reclaiming idle sandboxes) can safely decide whether disposing a sandbox would race an in-flight run. It is a pure read of the sandbox's existing internal concurrent-run guard; it does NOT introduce any new synchronisation, queueing, or refcounting.

#### Scenario: Idle sandbox reports not active

- **GIVEN** a sandbox created via `sandbox(opts)` with no `run()` call in flight
- **WHEN** a caller reads `sandbox.isActive`
- **THEN** it SHALL be `false`

#### Scenario: Running sandbox reports active

- **GIVEN** a sandbox whose `run(name, ctx)` has been invoked and whose returned promise has not yet settled
- **WHEN** a caller reads `sandbox.isActive` between the `run()` call and its resolution
- **THEN** it SHALL be `true`

#### Scenario: Settled run reports not active

- **GIVEN** a sandbox whose `run()` promise has resolved (ok or error)
- **WHEN** a caller reads `sandbox.isActive` after the settlement microtask
- **THEN** it SHALL be `false`
