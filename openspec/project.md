# Workflow Automation Service

## Purpose

A lightweight, event-driven workflow automation service. Users author workflows as TypeScript projects that wire triggers, events, and actions together. User-provided action code runs in a sandboxed QuickJS WASM context. The system distributes every event through a bus of consumers for persistence, scheduling, indexing, and logging.

## Tech Stack

- **Runtime**: Node.js (LTS)
- **Language**: TypeScript (strict mode)
- **Sandbox**: `quickjs-emscripten` — QuickJS WASM with fresh context per invocation
- **HTTP**: Hono with `@hono/node-server`
- **Build**: Vite with Rolldown, custom plugin for per-action bundling and manifest generation
- **Schema/Types**: Zod v4 for event schemas (compile-time type inference via `z.infer<>`, runtime payload validation)
- **Event Store**: DuckDB in-memory via `@duckdb/node-api` + Kysely query builder
- **Logging**: pino, structured JSON to stdout, wrapped behind app-owned `Logger` interface
- **Storage**: `StorageBackend` interface with filesystem and S3 implementations
- **Package Manager**: pnpm (workspace monorepo)
- **Dashboard**: Server-rendered HTML with HTMX, Alpine.js, and Jedison (JSON Schema forms)

## Architecture Principles

- **Four primitives**: Trigger → Event → Action → Event. Events are the connective tissue; triggers and actions are the nodes.
- **Single source of truth**: `workflow.ts` defines all wiring. Actions are plain handler functions with no embedded metadata.
- **Uniform async**: Every trigger is async. HTTP triggers return a static response immediately and emit events through the bus. No synchronous execution path.
- **Fan-out**: When an event has multiple subscribers, the scheduler creates a targeted copy for each via `EventSource.fork()`. Subscribers run independently. One failure does not block others.
- **Stateless actions**: Each invocation is independent. Fresh QuickJS context per invocation, JSON in / JSON out, no shared state.
- **Controlled host API**: Actions can read `ctx.event` and `ctx.env`, and call `ctx.emit()` and `ctx.fetch()`. No direct fs, net, process, or require access.
- **Append-only persistence**: Event state files are never modified. Each state transition writes a new file. Done events are archived. Files are independently useful for auditing.
- **Interface-first**: Persistence is abstracted behind `StorageBackend` (FS and S3 implementations). Event distribution is abstracted behind `BusConsumer`. New backends can be added without changing the runtime.

## Project Conventions

### Code Style

- Strict TypeScript with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- Named exports preferred over default exports (except action handler files which use default export)
- Explicit return types on all public functions
- No classes unless required by external APIs (prefer plain functions and interfaces)

### Naming

- Event types: dot-separated lowercase (`order.received`, `system.error`)
- Action files: camelCase matching the action name (`parseOrder.js`)
- Event IDs: prefixed with `evt_`
- Correlation IDs: prefixed with `corr_`

### Error Handling

- Actions that fail are transitioned to `state: "done"`, `result: "failed"` with an `error` field (no retry in v1)
- The `PayloadValidationError` type carries structured validation issues for invalid event payloads
- HTTP triggers return 422 with structured error details on payload validation failure
- Runtime errors (bus pipeline failures, sandbox crashes) are logged via structured logging

### Testing Strategy

- Unit tests for SDK (DSL builder, `defineEvent`, type inference)
- Unit tests for runtime components (scheduler, event source, work queue, persistence)
- Integration tests: build a sample workflow, run it end-to-end, assert event flow
- Sandbox tests: verify WASM isolation boundary, ctx bridging, safe globals, context disposal

## Domain Context

### Workflow Model

A **workflow** is a directed graph where:
- **Triggers** are entry points that produce events from external stimuli (HTTP requests in v1).
- **Events** are typed messages with Zod schemas flowing through the graph.
- **Actions** are sandboxed JavaScript handlers that consume one event type and may emit zero or more event types.

The graph is defined declaratively in `workflow.ts` using a TypeScript DSL. At build time, Vite bundles each action into a standalone `.js` file per workflow subdirectory and produces a `manifest.json` describing the wiring. Each action's `env` (resolved environment variables) is captured in the manifest at build time.

### Security Model

The service runs untrusted user code. Anyone can create an account. The sandbox must assume hostile input:
- `quickjs-emscripten` provides WASM-level isolation (separate memory space, no shared prototype chain).
- Each invocation gets a fresh QuickJS context. All handles are disposed after execution.
- Only `ctx.event` and `ctx.env` (read, serialized as JSON) and `ctx.emit()` and `ctx.fetch()` (write, bridged via deferred promises) cross the boundary.
- No access to fs, net, process, require, child_process, or any Node.js API.
- Safe globals only: `btoa`, `atob`, `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`.
- Event metadata is never exposed to action code. Actions receive `{ name, payload }`, not `RuntimeEvent`.
- Build-time metadata extraction is static — `.compile()` produces serializable metadata without executing action code.
- Memory limits and execution timeouts are deferred in v1 (QuickJS supports both, not yet wired).

### Event Pipeline

Events flow through an `EventBus` that fans out to an ordered list of `BusConsumer` implementations:

1. **Persistence** (optional): Append-only state files via `StorageBackend` (FS or S3). `pending/` for active events, `archive/` for terminal and historical events. Fire-and-forget archival on terminal states.
2. **WorkQueue**: In-memory buffer of pending events. The scheduler dequeues from here.
3. **EventStore**: DuckDB in-memory index. Append-only (every state transition inserts a new row). Powers dashboard queries via Kysely.
4. **LoggingConsumer**: Centralized structured logging of all event lifecycle transitions.

State transitions are performed by `EventSource.transition()`, which creates a new immutable `RuntimeEvent` and emits it through the bus. Events are never mutated.

On startup, the persistence consumer's `recover()` method scans `pending/` and `archive/` directories, yielding batches that are bootstrapped into all consumers to rebuild in-memory state.

No ordering guarantees. No retry in v1.

## Monorepo Structure

```
packages/
├── sdk/              # @workflow-engine/sdk
├── vite-plugin/      # @workflow-engine/vite-plugin
└── runtime/          # @workflow-engine/runtime
workflows/            # User-defined workflows (build target, not a package)
```

- **sdk**: `createWorkflow` DSL builder, `http` trigger helper, `env()` helper, `ActionContext` type, `ManifestSchema`, Zod re-exports.
- **vite-plugin**: Vite plugin that imports workflow DSL at build time, extracts manifest via `.compile()`, bundles each action as a standalone default-export `.js` file, enforces TypeScript type checking on production builds.
- **runtime**: HTTP server (Hono), scheduler, QuickJS WASM sandbox, EventBus + consumers (persistence, work-queue, event-store, logging), event source, workflow loader, dashboard UI, trigger UI.
- **workflows**: Workspace member containing user-authored `.ts` workflow files. Built by the vite-plugin into `workflows/dist/<name>/manifest.json` + per-action `.js` files.

## Important Constraints

- **Single instance**: One service instance runs all loaded workflows. `WorkflowRuntime` components are instantiable objects for future multi-instance support.
- **No hot-reload**: Restart the service to deploy workflow updates.
- **No retry**: Failed actions transition to `done/failed`. Retry is a future addition.
- **JSON only**: All data crossing the sandbox boundary must be JSON-serializable.
- **Resource limits deferred**: QuickJS supports memory limits and interrupt handlers, but neither is wired in v1.

## External Dependencies

- `quickjs-emscripten` + `@jitl/quickjs-wasmfile-release-sync` — QuickJS WASM sandbox
- `zod` (v4) — Schema definition, type inference, and runtime validation
- `vite` — Build tooling with Rolldown bundler
- `hono` + `@hono/node-server` — HTTP server framework
- `@duckdb/node-api` + `kysely` — In-memory event store and query builder
- `pino` — Structured JSON logging
- `@aws-sdk/client-s3` — S3 storage backend
- `nanoid` — Event and correlation ID generation
- `alpinejs` + `htmx.org` + `jedison` — Dashboard and trigger UI
