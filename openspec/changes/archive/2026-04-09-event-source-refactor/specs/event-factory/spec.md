## REMOVED Requirements

### Requirement: EventFactory with three creation modes
**Reason**: Replaced by EventSource which combines event creation with auto-emit to the bus.
**Migration**: Use `createEventSource(schemas, bus)` instead of `createEventFactory(schemas)`. The create/derive/fork methods remain but now auto-emit.

### Requirement: create method for new event chains
**Reason**: Replaced by EventSource.create() which auto-emits.
**Migration**: `source.create(type, payload)` — now async, returns `Promise<RuntimeEvent>`.

### Requirement: derive method for child events in a chain
**Reason**: Replaced by EventSource.derive() which auto-emits.
**Migration**: `source.derive(parent, type, payload)` — now async, returns `Promise<RuntimeEvent>`.

### Requirement: fork method for fan-out copies
**Reason**: Replaced by EventSource.fork() which auto-emits.
**Migration**: `source.fork(parent, { targetAction })` — now async, returns `Promise<RuntimeEvent>`.

### Requirement: EventFactory is a closure-based factory
**Reason**: Replaced by `createEventSource(schemas, bus)`. Same closure-based pattern, different name and additional bus parameter.
**Migration**: Rename `event-factory.ts` to `event-source.ts`. Update all imports.
