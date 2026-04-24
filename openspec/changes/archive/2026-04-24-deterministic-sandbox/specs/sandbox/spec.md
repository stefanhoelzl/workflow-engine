## MODIFIED Requirements

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
