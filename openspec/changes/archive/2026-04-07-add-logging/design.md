## Context

The workflow engine processes HTTP webhooks through a trigger-event-action pipeline. The event model already carries `correlationId` and `parentEventId` for tracing, but nothing in the system writes logs. The only log line is a `console.log` at startup in `main.ts`.

Current components and their boundaries:

```
HTTP Request → httpTriggerMiddleware → ContextFactory.httpTrigger → EventQueue.enqueue
                                                                         │
EventQueue.dequeue ← Scheduler loop → action.match → action.handler → EventQueue.ack/fail
                                                          │
                                              ctx.emit (child events)
                                              ctx.fetch (outbound HTTP)
```

## Goals / Non-Goals

**Goals:**
- Structured JSON logging to stdout for operational monitoring and audit
- Full request tracing via correlationId on all log entries where possible
- Payload-level logging at trace level for debugging
- Logger abstraction that isolates pino from the rest of the codebase
- Constructor injection for testability

**Non-Goals:**
- Log aggregation, shipping, or storage (stdout is the boundary — deployment handles the rest)
- Metrics or distributed tracing (OpenTelemetry, Prometheus) — separate concern
- Logging inside sandboxed action code (actions don't get a logger)
- Log rotation or file output (stdout only)

## Decisions

### Decision 1: pino behind an app-owned Logger interface

**Choice**: Create `logger.ts` that exports a `Logger` interface and `createLogger(name, options?)` factory. pino is only imported inside this module.

**Alternatives considered**:
- **Direct pino usage everywhere**: Simpler, but couples the entire app to pino's API (e.g., the `(data, msg)` argument order). Swapping loggers later would touch every file.
- **winston**: Slower, heavier. pino is the standard for new Node.js services.
- **console.log wrapper**: Would need to reimplement levels, structured output, child loggers. Not worth it when pino exists.

**Interface**:
```typescript
interface Logger {
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
  debug(msg: string, data?: Record<string, unknown>): void
  trace(msg: string, data?: Record<string, unknown>): void
  child(bindings: Record<string, unknown>): Logger
}

type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent"

function createLogger(name: string, options?: { level?: LogLevel }): Logger
```

The wrapper flips pino's `(data, msg)` calling convention to the more conventional `(msg, data?)`.

### Decision 2: Four logging boundaries, no queue decorator

**Choice**: Log at 4 natural boundaries — Hono middleware, context emit, context fetch, scheduler (via its Logger). No `LoggingEventQueue` decorator.

**Rationale**: The scheduler already has full event context (including correlationId) at every point where queue operations happen. A queue decorator would duplicate most log entries. The only thing a decorator would uniquely add is `event.enqueued`, which is already covered by logging in context emit.

**Hook points and what they log**:

| Hook Point | Logger Name | Log Events |
|---|---|---|
| Hono middleware | `http` | Standard access log: method, path, status, duration |
| Context emit | `context` | event.emitted: type, correlationId, eventId, parentEventId |
| Context fetch | `context` | fetch.start, fetch.completed/failed: url, method, status, duration |
| Scheduler (built-in) | `scheduler` | action.started, action.completed, action.failed, event.no-match, event.ambiguous-match |

**Sequence for a full request**:

```
HTTP POST /webhooks/cronitor
  │
  ├─ http:      info  request { method: POST, path: /webhooks/cronitor }
  │
  ├─ context:   info  event.emitted { correlationId, type: cronitor.webhook, eventId: evt_001 }
  │             trace event.emitted.payload { correlationId, payload: {...} }
  │
  ├─ http:      info  response { method: POST, path: /webhooks/cronitor, status: 202, duration: 5 }
  │
  ├─ scheduler: info  action.started { correlationId, eventId: evt_001, action: dispatch }
  │
  │  (dispatch fans out)
  ├─ context:   info  event.emitted { correlationId, type: cronitor.webhook, eventId: evt_002, targetAction: notify-nextcloud }
  │
  ├─ scheduler: info  action.completed { correlationId, eventId: evt_001, action: dispatch, duration: 12 }
  │
  ├─ scheduler: info  action.started { correlationId, eventId: evt_002, action: notify-nextcloud }
  │
  │  (action fetches)
  ├─ context:   info  fetch.start { correlationId, url: https://nextcloud.example.com/..., method: POST }
  ├─ context:   trace fetch.request.body { correlationId, body: {...} }
  ├─ context:   info  fetch.completed { correlationId, url: ..., status: 200, duration: 180 }
  │
  ├─ scheduler: info  action.completed { correlationId, eventId: evt_002, action: notify-nextcloud, duration: 204 }
```

### Decision 3: Constructor injection for all loggers

**Choice**: Create named loggers in `main.ts` and pass them to components via constructors.

**Alternatives considered**:
- **Global/singleton (Python-style `getLogger`)**: Works, but hides dependencies and makes testing require module mocking.
- **AsyncLocalStorage for correlationId**: Unnecessary — every hook point already has access to the `Event` object which carries `correlationId`. No deep call stacks to thread through.

**Wiring in main.ts**:
```typescript
const level = process.env.LOG_LEVEL ?? "info"
createLogger("http", { level })       → Hono access log middleware
createLogger("context", { level })    → ContextFactory constructor
createLogger("scheduler", { level })  → Scheduler constructor
```

Log level is configured via a single `LOG_LEVEL` environment variable (default: `"info"`). All loggers share the same level. Set `LOG_LEVEL=trace` for payload dumps.

The Scheduler receives a Logger via constructor and uses it directly to log lifecycle events (action start/complete/fail, no-match, ambiguous-match). No external hooks needed — the Scheduler owns its logging.

### Decision 4: correlationId as plain data, not child logger bindings

**Choice**: Pass correlationId in the `data` parameter of each log call rather than creating a child logger per correlation.

**Rationale**: Every log call site already has access to the event (and thus correlationId). Creating a child logger per-request adds object allocation overhead for no real benefit — it just saves repeating one field. The `child()` method is still exposed on the Logger interface for the `createLogger` implementation (name binding) and potential future use.

## Risks / Trade-offs

- **pino dependency**: Adds a runtime dependency. Mitigated by the wrapper — swapping is a one-file change.
- **Log volume at trace level**: Full payload dumps can be large. Mitigated by defaulting to `info` level; `trace` is opt-in.
- **No structured error serialization**: pino has built-in error serializers. The wrapper should ensure errors passed in `data` are properly serialized (stack trace, message).
