## MODIFIED Requirements

### Requirement: LoggingConsumer implements BusConsumer

The system SHALL provide a `LoggingConsumer` that implements the `BusConsumer` interface. It SHALL be created via `createLoggingConsumer(logger: Logger): BusConsumer`.

The logging consumer SHALL declare `name === "logging"` and `strict === false`. Per the event-bus contract (see `event-bus/spec.md § Requirement: EventBus interface`), best-effort consumer failures are logged as `bus.consumer-failed` and the bus continues to subsequent consumers — the runtime is not terminated. The logging consumer produces operator-facing structured output, not durability records, and a transient failure here is recoverable on the next event.

#### Scenario: Factory creates a BusConsumer

- **GIVEN** a Logger instance
- **WHEN** `createLoggingConsumer(logger)` is called
- **THEN** the returned object implements `handle()`
- **AND** exposes `name === "logging"`
- **AND** exposes `strict === false`
