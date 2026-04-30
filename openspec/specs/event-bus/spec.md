# Event Bus Specification

## Purpose

Provide the central event distribution mechanism that fans out invocation lifecycle events to registered consumers in a deterministic order.
## Requirements
### Requirement: Capability deprecated

The `event-bus` capability SHALL be considered deprecated and is retained as a
tombstone only. The runtime SHALL NOT export `BusConsumer`, `EventBus`, or
`createEventBus` and SHALL NOT route invocation events through a fan-out bus.
Lifecycle event delivery flows directly from the executor into
`EventStore.record()` (see the `event-store` capability) and `executor/log-lifecycle.ts`.

#### Scenario: No bus symbols exported

- **WHEN** a caller imports from `@workflow-engine/runtime`
- **THEN** there SHALL be no symbol named `EventBus`, `BusConsumer`, or `createEventBus`

