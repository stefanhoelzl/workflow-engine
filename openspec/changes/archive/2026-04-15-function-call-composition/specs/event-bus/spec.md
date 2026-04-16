## ADDED Requirements

### Requirement: BusConsumer interface for invocation lifecycle

The system SHALL define a `BusConsumer` interface with one method:
- `handle(event: InvocationLifecycleEvent): Promise<void>` — called for each lifecycle event at runtime

`InvocationLifecycleEvent` SHALL be a discriminated union over `kind: "started" | "completed" | "failed"` with the corresponding payload as defined in the `invocations` capability spec.

The `bootstrap` method on `BusConsumer` SHALL be removed in v1; consumers that need startup data (like EventStore) SHALL read from persistence's `scanArchive()` directly during their own initialization.

#### Scenario: Consumer receives lifecycle event

- **GIVEN** a registered BusConsumer
- **WHEN** `bus.emit({ kind: "started", id, workflow, trigger, ts, input })` is called
- **THEN** the consumer's `handle` SHALL be called with that event

### Requirement: EventBus interface

The system SHALL define an `EventBus` interface with one method:
- `emit(event: InvocationLifecycleEvent): Promise<void>` — fan out a lifecycle event to all consumers

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

## REMOVED Requirements

### Requirement: BusConsumer interface

**Reason**: Replaced by the v1 `BusConsumer` interface above. The v0 interface required `bootstrap(events, options)` for startup data plumbing through the bus; v1 has consumers read their initial state directly from persistence (EventStore via `scanArchive()`), so `bootstrap` is removed.

**Migration**: Implement only `handle(event)`. EventStore reads archive at init.
