## ADDED Requirements

### Requirement: Dashboard query patterns
The EventStore's existing `query` property SHALL support the query patterns required by the dashboard without interface changes. The dashboard module SHALL build queries using the existing Kysely `SelectQueryBuilder`.

#### Scenario: Latest state per event
- **WHEN** the dashboard queries for current event states
- **THEN** a `ROW_NUMBER() OVER (PARTITION BY id ORDER BY createdAt DESC)` window function can be used to select the latest row per event `id`

#### Scenario: Correlation summary query
- **WHEN** the dashboard queries for correlation summaries
- **THEN** the query can group by `correlationId` and compute: aggregate state, initial event type (where `parentEventId IS NULL`), distinct event count, and max `createdAt`

#### Scenario: Events by correlationId query
- **WHEN** the dashboard queries for all events in a correlation chain
- **THEN** the query can filter by `correlationId` and return the latest state per event with all fields (id, type, state, parentEventId, targetAction, payload, error, createdAt)

#### Scenario: Distinct initial event types query
- **WHEN** the dashboard queries for filter dropdown options
- **THEN** the query can select distinct `type` values where `parentEventId IS NULL`
