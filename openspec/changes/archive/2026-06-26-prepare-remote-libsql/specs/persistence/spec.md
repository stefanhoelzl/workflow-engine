## MODIFIED Requirements

### Requirement: Capability deprecated

The `persistence` capability SHALL be considered deprecated and is retained as
a tombstone only. The runtime SHALL NOT write `pending/{id}/{seq}.json` per-event
records or `archive/{id}.json` per-invocation rollups. Durable storage of
invocation events lives in the `event-store` capability, which uses libSQL as
its substrate — an embedded on-disk database file (`events.db`) when
`DATABASE_URL` is a `file:…` URL, or a remote libSQL service when `DATABASE_URL`
is a `libsql://…`/`https://…` URL.

#### Scenario: No pending or archive JSON files written

- **GIVEN** a runtime processing invocations against the FS backend
- **WHEN** the operator inspects the persistence root
- **THEN** there SHALL NOT be any `pending/` directory
- **AND** there SHALL NOT be any `archive/{id}.json` files
