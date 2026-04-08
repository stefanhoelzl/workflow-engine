## Context

The runtime entrypoint (`main.ts`) starts two long-running components — the scheduler loop and the HTTP server — without coordinated lifecycle management. The scheduler is a class with `start()`/`stop()` methods; the server is a bare `serve()` call returning a Node server instance that's discarded. Neither component surfaces errors to the entrypoint, and there's no shutdown handling for SIGINT/SIGTERM.

The `dequeue()` method blocks indefinitely when the queue is empty, so `scheduler.stop()` can't unblock the loop without enqueueing a dummy event — a workaround visible in the existing tests.

## Goals / Non-Goals

**Goals:**

- Uniform `Service` interface for all long-running components (`start()` / `stop()` returning promises)
- Graceful shutdown on SIGINT/SIGTERM: drain in-flight work, then exit
- Fatal error propagation: if a service fails, shut everything down and exit non-zero
- Cancellable `dequeue()` via `AbortSignal` so the scheduler loop exits cleanly
- Clean entrypoint structure with explicit async flow

**Non-Goals:**

- Concurrent event processing (remains sequential for now)
- Health checks or readiness probes
- Configurable shutdown timeouts
- Restart/supervision of individual services

## Decisions

### 1. Shared `Service` interface in `services/index.ts`

```typescript
interface Service {
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

`start()` returns a promise that resolves on clean stop and rejects on fatal error. `stop()` triggers graceful shutdown and resolves when the service is fully stopped.

**Why**: A uniform contract lets the entrypoint manage all services identically — start them, catch their errors, and stop them in a coordinated way. The alternative (ad-hoc APIs per component) is what we have today and it doesn't compose.

### 2. Closure-based factories instead of classes

Both `createScheduler()` and `createServer()` return plain `Service` objects backed by closure state. The `Scheduler` class is removed.

**Why**: The class exposes internal state (`stopped` getter, `#loopPromise`) that leaks implementation details. A factory returning `{ start, stop }` constrains the API surface to exactly what the entrypoint needs. Closures keep mutable state private without `#private` field ceremony.

### 3. `createApp()` split from `createServer()`

`createApp(...middlewares)` returns a Hono app (testable via `app.request()`). `createServer(port, ...middlewares)` wraps it into a `Service`.

**Why**: Server tests need to call `app.request()` without starting a real HTTP listener. Splitting the two concerns preserves the existing test pattern.

### 4. `AbortSignal` on `dequeue()` for cancellable blocking

`EventQueue.dequeue(signal?: AbortSignal)` rejects with an `AbortError` when the signal fires. The `InMemoryEventQueue` implementation removes the waiter from the array on abort to prevent race conditions.

**Why over sentinel events**: AbortSignal is the standard Node.js/Web API cancellation mechanism. Sentinel events pollute the queue and require all implementations to handle a magic event type. AbortSignal is opt-in (parameter is optional) so the interface stays backwards-compatible.

**Why over timeout-based polling**: Polling adds latency (up to the poll interval) and unnecessary CPU cycles. AbortSignal gives instant cancellation.

### 5. Server error handling scoped to bind failures

The server's `start()` promise only rejects on errors that prevent the server from becoming responsive (e.g., `EADDRINUSE`, `EACCES`). After the `'listening'` event, the error rejection handler is removed — per-connection errors don't trigger shutdown.

**Why**: Per-connection errors (socket resets, timeouts) are normal in production. Only pre-listen failures indicate a truly broken server that warrants shutting down the process.

### 6. Signal handling with double-signal guard

SIGINT and SIGTERM trigger a single `shutdown()` function protected by a boolean guard. Second signals are ignored (graceful shutdown continues).

**Why over force-exit on second signal**: Force-exit risks corrupting in-flight queue state. The shutdown sequence is fast (drain current event + close server) so patience is fine.

### 7. `process.exit()` after cleanup

After `Promise.allSettled([server.stop(), scheduler.stop()])`, the process logs and calls `process.exit(0)` (or `process.exit(1)` on error).

**Why over natural drain**: If any reference (timer, socket, etc.) accidentally keeps the event loop alive, natural drain hangs indefinitely. Explicit exit is deterministic.

### 8. File structure

```
src/services/
  index.ts          # Service interface export
  scheduler.ts      # createScheduler() factory
  scheduler.test.ts # scheduler tests
  server.ts         # createApp() + createServer()
  server.test.ts    # server tests (uses createApp)
```

`src/scheduler/` directory is removed. `src/server.ts` moves into `services/`.

## Risks / Trade-offs

**[Risk] AbortSignal adds complexity to EventQueue interface** → Mitigation: The parameter is optional, so existing and future implementations can ignore it. The `InMemoryEventQueue` change is ~10 lines.

**[Risk] `process.exit()` can skip cleanup** → Mitigation: All cleanup (`stop()` calls) happens before `process.exit()`. The exit is the last statement.

**[Risk] Scheduler loop error crashes the process** → Accepted trade-off: A half-running process (scheduler dead, server alive) is worse than a clean restart. Container orchestrators will restart the process.

## Shutdown Sequence

```
  SIGINT/SIGTERM or service error
         │
         ▼
    shutdown(code)
         │
         ├── guard: if already shutting down, return
         │
         ├── log "shutting down"
         │
         ├── Promise.allSettled([
         │     server.stop(),      ← server.close() wrapped in promise
         │     scheduler.stop(),   ← abort + await loop drain
         │   ])
         │
         ├── log "shutdown complete"
         │
         └── process.exit(code)
```
