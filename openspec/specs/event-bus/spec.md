# Event Bus Specification

## Purpose

Provide the central event distribution mechanism that fans out invocation lifecycle events to registered consumers in a deterministic order.

## Requirements

### Requirement: BusConsumer interface for invocation lifecycle

The system SHALL define a `BusConsumer` interface with one method:
- `handle(event: InvocationEvent): Promise<void>` --- called for each event at runtime

`InvocationEvent` SHALL be a discriminated union over `kind` as defined in the `invocations` capability spec and the `@workflow-engine/core` `EventKind` union. The three invocation lifecycle kinds are `"trigger.request"` (invocation start), `"trigger.response"` (successful terminal), and `"trigger.error"` (failed terminal). Non-lifecycle kinds (`action.*`, `fetch.*`, `timer.*`, `console.*`, `wasi.*`, `system.*`) also flow through the bus; consumers SHALL filter by `kind` for logic that applies only to lifecycle events.

Events reaching `handle` SHALL already be fully widened by the executor's `sb.onEvent` receiver: runtime-owned fields (`tenant`, `workflow`, `workflowSha`, `invocationId`, and on `trigger.request` only `meta.dispatch`) are stamped before emission and SHALL NOT be re-stamped or mutated by consumers. Sandbox-owned intrinsic fields (`seq`, `ref`, `ts`, `at`, `id`) are likewise immutable on receipt.

The `bootstrap` method on `BusConsumer` SHALL be removed in v1; consumers that need startup data (like EventStore) SHALL read from persistence's `scanArchive()` directly during their own initialization.

#### Scenario: Consumer receives lifecycle event

- **GIVEN** a registered BusConsumer
- **WHEN** `bus.emit({ kind: "trigger.request", id, workflow, trigger, at, ts, input, meta: { dispatch: { source: "trigger" } } })` is called
- **THEN** the consumer's `handle` SHALL be called with that event

### Requirement: EventBus interface

The system SHALL define an `EventBus` interface with one method:
- `emit(event: InvocationEvent): Promise<void>` --- fan out an event to all consumers

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

The system SHALL provide a `createEventBus(consumers: BusConsumer[]): EventBus` factory function. Consumers SHALL be fixed at construction time. There SHALL be no `register()` or `unregister()` methods. Consumer order is determined by array position.

Consumer order is guidance, not a contract — the event bus itself does not enforce any specific ordering, and no validation runs against the supplied array. The runtime's canonical wiring uses `[persistence, eventStore, logging]` (see `packages/runtime/src/main.ts`) so that persistence observes the event before EventStore indexes it and before the logging consumer emits human-readable output; this ordering is a runtime-integration choice, not a requirement on the event-bus module, and other compositions (tests, subset harnesses, future consumers) are free to pick a different order as long as intra-event serialization is preserved by the bus's internal emit loop.

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

- **GIVEN** an `InvocationEvent`
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
