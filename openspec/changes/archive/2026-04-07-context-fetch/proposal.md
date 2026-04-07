## Why

Actions need a way to make outbound HTTP requests. When the V8 sandbox lands, global `fetch` will be unavailable inside isolates. Adding `ctx.fetch()` now establishes the API contract so action authors use the context-provided method from the start, and the sandbox can intercept it later without breaking existing actions.

## What Changes

- Add a `fetch(url, init?)` method to `ActionContext` that delegates to an injected fetch function
- Inject the fetch function via constructor (same pattern as `emit`)
- `ContextFactory` accepts a fetch parameter and passes it through to `ActionContext`
- Production wiring passes `globalThis.fetch`
- `Context` interface and `HttpTriggerContext` are unchanged — fetch is ActionContext-only
- Returns native `Response` objects (no serialization layer until sandbox requires it)

## Capabilities

### New Capabilities

(none — this extends an existing capability)

### Modified Capabilities

- `context`: ActionContext gains a `fetch` method; ContextFactory gains a `fetch` constructor parameter

## Impact

- `packages/runtime/src/context/index.ts` — ActionContext class and ContextFactory
- `packages/runtime/src/main.ts` — wire `globalThis.fetch` into ContextFactory
- All test files that instantiate `ContextFactory` or `ActionContext` directly (context.test.ts, scheduler.test.ts, dispatch.test.ts, integration.test.ts)
- No QueueStore interface changes
- No manifest format changes
- No new dependencies
