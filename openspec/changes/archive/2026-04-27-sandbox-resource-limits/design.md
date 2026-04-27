## Context

The QuickJS sandbox in `packages/sandbox` today has no enforced resource limits. `memoryLimit` is plumbed from `SandboxOptions` → worker `init` message → `QuickJS.create({ memoryLimit })`, but the runtime (`packages/runtime/src/main.ts`) never sets it. Sandboxes are cached per `(owner, sha)` in `sandbox-store.ts` and reused across many invocations; between invocations, guest state is reset via a post-init snapshot restore (SECURITY.md §2 R-10), but host-side plugin state and the QuickJS heap persist for the sandbox's lifetime.

Under the project's hostile-multi-tenant threat model, the absence of limits means a single misbehaving or adversarial workflow can exhaust node resources and DoS every tenant sharing the pod.

This change builds on the post-rebase architecture introduced in commit `2737b338` (main-owned seq/ref stamping + system.* prefix consolidation):

- `RunSequencer` (main-thread) stamps `seq` and `ref` from worker-emitted wire events; the worker no longer mints those fields.
- Wire events carry `type: "leaf" | {open: callId} | {close: callId}` so framing is decoupled from kind strings.
- `sequencer.finish({closeReason})` is THE death-path synthesis primitive: it emits LIFO synthetic close events for every still-open frame, naturally seq/ref-stamped.
- Reserved event prefixes shrunk to three: `trigger`, `action`, `system`. Seven host-call prefixes (fetch/mail/sql/timer/console/wasi/uncaught-error) folded into `system.*` with a `name` discriminator.
- `SECURITY.md §2 R-8` splits the stamping boundary: bridge-stamped (worker), Sandbox-stamped (main RunSequencer), runtime-stamped (executor `sb.onEvent` widener).

Resource-limit detection and termination plug into these primitives rather than fabricating their own seq/ref or event-synthesis pipeline.

## Goals / Non-Goals

**Goals:**
- Enforce five resource dimensions per run: memory, stack, CPU wall-clock, output bytes, concurrent pending host-callables.
- Uniform termination contract: every breach terminates the worker and evicts the cached sandbox. No clean-throw escape; hostile tenants cannot catch-and-retry past a cap.
- Death-path event synthesis flows through `RunSequencer` — no manual seq/ref fabrication anywhere.
- Configuration lives in `packages/runtime/src/config.ts` zod schema with defaults in the schema itself (one source of truth, visible in PR review, no Dockerfile drift).
- Dimension name carried structurally through the sandbox→executor boundary, not string-parsed from error messages.
- Single-subscriber `onTerminated` API. `sandbox-store` is the sole production subscriber.

**Non-Goals:**
- Per-workflow manifest-declared budgets (authors cannot raise or lower limits).
- Per-owner tiers (no `owner → tier → limits` store).
- Timer-count cap, fetch-count cap, mail-count cap (pending-callables + CPU already cover these).
- Network-bandwidth cap (below the OS boundary; out of scope).
- SDK surface changes. `workflows/src/demo.ts` stays unchanged.
- Self-restoring Sandbox semantics (Sandbox transparently spawning a new worker after termination). Considered and rejected for this PR — viable as a future change if breach-and-recover becomes a hot path.
- Reserved-prefix runtime guard test. Author code has no SDK API for emitting arbitrary event kinds; reserved prefixes are docs/review convention enforced by code review of plugin contributors.

## Decisions

### D1. Two classes of caps: recoverable (in-VM) vs terminal (sandbox-level)

The five enforced dimensions split into two semantic classes, distinguished by whether the guest can catch the breach and continue.

| Class | Dimension | Detection site | Guest can catch? | Sandbox survives? | Bus event |
|---|---|---|---|---|---|
| **Recoverable** | memory | QuickJS native (in-VM) | YES — catchable `InternalError: out of memory` | YES (no eviction) | None — ordinary run error if uncaught |
| **Recoverable** | stack | QuickJS host boundary (wasm trap) | NO — wasm trap unwinds past guest `try`/`catch`; host recovers in `vm.callFunction`'s catch | YES (no eviction) | None — ordinary run error |
| **Terminal** | cpu | Main-thread watchdog → `worker.terminate()` | NO (kills worker thread) | NO (sandbox evicted) | `system.exhaustion` leaf + synth `trigger.error` close via `sequencer.finish` |
| **Terminal** | output | Worker-thread `queueMicrotask` throw on Node side | NO (bypasses VM) | NO (sandbox evicted) | `system.exhaustion` leaf + synth closes |
| **Terminal** | pending | Worker-thread `queueMicrotask` throw on Node side | NO (bypasses VM) | NO (sandbox evicted) | `system.exhaustion` leaf + synth closes |

**Recoverable caps (memory, stack):**
- `QuickJS.create({ memoryLimit })` and `qjs_set_max_stack_size()` configure native QuickJS caps.
- Both share the recoverable property at the sandbox level: the worker stays alive, the sandbox stays cached, no `system.exhaustion` event is emitted. They differ in guest-catchability due to a `quickjs-wasi` engine constraint:
  - **memory**: surfaces as a catchable `InternalError: out of memory` exception inside the QuickJS VM. Guest code can `try { ... } catch (e) { ... }` around the breaching allocation and continue. An uncaught breach bubbles to `vm.callFunction`'s catch in `worker.ts` and becomes `RunResult{ok:false, error}`.
  - **stack**: surfaces as a wasm-runtime trap (`WebAssembly.RuntimeError: memory access out of bounds`) because `quickjs-wasi` 2.2.0's native `js_check_stack_overflow` does not fire fast enough — the wasm linear-memory stack exhausts before the in-VM check raises a JS-level `RangeError`. The trap unwinds the entire wasm call stack, including any guest QuickJS-level `try`/`catch` (which is itself implemented in wasm). The worker catches the trap at the host boundary and produces `RunResult{ok:false, error}`. The sandbox survives via the existing post-init snapshot restore on next run.
- Operational role: protect the node from accidental runaway growth; trust the workflow author to handle gracefully or fail cleanly. A hostile tenant who swallows OOM (memory only — stack is uncatchable) cannot make progress: each allocation that hits the cap fails, paying full CPU for nothing. The asymmetry is engine-level, not policy-level, and is documented as a known constraint (a future `quickjs-wasi` upgrade or build-flag tweak could promote stack to catchable; not in scope for this PR).

**Terminal limits (cpu, output, pending):**
- CPU: main-thread `setTimeout` watchdog in `worker-termination.ts`, armed at `sb.run()` start, disarmed on success. On expiry sets `cpuBudgetExpired = true` and calls `worker.terminate()`. Guest's QuickJS try/catch is irrelevant — the entire VM context is destroyed.
- Output bytes: counter at the worker→main event-post boundary, scoped to `type:"event"` messages, measuring `JSON.stringify(msg.event).length`. On overflow: drop the in-flight event, `throwLimit("output", cumulative)` queues a microtask throw on the Node thread.
- Pending callables: counter at `sandbox-context.ts#pluginRequest`. On overflow: `throwLimit("pending", count)` queues a microtask throw on the Node thread.
- Microtask throws happen on the Node thread *outside* any QuickJS evaluation. The guest's QuickJS-level try/catch cannot intercept them — by the time the throw runs, control has left the VM.
- Operational role: protect the shared runtime from tampering by hostile tenants. Tamper-resistant by construction.

**Tagged error shape (terminal class only):**
- Worker-origin terminal breaches (output, pending) construct a tagged `SandboxLimitError` (`err.name = "SandboxLimitError"`, `err.dim ∈ {"output","pending"}`, optional `err.observed`) and throw via `queueMicrotask`. Node structured-clones the Error including `dim` and `observed` over the worker's `error` event.
- CPU breaches are main-origin: the watchdog flag-and-terminate path produces `dim = "cpu"` synthesised main-side from `cpuBudgetExpired`.

**Alternatives considered:**
- *Treat all five dimensions as terminal (always evict, always synthesise system.exhaustion).* The original design before this classification. Rejected — memory and stack OOM are inherently catchable QuickJS exceptions, and forcing termination would require either intercepting them before the guest's catch fires (possible but invasive) or accepting that swallowed OOMs go undetected anyway. The honest move is to acknowledge the asymmetry in the spec and treat memory/stack as best-effort node-protection caps rather than tamper-resistant tenant boundaries.
- *Dedicated `{type:"limit", dim}` protocol message + `worker.terminate()` from main for output/pending.* Requires new entries in `protocol.ts`, duplicates Node's existing error-channel behaviour, and introduces a message-vs-exit race. Rejected.
- *Encode dimension in the process exit code.* Fragile — SIGSEGV=139, SIGKILL=137, uncaughtException default=1 already overlap.
- *Emit a sentinel `SandboxEvent` before dying.* Conflates internal limit signalling with the guest-visible event stream. Rejected.
- *Clean throw inside guest for output-bytes ("survivable" limit).* Lets honest verbose workflows recover cheaply but gives hostile tenants a catch-and-retry loop bounded only by CPU. Rejected per hostile-multi-tenant threat model — output stays terminal.

### D2. `worker-termination.ts` encapsulates worker-lifecycle correlation

```
type LimitDim = "cpu" | "output" | "pending"
  // ONLY terminal dimensions. memory and stack are recoverable
  // QuickJS exceptions; they never reach this classification.

type TerminationCause =
  | { kind: "limit"; dim: LimitDim; observed?: number }
  | { kind: "crash"; err: Error }

interface WorkerTermination {
  armCpuBudget(ms: number): void
  disarmCpuBudget(): void
  markDisposing(): void
  onTerminated(cb: (cause: TerminationCause) => void): void
  cause(): TerminationCause | null
}

function createWorkerTermination(worker: Worker): WorkerTermination
```

Encapsulates: the `lastError` / `disposing` / `cpuBudgetExpired` / `observedOnExpiry` state flags; `worker.on("error")` + `worker.on("exit")` wiring; the CPU watchdog `setTimeout`; `SandboxLimitError` recognition; exactly-once `onTerminated` dispatch; suppression on dispose.

**Cause classification** (used by both internal `onTerminated` dispatch and the synchronous `cause()` getter):

```
function cause(): TerminationCause | null {
  if (disposing)            return null
  if (cpuBudgetExpired)
    return { kind: "limit", dim: "cpu", observed: observedOnExpiry }
  if (lastError?.name === "SandboxLimitError" && lastError.dim)
    return { kind: "limit", dim: lastError.dim,
             ...(lastError.observed !== undefined
                 ? { observed: lastError.observed } : {}) }
  if (lastError) return { kind: "crash", err: lastError }
  return null
}
```

The `cause()` getter is consumed synchronously by `sandbox.ts`'s `onError` / `onExit` handlers inside `sb.run()`, before the run promise settles. The `onTerminated` callback is consumed exclusively by `sandbox-store` for cache eviction.

**Alternatives considered:**
- *Cause via `onTerminated` callback chain only* (no synchronous getter). Required `sandbox.ts` to buffer the cause from a callback and read it later in `onError`/`onExit`, introducing implicit ordering dependency between worker-termination's internal dispatch and sandbox.ts's per-run listener registration. Rejected — fragile.
- *Read `err.name === "SandboxLimitError"` directly from the worker error event in sandbox.ts*. Doesn't cover CPU (no `err` for main-side terminate), forcing a hybrid that exposes worker-termination internals anyway. Rejected — partial solution.

### D3. Death-path synthesis lives in `sandbox.ts`, not the executor

On any worker termination during a live run, `sandbox.ts`'s `sb.run()` `onError`/`onExit` handler:

```
const cause = termination.cause()

if (cause?.kind === "limit") {
  sequencer.next({
    type: "leaf",
    kind: "system.exhaustion",
    name: cause.dim,
    input: {
      budget: limits[cause.dim],
      ...(cause.observed !== undefined ? { observed: cause.observed } : {}),
    },
  })
}

const closeReason =
  cause?.kind === "limit" ? `limit:${cause.dim}` :
  cause?.kind === "crash" ? `crash:${cause.err.message}` :
  err.message    // fallback (clean-end has cause === null and a different code path)

const synthClosed = sequencer.finish({ closeReason })
for (const evt of synthClosed) forwardSandboxEvent(evt)

reject(err)    // sb.run() rejects symmetrically with crash
```

`sequencer.finish({closeReason})` synthesises LIFO closes for every still-open frame (e.g. `system.error → action.error → trigger.error`), each carrying `error: { message: closeReason }` with proper seq/ref stamping. The synth `trigger.error` is the terminal event for the invocation; the dashboard's existing terminal-resolution logic finds it via `e.ref === triggerEvent.seq` and renders the trigger bar with its existing `errored: true` styling.

The executor has NO limit-specific code path. Its existing try/catch around `sb.run()` converts both crash rejections and limit rejections into `InvokeResult{ok:false, error:{message}}` uniformly. Events flow through `sb.onEvent` untouched.

**Alternatives considered:**
- *Executor synthesises `limit.exceeded` + terminal `failed` events* (the original design before the rebase). The pre-rebase code base had no `RunSequencer`; the executor had to fabricate seq/ref by hand, introducing the bugs called out in the post-implementation review (`seq:-1, ref:null` collisions with event-store PK, persistence file naming, flamegraph layout). Post-rebase the RunSequencer eliminates the need for hand-rolled synthesis entirely. Rejected.
- *Worker emits the leaf event before dying.* Conflates "guest-visible event" with "internal exhaustion signal," and racy with the worker dying mid-post. Rejected.

### D4. Single-subscriber `Sandbox.onTerminated`; sandbox-store evicts on any cause

`Sandbox.onTerminated(cb)` accepts ONE production subscriber: `sandbox-store`. On any cause (limit or crash), the store evicts the corresponding `(owner, sha)` cache entry so the next `get()` rebuilds cold.

```
sandbox-store: build()  →  promise.then(sb => sb.onTerminated(cause => {
                                cache.delete(storeKey(owner, sha))
                                logger.info("sandbox evicted", { ... })
                              }))
factory:                NO subscription. Pure builder; no `created` Set,
                        no dispose() method, no termination tracking.
                        Test fixtures dispose explicitly.
executor:               NO subscription. Event-driven via sb.run()
                        rejection; no awareness of termination cause.
sandbox.ts internal:    Uses worker-termination.onTerminated INTERNALLY
                        to update its own `terminatedCause` flag (so a
                        subsequent sb.run() can reject pre-flight). Not
                        a public Sandbox.onTerminated subscriber.
```

This collapses the original three-subscriber design into one. The "fan-out across silent overwrites" bug surfaced in the post-implementation review cannot occur because there is no fan-out: `Sandbox.onTerminated` retains its single-slot semantics, and the store is the only registrant.

**Alternatives considered:**
- *Multi-subscriber Set in `sandbox.ts`.* Smallest code diff but accepts the architectural confusion that factory + store + executor each "own" a slice of termination handling. Rejected in favour of clarifying ownership.
- *Self-restoring Sandbox.* Sandbox transparently spawns a new worker after termination, hiding the death from external callers. Eliminates termination handling from store + executor entirely. Rejected for this PR (significantly larger scope, requires retaining init params per Sandbox, needs init-failure kill-switch policy). Viable as a future change.

### D5. `system.exhaustion` rides the existing reserved `system.*` prefix

No new reserved prefix. The post-rebase `system.*` family already covers leaf events emitted main-side for runtime-driven happenings (`system.exception` for guest uncaught throws, `system.call` for fire-and-forget host calls). `system.exhaustion` joins as a leaf with `name: <dim>` and `input: { budget, observed? }`. SECURITY.md §2 R-7 reserved-prefix list is unchanged.

`observed` populated only when measurable post hoc:
- `dim = "cpu"`: elapsed ms between `armCpuBudget()` and watchdog firing
- `dim = "output"`: cumulative bytes including the breaching event
- `dim = "pending"`: in-flight count at the breaching request
- `dim = "memory"` / `dim = "stack"`: omitted (QuickJS surfaces no measurement)

The synth `trigger.error` close emitted by `sequencer.finish({closeReason: \`limit:${dim}\`})` carries `error: { message: "limit:<dim>" }` — concise, greppable, and sufficient for dashboard correlation. No `error.kind` discriminant; no `error.dimension` field. Dashboard reads structured budget/observed from the `system.exhaustion` leaf via hover title; raw EventStore consumers correlating without the leaf still get the dim from the message.

### D6. Zod-schema defaults, no Dockerfile ENV

```
SANDBOX_LIMIT_MEMORY_BYTES      z.coerce.number().int().positive().default(67_108_864)    // 64 MiB
SANDBOX_LIMIT_STACK_BYTES       z.coerce.number().int().positive().default(524_288)       // 512 KiB
SANDBOX_LIMIT_CPU_MS            z.coerce.number().int().positive().default(60_000)        // 60 s
SANDBOX_LIMIT_OUTPUT_BYTES      z.coerce.number().int().positive().default(4_194_304)     // 4 MiB
SANDBOX_LIMIT_PENDING_CALLABLES z.coerce.number().int().positive().default(64)
```

Defaults in the schema mean `pnpm dev`, test runs, local cluster, and prod all use identical values when the env var is unset. Operators override via K8s env in `infrastructure/envs/<env>/`; no per-container Dockerfile drift.

### D7. `sb.run()` rejects symmetrically with crash

```
crash:  reject(new Error("worker exited with code N"))            [existing]
limit:  reject(new Error(`sandbox limit exceeded: ${dim}`))       [new]
```

Both flow through the executor's existing try/catch around `sb.run()` into `InvokeResult{ok:false, error:{message}}`. Triggers (HTTP / manual / cron) consume `InvokeResult.ok` and `error.message` only — no structured cause. Resolving with `{ok:false}` was considered and rejected: it diverges from how crashes work today and gains nothing at the consumer level.

### D8. `SandboxStore` lifetime widened to allow internal eviction

The pre-existing requirement "SandboxStore lifetime is the process lifetime" said the store SHALL NOT dispose individual sandboxes during normal operation and SHALL NOT expose any public API for per-key eviction. The LRU-eviction commit (`782094e8`) shipped without updating this requirement, leaving a stale clause. This PR widens it explicitly:

> The store MAY dispose individual sandboxes for internal cache management (LRU cap reached or sandbox terminated abnormally). It SHALL NOT expose a public per-key eviction API.

This documents both the LRU eviction (already shipping) and our termination-induced eviction in one cleaned-up requirement.

### D9. Factory ownership stripped

`SandboxFactory` becomes a pure builder:
- No `created` Set tracking live sandboxes
- No `factory.dispose()` walking the set
- No subscription to `onTerminated`

Sandbox lifetime ownership belongs to the consumer of `factory.create()`. In production, every sandbox flows through `sandbox-store`; the store calls `sb.dispose()` on every cached entry on its own `dispose()`. Tests that construct sandboxes via the factory directly are responsible for disposing them — convention matches other lifetime-owning types in this codebase. `factory.dispose()` callers in tests are migrated to dispose individual sandboxes.

## Risks / Trade-offs

- **[Risk]** `queueMicrotask(throw)` depends on Node's `uncaughtException` → `worker.error` event path firing reliably for microtask-origin throws inside a try/catch-wrapped Callable handler. **Mitigation:** dedicated unit test in `worker-termination.test.ts` asserting that a `queueMicrotask(() => { throw new SandboxLimitError(...) })` inside a plugin try/catch in the mock harness produces `onTerminated({kind:"limit", dim:...})`. Node has supported this semantics stably since v14.
- **[Risk]** Honest workflows hit the 4 MiB output cap with a verbose debug trace and lose the whole sandbox. **Mitigation:** the cap is per-env tunable via `SANDBOX_LIMIT_OUTPUT_BYTES`; cold-start rebuild is sub-second. Operators raise the cap if their workloads warrant.
- **[Risk]** CPU watchdog races: `disarmCpuBudget()` could be called after the timer's callback already started executing. **Mitigation:** `cpuBudgetExpired = true` is set BEFORE `worker.terminate()` so the exit handler reads it regardless of disarm timing; the centralized state machine in `worker-termination.ts` is unit-tested for these edge cases.
- **[Risk]** Pending-callables counter false positives. A workflow legitimately running 65 concurrent fetches trips the default cap of 64. **Mitigation:** default tuneable; 64 is a conservative starting point. Revisit if real workloads push against it.
- **[Risk]** `Sandbox.onTerminated` single-subscriber semantics rely on convention. A future contributor adding a second subscriber would silently overwrite the store's eviction handler. **Mitigation:** spec requirement explicitly states single-subscriber; runtime check in `sandbox.ts` could throw on a second registration (small belt-and-braces — worth adding).
- **[Trade-off]** Always terminate + evict means verbose-but-honest workflows lose any host-side plugin state (compiled validators on `PluginSetup`, timer-Map entries) on every breach. Explicit cost of the hostile-tenant stance.
- **[Trade-off]** Death-path event synthesis lives in `sandbox.ts` rather than the executor. Pulls slightly more responsibility into the sandbox package, but keeps event synthesis adjacent to the RunSequencer that owns seq/ref stamping. The executor is correspondingly simpler — no special-case code.

## Migration Plan

No user-facing migration. Existing workflows continue to run; those that hit a new cap see a `system.exhaustion` marker in the dashboard and a terminal `trigger.error` close with `error.message: "limit:<dim>"`.

Rollout order:
1. Land `worker-termination.ts` + `cause()` getter + tagged `SandboxLimitError` + worker-side counters + QuickJS `memoryLimit`/`maxStackSize` wiring. Unit tests in `packages/sandbox`.
2. Land config fields in `packages/runtime/src/config.ts` + threading through `main.ts` → sandbox factory.
3. Strip factory lifetime tracking; migrate test fixtures to dispose explicitly.
4. Wire `sandbox.ts`'s `onError`/`onExit` to consult `cause()`, emit `system.exhaustion` leaf, and call `sequencer.finish({closeReason})`. Update `sb.run()` rejection format.
5. Land `sandbox-store` eviction subscription. Confirm single-subscriber semantics.
6. Update `EventKind` union with `system.exhaustion`; update flamegraph marker-kinds list with hover-title formatting. No new CSS.
7. Update SECURITY.md R-11 invariant. R-7/R-8 unchanged.
8. Spec deltas: `sandbox`, `runtime-config`, `invocations`, `dashboard-list-view`. No `executor` delta.

No rollback plan beyond reverting the PR; all code paths are additive except the `onDied` → `onTerminated` rename and factory ownership stripping (both fully contained within the monorepo).

## Open Questions

- None at this revision. Output-cap counting scope is pinned (count `type:"event"` only; measure `JSON.stringify(msg.event)`; bypass `ready`/`init-error`/`done`/`log`). CPU watchdog grace period between expiry and `worker.terminate()` is zero. `observed` field semantics pinned per dimension.
