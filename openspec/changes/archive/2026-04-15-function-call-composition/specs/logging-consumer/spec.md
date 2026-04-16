## ADDED Requirements

### Requirement: Logging consumer logs invocation lifecycle

The logging consumer SHALL implement `BusConsumer` and SHALL emit one structured pino log entry per invocation lifecycle event. Each log entry SHALL include the invocation `id`, `workflow`, `trigger`, `kind` (`started | completed | failed`), and timestamp. `failed` entries SHALL additionally include the serialized error.

#### Scenario: Started event logged

- **WHEN** the consumer receives `{ kind: "started", id: "evt_a", workflow: "w", trigger: "t", ts }`
- **THEN** the consumer SHALL log a structured entry at `info` level containing `id`, `workflow`, `trigger`, `kind: "started"`, `ts`

#### Scenario: Failed event logged with error

- **WHEN** the consumer receives `{ kind: "failed", id: "evt_a", error: { message: "boom", stack } }`
- **THEN** the consumer SHALL log a structured entry at `error` level including the serialized error

### Requirement: Logging consumer never throws

The logging consumer's `handle()` SHALL never throw. Any internal logging-library error SHALL be caught and swallowed (logged to stderr at most).

#### Scenario: Logger backend failure does not propagate

- **GIVEN** a logger whose write fails
- **WHEN** `handle(event)` is called
- **THEN** the consumer SHALL NOT propagate the error
- **AND** subsequent bus emissions SHALL be unaffected

## REMOVED Requirements

### Requirement: Logging consumer logs RuntimeEvent state transitions

**Reason**: RuntimeEvent state transitions (`pending → processing → done/succeeded|failed|skipped`) are gone in v1. There are no `processing` or `skipped` lifecycle events; logs reflect the simpler `started | completed | failed` invocation lifecycle.

**Migration**: Update consumers of structured logs to read the new lifecycle fields. The `state`/`result` fields are replaced by `kind`.
