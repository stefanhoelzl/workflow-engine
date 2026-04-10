## 1. Dependencies and Action Type

- [x] 1.1 Add `quickjs-emscripten` to `packages/runtime/package.json`
- [x] 1.2 Change `Action` interface: replace `handler: (ctx: ActionContext) => Promise<void>` with `source: string` in `packages/runtime/src/actions/index.ts`
- [x] 1.3 Change `TransitionOpts` error field from `error: string` to `error: { message: string; stack: string }` in `packages/runtime/src/event-source.ts`
- [x] 1.4 Update event store and dashboard to handle the new error object format

## 2. Sandbox Core

- [x] 2.1 Create `packages/runtime/src/sandbox/index.ts` with `SandboxResult` type, `Sandbox` interface, and `createSandbox()` factory that instantiates the QuickJS WASM module
- [x] 2.2 Implement `spawn()`: create fresh QuickJS context, evaluate action source as module with default export, extract and call handler, return `SandboxResult`, dispose context
- [x] 2.3 Accept `AbortSignal` parameter in `spawn()` (no-op for now)

## 3. Sandbox Globals

- [x] 3.1 Create `packages/runtime/src/sandbox/globals.ts` with `btoa`/`atob` setup
- [x] 3.2 Add `setTimeout`/`clearTimeout` bridging: register sync host functions that delegate to Node.js timers, return real timer IDs, pump `executePendingJobs()` on callback
- [x] 3.3 Add `setInterval`/`clearInterval` bridging with same pattern

## 4. Ctx Bridge

- [x] 4.1 Create `packages/runtime/src/sandbox/bridge.ts` with generic async bridge helper (deferred promise pattern: `newPromise()` → host async op → `deferred.resolve()` → `executePendingJobs()`)
- [x] 4.2 Bridge `ctx.event` and `ctx.env` as serialized JSON data on QuickJS global
- [x] 4.3 Bridge `ctx.emit(type, payload)` as async host function using deferred pattern
- [x] 4.4 Bridge `ctx.fetch(url, init)` as async host function using deferred pattern
- [x] 4.5 Implement Response proxy: construct QuickJS object with `status`, `statusText`, `ok`, `url` properties, `headers` as Map (lowercase keys), `json()` and `text()` as async host bridges

## 5. Scheduler Integration

- [x] 5.1 Update `createScheduler()` signature to accept `Sandbox` parameter
- [x] 5.2 Replace `await action.handler(ctx)` with `await sandbox.spawn(action.source, ctx)` in `executeAction`
- [x] 5.3 Update `executeAction` to pattern-match on `SandboxResult` — store `{ message, stack }` error object on failure
- [x] 5.4 Update `main.ts` to call `createSandbox()` and pass sandbox to scheduler

## 6. Loader Changes

- [x] 6.1 Update loader to read per-action source files via `readFile` instead of `import()`
- [x] 6.2 Read each action's `module` field from manifest to resolve the source file path
- [x] 6.3 Produce `Action` objects with `source: string` instead of `handler: function`

## 7. Vite Plugin Changes

- [x] 7.1 Emit one file per action (`dist/{workflow}/{actionName}.js`) instead of single `actions.js`
- [x] 7.2 Transform each action handler to `export default async (ctx) => { ... }` format
- [x] 7.3 Update manifest generation: per-action `module` field instead of root `module` field
- [x] 7.4 Remove `handler` field from manifest action entries (no longer needed — action name is the filename)

## 8. SDK Manifest Schema

- [x] 8.1 Update `ManifestSchema` in SDK: add `module` to action schema, remove root `module` field
- [x] 8.2 Remove `handler` field from action schema (or make optional for backwards compat during migration)

## 9. Tests

- [x] 9.1 Sandbox isolation tests: verify action code cannot access `process`, `require`, `fs`, `fetch`, `globalThis.constructor`
- [x] 9.2 Sandbox result tests: successful execution returns `{ ok: true }`, thrown errors return `{ ok: false, error: { message, stack } }`
- [x] 9.3 Ctx bridge tests: `emit()` calls host-side emit, `fetch()` returns Response proxy with status/headers/json()/text()
- [x] 9.4 Globals tests: `btoa`/`atob` work, `setTimeout`/`clearTimeout` work with real timer IDs, timer callbacks pump promises
- [x] 9.5 Concurrent async test: `Promise.all([ctx.fetch(url1), ctx.fetch(url2)])` completes with both results
- [x] 9.6 Update existing scheduler tests to use sandbox instead of direct handler calls
- [x] 9.7 Update existing loader tests for new source-string Action format
- [x] 9.8 Update Vite plugin tests for per-action output format
- [x] 9.9 Rebuild cronitor workflow with updated plugin and verify it loads and runs correctly
