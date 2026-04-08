## MODIFIED Requirements

### Requirement: BusConsumer interface

The system SHALL define a `BusConsumer` interface with two methods:
- `handle(event: RuntimeEvent): Promise<void>` — called for each event at runtime
- `bootstrap(events: RuntimeEvent[], options?: { finished?: boolean; pending?: boolean }): Promise<void>` — called with batches of events during startup recovery

The `pending` option signals the source of the batch:
- `pending: true` — the batch contains active events from the `pending/` directory (at most one per event ID, current state)
- `pending: false` — the batch contains historical events from the `archive/` directory

Both methods SHALL be required (no optional methods). Consumers that do not need bootstrap logic SHALL provide an empty implementation.

#### Scenario: Consumer receives runtime event

- **GIVEN** a registered BusConsumer
- **WHEN** `bus.emit(event)` is called
- **THEN** the consumer's `handle(event)` is called with the full RuntimeEvent

#### Scenario: Consumer receives bootstrap batch

- **GIVEN** a registered BusConsumer
- **WHEN** `bus.bootstrap(events, { finished: false })` is called
- **THEN** the consumer's `bootstrap(events, { finished: false })` is called with the batch

#### Scenario: Consumer receives bootstrap completion signal

- **GIVEN** a registered BusConsumer
- **WHEN** `bus.bootstrap([], { finished: true })` is called
- **THEN** the consumer's `bootstrap([], { finished: true })` is called

#### Scenario: Consumer receives pending batch

- **GIVEN** a registered BusConsumer
- **WHEN** `bus.bootstrap(events, { pending: true })` is called
- **THEN** the consumer's `bootstrap(events, { pending: true })` is called

#### Scenario: Consumer receives archive batch

- **GIVEN** a registered BusConsumer
- **WHEN** `bus.bootstrap(events, { pending: false })` is called
- **THEN** the consumer's `bootstrap(events, { pending: false })` is called
