## Why

Today the QuickJS sandbox has no enforced resource limits: no memory cap (the `memoryLimit` option is plumbed end-to-end but never set by the runtime), no CPU wall-clock budget, no stack cap, no output-volume cap, and no cap on in-flight host-call requests. Under the project's hostile-multi-tenant threat model, any single workflow invocation can exhaust node resources (runaway `while(true)`, unbounded heap growth, event-stream flooding, Promise.all of thousands of fetches) and degrade or DoS every other tenant sharing the pod.

## What Changes

- Introduce five enforced per-run resource caps on the sandbox in two semantic classes:
  - **Recoverable caps** (in-VM, guest-catchable): memory, stack. QuickJS raises a normal catchable error (out-of-memory or stack-overflow) inside the VM. The guest MAY catch and continue; an uncaught breach surfaces as a regular run error and the sandbox SURVIVES for subsequent invocations. Protects the node from runaway growth without forcing eviction.
  - **Terminal limits** (sandbox-level, guest cannot catch): CPU wall-clock, aggregate output bytes, concurrent pending host-callables. The worker thread is killed; the guest's QuickJS try/catch is bypassed; the sandbox is evicted from cache; the bus receives a `system.exhaustion` leaf and synth `trigger.error` closes. Protects the shared runtime from tampering by hostile tenants.
- Register the five caps as runtime-config fields in `packages/runtime/src/config.ts` with zod-schema defaults (`SANDBOX_LIMIT_MEMORY_BYTES=64 MiB`, `SANDBOX_LIMIT_STACK_BYTES=512 KiB`, `SANDBOX_LIMIT_CPU_MS=60000`, `SANDBOX_LIMIT_OUTPUT_BYTES=4 MiB`, `SANDBOX_LIMIT_PENDING_CALLABLES=64`). Configuration surface is uniform across both classes; the breach mechanism differs.
- Terminal-class breaches use a tagged `SandboxLimitError` thrown via `queueMicrotask` (output, pending) so it escapes surrounding plugin try/catches and lands on the worker's `error` event with a `dim` property intact, OR a main-owned watchdog `setTimeout` calling `worker.terminate()` on expiry (cpu). Recoverable-class breaches do NOT use this mechanism — QuickJS surfaces them as ordinary VM exceptions.
- Introduce `packages/sandbox/src/worker-termination.ts` factory `createWorkerTermination(worker)` encapsulating the worker-lifecycle correlation: error/exit event correlation, the CPU watchdog, `SandboxLimitError` recognition, exactly-once `onTerminated` dispatch, and a synchronous `cause(): TerminationCause | null` getter that classifies into `{kind:"limit", dim, observed?} | {kind:"crash", err}`.
- Death-path event synthesis lives entirely in `sandbox.ts`, leveraging the post-rebase `RunSequencer`. On terminal-limit termination: emit a `system.exhaustion` leaf via `sequencer.next()` (carrying `name: dim, input: {budget, observed?}` where `dim` is one of `cpu | output | pending`), then call `sequencer.finish({closeReason: \`limit:${dim}\`})` to synthesise LIFO close events for every still-open frame (system.error → action.error → trigger.error). On crash termination: skip the leaf; just `sequencer.finish({closeReason: err.message})`. Recoverable breaches (memory, stack) emit no synthesis at all — the run continues if the guest catches, or fails normally if it doesn't. Seq/ref stamping flows through the existing RunSequencer — no manual fabrication.
- New event kind `system.exhaustion` rides the existing reserved `system.*` prefix. **No change to SECURITY.md §2 R-7** — `system` is already reserved.
- `sb.run()` rejects with `Error("sandbox limit exceeded: ${dim}")` on limit, symmetric with the existing `Error("worker exited with code N")` on crash. The executor's existing try/catch handles both into `InvokeResult{ok:false, error:{message}}`; no executor-side limit-specific code path.
- `Sandbox.onTerminated` has exactly one production subscriber: `sandbox-store`, for `(owner, sha)` cache eviction. `SandboxFactory` becomes a pure builder — no `created` Set, no `dispose()`, no `onTerminated` subscription; sandbox lifetime ownership is the store's. Tests that construct sandboxes via the factory directly dispose explicitly.
- The dashboard renders `system.exhaustion` with the generic system.* marker styling. Invocation failure visibility is driven by the synth `trigger.error` close (which sets the existing `errored: true` on the trigger bar). Marker hover title carries kind, name, budget, and observed for the common diagnosis path.
- SECURITY.md gains a new R-11 invariant codifying the recoverable/terminal classification: terminal limits flow through the uniform termination pipeline (detection → `worker-termination.cause()` → `sandbox.ts` synth via sequencer → sandbox-store eviction); recoverable caps are documented as in-VM, guest-catchable, sandbox-survival semantics. R-7 and R-8 are unchanged.

## Capabilities

### New Capabilities
- None. All new behaviour extends existing specs.

### Modified Capabilities
- `sandbox`: new shared termination contract and five dimension-specific resource-limit requirements; `Memory limit configuration` requirement is rewritten to drop the optional shape; `SandboxStore lifetime is the process lifetime` requirement is widened to allow internal eviction (LRU and termination) while keeping "no public per-key eviction API"; `Sandbox death notification` requirement is updated for `onTerminated(cause: TerminationCause)` with explicit single-subscriber semantics; new `Eviction on sandbox termination` requirement on the sandbox-store side.
- `runtime-config`: five new config fields (memory, stack, cpu, output, pending) with zod-schema defaults.
- `invocations`: new `system.exhaustion` event kind under the existing reserved `system.*` prefix. No modification to invocation lifecycle events — death-path synth closes from `sequencer.finish` carry the terminal semantics naturally.
- `dashboard-list-view`: `Instant markers` requirement adds `system.exhaustion` to the marker-kinds list. No dedicated CSS class.

## Impact

- Code:
  - `packages/sandbox/src/worker-termination.ts` (new) — `createWorkerTermination` factory, `TerminationCause` type, `cause()` getter
  - `packages/sandbox/src/limit-counters.ts` (new) — `throwLimit(dim, observed?)` helper, output-bytes counter, pending-callables counter, `resetRunCounters()`
  - `packages/sandbox/src/sandbox.ts` — widened `SandboxOptions` with required limit fields; `onDied(err)` → `onTerminated(cause)`; CPU watchdog wiring; on-error/on-exit consults `termination.cause()`, conditionally emits `system.exhaustion` leaf via `sequencer.next()`, then calls `sequencer.finish({closeReason})`; `sb.run()` rejection format updated for limits
  - `packages/sandbox/src/factory.ts` — stripped of lifetime tracking (no `created` Set, no `dispose()`, no termination subscription); pure builder
  - `packages/sandbox/src/worker.ts` — `QuickJS.create({memoryLimit})` + `qjs_set_max_stack_size`; OOM/stack-overflow re-throw via `throwLimit`; output-bytes counter scoped to `type:"event"` messages, measuring `JSON.stringify(msg.event)`; per-run counter reset
  - `packages/sandbox/src/sandbox-context.ts` — pending-callables counter at `pluginRequest` boundary
  - `packages/sandbox/src/protocol.ts` — `init` payload extended with `memoryBytes | stackBytes | outputBytes | pendingCallables`
  - `packages/sandbox/src/index.ts` — exports `TerminationCause`, `LimitDim`, `SANDBOX_LIMIT_ERROR_NAME`
  - `packages/runtime/src/config.ts` — five new schema fields with defaults
  - `packages/runtime/src/main.ts` — threads config into the sandbox factory
  - `packages/runtime/src/sandbox-store.ts` — single subscriber to `onTerminated`; evicts `(owner, sha)` on any cause (limit or crash)
  - `packages/runtime/src/executor/index.ts` — no limit-specific code; existing try/catch handles the limit reject like a crash reject
  - `packages/runtime/src/ui/dashboard/flamegraph.ts` — `system.exhaustion` added to marker-kinds list with hover title carrying name/budget/observed
  - `packages/core/src/index.ts` — `EventKind` union gains `"system.exhaustion"`
  - `packages/sandbox-stdlib/test/wpt/harness/runner.ts` — threads the five new limit fields
- Specs: `sandbox`, `runtime-config`, `invocations`, `dashboard-list-view`. No `executor` spec change.
- SECURITY.md: new R-11 invariant. R-7 and R-8 unchanged.
- Tests: per-dimension sandbox tests assert `sb.run()` rejects + bus stream contains a `system.exhaustion` leaf with the expected `name` and `input.budget`. One runtime integration test (cpu dimension) exercises executor → sandbox → bus → event-store → cache eviction end-to-end. Recovery-regression test verifies the existing `engine_crashed` synthesis path is unaffected. Plugin-swallow security test verifies `queueMicrotask` escape mechanism survives a try/catch attempt. No reserved-prefix-guard runtime test (author code has no API for emitting arbitrary kinds; the reserved-prefix list is a docs/review convention).
- No manifest-format changes. No SDK surface changes. `workflows/src/demo.ts` unchanged (limits are enforcement, not author-facing).
- No cross-consumer (EventBus) changes beyond adding a new event kind that flows through the existing widen/forward pipeline untouched.
