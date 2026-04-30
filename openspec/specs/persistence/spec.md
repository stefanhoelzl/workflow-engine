# Persistence Specification

## Purpose

Provide crash-resilient invocation persistence using pending/archive lifecycle records, ensuring invocations survive process restarts through atomic writes and startup recovery.
## Requirements
### Requirement: Capability deprecated

The `persistence` capability SHALL be considered deprecated and is retained as
a tombstone only. The runtime SHALL NOT write `pending/{id}/{seq}.json` per-event
records or `archive/{id}.json` per-invocation rollups. Durable storage of
invocation events lives in the `event-store` capability, which uses DuckLake
(catalog DB + Parquet files) as its substrate.

#### Scenario: No pending or archive JSON files written

- **GIVEN** a runtime processing invocations against any backend (FS or S3)
- **WHEN** the operator inspects the persistence root
- **THEN** there SHALL NOT be any `pending/` directory
- **AND** there SHALL NOT be any `archive/{id}.json` files

