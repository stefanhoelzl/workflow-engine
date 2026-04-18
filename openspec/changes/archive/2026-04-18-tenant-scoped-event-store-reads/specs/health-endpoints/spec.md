## MODIFIED Requirements

### Requirement: Eventstore deep check
The eventstore check SHALL execute `eventStore.ping()` (a `SELECT 1` round-trip) against the EventStore. It SHALL report `componentType: "datastore"` and the round-trip duration in milliseconds as `observedValue`.

The check SHALL NOT depend on the contents of the `events` table or on any tenant. A successful ping confirms DB connectivity and read latency without scanning rows.

#### Scenario: Eventstore check passes
- **GIVEN** the event store is responsive
- **WHEN** the eventstore check runs
- **THEN** it SHALL invoke `eventStore.ping()`
- **AND** SHALL return `"status":"pass"` with the round-trip duration in ms as `observedValue`

#### Scenario: Eventstore check fails
- **GIVEN** the event store ping throws an error (DuckDB unavailable or query error)
- **WHEN** the eventstore check runs
- **THEN** it SHALL return `"status":"fail"` with the error message in `"output"`
