# Workflow Automation Service

## Purpose

A lightweight, event-driven workflow automation service. Users author workflows as TypeScript projects that wire triggers, events, and actions together. User-provided action code runs in a sandboxed V8 isolate. The system persists every event to a filesystem-backed append-only queue for crash recovery and auditability.

## Tech Stack

- **Runtime**: Node.js (LTS)
- **Language**: TypeScript (strict mode)
- **Sandbox**: `isolated-vm` — V8 Isolates with separate heap, no shared prototype chain
- **Build**: Vite with Rolldown, custom plugin for action bundling and manifest generation
- **Schema/Types**: Zod for event schemas (compile-time type inference via `z.infer<>`)
- **Package Manager**: pnpm (workspace monorepo)
- **Logging**: Structured JSON Lines to file

## Architecture Principles

- **Four primitives**: Trigger → Event → Action → Event. Events are the connective tissue; triggers and actions are the nodes.
- **Single source of truth**: `workflow.ts` defines all wiring. Actions are plain handler functions with no embedded metadata.
- **Uniform async**: Every trigger is async. HTTP triggers return a static response immediately and enqueue events. No synchronous execution path.
- **Fan-out**: When an event has multiple subscribers, each gets an independent queue entry. Subscribers run in parallel. One failure does not block others.
- **Stateless actions**: Each invocation is independent. Fresh isolate per invocation, JSON in / JSON out, no shared state.
- **Minimal API surface**: Actions can only read `ctx.data` and call `ctx.emit()`. No fetch, no fs, no secrets in v1.
- **Append-only log**: Events are never deleted. Done and failed events are retained for audit trail and replay.
- **Interface-first**: The queue is abstracted behind `QueueStore`. The filesystem implementation is the first backend; S3, SQLite, Redis can follow without changing the runtime.

## Project Conventions

### Code Style

- Strict TypeScript with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- Named exports preferred over default exports (except action handler files which use default export)
- Explicit return types on all public functions
- No classes unless required by external APIs (prefer plain functions and interfaces)

### Naming

- Event types: dot-separated lowercase (`order.received`, `system.error`)
- Action files: camelCase matching the action name (`parseOrder.ts`)
- Queue event IDs: prefixed with `evt_` + ULID or nanoid
- Correlation IDs: prefixed with `corr_`
- Trace IDs: prefixed with `trace_`

### Error Handling

- Actions that throw are moved to `failed/` immediately (no retry in v1)
- A `system.error` event is emitted for every action failure
- Runtime errors (queue write failures, isolate crashes) are logged and surfaced via structured logs

### Testing Strategy

- Unit tests for SDK (DSL builder, `defineEvent`, type inference)
- Unit tests for runtime components (scheduler, dispatcher, queue)
- Integration tests: build a sample workflow, run it end-to-end, assert event flow
- Sandbox tests: verify isolate memory/timeout limits, verify host API boundary

## Domain Context

### Workflow Model

A **workflow** is a directed graph where:
- **Triggers** are entry points that produce events from external stimuli (HTTP requests in v1).
- **Events** are typed messages with Zod schemas flowing through the graph.
- **Actions** are sandboxed JavaScript handlers that consume one event type and may emit zero or more event types.

The graph is defined declaratively in `workflow.ts` using a TypeScript DSL. At build time, Vite bundles each action into a standalone `.js` file and produces a `manifest.json` describing the wiring.

### Security Model

The service runs untrusted user code. Anyone can create an account. The sandbox must assume hostile input:
- `isolated-vm` provides V8 Isolate-level separation (separate heap, no prototype chain traversal).
- 8 MB memory limit, 30-second execution timeout per invocation.
- Only `ctx.data` (read) and `ctx.emit()` (write to host) cross the boundary.
- No access to fs, net, process, require, child_process, or any Node.js API.
- Event metadata is never exposed to action code.
- Build-time metadata extraction is static (AST-free since v1 derives everything from workflow.ts) — action code is never executed at build time.

### Queue Semantics

- Filesystem-backed with subdirectories: `pending/`, `processing/`, `done/`, `failed/`.
- Atomic `fs.rename` for state transitions (crash-safe on Linux/macOS).
- On startup: files in `processing/` are recovered to `pending/` (crash recovery).
- In-memory list drives the scheduler; filesystem is the persistence layer.
- No ordering guarantees. No retry in v1.

## Monorepo Structure

```
packages/
├── sdk/              # @your-platform/sdk
├── vite-plugin/      # @your-platform/vite-plugin
└── runtime/          # @your-platform/runtime
```

- **sdk**: `defineEvent`, `workflow` DSL builder, `httpTrigger`, `ActionContext` type, Zod re-exports.
- **vite-plugin**: Vite plugin that imports the workflow DSL at build time, configures action entries, emits `manifest.json`.
- **runtime**: HTTP server, scheduler, executor (isolated-vm), dispatcher (fan-out), queue interface + filesystem implementation, manifest loader.

## Important Constraints

- **Single instance**: One workflow per service instance in v1. `WorkflowRuntime` is designed as an instantiable object for future multi-workflow support.
- **No hot-reload**: Restart the service to deploy workflow updates.
- **No runtime validation**: Zod schemas are compile-time only in v1. Runtime validation can be added by serializing schemas at build time.
- **No retry**: Failed actions go straight to `failed/`. Retry is a future addition to `QueueStore`.
- **JSON only**: All data crossing the sandbox boundary must be JSON-serializable.

## External Dependencies

- `isolated-vm` — V8 Isolate sandbox (native addon, requires C++ build toolchain)
- `zod` — Schema definition and type inference
- `vite` — Build tooling with Rolldown bundler
- `nanoid` or `ulid` — Event ID generation
