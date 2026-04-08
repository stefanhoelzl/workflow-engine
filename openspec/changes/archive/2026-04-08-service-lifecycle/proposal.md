## Why

The runtime entrypoint has no graceful shutdown — `scheduler.start()` fires and forgets, `serve()` keeps the process alive, and neither has error handling. If the scheduler loop fails silently the process continues half-alive, and there's no way to drain in-flight work on SIGINT/SIGTERM. The scheduler and server also have inconsistent APIs (class vs. bare function), making the entrypoint harder to reason about.

## What Changes

- Introduce a `Service` interface (`start(): Promise<void>`, `stop(): Promise<void>`) as the shared contract for long-running components
- Replace the `Scheduler` class with a `createScheduler()` factory returning a closure-based `Service`
- Wrap the HTTP server in a `createServer()` factory returning a `Service` (with `createApp()` split out for testability)
- Move scheduler and server into a `services/` directory
- Add `AbortSignal` support to `EventQueue.dequeue()` so the scheduler loop can be interrupted on shutdown
- Restructure `main.ts` as an `async main()` with signal handlers (SIGINT, SIGTERM), coordinated shutdown via `Promise.allSettled`, and `process.exit()`
- Service `start()` promises reject on fatal errors (scheduler loop failure, server bind failure), triggering full shutdown

## Capabilities

### New Capabilities

- `service-lifecycle`: Service interface, factory patterns, graceful shutdown coordination, and signal handling

### Modified Capabilities

- `event-queue`: `dequeue()` gains an optional `AbortSignal` parameter for cancellation
- `scheduler`: Becomes a closure-based factory returning `Service`; `stop()` returns `Promise<void>` instead of being void-based
- `http-server`: `createServer` returns a `Service` wrapping the Hono app; `createApp` split out for test access

## Impact

- **Code**: `packages/runtime/src/scheduler/` moves to `packages/runtime/src/services/scheduler.ts`, `server.ts` moves to `services/server.ts`, new `services/index.ts` for the `Service` type
- **Interfaces**: `EventQueue.dequeue()` signature changes (backwards-compatible — signal is optional)
- **Tests**: Scheduler tests updated for factory API and AbortSignal (no more dummy-event-to-unblock workaround); server tests use `createApp` directly
- **Entrypoint**: `main.ts` restructured as async main with shutdown handling
