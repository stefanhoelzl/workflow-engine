## Why

The workflow engine has no running code yet. An HTTP trigger is the entry point for all external stimuli — without it, nothing can flow through the system. Building this first establishes the HTTP server foundation, the trigger abstraction, and the request-handling pipeline that everything else will build on.

## What Changes

- Add **Hono** (`hono` + `@hono/node-server`) as the HTTP framework for the runtime
- Introduce `HttpTriggerDefinition` — a pure data type describing an HTTP trigger (path, method, response)
- Introduce `HttpTriggerRegistry` — a minimal registry for registering and looking up trigger definitions
- Introduce `httpTriggerMiddleware` — Hono middleware connecting the HTTP server to the registry, handling the `/webhooks/` prefix and invoking a callback when a trigger matches
- Introduce `createServer(...middlewares)` — a generic Hono server factory that knows nothing about triggers
- Add `main.ts` as the runtime entry point with hardcoded trigger wiring (temporary, replaced when SDK/manifest lands)

## Capabilities

### New Capabilities
- `http-trigger`: HTTP trigger definitions, registry for managing them, and middleware for matching incoming requests to triggers
- `http-server`: Generic Hono HTTP server that accepts middleware, serves as the foundation for all platform HTTP endpoints

### Modified Capabilities

None.

## Impact

- **New dependencies**: `hono`, `@hono/node-server`
- **New package structure**: `packages/runtime/src/` gains `main.ts`, `server.ts`, and `triggers/http.ts`
- **No effect** on sandbox, queue, events, SDK, or build pipeline — those don't exist yet
- **No security implications** — this change doesn't touch the sandbox boundary
- **No manifest or QueueStore changes** — triggers are hardcoded for now
