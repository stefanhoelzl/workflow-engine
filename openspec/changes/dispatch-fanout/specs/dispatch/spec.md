## REMOVED Requirements

### Requirement: Dispatch is a built-in action
**Reason**: Fan-out is now handled by the scheduler directly. The dispatch action was infrastructure masquerading as a user action.
**Migration**: No migration needed. The scheduler automatically fans out undirected events. Remove `createDispatchAction` usage from runtime initialization.

### Requirement: Fan-out by cloning events
**Reason**: Fan-out cloning is now performed by the scheduler using `EventFactory.fork()`.
**Migration**: The scheduler creates targeted copies via `EventFactory.fork(parent, { targetAction })` and emits them to the EventBus.

### Requirement: Dispatch uses ActionContext
**Reason**: Fan-out no longer goes through an action handler. The scheduler emits fork copies directly via the EventBus.
**Migration**: No action context is involved in fan-out. The scheduler uses `EventFactory.fork()` and `bus.emit()` directly.

### Requirement: Subscriber discovery via match functions
**Reason**: Subscriber discovery is now based on the declarative `action.on` field instead of synthetic events and match predicates.
**Migration**: The scheduler finds subscribers via `actions.filter(a => a.on === event.type)`.

### Requirement: Zero subscribers is not an error
**Reason**: This behavior is preserved but moves to the scheduler spec. Zero subscribers results in the original event transitioning to `skipped`.
**Migration**: See scheduler spec — fan-out with zero matches transitions the original event to `skipped`.
