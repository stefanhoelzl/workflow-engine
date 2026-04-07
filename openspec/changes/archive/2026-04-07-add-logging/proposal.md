## Why

The engine has zero operational visibility — the only log line is the startup message. When an event fails, an action misbehaves, or a trigger fires unexpectedly, there is no way to observe what happened without attaching a debugger. Structured logging across the trigger-event-action pipeline is needed for operational monitoring and audit.

## What Changes

- Add a `logger` module (`logger.ts`) that wraps pino behind an app-owned `Logger` interface — pino is never imported outside this module
- Add structured logging at 4 hook points:
  - **Hono middleware**: standard HTTP access log (method, path, status, duration)
  - **Context emit**: logs every event emission with correlationId, event type, eventId, parentEventId
  - **Context fetch**: logs outbound HTTP requests (url, method, status, duration)
  - **Scheduler (built-in via Logger)**: logs action start/complete/fail, no-match, ambiguous-match with correlationId and duration
- Log levels: `info` (operational state transitions), `debug` (routing/matching decisions), `trace` (full payload dumps)
- All loggers are passed via constructor injection

## Capabilities

### New Capabilities
- `logging`: Logger interface, pino wrapper, log levels, createLogger factory

### Modified Capabilities
- `scheduler`: Add Logger to constructor for built-in logging
- `context`: Add logging on emit and fetch calls

## Impact

- New dependency: `pino` (runtime)
- Modified interfaces: `Scheduler` (Logger parameter)
- Modified classes: `ContextFactory`, `ActionContext`, `HttpTriggerContext`
- Modified: `server.ts` (Hono access log middleware), `main.ts` (logger wiring)
