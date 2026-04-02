## 1. Setup

- [x] 1.1 Add `hono` and `@hono/node-server` dependencies to `packages/runtime`
- [x] 1.2 Create directory structure: `src/triggers/` directory, `src/main.ts`, `src/server.ts`, `src/triggers/http.ts`

## 2. HTTP Trigger

- [x] 2.1 Implement `HttpTriggerDefinition` type and `HttpTriggerRegistry` (register, lookup) in `src/triggers/http.ts`
- [x] 2.2 Implement `httpTriggerMiddleware` factory in `src/triggers/http.ts`
- [x] 2.3 Unit tests for registry (register + lookup match, lookup miss, wrong method)
- [x] 2.4 Unit tests for middleware (matching request → callback + response, no match → next, outside /webhooks/ → next, non-JSON body → 400)

## 3. HTTP Server

- [x] 3.1 Implement `createServer(...middlewares)` in `src/server.ts`
- [x] 3.2 Unit tests for server (middleware mounting, unmatched route → 404)

## 4. Entry Point

- [x] 4.1 Implement `main.ts` with hardcoded trigger wiring and server startup
- [x] 4.2 Verify end-to-end: start process, curl POST /webhooks/order → 202
