## Context

The `@workflow-engine/sandbox` package currently runs each QuickJS VM in-process on the Node runtime's main thread. The scheduler (`packages/runtime/src/services/scheduler.ts`) processes events sequentially, awaiting `sb.run(...)` for each. Synchronous guest CPU work (busy loops, large JSON parsing, tight crypto loops, module-level side effects) freezes the entire Node event loop for the duration of that run — HTTP handlers, trigger ingestion, the derive-emit pipeline, and metrics flushes all stall.

The blocking is architectural: QuickJS executes synchronously between bridge yields, and the host-bridge itself runs on the same event loop. Async host methods (fetch, crypto.subtle, emit) are the only yield points. Between them, the main thread is captive to the guest.

The decision, reached through an exploratory interview (see conversation transcript), is to move each sandbox into a dedicated Node `worker_threads` Worker. The scheduler loop keeps awaiting `sb.run(...)` (so event ordering is preserved), but the main thread is free to do other work concurrently with guest execution.

Related artifacts:

- Proposal: `proposal.md`
- Spec deltas: `specs/sandbox/spec.md`, `specs/sandbox-factory/spec.md`, `specs/scheduler/spec.md`
- Threat model: `/SECURITY.md §2`

## Goals / Non-Goals

**Goals:**

- Unblock the Node main event loop during guest CPU work without changing event ordering or per-event semantics.
- Preserve the QuickJS-in-WASM guest/host isolation boundary exactly — no new guest surface, no weaker mitigations.
- Keep the public `Sandbox` API source-compatible for scheduler and test callers; the only additive surface is `Sandbox.onDied` and `createSandboxFactory`.
- Handle worker death (WASM traps, uncaught worker-JS errors) without bricking the scheduler for the affected action.
- Separate guest-side log capture (`RunResult.logs`, unchanged) from operational telemetry (factory logger, new).
- Give a stable entry point for future work: pool models, eviction/TTL, per-run timeouts, parallel scheduling.

**Non-Goals:**

- Per-run timeout or interruption of busy-loop guests. Deferred; surfaced as known gap.
- Worker pool with sticky affinity. Deferred; the Opt-1 "one worker per source" model is the starting point.
- Sharing compiled QuickJS `WebAssembly.Module` across workers. Deferred; mitigated by parallel spawn at workflow registration.
- TTL / LRU eviction for the factory cache. Deferred; `factory.dispose(source)` can be added later without API change.
- Circuit breaker on repeated crashes.
- Browser / cross-runtime worker abstraction (`threads.js`, `comlink`). Node-only for now.
- Changing `RunResult` schema, dashboard timeline, or event-store semantics.

## Decisions

### D1. Worker model: `worker_threads`, one worker per action source

**Chosen:** Node `worker_threads`. One worker per unique action source, lazily created, reused for all runs against that source.

**Alternatives considered:**

- *Pooled workers with sticky affinity.* Fixed `ceil(cpus - 1)` pool, `hash(source) % N` routes each source to one worker, which caches multiple VMs. Bounded memory, supports multi-tenant growth, but requires a dispatcher, per-worker VM cache, and eviction policy. Chosen as **Phase 2**; Opt-1 is forward-compatible (one Sandbox becomes one item in the pool's backing map).
- *Per-invocation spawn.* Strongest isolation, worst startup cost (~300ms per event). Defeats caching.
- *Abstracted `worker_threads` + Web Workers via `comlink` / `threads.js`.* Useful only if guest code also runs in browsers, which it does not.

**Rationale:** Opt-1 mirrors the existing `Map<source, Sandbox>` 1:1. Thin translation layer. Pool optimization has no blocker in this design — can swap internals when the constraint (memory pressure with many workflows) actually binds.

### D2. Factory owns lifecycle; scheduler is oblivious

**Chosen:** Introduce `createSandboxFactory({ logger })` in `@workflow-engine/sandbox`. Scheduler injects a factory and calls `factory.create(source)` per event. Death handling, eviction, and logging are inside the factory.

**Alternatives considered:**

- *Self-healing Sandbox.* `sb.run()` detects dead worker and respawns transparently. Keeps scheduler unchanged but couples respawn logic to the single-Sandbox class and hides death from observability.
- *Scheduler keeps the Map, exposes `isAlive()` on Sandbox.* Same correctness but leaks worker lifecycle concerns into the scheduler.

**Rationale:** Factory is the natural home for observability (logger), Phase-2 eviction, and workflow-registry-driven invalidation. Sandbox stays a simple "one worker, one VM" object. Scheduler stays focused on event routing.

### D3. Per-run RPC listener, no runId registry

**Chosen:** Each `sb.run()` installs scoped `message` and `error` listeners on its worker. The listener captures `extraMethods` from its lexical scope. When a `request` arrives, the listener calls `extraMethods[method](...args)` and posts the `response`. When `done` arrives, listeners are torn down and the run resolves.

**Alternatives considered:**

- *Global `Map<runId, {event, action, emit}>` on the main side; every message carries `runId`.* Needed if concurrent runs can execute on the same sandbox. But concurrent `run()` on the same sandbox is documented UB, and QuickJS is single-threaded per worker — at most one run is in flight. Closure scoping is sufficient and simpler.

**Rationale:** Zero shared state, zero `runId` plumbing, teardown is a simple event-listener removal. The UB rule makes this valid; if Phase-2 pool ever multiplexes, add a map then.

### D4. Message protocol: three types, symmetric bridge via `requestId`

**Chosen:** `init` / `ready` / `run` / `request` / `response` / `done`. `requestId` is a monotonic worker-local counter that correlates concurrent bridge calls (e.g., `await Promise.all([emit(a), emit(b)])`).

```text
  MAIN ─── {type:"init", source, methodNames, filename}          ──▶ WORKER
  MAIN ◀── {type:"ready"}                                        ─── WORKER
  MAIN ─── {type:"run", exportName, ctx, extraNames}             ──▶ WORKER
  MAIN ◀── {type:"request", requestId, method, args}             ─── WORKER
  MAIN ─── {type:"response", requestId, ok, result?, error?}     ──▶ WORKER
  MAIN ◀── {type:"done", payload}                                ─── WORKER
```

**Alternatives considered:**

- *Single `bridge` type for both call and reply, distinguished by message shape.* Equivalent but less greppable.
- *Drop `type` field, discriminate by shape alone.* Fewer bytes, more cognitive load.
- *Sequential-only protocol (no `requestId`).* Breaks the natural `Promise.all([emit(...), emit(...)])` idiom — replies may arrive out of order.

**Rationale:** `requestId` is mandatory for concurrent bridge calls (replies CAN arrive out of order since main-side `emit`'s internal `source.derive` has its own async I/O). Three types keep each direction semantically distinct without losing the symmetry between request/response.

### D5. Cancel-on-run-end

**Chosen:** When a run's guest code resolves or throws, the worker clears every `setTimeout`/`setInterval` registered during that run and aborts the per-run `AbortController` that wraps all in-flight `__hostFetch` calls.

**Alternatives considered:**

- *Let timers and fetches continue across runs (current behavior).* Preserves naive fire-and-forget, but creates the pre-existing latent bug where `setTimeout(() => emit(...), N)` fires during a later run against the wrong event context.
- *Cancel only at sandbox dispose, not per-run.* Closer to current behavior; doesn't fix the cross-run timer→emit bug.

**Rationale:** A run is now a closed unit. Fire-and-forget is expressed via `emit` (which creates a child event handled by a separate run), not via timers. The semantics align with what workflow authors probably expect. Caveat noted in docs for patterns like `void fetch('/analytics/ping')` — these must become emit-based events if they need to survive.

### D6. Eager bootstrap: `sandbox()` blocks until `ready`

**Chosen:** `sandbox(source, ...)` resolves only after the worker spawns, loads QuickJS WASM, installs bridges, evaluates the source, and posts `ready`.

**Alternatives considered:**

- *Lazy: first `run()` waits for init.* Smaller surface at the `sandbox()` call site, but moves latency into the event-dispatch path, which is harder to reason about.
- *Eager WASM, lazy source eval.* Tiny improvement; adds a state to reason about.

**Rationale:** Matches today's behavior surface: `sandbox()` is already async; eval failures surface from the factory call. Spawning sandboxes in parallel at workflow-registration time (`Promise.all(actions.map(a => factory.create(a.source)))`) compresses N workers' startup to ~one worker's latency.

### D7. Fault model: guest throws stay in-worker; WASM / bridge bugs terminate the worker

**Chosen:** Five failure modes, explicitly separated:

| Mode | Cause | Worker? | Surfaced |
|---|---|---|---|
| 1 | Guest throws inside export | Lives | `done` with `{ok:false, error}` |
| 2 | evalCode fails at load | Lives | `ready` rejects init (sandbox()/factory.create() reject) |
| 3 | Bridge handler throws (e.g., derive validation) | Lives | `response` with `{ok:false, error}` → guest await rejects |
| 4 | WASM-level trap (stack overflow escaping QuickJS, OOM) | Dies | `worker.on("exit")` → `onDied` |
| 5 | Bug in worker bridge JS code | Dies | `worker.on("error")` → `onDied` |

**Invariant:** the worker's top-level message handler wraps every dispatch in try/catch. A guest-side error MUST NOT escalate to a worker crash.

**Alternatives considered:**

- *Respawn inside Sandbox on death.* Mode 4/5 silently recovered. Hides consistent crashers from the operator.
- *Circuit breaker: after N crashes, stop respawning.* Adds a threshold to pick. Deferred.

**Rationale:** Factory-level "evict + lazy respawn" gives bounded visibility (logs on each death) without hiding repeated failures. Operator sees a stream of `warn` entries in the same way they'd see a stream of failed events today.

### D8. No caching of Mode-2 failures in the factory

**Chosen:** `factory.create(source)` that hits an eval failure rejects and does NOT cache the failure. A subsequent call retries the full construction.

**Alternatives considered:**

- *Permanent cache of the failure.* Faster on repeated events, but never recovers until factory dispose.
- *TTL cache of the failure.* Cheapest path to "try again in a minute" semantics. Adds a TTL config.

**Rationale:** Simplicity. `action.source` is immutable for a given workflow registration, so retries will fail identically until a deploy changes the source. Overhead is ~300ms per failed event — acceptable. When workflow-registry-driven invalidation lands, add cache then if needed.

### D9. Host bridge runs in the worker; only `emit` crosses to main

**Chosen:** `bridge-factory.ts`, `bridge.ts`, `crypto.ts`, `globals.ts` execute inside the worker. Their `impl` functions call worker-native `fetch`, `crypto.subtle`, timer APIs directly. `bridge-factory`'s auto-logging captures everything into `RunResult.logs` as today.

The only bridge whose `impl` crosses the worker↔main boundary is `emit` (and any other per-run or construction-time method the scheduler passes in), because the implementation closes over main-side state.

**Alternatives considered:**

- *Proxy fetch/crypto back to main via postMessage.* Preserves today's main-side visibility, but wastes a round-trip for no security benefit — the worker's process env, DNS, and filesystem are identical to main's.
- *Install new logging wrappers on `globalThis.fetch`/`crypto.subtle` inside the worker.* Redundant: `bridge-factory` already logs every `b.sync`/`b.async`. This was a misconception in an earlier revision of the design.

**Rationale:** The sandbox security boundary is QuickJS↔surrounding JS, not main↔worker. Moving the host-bridge into the worker is an implementation-level refactor, not a security change. Logging is preserved by construction.

### D10. Worker packaging: separate `dist/worker.js` via `import.meta.url`

**Chosen:** `packages/sandbox/src/worker.ts` compiled by `tsc` to `dist/worker.js`. Main-side code resolves the worker path with `new URL('./worker.js', import.meta.url)`.

**Alternatives considered:**

- *Inline the worker as an evaled string.* Worse DX (no stack traces, harder to debug), single-file but no benefit in a monorepo.
- *Bundle the worker with esbuild.* Reliable path resolution, but adds a build step the package does not currently have.

**Rationale:** ESM-native, matches the package's existing `tsc`-only build. Works in Node ≥18.

## Risks / Trade-offs

- **Worker startup latency (~150–500ms per sandbox on first create).** → Mitigate with parallel `Promise.all` spawn at workflow registration. Revisit `WebAssembly.Module` sharing only if measurements show pain after real deployment.

- **Memory footprint grows by ~15–30 MB per sandbox** (V8 isolate + QuickJS WASM + guest heap). → Realistic production (≤20 workflows on UpCloud K8s) is well under budget. If workflow count explodes, Phase-2 pool bounds this automatically.

- **Busy-loop guest still hangs its worker indefinitely** (no timeout). → Documented gap. Factory auto-evicts only on worker exit, which a busy loop never triggers. A guest that hangs will starve its sandbox cache entry and any subsequent events for that action will serialize behind the hang. Mitigation is future work: QuickJS `setInterruptHandler` with a time budget, or hard `worker.terminate()` after a threshold.

- **`WebAssembly.Module` is compiled per worker.** → Accepted until benchmarked. Mitigated by parallel spawn.

- **Test suite overhead** from per-test worker spawn (~5–10 s added). → Accept and measure. If painful, add vitest `beforeAll` per-file reuse or an env-gated in-process fallback. Not up-front.

- **Deterministic workflow crashes respawn each event (~300 ms per event).** → Acceptable signal; operator sees repeated `warn` logs. Faster feedback than silent-retry; slower than giving up entirely. Circuit breaker is deferred.

- **Fire-and-forget analytics `fetch()` pattern breaks** due to cancel-on-run-end. → Documentation note: fire-and-forget must be an `emit`-driven child event. Not a regression for current workflows (none rely on this pattern).

- **`structuredClone` on custom `Error` subclasses loses prototype chain.** → `PayloadValidationError` from `source.derive` is currently the only typed error. Guest already can't `instanceof` it (different JS runtime). Message, name, stack survive. No regression.

- **Error serialization round-trip shapes match today's bridge error shape** (`{name, message, stack}`). → Serializer lives in one place on both sides; easy to unit-test.

## Migration Plan

1. **Land factory + worker behind a new module path.** `createSandboxFactory` and `worker.ts` are additive. `sandbox()` still resolves to a worker-backed `Sandbox` — internal rewrite, same external signature. Existing sandbox tests run against the new implementation.

2. **Scheduler switches to factory injection.** `createScheduler` gains a `sandboxFactory` parameter alongside (or replacing) its `sandboxFactory?` option. Existing `sandboxFactory?` test injection points become `sandboxFactory` stubs with the new shape.

3. **Tests migrate:** sandbox test suite runs unchanged; scheduler tests that spy on sandbox creation update their mocks.

4. **Security doc update:** `/SECURITY.md §2` gets a paragraph on worker-isolation topology. No rules change.

5. **Rollout:** merge behind the main branch; there is no feature flag (internal single-tenant deployment). Runtime restart swaps in the new implementation. A rollback is a revert — the external API is unchanged.

## Open Questions

None blocking. Items that could be revisited after measurement:

- Does the real test-suite overhead warrant per-file worker reuse or in-process fallback?
- Does real production startup latency (N workflows at registration) warrant pursuing `WebAssembly.Module` sharing?
- Does any workflow author rely on fire-and-forget timers / fetches — if so, document and educate.
