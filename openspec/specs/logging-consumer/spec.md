## Purpose

Provide a dedicated bus consumer that centralizes all event lifecycle logging in a single location, replacing scattered log calls across individual components.

## Requirements

### Requirement: LoggingConsumer implements BusConsumer

The system SHALL provide a `LoggingConsumer` that implements the `BusConsumer` interface. It SHALL be created via `createLoggingConsumer(logger: Logger): BusConsumer`.

#### Scenario: Factory creates a BusConsumer

- **GIVEN** a Logger instance
- **WHEN** `createLoggingConsumer(logger)` is called
- **THEN** the returned object implements `handle()` and `bootstrap()`

### Requirement: handle() logs events at appropriate levels

The `handle(event)` method SHALL log every emitted event. The log level SHALL depend on the event state:
- `pending` → info level, message `"event.created"`
- `processing` → trace level, message `"event.processing"`
- `done` with `result: "succeeded"` → trace level, message `"event.done"`
- `done` with `result: "skipped"` → trace level, message `"event.done"`
- `done` with `result: "failed"` → error level, message `"event.failed"`

Each log entry SHALL include: `correlationId`, `eventId` (the event's `id`), `type`, `state`.
When present, the entry SHALL also include: `targetAction`, `result`, `error`.

#### Scenario: New pending event logged at info

- **GIVEN** a LoggingConsumer with a Logger
- **WHEN** `handle({ id: "evt_001", state: "pending", type: "order.received", correlationId: "corr_abc", ... })` is called
- **THEN** the logger is called at info level with message `"event.created"` and data containing `correlationId: "corr_abc"`, `eventId: "evt_001"`, `type: "order.received"`

#### Scenario: Processing event logged at trace

- **GIVEN** a LoggingConsumer with a Logger
- **WHEN** `handle({ state: "processing", ... })` is called
- **THEN** the logger is called at trace level with message `"event.processing"`

#### Scenario: Succeeded event logged at trace

- **GIVEN** a LoggingConsumer with a Logger
- **WHEN** `handle({ state: "done", result: "succeeded", ... })` is called
- **THEN** the logger is called at trace level with message `"event.done"` and data containing `result: "succeeded"`

#### Scenario: Failed event logged at error

- **GIVEN** a LoggingConsumer with a Logger
- **WHEN** `handle({ state: "done", result: "failed", error: "timeout", ... })` is called
- **THEN** the logger is called at error level with message `"event.failed"` and data containing `result: "failed"`, `error: "timeout"`

#### Scenario: targetAction included when present

- **GIVEN** a LoggingConsumer with a Logger
- **WHEN** `handle({ targetAction: "sendEmail", state: "pending", ... })` is called
- **THEN** the log data includes `targetAction: "sendEmail"`

### Requirement: bootstrap() logs recovery summary

The `bootstrap(events, options)` method SHALL log a summary at info level with message `"events.recovered"` and the count of events in the batch.

#### Scenario: Bootstrap logs event count

- **GIVEN** a LoggingConsumer with a Logger
- **WHEN** `bootstrap([evt1, evt2, evt3])` is called
- **THEN** the logger is called at info level with message `"events.recovered"` and data containing `count: 3`

#### Scenario: Bootstrap with empty batch

- **GIVEN** a LoggingConsumer with a Logger
- **WHEN** `bootstrap([])` is called
- **THEN** the logger is called at info level with message `"events.recovered"` and data containing `count: 0`

### Requirement: Consumer ordering in bus

The LoggingConsumer SHALL be placed **after** the PersistenceConsumer, WorkQueue, and EventStore in the bus consumer array. This ensures logs confirm what has already been persisted and indexed.

#### Scenario: Logging consumer is last

- **GIVEN** a bus created with `[persistence, workQueue, eventStore, logging]`
- **WHEN** `bus.emit(event)` is called
- **THEN** `persistence.handle()` is called before `logging.handle()`
