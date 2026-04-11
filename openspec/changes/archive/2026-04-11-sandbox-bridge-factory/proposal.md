## Why

Every host-to-sandbox bridge is hand-coded with the same boilerplate: extract args from QuickJS handles, call the host implementation, marshal the result back, dispose handles, and for async bridges manage a deferred promise lifecycle. This produces ~200 lines of near-identical code across `globals.ts` and `bridge.ts`, making new bridges error-prone to add and existing ones hard to audit. There is also no `console` global in the sandbox, so action authors have no way to log debug output, and no structured record of which bridge calls an action made during execution.

## What Changes

- Introduce a `createBridge(vm, runtime)` factory that registers sync and async bridges declaratively via `{ args, marshal, impl }` descriptors, with typed arg extractors and marshal helpers.
- Refactor existing bridges (`btoa`, `atob`, `ctx.emit`, `ctx.fetch`, `response.json()`, `response.text()`) to use the factory.
- Add `console.log/info/warn/error/debug` as sandbox globals via the factory.
- Auto-log every bridge invocation (method, args, result, status, timing) to a structured `LogEntry[]` array scoped to each `spawn()` call.
- Add `logs: LogEntry[]` to both variants of `SandboxResult` so callers receive the full bridge/console trace.
- Timers (`setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`) remain hand-coded but gain access to the log array via `pushLog`.

## Capabilities

### New Capabilities

None. The bridge factory is internal implementation machinery for the sandbox.

### Modified Capabilities

- `action-sandbox`: Adds declarative bridge factory with typed arg extractors, marshal helpers, and auto-logging. `SandboxResult` gains a `logs: LogEntry[]` field on both variants. `console` global added. Safe globals list expanded to include `console.log/info/warn/error/debug`.

## Impact

- `packages/runtime/src/sandbox/bridge-factory.ts` — new file (factory, types, arg extractors, marshal helpers)
- `packages/runtime/src/sandbox/globals.ts` — rewritten to use factory for btoa/atob/console, timers stay hand-coded
- `packages/runtime/src/sandbox/bridge.ts` — rewritten to use factory for emit/fetch/response methods
- `packages/runtime/src/sandbox/index.ts` — updated SandboxResult type, wires bridge into spawn
- `packages/runtime/src/sandbox/sandbox.test.ts` — updated assertions, new logging/console tests
- `packages/runtime/src/services/scheduler.test.ts` — mock SandboxResult values gain `logs: []`
- No changes to ActionContext, EventBus, or any persistence layer
- No manifest format changes
- No breaking changes for action authors (additive only: console global + logs field)
