## MODIFIED Requirements

### Requirement: Workflow-scoped VM lifecycle

The sandbox SHALL hold a single QuickJS VM instance inside its worker for its lifetime. The VM SHALL NOT be disposed by consumers between `run()` calls. After each `run()` completes, the worker SHALL asynchronously restore the VM from a snapshot taken at end of init so that guest-visible state (`globalThis` writes, module-level `let`/`const` mutations, closures over mutable module state) from one `run()` SHALL NOT be observable by subsequent `run()`s on the same sandbox instance. The restore SHALL happen off the critical path of `run()`: the `run()` promise resolves when the guest handler completes and plugin `onRunFinished` hooks fire; the next `run()` awaits any in-flight restore before executing.

Worker-side plugin state (e.g., the timers plugin's pending-timer Map, compiled action validators held on `PluginSetup`) is NOT captured in the snapshot and SHALL persist for the sandbox's lifetime. Plugins with long-lived worker-side state SHALL continue to clean up per-run residues via `onRunFinished` per the existing plugin-runtime contract.

If `QuickJS.restore()` or host-callback rebinding fails during the async restore, the worker SHALL terminate as it would for any uncaught worker error; the main-thread `onTerminated` callback SHALL fire with the restore error; subsequent `run()` calls SHALL reject.

The sandbox SHALL expose `dispose(): Promise<void>` which terminates the worker. The synchronous side-effects (marking the sandbox as disposing and rejecting any pending `run()` promise with a disposal error) SHALL execute eagerly before the returned promise is observed; the returned promise SHALL resolve when the underlying `worker.terminate()` settles. If `worker.terminate()` rejects, `dispose()` SHALL reject with that error. After `dispose()` is initiated, subsequent `run()` calls SHALL throw. Pending in-flight bridge RPC calls from the worker at termination time SHALL be abandoned on the worker side; any side effect they triggered on the main side (e.g., an `emit` that already derived a child event) remains committed.

`dispose()` SHALL be idempotent: a second invocation SHALL return the same in-flight `Promise<void>` returned by the first invocation and SHALL NOT initiate a second `worker.terminate()`. After the first invocation has settled, further invocations SHALL return a settled promise that mirrors the original outcome.

The sandbox SHALL expose `onTerminated(cb)` which registers a single callback to be invoked when the underlying worker terminates unexpectedly (WASM-level trap, uncaught worker-JS error, abnormal exit, restore failure). `onTerminated` SHALL NOT fire as a result of a normal `dispose()` call. At most one callback SHALL be invoked per sandbox instance — subsequent registrations after termination SHALL fire the callback synchronously with the recorded cause.

Consumers of the sandbox are responsible for lifecycle: a new sandbox SHALL be constructed per workflow module load, and the sandbox SHALL be disposed on workflow reload/unload. `SandboxFactory` is the supported orchestrator for this; see the `sandbox-factory` capability.

#### Scenario: Guest state does not persist across runs

- **GIVEN** a sandbox whose source has `let count = 0; export function tick(ctx) { return ++count; }`
- **WHEN** `sb.run("tick", {})` is called three times
- **THEN** the three `result` values SHALL be 1, 1, 1

#### Scenario: Dispose releases QuickJS resources

- **GIVEN** a sandbox instance
- **WHEN** `await sb.dispose()` resolves
- **THEN** the underlying worker SHALL have terminated
- **AND** subsequent `sb.run(...)` calls SHALL throw
- **AND** `onTerminated` SHALL NOT fire as a result of this dispose

#### Scenario: Dispose rejects when worker.terminate() rejects

- **GIVEN** a sandbox whose underlying `worker.terminate()` is configured (in tests) to reject with a known error
- **WHEN** `sb.dispose()` is called and awaited
- **THEN** the returned promise SHALL reject with the same underlying error

#### Scenario: Dispose is idempotent

- **GIVEN** a sandbox instance
- **WHEN** `sb.dispose()` is called twice in quick succession before either call settles
- **THEN** both invocations SHALL return the same `Promise<void>` reference
- **AND** the underlying `worker.terminate()` SHALL be invoked exactly once

#### Scenario: Cross-sandbox isolation preserved

- **GIVEN** two sandbox instances constructed from different sources
- **WHEN** both execute concurrently
- **THEN** guest-visible mutations in one sandbox SHALL NOT be observable from the other
- **AND** the two workers SHALL be distinct `worker_threads` Workers

#### Scenario: Unexpected worker death fires onTerminated

- **GIVEN** a sandbox with an `onTerminated` callback registered
- **WHEN** the worker terminates due to a WASM-level trap or uncaught worker-JS error
- **THEN** the registered callback SHALL be invoked with a `TerminationCause` describing the failure
- **AND** any pending `run()` promise SHALL reject with that error

#### Scenario: Pending run rejects on dispose

- **GIVEN** a sandbox with an in-flight `run()` promise
- **WHEN** `sb.dispose()` is called before the worker posts `done`
- **THEN** the pending `run()` promise SHALL reject with a disposal error synchronously, before the dispose promise settles

#### Scenario: Restore failure marks sandbox dead

- **GIVEN** a sandbox with an `onTerminated` callback registered, in which the async post-run restore step throws (e.g., `QuickJS.restore` or a host-callback rebind fails)
- **WHEN** the failure is observed on the worker side
- **THEN** the registered `onTerminated` callback SHALL be invoked with a `TerminationCause` describing the restore failure
- **AND** subsequent `sb.run(...)` calls SHALL reject

### Requirement: Worker-thread isolation

The sandbox SHALL execute guest code inside a dedicated Node `worker_threads` Worker. The QuickJS runtime and context SHALL live in that worker. The main thread retains only the thin Sandbox proxy that routes `run()`, `dispose()`, and `onTerminated()` to the worker and services per-run RPC requests (`request` / `response`) from it.

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

### Requirement: Sandbox factory public API

The sandbox package SHALL export a `createSandboxFactory({ logger })` factory that returns a `SandboxFactory` instance.

```ts
interface SandboxFactory {
  create(source: string, options?: SandboxOptions): Promise<Sandbox>
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

#### Scenario: Factory exposes no dispose method

- **GIVEN** a `SandboxFactory` instance
- **WHEN** the factory is inspected
- **THEN** the factory SHALL NOT expose a `dispose` method (consistent with the `Factory-wide dispose` requirement)

## ADDED Requirements

### Requirement: SandboxStore dispose error reporting

`SandboxStore.dispose()` SHALL await the underlying `Sandbox.dispose()` promise of every cached entry (which itself resolves only when the worker has actually exited) before its own returned promise resolves. The store SHALL NOT abort shutdown on the first per-entry failure: every cached sandbox SHALL be granted a dispose attempt regardless of whether sibling disposals reject.

When any per-entry `Sandbox.dispose()` rejects — whether during LRU eviction or process-shutdown drain — the store SHALL emit exactly one structured log line at `error` severity carrying the fields `{owner, sha, reason, err}`, where `reason` is the literal string `"lru"` for LRU-eviction-driven disposals and `"store-dispose"` for shutdown-drain disposals. A successful per-entry disposal SHALL NOT emit a log line at the store layer.

The store SHALL NOT swallow rejections silently. The store SHALL NOT downgrade the severity to `warn` or `info`. The store SHALL NOT collapse multiple per-entry failures into a single aggregate log line.

#### Scenario: Per-entry dispose failure is logged at error severity

- **GIVEN** a store holding a cached sandbox whose `dispose()` is configured (in tests) to reject with a known error `E`
- **WHEN** `store.dispose()` is called and awaited
- **THEN** the injected logger SHALL receive exactly one `error("sandbox dispose failed", {...})` call for that entry
- **AND** the structured fields SHALL include `owner`, `sha`, `reason: "store-dispose"`, and `err: E`

#### Scenario: One failing dispose does not strand siblings

- **GIVEN** a store holding three cached sandboxes A, B, C where `B.dispose()` rejects but `A.dispose()` and `C.dispose()` resolve
- **WHEN** `store.dispose()` is called and awaited
- **THEN** `A.dispose()`, `B.dispose()`, and `C.dispose()` SHALL each have been invoked exactly once
- **AND** `store.dispose()` SHALL resolve (not reject)
- **AND** the logger SHALL have received exactly one error log for B

#### Scenario: store.dispose() awaits actual worker exits

- **GIVEN** a store holding a cached sandbox whose `worker.terminate()` is configured (in tests) to resolve only when an external deferred is settled
- **WHEN** `store.dispose()` is called and the deferred is not yet settled
- **THEN** the promise returned by `store.dispose()` SHALL NOT have resolved
- **AND** when the deferred is settled, `store.dispose()` SHALL subsequently resolve

#### Scenario: LRU eviction failure is logged with reason "lru"

- **GIVEN** a store at the `SANDBOX_MAX_COUNT` cap and a freshly-built entry triggering LRU eviction of an idle entry whose `dispose()` rejects
- **WHEN** the LRU sweep runs
- **THEN** the logger SHALL receive exactly one `error("sandbox dispose failed", {...})` call
- **AND** the structured fields SHALL include `reason: "lru"`
