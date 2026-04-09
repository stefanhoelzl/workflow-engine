# Logging Specification

## Purpose

Provide a structured logging abstraction that wraps pino behind an app-owned interface, isolating the logging dependency to a single module.

## Requirements

### Requirement: Logger interface

The system SHALL provide a `Logger` interface with methods `info`, `warn`, `error`, `debug`, and `trace`, each accepting `(msg: string, data?: Record<string, unknown>)`. The interface SHALL also expose a `child(bindings: Record<string, unknown>): Logger` method that returns a new Logger with the given bindings merged into every log entry.

#### Scenario: Log at info level

- **GIVEN** a Logger instance
- **WHEN** `logger.info("action.completed", { action: "notify", duration: 204 })` is called
- **THEN** a structured JSON line is written to stdout containing `msg: "action.completed"`, `action: "notify"`, `duration: 204`, and a timestamp

#### Scenario: Log at trace level with payload

- **GIVEN** a Logger instance with level set to `"trace"`
- **WHEN** `logger.trace("event.payload", { payload: { orderId: "123" } })` is called
- **THEN** a structured JSON line is written to stdout containing the full payload

#### Scenario: Log level filtering

- **GIVEN** a Logger instance with level set to `"info"`
- **WHEN** `logger.debug("some.detail", { key: "value" })` is called
- **THEN** no output is written (debug is below info)

#### Scenario: Child logger inherits bindings

- **GIVEN** a Logger instance
- **WHEN** `logger.child({ module: "scheduler" })` is called
- **THEN** the returned Logger includes `module: "scheduler"` in every log entry
- **AND** the parent Logger is not affected

### Requirement: createLogger factory

The system SHALL provide a `createLogger(name: string, options?: { level?: LogLevel }): Logger` factory function. The `name` parameter SHALL appear as a top-level `name` field in every log entry produced by the returned Logger. The default level SHALL be `"info"`.

#### Scenario: Create a named logger

- **GIVEN** `createLogger("scheduler")` is called
- **WHEN** the returned logger calls `logger.info("started")`
- **THEN** the output JSON contains `name: "scheduler"`

#### Scenario: Create a logger with custom level

- **GIVEN** `createLogger("context", { level: "trace" })` is called
- **WHEN** `logger.trace("payload", { data: {} })` is called
- **THEN** the trace entry is written to stdout

#### Scenario: Create a silent logger for tests

- **GIVEN** `createLogger("test", { level: "silent" })` is called
- **WHEN** any log method is called
- **THEN** no output is written

### Requirement: LogLevel type

The system SHALL define a `LogLevel` type with values: `"trace"`, `"debug"`, `"info"`, `"warn"`, `"error"`, `"fatal"`, `"silent"`.

#### Scenario: All levels are valid

- **GIVEN** the `LogLevel` type
- **WHEN** each of `"trace"`, `"debug"`, `"info"`, `"warn"`, `"error"`, `"fatal"`, `"silent"` is assigned to a `LogLevel` variable
- **THEN** the assignment is type-valid

### Requirement: pino isolation

The `pino` package SHALL only be imported inside `logger.ts`. No other module in the application SHALL import pino directly.

#### Scenario: Grep for pino imports

- **GIVEN** the full source tree excluding `logger.ts` and `node_modules`
- **WHEN** searching for `import.*pino` or `require.*pino`
- **THEN** no matches are found

### Requirement: Argument order convention

The Logger interface SHALL use `(msg, data?)` argument order. The implementation SHALL internally adapt this to pino's `(data, msg)` convention.

#### Scenario: Message-first calling convention

- **GIVEN** a Logger instance
- **WHEN** `logger.info("event.emitted", { eventId: "evt_001" })` is called
- **THEN** the output contains `msg: "event.emitted"` and `eventId: "evt_001"`

#### Scenario: Message without data

- **GIVEN** a Logger instance
- **WHEN** `logger.info("scheduler.started")` is called
- **THEN** the output contains `msg: "scheduler.started"` with no additional fields beyond name and timestamp

### Requirement: Event lifecycle logging via bus consumer

All event lifecycle logging SHALL be performed by a dedicated `LoggingConsumer` bus consumer, not by individual components (ContextFactory, Scheduler, main.ts). This centralizes event logging in a single location.

#### Scenario: No event logging outside LoggingConsumer

- **GIVEN** the full source tree excluding the logging consumer module
- **WHEN** searching for log calls with messages matching `event.emitted`, `event.created`, `action.started`, `action.completed`, `action.failed`, `event.no-match`, `event.fanout`, `event.fanout.skipped`, or `events.recovered`
- **THEN** no matches are found
