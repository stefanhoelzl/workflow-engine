## Why

The QuickJS sandbox crosses the host boundary via two distinct paths: the explicit bridge (`console.log`, `__hostFetch`, `__hostCallAction`, `__emitEvent`) which emits InvocationEvents, and WASI imports (`clock_time_get`, `random_get`, `fd_write`) which bypass the bridge entirely and emit nothing. Every `Date.now()`, `Math.random()`, `crypto.getRandomValues()`, and `crypto.randomUUID()` the guest invokes crosses the sandbox boundary silently, and any QuickJS engine-internal diagnostic written to stdout/stderr lands on the host process output with no trace in the event stream or logger.

This change closes the observability gap by overriding the three side-effecting WASI imports so that clock and randomness reads emit a new single-record `system.call` InvocationEvent, and engine diagnostics route through the sandbox's injected `Logger` at `debug` level. Replay/deterministic-control modes are explicitly deferred — this phase establishes the observability foundation their ledger will be built on.

## What Changes

- Add `system.call` as a new `EventKind` variant in `@workflow-engine/core`. Unlike `system.request` / `system.response` (paired, capture latency across guest→host→guest), `system.call` is a single-record event carrying both `input` and `output` — the reserved shape for instant synchronous sub-bridge host reads.
- Install a worker-side WASI factory in `packages/sandbox/src/worker.ts` that overrides `clock_time_get`, `random_get`, and `fd_write`. The factory builds its closures before `QuickJS.create` and captures a mutable monotonic anchor.
- `clock_time_get`: `CLOCK_REALTIME` passes through to host `Date.now()`. `CLOCK_MONOTONIC` returns `(performance.now() × 1e6) − anchorNs`. The anchor is set at worker init and re-set every time `bridge.setRunContext` fires, so guest `performance.now()` starts at ~0 at the beginning of each run.
- `random_get`: passes through to host `crypto.getRandomValues`. The emitted event's `output` carries `{ bufLen, sha256First16 }` — the buffer size plus the first 16 bytes of the SHA-256 of the returned bytes. Raw entropy bytes are never logged.
- Both clock and random overrides emit `system.call` events with `name` set to `wasi.clock_time_get` / `wasi.random_get`. Events are emitted only while `bridge.getRunContext()` is non-null — pre-run reads (during `QuickJS.create`, VM library init, or workflow source evaluation) silently pass through without emitting. Event `ref` is `refStack.at(-1) ?? null`; these are leaf events that never push or pop.
- `fd_write`: decodes the written bytes, line-buffers per fd, and on each completed line posts a new `WorkerToMain { type: "log" }` message. The main thread dispatches `log` messages to the sandbox's injected `Logger` via `logger[level](message, meta)` — no `InvocationEvent` is emitted for `fd_write` bytes. If no logger is provided, the message is silently dropped.
- Add `logger?: Logger` to `SandboxOptions`; `createSandboxFactory` passes its own injected logger through to every `sandbox()` it creates.
- Extend the sandbox `Logger` interface (at `packages/sandbox/src/factory.ts`) with a `debug(message, meta?)` method alongside the existing `info` / `warn` / `error`. `fd_write` traffic uses `debug` so it stays out of default log levels.
- Add `WorkerToMain` variant `{ type: "log", level, message, meta? }` to the protocol. Existing main-thread message handlers gain a noop branch; TypeScript exhaustiveness on the discriminated union enforces this.
- Add `emitSystemCall(method, input, output)` to the bridge's public interface in `bridge-factory.ts`. Seq comes from `bridge.nextSeq()`; `ref` from `refStack.at(-1) ?? null`. The helper does not push or pop the ref stack.
- Remove obsolete TODO comments at `packages/sandbox/src/protocol.ts:29-36`, `packages/sandbox/src/index.ts:43-47`, and `packages/sandbox/src/worker.ts:223-225`. These described why clock/random overrides couldn't be wired; with the worker-side factory in place, the comments rot.
- **BREAKING** in the spec layer: remove the three sandbox capability requirements "Caller-provided clock override" (line 757), "Caller-provided randomness override" (line 781), and "Override options follow existing patterns" (line 811). Each described a closure-valued option on `SandboxOptions` that cannot be implemented given the worker-thread architecture (closures do not cross `postMessage`). These requirements describe a deterministic-control API that will return in a future phase via serializable descriptor options, not closures. No code currently satisfies these requirements, so no code is being removed.
- Update `SECURITY.md §2` with a WASI override inventory, the invariant that `random_get` output never logs raw bytes, and the fact that `fd_write` bypasses the InvocationEvent stream. Note the remaining observability gap for WASM crypto extension internals (`crypto.subtle.*`) as explicitly out of scope.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `sandbox`: new requirements for WASI override installation, `system.call` event emission, monotonic clock anchoring at `setRunContext`, `fd_write` logger routing, `SandboxOptions.logger`, and the extended `Logger` interface with `debug`. Removes three obsolete caller-provided-override requirements.

## Impact

**Code:**

- `packages/core/src/index.ts`: +1 literal in the `EventKind` union.
- `packages/sandbox/src/protocol.ts`: +1 `WorkerToMain` variant; delete TODO block.
- `packages/sandbox/src/worker.ts`: new WASI factory, monotonic anchor state, WASI-event emission. Delete TODO block.
- `packages/sandbox/src/bridge-factory.ts`: +`emitSystemCall` method on the public `Bridge` interface.
- `packages/sandbox/src/factory.ts`: extend `Logger` interface with `debug`; pass logger into sandbox constructor.
- `packages/sandbox/src/index.ts`: add `logger?` to `SandboxOptions`; handle incoming `log` messages. Delete TODO block.

**Protocol:**

- `WorkerToMain` gains an additive `log` variant. `MainToWorker` unchanged.

**Security:**

- `SECURITY.md §2` receives a new subsection enumerating the overridden WASI imports and the invariants (no raw-byte logging for `random_get`; `fd_write` bypasses the event stream).

**Persistence / consumers:**

- No schema change. `InvocationEvent.input` and `output` are already independently nullable; a `system.call` record carrying both fits the existing event-store shape.
- `logging-consumer` is unaffected (it already ignores `system.*` events).
- Dashboard middleware is unaffected (it only handles `trigger.*`).

**Tests:**

- New unit tests for each override in `packages/sandbox/`.
- Existing exact-count assertions filter by `name`, so new `wasi.*` events do not pollute them.

**Dependencies:**

- None added. Uses existing `node:crypto`, `performance`, `worker_threads`.
