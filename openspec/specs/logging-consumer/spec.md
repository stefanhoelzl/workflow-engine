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

The logging consumer SHALL implement `BusConsumer` and SHALL emit one structured pino log entry per invocation lifecycle event. Each log entry SHALL include the invocation `id`, `workflow`, `trigger`, `kind` (`started | completed | failed`), and timestamp. `failed` entries SHALL additionally include the serialized error.

#### Scenario: Started event logged

- **WHEN** the consumer receives `{ kind: "started", id: "evt_a", workflow: "w", trigger: "t", ts }`
- **THEN** the consumer SHALL log a structured entry at `info` level containing `id`, `workflow`, `trigger`, `kind: "started"`, `ts`

#### Scenario: Failed event logged with error

- **WHEN** the consumer receives `{ kind: "failed", id: "evt_a", error: { message: "boom", stack } }`
- **THEN** the consumer SHALL log a structured entry at `error` level including the serialized error

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
