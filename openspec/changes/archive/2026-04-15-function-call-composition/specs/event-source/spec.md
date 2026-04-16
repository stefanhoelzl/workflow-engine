## REMOVED Requirements

### Requirement: EventSource with three creation modes and auto-emit

**Reason**: `EventSource` is removed entirely. Its responsibilities (constructing and emitting events for trigger ingress, action emit, and fan-out fork) collapse because v1 has no events and no fan-out. Lifecycle event emission to the bus is now done directly by the executor (see `executor` capability).

**Migration**: Replace any `EventSource.create/derive/fork/transition` callers with executor-driven invocation lifecycle events. Trigger ingress goes through `executor.invoke()`; action calls go through `__hostCallAction()` at the sandbox bridge.

### Requirement: create method creates and emits root events

**Reason**: Subsumed by the executor's `invoke()` method, which constructs the invocation record and emits `started` to the bus.

**Migration**: Use `executor.invoke(workflow, trigger, payload)`.

### Requirement: derive method creates and emits child events

**Reason**: Action calls do not produce child events; they are nested function calls within the trigger invocation (see `invocations` capability).

**Migration**: Replace `ctx.emit('x', payload)` chains with `await x(payload)` direct calls.

### Requirement: fork method creates targeted copies for fan-out

**Reason**: There is no fan-out at the wiring level. Parallel side effects are expressed as `Promise.all([a(x), b(x), c(x)])` in handler code.

**Migration**: Replace fan-out at the wiring level with explicit parallel calls in code.

### Requirement: transition emits state changes

**Reason**: There are no `pending → processing → done` state transitions for individual events. Invocations have a simpler `started → completed | failed` lifecycle, emitted directly by the executor.

**Migration**: Use the executor's lifecycle event emission.
