## Why

Guest workflow code currently executes inside a QuickJS VM that runs on the Node runtime's main thread. Synchronous CPU work in the guest (busy loops, large JSON parsing, tight crypto loops, module-level side effects) freezes the entire Node event loop for the duration of the run — HTTP handlers, trigger ingestion, the derive-emit pipeline, and metrics flushes all stall. The scheduler loop itself awaits every `sb.run(...)`, so the main thread is doubly blocked: parked on the run AND executing guest CPU work on the same thread.

Moving each sandbox into its own `worker_threads` worker removes the CPU blocking from the main thread. The scheduler loop still awaits run completion (ordering preserved), but the rest of the main-thread event loop keeps running concurrently with guest execution.

## What Changes

- `@workflow-engine/sandbox` spawns a dedicated `worker_threads` worker for each `sandbox()` instance. The QuickJS VM and the entire host-bridge layer (bridge-factory, bridge, crypto, globals) run inside the worker.
- Introduce a new `createSandboxFactory({ logger })` factory that owns the `Map<source, Sandbox>`, lazy-creates sandboxes, monitors worker death via a new `Sandbox.onDied` hook, and removes dead entries so the next `create(source)` spawns fresh.
- Add `worker.ts` entrypoint in `packages/sandbox/src` compiled to `dist/worker.js`, resolved via `new URL('./worker.js', import.meta.url)`.
- Define a narrow postMessage RPC protocol between main and worker: `init` / `ready` / `run` / `request` / `response` / `done`. `requestId` correlates concurrent bridge calls.
- **BREAKING** (internally): `sandbox()` bootstrap becomes eager — it resolves only after the worker has spawned, loaded QuickJS WASM, and evaluated the source. `run()`, `dispose()`, and `RunResult` semantics are preserved.
- **BREAKING** (behavior): Cancel-on-run-end. When a `run()` resolves (or throws), the worker aborts any in-flight fetches (via AbortController threaded through `bridgeHostFetch`) and clears any pending timers that the guest registered during that run. Timers / fetches no longer leak across runs. This fixes a pre-existing latent bug where a guest's `setTimeout(() => emit(...))` could fire during a subsequent run with the wrong event context.
- Scheduler (`packages/runtime/src/services/scheduler.ts`) replaces its in-house `Map<source, Sandbox>` with `factory.create(action.source)`. `pruneStaleSandboxes` stays for now (deferred cleanup is out of scope).
- Concurrent `sb.run()` on the same sandbox remains documented UB (scheduler is still sequential).
- Guest throws (Mode 1), eval failures (Mode 2), and bridge-handler throws (Mode 3) are reported via RunResult and DO NOT kill the worker. Only WASM traps (Mode 4) and worker-JS bugs (Mode 5) terminate the worker and trigger `onDied`.
- Operational events (worker created, disposed, died) flow through the factory's logger; guest-side logs continue to flow through `RunResult.logs` unchanged.
- No per-run timeout / busy-loop protection in this change — deferred.
- No circuit breaker on repeated crashes — deferred.
- No TTL / LRU eviction — deferred, but the factory is the hook point.
- No WASM module sharing across workers — deferred; mitigation for first-spawn cost is parallel spawn at workflow registration (`Promise.all` over actions).

## Capabilities

### Modified Capabilities

- `sandbox`: Worker-isolated execution replaces in-process QuickJS; adds `Sandbox.onDied` hook; adds cancel-on-run-end semantics; clarifies failure modes that kill the worker vs. those returned in `RunResult`. Introduces `createSandboxFactory({ logger })` inside the same package as the supported lifecycle owner for `Sandbox` instances — lazy-cached by source, monitors worker death, logs operational events. The strongest-isolation-boundary invariant is preserved — guest code still runs in QuickJS WASM; the host-bridge moves into the worker but exposes no new guest surface.
- `scheduler`: Replaces inline `Map<workflowName, Sandbox>` with `SandboxFactory.create(action.source)`; drops direct `sandbox()` dependency in favor of the factory.

## Impact

- **Code**:
  - `packages/sandbox/src/` — new `factory.ts`, new `worker.ts`, restructure of `index.ts` into a main-side thin proxy, small change to `bridge.ts` to accept an `AbortSignal`, small change to `globals.ts` to track per-run timer IDs for cancellation.
  - `packages/runtime/src/services/scheduler.ts` — depend on `SandboxFactory` instead of raw `sandbox()`; wire the factory at runtime construction.
  - `packages/sandbox/package.json` — `exports` field expanded to include the worker entrypoint; `tsc` emits `dist/worker.js`.
- **APIs**:
  - `@workflow-engine/sandbox` exports add `createSandboxFactory` and `SandboxFactory` type; `Sandbox` interface adds `onDied(cb)`.
  - `sandbox()` signature unchanged; behavior changes per breaking notes above.
- **Dependencies**: No new runtime dependencies. `worker_threads` is a Node built-in.
- **Build**: `tsc` already emits all `.ts` files under `src/`; adding `worker.ts` needs no build change other than an `exports` entry for discoverability.
- **Tests**: Existing sandbox test suite continues to run; each test pays a ~100–300ms worker-spawn cost. Measured overhead goal: the suite stays acceptably fast without introducing an in-process fallback. Scheduler tests that use the `sandboxFactory` injection point (already present) gain a factory-mock variant.
- **Security**: `/SECURITY.md §2` (Sandbox Boundary) SHALL be reviewed in the same change — the QuickJS boundary is functionally unchanged, but the host-bridge layer now runs in a `worker_threads` isolate instead of the main thread. No new guest surface; no weaker mitigation. The threat model's "NEVER add a global, host-bridge API, or Node.js surface to the QuickJS sandbox" rule is unaffected.
- **Deployments**: Memory footprint grows per sandbox (each worker carries its own V8 isolate + QuickJS WASM, ~15–30 MB). Realistic production (≤20 workflows) stays well under budget on the UpCloud K8s node plan. Local kind cluster unaffected.
- **Observability**: Guest-side `RunResult.logs` and dashboard timeline unchanged. New factory-scoped operational logs (created / disposed / died) are separate from `RunResult.logs`.
