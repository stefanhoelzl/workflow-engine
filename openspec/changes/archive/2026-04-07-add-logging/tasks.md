## 1. Logger Module

- [x] 1.1 Add pino dependency to packages/runtime
- [x] 1.2 Create `logger.ts` with `Logger` interface, `LogLevel` type, and `createLogger` factory wrapping pino
- [x] 1.3 Add tests for logger: level filtering, named loggers, child loggers, silent mode, argument order convention

## 2. Scheduler Logging

- [x] 2.1 Add Logger parameter to Scheduler constructor and implement built-in logging (action.started, action.completed, action.failed, event.no-match, event.ambiguous-match) with duration tracking
- [x] 2.2 Add tests for scheduler logging

## 3. Context Logging

- [x] 3.1 Add Logger parameter to ContextFactory constructor
- [x] 3.2 Add emit logging in `#createAndEnqueue`: info for event.emitted, trace for payload (covers both HttpTriggerContext and ActionContext)
- [x] 3.3 Add fetch logging in ActionContext: info for fetch.start and fetch.completed/failed with duration, trace for request body
- [x] 3.4 Add tests for context emit and fetch logging

## 4. HTTP Access Log

- [x] 4.1 Create Hono access log middleware that logs method, path, status, and duration
- [x] 4.2 Add Logger parameter to the server/middleware factory
- [x] 4.3 Add tests for access log middleware

## 5. Wiring and Integration

- [x] 5.1 Update `main.ts` to create named loggers and pass them to all components
- [x] 5.2 Update integration test to verify end-to-end log output across the full trigger-event-action pipeline
