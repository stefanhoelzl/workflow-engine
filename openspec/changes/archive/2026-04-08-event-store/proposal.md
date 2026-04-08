## Why

The runtime persists events to the filesystem for crash recovery but provides no way to query them. An admin dashboard needs to list workflow runs (correlations), inspect event timelines, and receive live updates via SSE. An in-memory analytical query index over events enables these use cases without coupling consumers to the persistence layer's file layout.

## What Changes

- Add an EventStore bus consumer (`event-bus/event-store.ts`) that indexes all events into an in-memory DuckDB instance, exposing a read-only Kysely query builder as its public API
- Modify `recover()` in persistence to yield ALL events (both directories, all states) instead of only pending/processing — enabling the EventStore to rebuild its full index on startup
- Add a `latest` flag to the bootstrap options so consumers can distinguish between intermediate state transitions and the current state per event
- Modify WorkQueue's `bootstrap()` to deduplicate by event ID when receiving `latest: true` batches, keeping only the most recent state per event
- Add `@duckdb/node-api`, `@oorabona/kysely-duckdb`, and `kysely` as runtime dependencies
- Use `@datazod/zod-sql` (postgres dialect with JSONB→JSON replacement) for DDL generation from Zod schemas

## Capabilities

### New Capabilities

- `event-store`: In-memory DuckDB-backed event index that implements BusConsumer, indexes all event state transitions (append-only), and exposes a typed read-only Kysely SelectQueryBuilder for ad-hoc queries

### Modified Capabilities

- `persistence`: Recovery yields all events from both pending/ and archive/ directories; output changes from `AsyncIterable<RuntimeEvent[]>` to yield `{ events, latest }` batches
- `event-bus`: Bootstrap options extended with `latest?: boolean` flag on the BusConsumer interface
- `work-queue`: Bootstrap deduplicates by event ID when `latest: true`, keeping only the most recent state per event

## Impact

- **event-bus/index.ts**: BusConsumer bootstrap options type gains `latest?: boolean`
- **event-bus/persistence.ts**: `recover()` scans both directories, yields all events in two phases (non-latest then latest)
- **event-bus/work-queue.ts**: `bootstrap()` adds event ID deduplication logic for `latest: true` batches
- **event-bus/event-store.ts**: New file — DuckDB setup, BusConsumer implementation, Kysely re-exports
- **main.ts**: Wire EventStore as third (last) bus consumer; update recovery loop for new `recover()` shape
- **Dependencies**: `@duckdb/node-api`, `@oorabona/kysely-duckdb`, `kysely`, `@datazod/zod-sql` added to runtime package
