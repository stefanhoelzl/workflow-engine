## ADDED Requirements

### Requirement: Capability deprecated

The `event-bus` capability SHALL be considered deprecated and is retained as a
tombstone only. The runtime SHALL NOT export `BusConsumer`, `EventBus`, or
`createEventBus` and SHALL NOT route invocation events through a fan-out bus.
Lifecycle event delivery flows directly from the executor into
`EventStore.record()` (see the `event-store` capability) and `executor/log-lifecycle.ts`.

#### Scenario: No bus symbols exported

- **WHEN** a caller imports from `@workflow-engine/runtime`
- **THEN** there SHALL be no symbol named `EventBus`, `BusConsumer`, or `createEventBus`

## REMOVED Requirements

### Requirement: BusConsumer interface for invocation lifecycle

**Reason**: With the persistence and logging consumers folded away, only one consumer of invocation events remains (`EventStore`). A bus abstraction over a single consumer is pure overhead. The executor calls `eventStore.record(event)` directly, with lifecycle log emission inline.

**Migration**: Replace any code that constructs a `BusConsumer` with direct calls into `EventStore`. Lifecycle logging moves to `executor/log-lifecycle.ts` (see the `invocations` capability delta).

### Requirement: EventBus interface

**Reason**: The bus abstraction is removed. There is no `EventBus.emit(event)` anymore.

**Migration**: Replace `bus.emit(event)` with `eventStore.record(event)` at the call site in `executor/index.ts`. The strict-consumer fatal-exit contract is gone — EventStore handles its own retry-then-drop policy and exits only via the SIGTERM drain path or process supervisor.

### Requirement: createEventBus factory

**Reason**: Factory and consumer registry are removed alongside the bus.

**Migration**: Remove the `createEventBus(consumers, opts)` call from `main.ts`. Wire the executor with `eventStore` and `logger` directly.

### Requirement: Events are immutable

**Reason**: Event immutability is preserved as a property of the in-memory accumulator and the DuckLake `events` table (rows are append-only by primary key `(id, seq)`). The dedicated requirement under `event-bus` is no longer needed because there is no bus to enforce it.

**Migration**: The constraint continues to hold by construction in EventStore; no caller change.

### Requirement: Module exports

**Reason**: The `event-bus/index.ts` module is deleted entirely.

**Migration**: Imports of `BusConsumer`, `EventBus`, `createEventBus` are removed from all call sites.

### Requirement: EventKind union extends additively for non-invocation surfaces

**Reason**: The kind union is owned by `@workflow-engine/core` and the `invocations` capability, not by the bus. Removing the bus does not change the union's additive-extension property; the requirement is moved out of the bus capability and survives wherever it materially belongs (the core types).

**Migration**: No code change; the property is unchanged. New event kinds continue to be added without breaking existing producers and consumers.
