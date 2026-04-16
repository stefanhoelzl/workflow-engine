## ADDED Requirements

### Requirement: One-shot startup recovery function

The runtime SHALL expose a `recover(persistence, bus)` startup function that runs once before the HTTP server begins accepting requests. The function SHALL scan `pending/`, construct a `failed: engine_crashed` lifecycle event for each entry, and emit it via the bus. The bus dispatch SHALL cause the persistence consumer to write `archive/<id>.json` and remove the corresponding `pending/<id>.json` for each entry.

#### Scenario: Crashed pending invocations swept on startup

- **GIVEN** the runtime starts with two entries in `pending/` left over from a prior crash
- **WHEN** `recover(persistence, bus)` runs
- **THEN** the function SHALL emit one `failed` lifecycle event per entry, each carrying `error: { kind: "engine_crashed" }`
- **AND** after the function returns, `pending/` SHALL contain no entries from the prior session
- **AND** `archive/` SHALL contain a `failed` archive record for each former pending entry

#### Scenario: Empty pending is a no-op

- **GIVEN** the runtime starts with an empty `pending/` directory
- **WHEN** `recover(persistence, bus)` runs
- **THEN** the function SHALL complete without emitting any events

### Requirement: EventStore bootstraps from archive scan independently

The EventStore consumer SHALL bootstrap its in-memory index by scanning `archive/` directly at consumer-init time, NOT by replaying `loaded` events through the bus. After init, the EventStore SHALL receive runtime updates exclusively via bus lifecycle events.

#### Scenario: EventStore index populated from archive at init

- **GIVEN** an `archive/` directory containing N invocation records from prior sessions
- **WHEN** the EventStore consumer initializes
- **THEN** the consumer SHALL read all N records and insert them into its DuckDB index
- **AND** the consumer SHALL NOT require any `loaded` lifecycle events to populate this initial state

#### Scenario: Recovery emits failed events that EventStore consumes

- **GIVEN** the EventStore consumer has bootstrapped from archive
- **WHEN** `recover()` emits `failed` events for crashed pending entries
- **THEN** the EventStore consumer SHALL index each emitted failed event via the normal runtime bus path

### Requirement: Recovery runs before HTTP server starts

The runtime startup sequence SHALL run `recover()` after consumers initialize but BEFORE the HTTP server binds its port. Triggers MUST NOT receive incoming requests until recovery has completed.

#### Scenario: Recovery completes before port bind

- **WHEN** the runtime starts
- **THEN** the startup sequence SHALL be: storage backend init → bus + consumers init (EventStore bootstraps from archive) → workflow registry init → recover() → HTTP server bind
- **AND** no request to `/webhooks/*` SHALL be processed before recover() resolves
