## 1. Core: `system.call` event kind

- [x] 1.1 Add `"system.call"` literal to the `EventKind` union in `packages/core/src/index.ts`
- [x] 1.2 Add a JSDoc comment on the union clarifying that `system.call` is a single-record kind (input and output in the same event, no paired counterpart)
- [x] 1.3 Run `pnpm check` and fix any TypeScript exhaustiveness errors surfaced in consumers (persistence, logging-consumer, dashboard middleware, tests)

## 2. Sandbox: protocol delta

- [x] 2.1 Add `WorkerToMain` variant `{ type: "log"; level: "debug" | "info" | "warn" | "error"; message: string; meta?: Record<string, unknown> }` in `packages/sandbox/src/protocol.ts`
- [x] 2.2 Delete the TODO comment block at `packages/sandbox/src/protocol.ts:29-36`
- [x] 2.3 Delete the TODO comment block at `packages/sandbox/src/index.ts:43-47`
- [x] 2.4 Delete the TODO comment block at `packages/sandbox/src/worker.ts:223-225`

## 3. Sandbox: bridge event-emission primitive

- [x] 3.1 Add `emitSystemCall(method: string, input: unknown, output: unknown): void` to the `Bridge` interface in `packages/sandbox/src/bridge-factory.ts`
- [x] 3.2 Implement `emitSystemCall` inside `createBridge` — computes `seq = seq++`, `ref = refStack.at(-1) ?? null`, builds a `system.call` event via a new `buildSystemEvent` call path (or extend the existing helper), and calls the local `emit(event)` when `runContext` is non-null
- [x] 3.3 Ensure `emitSystemCall` neither pushes nor pops the `refStack`
- [x] 3.4 Unit test: emitting a `system.call` during a run produces exactly one event with the expected kind/name/ref/seq shape

## 4. Sandbox: WASI factory in the worker

- [x] 4.1 In `packages/sandbox/src/worker.ts`, declare a `wasiAnchorNs: bigint` state variable initialised to `BigInt(Math.trunc(performance.now() * 1_000_000))` inside `handleInit` before `QuickJS.create`
- [x] 4.2 Build a `wasi: (memory) => overrides` factory closure in `handleInit` that captures `wasiAnchorNs`, the bridge-to-be (via an indirection since bridge is created after VM), and the `post` function for log messages
- [x] 4.3 Pass the factory into `QuickJS.create({ ..., wasi })`
- [x] 4.4 Update `handleRun` (or the code path that calls `bridge.setRunContext`) to re-set `wasiAnchorNs = BigInt(Math.trunc(performance.now() * 1_000_000))` immediately before `bridge.setRunContext(...)`

## 5. Sandbox: clock_time_get override

- [x] 5.1 Inside the WASI factory, implement `clock_time_get(clockId, precision, resultPtr)` — for `CLOCK_REALTIME` write `BigInt(Date.now()) * 1_000_000n`; for `CLOCK_MONOTONIC` write `BigInt(Math.trunc(performance.now() * 1_000_000)) - wasiAnchorNs`
- [x] 5.2 After writing the result bytes, if `bridge.getRunContext()` returns non-null, call `bridge.emitSystemCall("wasi.clock_time_get", { clockId: "REALTIME" | "MONOTONIC" }, { ns: <number> })`
- [x] 5.3 Ensure pre-run calls (before the first `setRunContext`) do not emit — verified by the `runContext` guard already on `bridge.emitSystemCall`
- [x] 5.4 Unit test: in-run call to `Date.now()` emits one `wasi.clock_time_get` event with the expected shape
- [x] 5.5 Unit test: `performance.now()` inside an active run returns a value near zero at the start of the run, and a strictly greater value later in the same run
- [x] 5.6 Unit test: cached sandbox across two runs — `performance.now()` at the start of run 2 is less than its final value in run 1
- [x] 5.7 Unit test (security boundary): pre-run WASI reads do not produce InvocationEvents

## 6. Sandbox: random_get override

- [x] 6.1 Inside the WASI factory, implement `random_get(bufPtr, bufLen)` — call `crypto.getRandomValues` on a `Uint8Array` view into WASM memory, return `0` on success
- [x] 6.2 After filling bytes, if `bridge.getRunContext()` returns non-null, compute `sha256First16` as the lowercase hex of the first 16 bytes of `createHash("sha256").update(bytes).digest()` (using `node:crypto`) and call `bridge.emitSystemCall("wasi.random_get", { bufLen }, { bufLen, sha256First16 })`
- [x] 6.3 Confirm the implementation never logs or passes raw entropy bytes to any emit, log, or return path outside the guest's `bufPtr` region
- [x] 6.4 Unit test: in-run `crypto.getRandomValues(new Uint8Array(32))` emits one `wasi.random_get` event with `input.bufLen === 32`, `output.bufLen === 32`, and `output.sha256First16` being a 32-char lowercase hex string
- [x] 6.5 Unit test (security invariant): the emitted event has no property holding the raw bytes (scan event JSON)
- [x] 6.6 Unit test: pre-run `random_get` reads do not emit events

## 7. Sandbox: fd_write capture

- [x] 7.1 Add a per-fd line buffer map (`Map<number, string>`) local to the WASI factory
- [x] 7.2 Inside the WASI factory, implement `fd_write(fd, iovsPtr, iovsLen, nwrittenPtr)` — decode the iovs' bytes as UTF-8, append to the per-fd buffer, split on `\n`, post one `WorkerToMain { type: "log", level: "debug", message: "quickjs.fd_write", meta: { fd, text } }` per completed line, retain any trailing partial line in the buffer
- [x] 7.3 On worker `dispose`, flush any remaining partial buffer contents as final log messages (optional — only if the buffer is non-empty)
- [x] 7.4 Do NOT write bytes to host `process.stdout` or `process.stderr`
- [x] 7.5 Unit test: a `fd_write` call carrying bytes for `"some diagnostic\n"` on fd 2 produces a single `log` message with the expected meta
- [x] 7.6 Unit test: a `fd_write` call carrying bytes without a trailing newline produces zero log messages until the next write completes a line
- [x] 7.7 Unit test (security boundary): no InvocationEvent is emitted for any `fd_write` input

## 8. Sandbox main-thread: Logger wiring

- [x] 8.1 Extend the `Logger` interface in `packages/sandbox/src/factory.ts` with `debug(message: string, meta?: Record<string, unknown>): void`
- [x] 8.2 Add `logger?: Logger` field to `SandboxOptions` in `packages/sandbox/src/index.ts`
- [x] 8.3 In `sandbox()` main-thread setup, capture the `logger` from options and install a `WorkerToMain { type: "log" }` handler that calls `logger[level](message, meta)` when a logger is present and discards silently otherwise
- [x] 8.4 In `createSandboxFactory` (`factory.ts`), pass the factory's logger into every `sandbox()` call: `sandbox(source, {}, { ...options, logger })`
- [x] 8.5 Update `packages/sandbox/src/factory.test.ts` and any other test that constructs a spy `Logger` to include a `debug: vi.fn()` method
- [x] 8.6 Unit test: a factory-created sandbox whose worker emits a `fd_write` routes the line to the factory's injected `Logger.debug`
- [x] 8.7 Unit test: a direct `sandbox()` call without `options.logger` silently drops incoming `log` messages (no throw, no host stdout output)

## 9. Security documentation

- [x] 9.1 Update `SECURITY.md §2` with a new subsection "WASI override inventory" listing the three overridden WASI imports (`clock_time_get`, `random_get`, `fd_write`) and their behaviors
- [x] 9.2 In the same subsection, record the invariant: `wasi.random_get` events carry only `bufLen` and `sha256First16`; raw entropy bytes MUST NEVER appear in any emitted event or log
- [x] 9.3 Document that `fd_write` bytes bypass the InvocationEvent stream and route to the sandbox's injected `Logger` at `debug` level; when no `Logger` is injected, bytes are discarded
- [x] 9.4 Document the known residual gap: WASM crypto extension operations (`crypto.subtle.*`) run inside the extension's WASM memory without crossing a boundary we instrument — no observability beyond the entropy they consume via `random_get`

## 10. Cross-cutting validation

- [x] 10.1 Run `pnpm validate` (lint + format + typecheck + tests) until green
- [x] 10.2 Run the full sandbox test suite `pnpm --filter @workflow-engine/sandbox test` and confirm no pre-existing assertions fail due to new `system.call` events surfacing in event streams
- [x] 10.3 Run `pnpm --filter @workflow-engine/runtime test` to confirm persistence, event-store, logging-consumer, and dashboard consumers tolerate the new kind
- [x] 10.4 Manual smoke: start the local stack (`pnpm local:up`) or the dev runtime, trigger a workflow that uses `Date.now()` / `crypto.randomUUID()`, and verify the resulting invocation's events contain the expected `system.call wasi.*` entries
- [x] 10.5 Run `pnpm exec openspec validate instrument-wasi-imports --strict` and confirm the proposal validates against the spec-driven schema
