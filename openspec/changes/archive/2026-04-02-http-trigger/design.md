## Context

The workflow engine runtime has no code yet — `packages/runtime/src/index.ts` exports nothing. This is the first feature: standing up an HTTP server that can receive trigger requests. The runtime will grow to include a queue, scheduler, sandbox, and platform API endpoints (auth, deploy), so the HTTP layer must be generic and extensible.

## Goals / Non-Goals

**Goals:**
- Establish the HTTP server foundation using Hono
- Implement a decoupled HTTP trigger system (definition, registry, middleware)
- Have a running process that accepts `curl` requests and responds
- Set up the directory structure and testing patterns for the runtime package

**Non-Goals:**
- Events, queue, or any downstream processing of trigger payloads
- SDK or DSL for defining triggers (hardcoded for now)
- Manifest loading or build pipeline integration
- Platform API endpoints (auth, deploy, health)
- Generic trigger abstraction (only HTTP triggers in this step)
- Unregister/replace triggers (add when deploy workflow exists)

## Decisions

### 1. Hono as HTTP framework

**Choice**: Hono + `@hono/node-server`

**Alternatives considered**:
- `node:http` — zero deps but requires hand-rolling routing, JSON parsing, error handling. Would end up building a framework.
- Fastify — powerful plugin system but heavier dependency tree (~15 deps) and more conceptual overhead than needed.
- Express — showing its age, weaker TypeScript support.

**Rationale**: Minimal footprint (~50KB, 1 dep), first-class TypeScript, web-standard `Request`/`Response` APIs. Testing via `app.request()` requires no running server. The trigger registry pattern means triggers are decoupled from the framework anyway, so the choice is low-risk.

### 2. Trigger definitions as pure data

**Choice**: `HttpTriggerDefinition` is a plain object with `path`, `method`, and `response` — no behavior, no framework imports.

**Rationale**: Keeps trigger definitions portable. When the SDK produces these from `httpTrigger()` calls or the manifest contains them, no coupling to Hono exists. Also makes the registry trivially testable.

### 3. Registry + middleware separation

**Choice**: Three distinct pieces:
- `HttpTriggerRegistry` — stores and looks up definitions (pure data, no HTTP awareness)
- `httpTriggerMiddleware(registry, callback)` — Hono middleware that bridges HTTP requests to the registry, invokes callback on match
- `createServer(...middlewares)` — generic Hono app factory

**Alternatives considered**:
- Registry owns the callback — adds behavior to what should be a data store.
- Server knows about triggers directly — couples the HTTP server to trigger concepts, making it harder to add other platform routes.

**Rationale**: Each piece has a single responsibility and clear test boundary. The middleware is the integration point; registry and server are independently testable.

### 4. `/webhooks/` prefix owned by middleware

**Choice**: `HttpTriggerDefinition.path` is relative (e.g., `"order"`). The middleware prepends `/webhooks/` when matching.

**Rationale**: Trigger definitions shouldn't know about URL routing. If the mount point changes, only the middleware changes. Also keeps definitions clean when they later come from the SDK.

### 5. `main.ts` as entry point, separate from server

**Choice**: `main.ts` is the process entry point. `server.ts` exports a `createServer` factory.

**Rationale**: The HTTP server is one part of the runtime. `main.ts` will later also initialize the queue, scheduler, and load manifests. Keeping it separate means `server.ts` stays focused and testable without starting a process.

### 6. Callback passed to middleware factory

**Choice**: `httpTriggerMiddleware(registry, onTrigger)` — the callback is a parameter, not registered on the registry.

**Rationale**: The registry is a lookup table. What happens when a trigger fires is the middleware's (and later the runtime's) concern. This keeps the registry minimal and avoids mixing data storage with event dispatch.

## Risks / Trade-offs

- **Hardcoded trigger is throwaway code** → Acceptable. It's isolated to `main.ts` with comments marking it temporary. Replaced when manifest loading lands.
- **No input validation on trigger payloads** → The spec says Zod validation is compile-time only in v1. Non-JSON bodies get a 400; valid JSON passes through unvalidated.
- **Single callback for all triggers** → Sufficient for now. If different triggers need different handling later, the callback receives the definition so it can dispatch.

## Request Flow

```
  curl POST /webhooks/order
       │
       ▼
  ┌─────────────────────┐
  │  Hono HTTP Server    │
  │  (createServer)      │
  └──────────┬──────────┘
             │ middleware chain
             ▼
  ┌─────────────────────┐
  │  httpTriggerMiddle-  │
  │  ware                │
  │                      │
  │  1. strip /webhooks/ │
  │  2. registry.lookup  │──── no match ──▶ next() ──▶ 404
  │  3. parse JSON body  │
  │  4. call onTrigger   │
  │  5. return response  │
  └──────────────────────┘
```
