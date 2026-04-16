# Event Bus Specification

## Purpose

Provide the central event distribution mechanism that fans out invocation lifecycle events to registered consumers in a deterministic order.

## Requirements

### Requirement: BusConsumer interface for invocation lifecycle

The system SHALL define a `BusConsumer` interface with one method:
- `handle(event: InvocationLifecycleEvent): Promise<void>` --- called for each lifecycle event at runtime

`InvocationLifecycleEvent` SHALL be a discriminated union over `kind: "started" | "completed" | "failed"` with the corresponding payload as defined in the `invocations` capability spec.

The `bootstrap` method on `BusConsumer` SHALL be removed in v1; consumers that need startup data (like EventStore) SHALL read from persistence's `scanArchive()` directly during their own initialization.

#### Scenario: Consumer receives lifecycle event

- **GIVEN** a registered BusConsumer
- **WHEN** `bus.emit({ kind: "started", id, workflow, trigger, ts, input })` is called
- **THEN** the consumer's `handle` SHALL be called with that event

### Requirement: EventBus interface

The system SHALL define an `EventBus` interface with one method:
- `emit(event: InvocationLifecycleEvent): Promise<void>` --- fan out a lifecycle event to all consumers

The bus SHALL dispatch synchronously through registered consumers in registration order. `emit` SHALL await all consumers' `handle` calls in sequence and SHALL resolve only after the last consumer returns.

#### Scenario: Emit fans out to all consumers in order

- **GIVEN** an EventBus created with consumers `[persistence, eventStore, logging]`
- **WHEN** `bus.emit(event)` is called
- **THEN** persistence.handle(event) SHALL run first
- **AND** eventStore.handle(event) SHALL run after persistence resolves
- **AND** logging.handle(event) SHALL run after eventStore resolves
- **AND** `bus.emit` SHALL resolve only after logging.handle resolves

#### Scenario: Consumer error propagates

- **GIVEN** an EventBus with a consumer whose `handle` throws
- **WHEN** `bus.emit(event)` is called
- **THEN** subsequent consumers SHALL NOT be called
- **AND** `bus.emit` SHALL reject with the error

### Requirement: createEventBus factory

The system SHALL provide a `createEventBus(consumers: BusConsumer[]): EventBus` factory function. Consumers SHALL be fixed at construction time. There SHALL be no `register()` or `unregister()` methods. Consumer order is determined by array position. The recommended consumer order is: Persistence, EventStore, Logging.

#### Scenario: Create bus with consumers
- **GIVEN** an array of BusConsumer instances `[persistence, eventStore, logging]`
- **WHEN** `createEventBus([persistence, eventStore, logging])` is called
- **THEN** the returned EventBus fans out events to all three consumers in order

#### Scenario: Empty consumer list
- **GIVEN** an empty array
- **WHEN** `createEventBus([])` is called
- **THEN** the returned EventBus emits without error (no-op fan-out)

### Requirement: Events are immutable

Events SHALL be treated as immutable. The original event object SHALL never be mutated.

#### Scenario: State transition creates new object

- **GIVEN** an InvocationLifecycleEvent
- **WHEN** a consumer processes the event
- **THEN** the original event object SHALL not be mutated

### Requirement: Module exports

The `event-bus/index.ts` module SHALL export:
- `EventBus` interface
- `BusConsumer` interface
- `createEventBus` factory function

#### Scenario: All types importable from event-bus module

- **WHEN** a consumer imports from the event-bus module
- **THEN** `EventBus`, `BusConsumer`, and `createEventBus` are available
