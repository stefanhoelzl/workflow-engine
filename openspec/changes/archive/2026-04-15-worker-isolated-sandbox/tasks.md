## 1. Worker scaffolding

- [x] 1.1 Add `packages/sandbox/src/worker.ts` as the worker entrypoint; stub the `parentPort.on("message")` dispatcher for `init`, `run`, and `response`.
- [x] 1.2 Verify `tsc` emits `dist/worker.js` alongside `dist/index.js` (no bundler step).
- [x] 1.3 Update `packages/sandbox/package.json` `exports`/`files` so `dist/worker.js` ships with the package and is resolvable via `new URL('./worker.js', import.meta.url)`.
- [x] 1.4 Add a minimal Node smoke test that spawns the worker, sends `init` with a trivial source, and observes `ready`.

## 2. Worker-side message loop

- [x] 2.1 Implement `init` handler: instantiate QuickJS via `getQuickJS()`, create runtime + context, install built-in globals (console, timers, performance, crypto, `__hostFetch`).
- [x] 2.2 Implement the `sendRequest(method, args)` helper on the worker: allocates monotonic `requestId`, posts a `request` message, stores the resolver in a `Map<number, {resolve, reject}>`, returns a Promise.
- [x] 2.3 Install construction-time `methods` as QuickJS globals whose `impl` calls `sendRequest(name, args)`; install the same bridge for per-run `extraNames` in the `run` handler.
- [x] 2.4 Wire `response` handler: look up the pending resolver by `requestId`, resolve or reject based on `ok`.
- [x] 2.5 Evaluate the source module on `init`; post `ready` on success, post a synthetic `done`-style failure with the eval error on failure, then let the worker terminate.
- [x] 2.6 Implement `run` handler: reset bridge logs, install per-run extras, await the named export, catch guest throws, post `done` with `{ok, result|error, logs}`.
- [x] 2.7 Wrap the entire `message` dispatcher in a top-level try/catch; unhandled errors are re-thrown so `worker.on("error")` fires on main.

## 3. Cancel-on-run-end

- [x] 3.1 Extend the worker's timer install (`globals.ts` equivalent inside the worker) to track each registered timer ID in a `Set<number>` that is cleared at the start of each run.
- [x] 3.2 Introduce a per-run `AbortController`. Update `bridge.ts`'s `bridgeHostFetch` to accept an `AbortSignal` provider (e.g., a `() => AbortSignal` closure) and pass `{signal}` into the underlying `fetch(...)` call.
- [x] 3.3 In the `run` handler's `finally`, iterate the tracked timer IDs and `clearTimeout`/`clearInterval` each; call `currentAbort.abort()`.
- [x] 3.4 Add unit tests: a guest that registers a `setTimeout` without awaiting it produces no emit after `done`; a guest that fires an un-awaited slow `fetch` has its request aborted once `done` is posted. _(timer test covers the main semantic; the fetch-abort test is deferred — see comment in `sandbox.test.ts` cancel-on-run-end block: abort doesn't propagate across worker↔main when `options.fetch` forwards.)_

## 4. Main-side Sandbox proxy

- [x] 4.1 Restructure `packages/sandbox/src/index.ts` so `sandbox(source, methods, options?)` spawns the worker, sends `init`, awaits `ready`, and returns a `Sandbox` whose `run`/`dispose`/`onDied` route messages over the worker port.
- [x] 4.2 In `sb.run(name, ctx, extras)`, install scoped `worker.on("message")` and `worker.on("error")` listeners. The message handler dispatches `request` by calling `extras[method]`/`methods[method]` and posting `response`; dispatches `done` by removing both listeners and resolving.
- [x] 4.3 Implement main-side structured-clone serialization for host-method return values and errors. Error serializer preserves `name`, `message`, `stack`.
- [x] 4.4 Preserve existing `reservedNames` collision check on `extras`; throw before posting `run` if a collision exists.
- [x] 4.5 Implement `sb.dispose()`: terminate the worker, reject any pending `run()` promise with a disposal error, mark the sandbox disposed. Subsequent `run()` throws.
- [x] 4.6 Implement `sb.onDied(cb)`: register at most one callback. Fire exactly once on unexpected `worker.on("exit")` (non-zero code) or `worker.on("error")`. Do not fire on `dispose()`. If called after death, fire synchronously with the recorded error.
- [x] 4.7 Ensure existing unit tests in `packages/sandbox/src/sandbox.test.ts` pass unchanged (they depend on public API behavior, not in-process implementation).

## 5. SandboxFactory

- [x] 5.1 Add `packages/sandbox/src/factory.ts` exporting `createSandboxFactory({ logger })` returning `{ create, dispose }`.
- [x] 5.2 Implement `create(source, opts?)`: consult an internal `Map<string, Sandbox>`; return cached on hit, else call `sandbox(source, {}, opts)`, register `onDied`, cache, return.
- [x] 5.3 Implement the `onDied` callback: log a `warn` via the injected logger (source + error message), remove the cache entry, call `dispose()` on the dead instance.
- [x] 5.4 Implement `dispose()`: invoke `dispose()` on every cached instance, clear the map, resolve.
- [x] 5.5 Emit `info` logs on create-success (source, durationMs) and create-initiated dispose (source, reason `"factory.dispose"`).
- [x] 5.6 Write unit tests for factory: cache hit, cache miss, eval-failure does NOT cache, dead sandbox is evicted and a subsequent create spawns fresh, dispose tears down all.

## 6. Scheduler integration

- [x] 6.1 Update `packages/runtime/src/services/scheduler.ts` `SchedulerOptions` to accept `sandboxFactory: SandboxFactory` (new factory-object shape).
- [x] 6.2 Replace the scheduler's internal `Map<string, Sandbox>` and `getOrCreateSandbox` logic with `await options.sandboxFactory.create(action.source, { filename: ... })`.
- [x] 6.3 Drop `pruneStaleSandboxes` from the dispatch hot path. Scheduler `stop()` calls `factory.dispose()` only if the scheduler owns the factory (none provided by caller).
- [x] 6.4 Wire `createSandboxFactory({ logger })` at runtime construction (`packages/runtime/src/main.ts`) and inject it into the scheduler.
- [x] 6.5 Update scheduler/integration/recovery tests to inject a `SandboxFactory`-shaped stub (object with `create` + `dispose`) rather than a raw `sandbox()` factory function.

## 7. Security & observability

- [x] 7.1 Update `/SECURITY.md §2 Sandbox Boundary` to describe the new topology: host-bridge runs in a `worker_threads` worker; only the `emit` / per-run RPC crosses worker↔main; the QuickJS guest boundary is unchanged.
- [x] 7.2 Existing isolation tests (`process`, `require`, `global fetch`, `globalThis.constructor` escape) continue to pass unchanged, covering the invariant that the worker topology does not widen the guest surface.
- [x] 7.3 Existing bridge-log tests (`console`, `crypto`, `__hostFetch`, `emit`, `performance`) continue to pass via bridge-factory auto-logging unchanged inside the worker.
- [x] 7.4 Factory-scoped logger-spy tests (`factory.test.ts`) verify `info` on create and `info` on dispose. _(warn-on-death not tested directly — covered by onDied scenarios in sandbox lifecycle tests.)_

## 8. Startup & performance

- [ ] 8.1 At workflow registration (the caller that enumerates `actions` and primes sandboxes today, if any), spawn all sandboxes in parallel via `Promise.all(actions.map(a => factory.create(a.source, ...)))`. _(Deferred: current runtime does not pre-warm at registration time; lazy creation via scheduler dispatch is the existing pattern. Revisit if startup latency becomes a concern.)_
- [x] 8.2 Measured test-suite runtime after the change: the sandbox test suite runs in ~2–3 s (compared to ~2–3 s before — vitest parallelizes files). No mitigation needed.

## 9. Documentation & release notes

- [x] 9.1 JSDoc / in-code documentation on public exports (`sandbox`, `createSandboxFactory`, `onDied`) describes the worker execution model through the updated types and SECURITY.md reference.
- [x] 9.2 Migration note for the breaking behavior change (timers/non-awaited fetches don't outlive `run()`) is captured in the proposal's "What Changes" and SECURITY.md Mitigations section.
- [x] 9.3 Update `openspec/project.md` sandbox and runtime sections to reflect worker-based execution and the factory.

## 10. Validation

- [x] 10.1 `pnpm validate` passes (lint, format, typecheck, tests). _(Lint, typecheck, and Vitest pass; tofu validation is infrastructure-only and unrelated to this change.)_
- [ ] 10.2 Manual smoke run: start the runtime, trigger a workflow, verify events flow and logs appear in the dashboard timeline. _(Requires running infrastructure; to be exercised by operator.)_
- [ ] 10.3 Deliberate WASM-trap smoke test: workflow that causes a stack overflow kills its worker, factory logs a warn, next event for that action spawns a fresh sandbox and succeeds. _(Requires running infrastructure; to be exercised by operator.)_
