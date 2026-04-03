## MODIFIED Requirements

### Requirement: Rich event metadata

The system SHALL attach the following metadata to every event: `id`, `type`, `correlationId`, `parentEventId`, `targetAction`, `createdAt`.

#### Scenario: Trigger creates initial event

- **GIVEN** an HTTP trigger fires
- **WHEN** the event is created via `HttpTriggerContext.emit()`
- **THEN** `id` is a unique identifier (prefixed `evt_`)
- **AND** `correlationId` is a new unique ID (prefixed `corr_`)
- **AND** `parentEventId` is `undefined`

#### Scenario: Action emits downstream event

- **GIVEN** an action processing event `evt_001` emits a new event via `ctx.emit()`
- **WHEN** the downstream event is created
- **THEN** it inherits `correlationId` from `evt_001`
- **AND** `parentEventId` is set to `evt_001`

## REMOVED Requirements

### Requirement: System error event

**Reason**: Out of scope for this change. Will be introduced in a future change.
**Migration**: No migration needed — this requirement was not yet implemented.

### Requirement: User-subscribable system events

**Reason**: Depends on system error event which is out of scope for this change.
**Migration**: No migration needed — this requirement was not yet implemented.
