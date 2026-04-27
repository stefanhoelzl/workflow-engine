## ADDED Requirements

### Requirement: Sandbox resource caps — two-class classification

The sandbox SHALL enforce five resource caps in two semantic classes:

- **Recoverable caps** — `memory`, `stack`. The cap is enforced inside the QuickJS VM (or at its host boundary). On breach, the sandbox SHALL survive: no eviction is triggered, no `system.exhaustion` event is emitted, and a follow-up `sb.run()` SHALL succeed. The role of these caps is to bound resource growth so that one workflow cannot exhaust the node, NOT to provide tamper-resistant tenant isolation.

  Within the recoverable class, the two dimensions differ in guest-catchability — an engine-level constraint of the QuickJS WASM build, not a design choice:
    - `memory` SHALL surface as a catchable QuickJS `InternalError: out of memory` exception inside the VM. Guest code MAY `try`/`catch` it and continue; an uncaught breach produces a `RunResult{ok:false, error}`.
    - `stack` SHALL surface as a wasm-runtime trap (e.g. `WebAssembly.RuntimeError: memory access out of bounds`) because `quickjs-wasi`'s native stack-check does not raise a JS-level `RangeError` before the wasm linear-memory stack exhausts. Guest `try`/`catch` cannot intercept the trap (the wasm call stack is unwound past it). The worker SHALL catch the trap at the host boundary (`vm.callFunction`'s catch in `worker.ts`) and produce an ordinary `RunResult{ok:false, error}`; the sandbox SHALL stay alive.
- **Terminal limits** — `cpu`, `output`, `pending`. The cap is enforced outside the guest's reach: CPU by a main-thread watchdog calling `worker.terminate()`, output and pending by a `queueMicrotask`-thrown `SandboxLimitError` on the Node thread outside any QuickJS evaluation frame. Guest code CANNOT catch a terminal breach. The worker SHALL die; the sandbox SHALL be evicted from the cache; the bus SHALL receive a `system.exhaustion` leaf and synthesised LIFO close events from `sequencer.finish`.

The configuration surface is uniform across both classes (five `SANDBOX_LIMIT_*` env vars); the breach mechanism and observability differ.

#### Scenario: Recoverable breach is catchable inside the guest

- **GIVEN** a sandbox with `memoryBytes = 1_048_576` (1 MiB) running `try { new Array(1e8).fill(1) } catch (e) { return "swallowed" } return "ok"`
- **WHEN** the allocation triggers QuickJS OOM
- **THEN** the guest's `catch` block SHALL fire with the OOM error
- **AND** the run SHALL resolve with `"swallowed"`
- **AND** NO `system.exhaustion` event SHALL be emitted
- **AND** the sandbox SHALL remain cached (no eviction)

#### Scenario: Recoverable breach uncaught yields ordinary run failure

- **GIVEN** the same sandbox running `new Array(1e8).fill(1); return "ok"` with no try/catch
- **WHEN** the allocation triggers QuickJS OOM
- **THEN** `sb.run()` SHALL resolve with `RunResult{ok:false, error:{message: /out of memory/}}`
- **AND** NO `system.exhaustion` event SHALL be emitted
- **AND** the sandbox SHALL remain cached (no eviction); a subsequent `sb.run()` SHALL succeed

#### Scenario: Terminal breach kills sandbox regardless of guest catch

- **GIVEN** a sandbox with `pendingCallables = 4` running `try { await Promise.all([...5 host calls]) } catch (e) { return "swallowed" }`
- **WHEN** the 5th callable dispatches and trips the cap
- **THEN** the worker SHALL die (the `queueMicrotask` throw bypasses the QuickJS try/catch)
- **AND** the guest's `catch` block SHALL NOT execute (control never returns to QuickJS after the throw)
- **AND** `sb.run()` SHALL reject with `Error("sandbox limit exceeded: pending")`
- **AND** the bus SHALL receive a `system.exhaustion` leaf with `name: "pending"`
- **AND** the `(owner, sha)` cache entry SHALL be evicted

### Requirement: Terminal-limit termination contract

Terminal-class breaches (`cpu`, `output`, `pending`) SHALL share a uniform termination contract. On any terminal breach the worker SHALL be terminated and the sandbox SHALL NOT be reused.

Worker-origin terminal breaches (output, pending) SHALL surface via a tagged Error: the worker constructs a plain `Error` with `err.name = "SandboxLimitError"` and an own property `err.dim` set to the dimension name (one of `"output" | "pending"`), optionally `err.observed`, and throws it via `queueMicrotask(() => { throw e })` so the throw lands on the Node thread outside any QuickJS evaluation frame. Node's structured clone SHALL preserve the `dim` and `observed` own properties when the Error is delivered to main via the worker's `error` event. The worker SHALL exit after the throw.

CPU-budget breaches SHALL be enforced main-side: a watchdog armed at the start of every `sandbox.run()` SHALL, on expiry, mark an internal `cpuBudgetExpired` flag (with `observedOnExpiry` recording elapsed milliseconds) and call `worker.terminate()`. No worker-side `error` event fires for CPU breaches; the dim value `"cpu"` is synthesized main-side.

A factory `createWorkerTermination(worker)` exported from `packages/sandbox/src/worker-termination.ts` SHALL encapsulate the correlation between Node's `error` and `exit` events, the CPU watchdog, the `SandboxLimitError` recognition, and the exactly-once `onTerminated` dispatch. It SHALL expose:

- `armCpuBudget(ms)` — starts the watchdog; called by `sandbox.run()`
- `disarmCpuBudget()` — clears the watchdog; called on run success
- `markDisposing()` — suppresses the `onTerminated` callback; called by `dispose()`
- `onTerminated(cb: (cause: TerminationCause) => void)` — fires exactly once per worker lifecycle
- `cause(): TerminationCause | null` — synchronous getter returning the same classification used in `onTerminated` dispatch; consumed by `sandbox.ts`'s `onError`/`onExit` handlers inside `sb.run()`

Where:

```
type LimitDim = "cpu" | "output" | "pending"
  // Only terminal dimensions appear in TerminationCause. Recoverable
  // dimensions (memory, stack) never reach this classification.
type TerminationCause =
  | { kind: "limit"; dim: LimitDim; observed?: number }
  | { kind: "crash"; err: Error }
```

On worker termination during a live run, `sandbox.ts` SHALL consult `termination.cause()` and:

1. If `cause.kind === "limit"`, emit a `system.exhaustion` leaf via `sequencer.next({type:"leaf", kind:"system.exhaustion", name: cause.dim, input: { budget, ...(observed ? {observed} : {}) }})`.
2. Always call `sequencer.finish({closeReason})` with `closeReason` = `\`limit:${cause.dim}\`` (limit) or `\`crash:${cause.err.message}\`` (crash). The sequencer SHALL synthesise LIFO close events for every still-open frame; the sandbox SHALL forward each through `onEvent`.
3. Reject the run promise: `Error(\`sandbox limit exceeded: ${cause.dim}\`)` for limit, `Error(\`worker exited with code ${code}\`)` for crash (existing).

#### Scenario: Worker-origin limit throw carries dim to main

- **GIVEN** a worker that executes `queueMicrotask(() => { const e = new Error("x"); e.name = "SandboxLimitError"; e.dim = "output"; e.observed = 4194305; throw e; })`
- **WHEN** the worker exits
- **THEN** `termination.cause()` SHALL return `{kind:"limit", dim:"output", observed: 4194305}`
- **AND** `onTerminated({kind:"limit", dim:"output", observed: 4194305})` SHALL fire exactly once

#### Scenario: CPU watchdog fires during tight synchronous loop

- **GIVEN** a sandbox whose `armCpuBudget(50)` was called, and guest code runs a tight synchronous loop
- **WHEN** the 50ms budget expires
- **THEN** the sandbox SHALL call `worker.terminate()` with `cpuBudgetExpired = true` set beforehand
- **AND** `termination.cause()` SHALL return `{kind:"limit", dim:"cpu", observed: <≈50>}`
- **AND** `onTerminated({kind:"limit", dim:"cpu", observed: <≈50>})` SHALL fire

#### Scenario: System.exhaustion leaf emitted on limit termination

- **GIVEN** a sandbox running an invocation that breaches the cpu budget mid-flight (cpuMs = 100)
- **WHEN** the watchdog terminates the worker
- **THEN** `sandbox.ts` SHALL emit (before any synth closes) a `system.exhaustion` leaf with `name: "cpu"`, `input.budget: 100`, `input.observed: <≈100>`
- **AND** the leaf SHALL flow through `onEvent` with seq/ref stamped by `RunSequencer`

#### Scenario: Synth closes carry "limit:dim" message

- **GIVEN** a limit termination during a run with active `trigger.request` and `action.request` frames
- **WHEN** `sequencer.finish({closeReason: "limit:cpu"})` runs
- **THEN** the synthesised closes SHALL be `system.error → action.error → trigger.error` (LIFO order)
- **AND** each close's `error.message` SHALL be `"limit:cpu"`

#### Scenario: disarm before expiry prevents firing

- **GIVEN** `armCpuBudget(60000)` was called and `disarmCpuBudget()` was called 10ms later
- **WHEN** 60 seconds pass
- **THEN** `onTerminated` SHALL NOT fire for a CPU cause
- **AND** `termination.cause()` SHALL return `null`

#### Scenario: dispose suppresses onTerminated

- **GIVEN** a sandbox where `markDisposing()` was called and then `worker.terminate()` issued
- **WHEN** the worker's `exit` event fires
- **THEN** `onTerminated` SHALL NOT be invoked
- **AND** `termination.cause()` SHALL return `null`

#### Scenario: Non-limit Error classified as crash

- **GIVEN** a worker that throws `new Error("boom")` with no `SandboxLimitError` name
- **WHEN** the worker exits
- **THEN** `termination.cause()` SHALL return `{kind:"crash", err}` with `err.message === "boom"`

#### Scenario: queueMicrotask escapes surrounding try/catch

- **GIVEN** a plugin's Callable dispatch wraps request handling in `try { ... } catch (e) { emit response-error }`
- **WHEN** the handler invokes `queueMicrotask(() => { throw new SandboxLimitError("pending") })`
- **THEN** the catch block SHALL NOT swallow the error
- **AND** the worker SHALL exit with an uncaught exception
- **AND** `onTerminated({kind:"limit", dim:"pending"})` SHALL fire main-side

### Requirement: Sandbox recoverable cap — stack

The sandbox factory SHALL accept a `stackBytes` option (positive integer). The worker SHALL apply it via `qjs_set_max_stack_size(bytes)` immediately after `QuickJS.create` and after `QuickJS.restore`. Guest code exceeding the stack depth SHALL trigger a wasm-runtime trap (because `quickjs-wasi`'s native stack-check does not raise a JS-level `RangeError` before the wasm linear-memory stack exhausts — see "Sandbox resource caps — two-class classification"). The trap unwinds the wasm call stack past any guest `try`/`catch`; the host (`vm.callFunction`'s catch in `worker.ts`) SHALL recover the trap as an ordinary run error. The sandbox SHALL stay alive; no `system.exhaustion` event SHALL be emitted; the cache SHALL NOT be evicted.

#### Scenario: Deep recursion fails the run cleanly; sandbox survives

- **GIVEN** a sandbox created with `stackBytes = 64 * 1024`
- **WHEN** guest code executes an unbounded recursion (with or without surrounding `try`/`catch` — the trap unwinds either way)
- **THEN** the wasm runtime SHALL trap on stack exhaustion
- **AND** `sb.run()` SHALL resolve with `RunResult{ok:false, error}` (the error message is the wasm-runtime message produced by the trap)
- **AND** NO `system.exhaustion` event SHALL be emitted
- **AND** the sandbox SHALL remain cached and usable for the next invocation

### Requirement: Sandbox resource limit — cpu

The sandbox factory SHALL accept a `cpuMs` option (positive integer). At the start of every `sandbox.run()` the sandbox SHALL arm a wall-clock watchdog of `cpuMs` milliseconds; on success the watchdog SHALL be disarmed. On expiry the watchdog SHALL terminate the worker and cause `onTerminated({kind:"limit", dim:"cpu", observed: <elapsed>})` to fire.

The watchdog SHALL NOT count time the sandbox spends between runs (i.e. `cpuMs` is per-`run()`, not per-sandbox-lifetime).

#### Scenario: Infinite synchronous loop terminated

- **GIVEN** a sandbox created with `cpuMs = 100`
- **WHEN** `sandbox.run("loop", {})` is called and the run body is `while(true){}`
- **THEN** after approximately 100ms the sandbox SHALL call `worker.terminate()`
- **AND** `onTerminated({kind:"limit", dim:"cpu", observed: <≈100>})` SHALL fire

#### Scenario: Legitimate run under budget completes normally

- **GIVEN** a sandbox created with `cpuMs = 60000`
- **WHEN** a run completes in 10ms
- **THEN** the watchdog SHALL be disarmed
- **AND** `onTerminated` SHALL NOT fire

### Requirement: Sandbox resource limit — output bytes

The sandbox factory SHALL accept an `outputBytes` option (positive integer). The worker SHALL maintain a counter at the worker→main `parentPort.postMessage` boundary scoped to messages whose `type === "event"`. The counter SHALL accumulate `JSON.stringify(msg.event).length` per posted event and SHALL reset to `0` at the start of each run.

On the post that would push cumulative bytes over `outputBytes`, the worker SHALL drop the in-flight event (NOT post it) and throw `SandboxLimitError` with `dim = "output"` and `observed = cumulativeIncludingBreach` via `queueMicrotask`, per the termination contract.

Control messages (`type === "ready" | "init-error" | "done" | "log"`) SHALL bypass the counter — they are fixed-shape protocol traffic, not author-emitted events, and dropping them would strand main's pending run promise or lose engine diagnostics.

#### Scenario: Cumulative event bytes exceed cap

- **GIVEN** a sandbox created with `outputBytes = 1024`
- **WHEN** guest code emits events whose cumulative `JSON.stringify(msg.event).length` reaches 1025 bytes
- **THEN** the worker SHALL drop the breaching event
- **AND** the worker SHALL throw `SandboxLimitError` with `dim = "output"` and `observed >= 1025` via `queueMicrotask`
- **AND** `onTerminated({kind:"limit", dim:"output", observed: <≥1025>})` SHALL fire

#### Scenario: Counter resets between runs

- **GIVEN** a sandbox whose previous run emitted 3 MiB of events without breach (cap is 4 MiB)
- **WHEN** a new run starts and emits 3 MiB of events
- **THEN** the new run SHALL NOT trip the cap on its own emissions

#### Scenario: Control messages bypass the cap

- **GIVEN** a sandbox whose run emits exactly `outputBytes - 100` bytes worth of events, then completes
- **WHEN** the worker posts the `done` message
- **THEN** the cap SHALL NOT count `done`'s bytes
- **AND** the run SHALL resolve normally with the result

### Requirement: Sandbox resource limit — pending callables

The sandbox factory SHALL accept a `pendingCallables` option (positive integer). The counter SHALL be maintained at `packages/sandbox/src/sandbox-context.ts#pluginRequest` — the canonical async guest→host call boundary through which fetch, mail, sql, timer, and any other plugin request flows. The counter SHALL increment on request dispatch and decrement on response/error.

On the dispatch that would push the counter over `pendingCallables`, the worker SHALL throw `SandboxLimitError` with `dim = "pending"` and `observed = newCount` via `queueMicrotask`, per the termination contract.

#### Scenario: Promise.all of many host calls trips cap

- **GIVEN** a sandbox created with `pendingCallables = 4`
- **WHEN** guest code awaits `Promise.all` of 5 simultaneous `fetch` requests
- **THEN** on the 5th request the worker SHALL throw `SandboxLimitError` with `dim = "pending"`, `observed: 5`
- **AND** `onTerminated({kind:"limit", dim:"pending", observed: 5})` SHALL fire

#### Scenario: Sequential host calls stay under cap

- **GIVEN** a sandbox created with `pendingCallables = 1`
- **WHEN** guest code performs 100 `fetch` requests sequentially (`await` between each)
- **THEN** the in-flight count SHALL never exceed 1
- **AND** `onTerminated` SHALL NOT fire

### Requirement: Eviction on sandbox termination

The `SandboxStore` SHALL register an `onTerminated` callback on every cached sandbox. On any `TerminationCause` (kind `"limit"` or `"crash"`), the store SHALL evict the corresponding `(owner, sha)` cache entry so the next `get()` rebuilds a fresh sandbox.

The `SandboxStore` SHALL be the SOLE production subscriber to `Sandbox.onTerminated`. Other components MUST NOT register an `onTerminated` callback on a cached sandbox; their lifetime/observability needs are met by other seams (factory: pure builder; executor: `sb.run()` rejection).

#### Scenario: Limit termination evicts cached entry

- **GIVEN** a `SandboxStore` caching a sandbox for `(owner="acme", sha="abc")`
- **WHEN** that sandbox's `onTerminated` fires with `{kind:"limit", dim:"cpu"}`
- **THEN** the `SandboxStore` SHALL remove the `(owner="acme", sha="abc")` entry from its cache
- **AND** a subsequent `get(owner="acme", workflow, bundleSource)` for the same sha SHALL rebuild a fresh sandbox

#### Scenario: Crash termination evicts cached entry

- **GIVEN** a `SandboxStore` caching a sandbox for `(owner="acme", sha="abc")`
- **WHEN** that sandbox's `onTerminated` fires with `{kind:"crash", err}`
- **THEN** the `SandboxStore` SHALL remove the `(owner="acme", sha="abc")` entry from its cache

## MODIFIED Requirements

### Requirement: Memory limit configuration

The sandbox factory SHALL accept a required `memoryBytes` number (positive integer, in bytes) in the options parameter. The sandbox SHALL pass it to `QuickJS.create({ memoryLimit: memoryBytes })`. Guest code that exceeds the limit SHALL trigger an `InternalError: out of memory` exception inside the QuickJS context — a recoverable in-VM exception. The guest MAY `try`/`catch` it; the sandbox SHALL NOT terminate; the worker SHALL stay alive; no `system.exhaustion` event SHALL be emitted; the cache SHALL NOT be evicted.

The factory SHALL NOT accept a sandbox without a memory limit; callers MUST supply a value. The runtime layer sources the value from `packages/runtime/src/config.ts`'s `SANDBOX_LIMIT_MEMORY_BYTES` field (see `runtime-config/spec.md`), which has a default of 64 MiB.

#### Scenario: Memory limit enforced; uncaught OOM fails the run cleanly

- **GIVEN** a sandbox created with `{ memoryBytes: 1024 * 1024 }` (1 MB)
- **WHEN** guest code attempts to allocate memory exceeding 1 MB with no `try`/`catch`
- **THEN** QuickJS SHALL raise an out-of-memory error
- **AND** `sb.run()` SHALL resolve with `RunResult{ok:false, error:{message: /out of memory/}}`
- **AND** the sandbox SHALL remain cached and usable for the next invocation

#### Scenario: Memory limit caught is swallowed

- **GIVEN** the same sandbox running `try { new Array(1e8).fill(1) } catch (e) { return "ok" }`
- **WHEN** the allocation triggers OOM
- **THEN** the catch block SHALL fire and the run SHALL resolve with `RunResult{ok:true, result:"ok"}`

### Requirement: Sandbox death notification

The sandbox SHALL expose `onTerminated(cb: (cause: TerminationCause) => void)` which registers a SINGLE callback to be invoked when the underlying worker terminates unexpectedly (resource-limit breach, WASM-level trap, uncaught worker-JS error, abnormal exit, restore failure). `onTerminated` SHALL NOT fire as a result of a normal `dispose()` call.

The callback SHALL be invoked AT MOST ONCE per sandbox instance. A subsequent `onTerminated(cb2)` registration after the worker has already terminated SHALL fire `cb2` synchronously with the recorded `TerminationCause`. Multiple calls to `onTerminated(...)` before termination SHALL be treated as a programmer error: the latest registration wins; earlier callbacks are silently overwritten. Production code SHALL register at most one callback per sandbox; in this codebase, the only production registrant is the `SandboxStore` (see "Eviction on sandbox termination").

The legacy callback name `onDied` SHALL be considered renamed: any reference to `onDied` in older specs SHALL be read as `onTerminated`. The cause shape changes from `Error` to `TerminationCause` (a discriminated union covering `{kind:"limit", dim, observed?}` and `{kind:"crash", err}`).

#### Scenario: Unexpected worker death fires onTerminated

- **GIVEN** a sandbox with an `onTerminated` callback registered
- **WHEN** the worker terminates because the underlying QuickJS context traps or an uncaught worker-JS error escapes
- **THEN** the registered `onTerminated` callback SHALL be invoked exactly once with `{kind:"crash", err}`

#### Scenario: dispose() does not fire onTerminated

- **GIVEN** a sandbox with an `onTerminated` callback registered
- **WHEN** `dispose()` is called
- **THEN** the worker SHALL be terminated
- **AND** `onTerminated` SHALL NOT fire as a result of this dispose

#### Scenario: Late registration replays cause

- **GIVEN** a sandbox whose worker has already terminated with cause `C`
- **WHEN** `onTerminated(cb)` is called after the termination
- **THEN** `cb(C)` SHALL be invoked synchronously

#### Scenario: Multiple registrations — last wins

- **GIVEN** a sandbox before termination
- **WHEN** `onTerminated(cb1)` is called, then `onTerminated(cb2)` is called, then the worker terminates with cause `C`
- **THEN** `cb2(C)` SHALL be invoked
- **AND** `cb1` SHALL NOT be invoked

### Requirement: SandboxStore lifetime is the process lifetime

The `SandboxStore` SHALL provide a public `dispose()` method that disposes every cached sandbox; this method SHALL be invoked only on process shutdown. The store MAY dispose individual sandboxes for internal cache management — specifically, when the LRU cap (`SANDBOX_MAX_COUNT`) is exceeded, or when a cached sandbox terminates abnormally (resource-limit breach or worker crash, surfaced via `onTerminated`). The store SHALL NOT expose any public per-key eviction API; eviction is exclusively an internal mechanism.

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

#### Scenario: Termination triggers internal eviction

- **GIVEN** a store holding a cached sandbox whose `onTerminated` fires
- **WHEN** the eviction handler runs
- **THEN** the cached entry for that `(owner, sha)` SHALL be removed from the store
- **AND** no public API call was made to trigger the eviction

### Requirement: Factory-wide dispose

The `SandboxFactory` SHALL be a pure builder. It SHALL NOT track lifetimes of created sandboxes and SHALL NOT expose a `dispose()` method. Callers of `factory.create()` are responsible for disposing the sandboxes they construct. In production, every sandbox is constructed via `SandboxStore`, which owns lifetimes through `SandboxStore.dispose()`. Tests that construct sandboxes directly via the factory SHALL dispose them explicitly.

#### Scenario: Factory has no lifetime tracking

- **GIVEN** a `SandboxFactory` instance
- **WHEN** the factory is inspected
- **THEN** it SHALL NOT have a `dispose()` method
- **AND** it SHALL NOT have a public `created` Set or similar lifetime-tracking field
- **AND** it SHALL NOT register an `onTerminated` callback on the sandboxes it creates
