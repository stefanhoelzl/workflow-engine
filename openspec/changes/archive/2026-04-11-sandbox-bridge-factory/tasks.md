## 1. Bridge Factory Core

- [x] 1.1 Create `packages/runtime/src/sandbox/bridge-factory.ts` with `LogEntry` type, typed arg extractors (`b.arg.string`, `.number`, `.json`, `.boolean` with `.optional` and `.rest` modifiers), and marshal helpers (`b.marshal.string`, `.number`, `.json`, `.boolean`, `.void`)
- [x] 1.2 Implement `sync(target, name, opts)` — arg extraction, impl call, marshaling, handle lifecycle (return handle, VM owns), auto-logging with timing, error handling
- [x] 1.3 Implement `async(target, name, opts)` — arg extraction, deferred promise creation, impl call, resolve/reject, `executePendingJobs()`, handle lifecycle (resolve then dispose), auto-logging with timing
- [x] 1.4 Implement `pushLog(entry)` method for non-factory bridges
- [x] 1.5 Implement `method` override option (defaults to `name` parameter)
- [x] 1.6 Verify type inference: `args` extractor tuple correctly constrains `impl` parameter types (compile-time check)

## 2. Refactor Globals

- [x] 2.1 Rewrite `btoa`/`atob` in `globals.ts` to use `b.sync()` with `b.arg.string` and `b.marshal.string`
- [x] 2.2 Add `setupConsole(b)` in `globals.ts` — register `console.log/info/warn/error/debug` as no-op sync bridges with `method: "console.<name>"`, `args: [b.arg.json.rest]`, `marshal: b.marshal.void`
- [x] 2.3 Update timer setup to use `b.vm` and `b.runtime` instead of direct `vm`/`runtime` params. Change `setupGlobals` signature to accept `Bridge` instead of `(vm, runtime)`.

## 3. Refactor Context Bridges

- [x] 3.1 Rewrite `bridgeEmit` in `bridge.ts` to use `b.async()` with `method: "ctx.emit"`, `args: [b.arg.string, b.arg.json]`, `marshal: b.marshal.void`
- [x] 3.2 Rewrite `bridgeFetch` in `bridge.ts` to use `b.async()` with `method: "ctx.fetch"`, `args: [b.arg.string, b.arg.json.optional]`, custom marshal via `marshalResponse`
- [x] 3.3 Rewrite `marshalResponse` to accept `Bridge` — use `b.async()` for `json()` and `text()` methods, keep imperative assembly for scalar properties and headers
- [x] 3.4 Update `bridgeEvent`/`bridgeEnv` to use `b.vm` instead of direct `vm` param. Change `bridgeCtx` signature to accept `(Bridge, ActionContext)`.

## 4. Wire Into Sandbox

- [x] 4.1 Update `SandboxResult` type in `index.ts` to include `logs: LogEntry[]` on both ok and error variants. Re-export `LogEntry`.
- [x] 4.2 Update `spawn()` to create bridge via `createBridge(vm, runtime)`, call `setupConsole(b)`, `setupGlobals(b)`, `bridgeCtx(b, ctx)`, and include `b.logs` in all return paths
- [x] 4.3 Update `dumpError` helper to accept and include logs in the error result

## 5. Update Tests

- [x] 5.1 Update `sandbox.test.ts` — change `expect(result).toEqual({ ok: true })` assertions to account for `logs` field
- [x] 5.2 Add test: `result.logs` is an array on both success and error results
- [x] 5.3 Add test: `console.log("hello")` produces LogEntry with `method: "console.log"`, `args: ["hello"]`, `status: "ok"`
- [x] 5.4 Add test: `console.warn` and `console.error` produce correct method names
- [x] 5.5 Add test: `ctx.emit(...)` produces LogEntry with `method: "ctx.emit"`, `status: "ok"`
- [x] 5.6 Add test: `ctx.fetch(...)` produces LogEntry with `method: "ctx.fetch"`
- [x] 5.7 Add test: failed bridge produces LogEntry with `status: "failed"` and `error` field
- [x] 5.8 Add test: sandbox isolation still holds (process, require, fetch, constructor escape) — verify no regressions
- [x] 5.9 Update `scheduler.test.ts` — add `logs: []` to all mock `SandboxResult` returns

## 6. Validate

- [x] 6.1 Run `pnpm validate` (lint + format + type check + tests) and fix any issues
