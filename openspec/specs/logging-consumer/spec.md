## Purpose

Provide a dedicated bus consumer that centralizes all invocation lifecycle logging in a single location.

## Requirements

### Requirement: LoggingConsumer implements BusConsumer

The system SHALL provide a `LoggingConsumer` that implements the `BusConsumer` interface. It SHALL be created via `createLoggingConsumer(logger: Logger): BusConsumer`.

#### Scenario: Factory creates a BusConsumer

- **GIVEN** a Logger instance
- **WHEN** `createLoggingConsumer(logger)` is called
- **THEN** the returned object implements `handle()`

### Requirement: Logging consumer logs invocation lifecycle

The logging consumer SHALL implement `BusConsumer` and SHALL emit one structured pino log entry per invocation lifecycle event. The lifecycle kinds are the three protocol-level trigger kinds: `trigger.request` (logged as message `"invocation.started"` at `info` level), `trigger.response` (logged as `"invocation.completed"` at `info` level), and `trigger.error` (logged as `"invocation.failed"` at `error` level). The lifecycle identity is encoded in the pino message name, not as a separate `kind` field on the log record.

Each log entry SHALL include the invocation `id`, `workflow`, `trigger` (from `event.name`), and timestamp. The timestamp field in the log entry SHALL be named `ts` (for continuity with the existing log format) and SHALL be populated directly from `event.at` — i.e. the ISO 8601 string already on the event — without any conversion through `new Date(...)` or similar. `trigger.error` entries SHALL additionally include the serialized `event.error`.

The logging consumer SHALL NOT read or emit `event.ts` (the per-run monotonic microsecond value); that field is not meaningful in cross-invocation log streams.

#### Scenario: trigger.request event logged

- **WHEN** the consumer receives `{ kind: "trigger.request", id: "evt_a", workflow: "w", name: "t", at: "2026-04-17T10:00:00.000Z", ts: 0, ... }`
- **THEN** the consumer SHALL log a structured entry at `info` level with message `"invocation.started"` containing `id: "evt_a"`, `workflow: "w"`, `trigger: "t"`, and `ts: "2026-04-17T10:00:00.000Z"` (the ISO string from `event.at`, pass-through)
- **AND** the log entry SHALL NOT contain a `kind` field

#### Scenario: trigger.error event logged with error

- **WHEN** the consumer receives `{ kind: "trigger.error", id: "evt_a", at, ts, error: { message: "boom", stack }, ... }`
- **THEN** the consumer SHALL log a structured entry at `error` level with message `"invocation.failed"` including the serialized error
- **AND** the log entry's `ts` field SHALL equal the event's `at` ISO string

#### Scenario: Monotonic ts is not logged

- **WHEN** the consumer receives any lifecycle event
- **THEN** the emitted log entry SHALL NOT contain the event's `ts` (per-run µs) field under any log key

### Requirement: Only trigger.* lifecycle events are logged

The logging consumer SHALL handle only the three invocation lifecycle kinds (`trigger.request`, `trigger.response`, `trigger.error`). All other bus event kinds — `action.*`, `system.*` (which now subsumes the previously distinct `fetch.*`, `mail.*`, `sql.*`, `timer.*`, `console.*`, `wasi.*` prefixes) — SHALL be ignored (no log entry emitted). Those kinds are captured by the EventStore for the dashboard and would be too verbose for the structured stdout log stream.

The consumer SHALL match strictly on `kind`, not on `name`. A `system.request` event with `name = "fetch"` SHALL be ignored at the same level as a `system.call` event with `name = "console.log"` — both fall outside the `trigger.*` filter.

#### Scenario: action.* event is not logged

- **WHEN** the consumer receives an event with `kind: "action.request"` (or any non-`trigger.*` kind)
- **THEN** the consumer SHALL NOT emit a log entry for that event

#### Scenario: system.* event is not logged regardless of name

- **GIVEN** the consumer receives any of: `system.request name="fetch"`, `system.response name="sendMail"`, `system.call name="console.log"`, `system.exception name="TypeError"`
- **WHEN** the consumer's `handle()` is called
- **THEN** the consumer SHALL NOT emit a log entry for any of those events

### Requirement: Logging consumer never throws

The logging consumer's `handle()` SHALL never throw. Any internal logging-library error SHALL be caught and swallowed (logged to stderr at most).

#### Scenario: Logger backend failure does not propagate

- **GIVEN** a logger whose write fails
- **WHEN** `handle(event)` is called
- **THEN** the consumer SHALL NOT propagate the error
- **AND** subsequent bus emissions SHALL be unaffected

### Requirement: Consumer ordering in bus

The LoggingConsumer SHALL be placed **after** the PersistenceConsumer and EventStore in the bus consumer array. This ensures logs confirm what has already been persisted and indexed.

#### Scenario: Logging consumer is last

- **GIVEN** a bus created with `[persistence, eventStore, logging]`
- **WHEN** `bus.emit(event)` is called
- **THEN** `persistence.handle()` is called before `logging.handle()`
