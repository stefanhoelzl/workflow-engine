## MODIFIED Requirements

### Requirement: DDL from Zod schema

The EventStore SHALL generate its DDL using `@datazod/zod-sql` with the `postgres` dialect, replacing `JSONB` with `JSON` in the output. The events table SHALL contain columns matching RuntimeEventSchema fields: `id`, `type`, `payload`, `targetAction`, `correlationId`, `parentEventId`, `createdAt`, `state`, `result`, `error`, `sourceType`, `sourceName`. The table SHALL have no explicit primary key and no indexes (DuckDB columnar storage handles query patterns without them).

#### Scenario: Table schema matches RuntimeEventSchema

- **GIVEN** a newly created EventStore
- **WHEN** an event with all fields populated is inserted
- **THEN** all fields including `sourceType` and `sourceName` are stored and queryable

#### Scenario: Table has no primary key

- **GIVEN** a newly created EventStore
- **WHEN** two events with the same `id` but different `state` are inserted
- **THEN** both rows exist in the table (append-only)

#### Scenario: Query events by sourceType

- **GIVEN** an EventStore with events from triggers and actions
- **WHEN** `eventStore.query.where('sourceType', '=', 'trigger').selectAll().execute()` is called
- **THEN** only events with `sourceType="trigger"` are returned

#### Scenario: Query events by sourceName

- **GIVEN** an EventStore with events from triggers `"orders"` and `"payments"`
- **WHEN** `eventStore.query.where('sourceName', '=', 'orders').selectAll().execute()` is called
- **THEN** only events with `sourceName="orders"` are returned
