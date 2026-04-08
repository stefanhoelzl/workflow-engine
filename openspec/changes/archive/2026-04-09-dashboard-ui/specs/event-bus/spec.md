## MODIFIED Requirements

### Requirement: createEventBus factory

The system SHALL provide a `createEventBus(consumers: BusConsumer[]): EventBus` factory function. Consumers SHALL be fixed at construction time. There SHALL be no `register()` or `unregister()` methods. Consumer order is determined by array position.

The SSE consumer SHALL be included in the consumer array when the dashboard is enabled. The recommended consumer order is: Persistence, WorkQueue, EventStore, SSEConsumer.

#### Scenario: Create bus with consumers
- **GIVEN** an array of BusConsumer instances `[persistence, workQueue, eventStore, sseConsumer]`
- **WHEN** `createEventBus([persistence, workQueue, eventStore, sseConsumer])` is called
- **THEN** the returned EventBus fans out events to all four consumers in order

#### Scenario: SSE consumer receives events after EventStore
- **GIVEN** an EventBus with consumers `[persistence, workQueue, eventStore, sseConsumer]`
- **WHEN** `bus.emit(event)` is called
- **THEN** `eventStore.handle(event)` completes before `sseConsumer.handle(event)` is called
- **THEN** the SSE consumer can query the EventStore for up-to-date data when rendering fragments

#### Scenario: Empty consumer list
- **GIVEN** an empty array
- **WHEN** `createEventBus([])` is called
- **THEN** the returned EventBus emits and bootstraps without error (no-op fan-out)
