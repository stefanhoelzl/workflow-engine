## Context

The runtime uses an EventBus with sequential fan-out to distribute RuntimeEvents to consumers: FS persistence (durability) and WorkQueue (scheduling). Events carry a `correlationId` that links all events within a workflow run, and each event goes through state transitions (`pending → processing → done/failed/skipped`), with the bus emitting a new immutable snapshot for each transition.

There is currently no way to query events — the FS persistence is append-only files organized in `pending/` and `archive/` directories. An admin dashboard (with SSE live updates) needs to list correlation summaries, inspect event timelines, and filter by state/type. This requires a queryable index.

## Goals / Non-Goals

**Goals:**
- Add a DuckDB-backed in-memory event index as a bus consumer
- Expose a typed Kysely query builder for ad-hoc queries (no domain methods)
- Keep the EventStore as a pure observer — non-fatal errors, last in bus order
- Modify recovery to feed all historical events into the EventStore on startup
- Re-export Kysely utilities from EventStore so consumers never import `kysely` directly

**Non-Goals:**
- HTTP API endpoints for the dashboard (separate change)
- SSE change stream implementation (separate change)
- Domain-specific query methods (consumers build queries via Kysely)
- Persistent query index (rebuilt from FS on every startup)
- Exposing any new API to sandboxed actions

## Decisions

### 1. DuckDB over SQLite

**Choice:** DuckDB in-memory via `@duckdb/node-api`

**Alternatives:**
- *SQLite (better-sqlite3)*: Battle-tested, lighter (~2MB vs ~58MB), mature Kysely dialect. But row-oriented storage is suboptimal for the aggregation-heavy query patterns (GROUP BY correlationId, COUNT, MIN, MAX) that correlation summaries require.
- *DuckDB*: Column-oriented, purpose-built for analytical queries. GROUP BY and aggregation are its sweet spot. No explicit indexes needed — columnar storage handles scan-based queries efficiently.

**Rationale:** The EventStore is primarily read for aggregation (correlation summaries). DuckDB's columnar engine handles this natively without indexes. The ~58MB binary size is acceptable for a server-side runtime.

### 2. Kysely dialect: @oorabona/kysely-duckdb

**Choice:** Community package `@oorabona/kysely-duckdb@0.5.1`

**Alternatives:**
- *Custom dialect (~50 LOC)*: Reuse Kysely's PostgreSQL query compiler + DuckDB driver wrapper. Full control but maintenance burden.
- *Other community packages*: `kysely-duckdb` (less mature), `@vicary/kysely-duckdb` (fork)

**Rationale:** Spiked and validated — all required operations work (SELECT, INSERT, GROUP BY, expression builders, sql tagged template, parameterized queries). The package supports transactions, CTEs, window functions, and ships with plugins. Single-maintainer risk accepted; fallback to custom dialect is straightforward.

### 3. DDL generation: zod-sql postgres dialect + JSONB→JSON replace

**Choice:** `@datazod/zod-sql` with postgres dialect, post-processing `JSONB` to `JSON`

**Alternatives:**
- *Raw SQL string*: Simple but schema drifts from RuntimeEventSchema.
- *MySQL dialect*: Maps to JSON natively but introduces DATETIME (DuckDB uses TIMESTAMP) and TINYINT(1) differences.
- *Custom dialect*: zod-sql doesn't support dialect extension (hardcoded union type).

**Rationale:** PostgreSQL dialect is closest to DuckDB's SQL compatibility. The only incompatibility is `JSONB` (DuckDB only has `JSON`), resolved with a single string replace. This keeps the DDL derived from the Zod schema.

### 4. API: Read-only Kysely SelectQueryBuilder

**Choice:** Expose `eventStore.query` — a pre-scoped `SelectQueryBuilder` with `selectFrom('events')` already applied. Re-export `sql` and necessary types from `event-store.ts`.

**Alternatives:**
- *Domain-specific methods* (listCorrelationSummaries, getEventsByCorrelationId, etc.): Stable API but anticipates query patterns that may change. Limits consumer flexibility.
- *Full Kysely db instance*: Maximum flexibility but exposes write access.
- *Domain methods + Kysely escape hatch*: Best of both but larger API surface.

**Rationale:** The dashboard HTTP layer (future change) will build its own queries for correlation summaries, event timelines, and filter dropdowns. Domain methods would be a premature abstraction. Read-only access prevents consumers from corrupting the index.

### 5. Write model: Append-only (one row per state transition)

**Choice:** Every `handle()` call INSERTs a new row. Same event ID appears multiple times with different states.

**Alternatives:**
- *UPSERT (one row per event)*: Simpler queries (no window functions for "latest state"), smaller table. But loses state transition history.

**Rationale:** Append-only preserves the full event lifecycle, enabling timeline views in the dashboard detail page. DuckDB's columnar storage handles the additional rows efficiently. Queries that need "current state per event" use standard SQL (e.g., window functions or MAX aggregation on a state priority column).

### 6. Aggregate state priority

**Choice:** 5-state priority: `processing > pending > failed > done > skipped`

A correlation's aggregate state is the highest-priority state among its events. This means:
- If any event is processing → correlation is "processing"
- If any event is pending (and none processing) → correlation is "pending"
- If any event failed (and none active) → correlation is "failed"
- If all events are done/skipped → correlation is "done"
- If all events are skipped → correlation is "skipped"

### 7. Recovery expansion

**Choice:** Modify `recover()` to yield all events from both `pending/` and `archive/` directories in two phases, using a `latest` flag on bootstrap options.

```
recover() yields:
  Phase 1: { events: [intermediate state transitions], latest: false }
  Phase 2: { events: [current state per event, deduplicated], latest: true }
```

WorkQueue ignores `latest: false` batches and only processes `latest: true`. EventStore inserts everything.

**Alternatives:**
- *Separate recoverAll() method*: Less invasive but adds a parallel API.
- *WorkQueue internal dedup*: Recovery stays simple but dedup logic is hidden in the consumer.

**Rationale:** The `latest` flag is a clean signal on the bootstrap interface. Consumers opt into the behavior they need. Recovery does the grouping/dedup work once, not per-consumer.

### 8. Bus registration order

**Choice:** EventStore is last: `[persistence, workQueue, eventStore]`

**Rationale:** EventStore is a pure observer. Processing should not be delayed by indexing. If persistence or WorkQueue fail, the EventStore doesn't see the event — maintaining consistency. Non-fatal error handling means EventStore failures don't halt the pipeline.

### 9. Error handling

**Choice:** Non-fatal. `handle()` wraps inserts in try/catch, logs errors, does not rethrow.

**Rationale:** The EventStore is a best-effort index. A DuckDB failure should not crash the event processing pipeline. The dashboard may be stale, but workflow execution continues.

### 10. No Service interface

**Choice:** DuckDB instance is created eagerly in the `createEventStore()` factory. No `start()`/`stop()` lifecycle.

**Rationale:** In-memory DuckDB needs no explicit cleanup. The factory runs DDL synchronously during creation. No lifecycle management reduces wiring complexity.

## Sequence: Event flow with EventStore

```
HTTP Request
    │
    ▼
Trigger ──emit──▶ EventBus.emit({ state: "pending" })
                      │
                      ├──▶ Persistence.handle()  → write to pending/
                      ├──▶ WorkQueue.handle()     → buffer event
                      └──▶ EventStore.handle()    → INSERT row (non-fatal)
                                                         │
Scheduler ◀── dequeue ── WorkQueue                       │
    │                                                    │
    ├──emit──▶ EventBus.emit({ state: "processing" })    │
    │              ├──▶ Persistence  → write              │
    │              ├──▶ WorkQueue    → ignore (not pending)│
    │              └──▶ EventStore   → INSERT row         │
    │                                                    │
    └──emit──▶ EventBus.emit({ state: "done" })          │
                   ├──▶ Persistence  → write + archive    │
                   ├──▶ WorkQueue    → ignore             │
                   └──▶ EventStore   → INSERT row         │
                                                         ▼
                                              DuckDB (3 rows for evt_1)
```

## Sequence: Startup recovery with EventStore

```
main.ts
    │
    ▼
persistence.recover()
    │
    ├── yield { events: [all non-latest transitions], latest: false }
    │       │
    │       ▼
    │   bus.bootstrap(events, { latest: false })
    │       ├──▶ Persistence.bootstrap()  → no-op
    │       ├──▶ WorkQueue.bootstrap()    → skip (latest: false)
    │       └──▶ EventStore.bootstrap()   → bulk INSERT all
    │
    └── yield { events: [latest per event], latest: true }
            │
            ▼
        bus.bootstrap(events, { latest: true })
            ├──▶ Persistence.bootstrap()  → no-op
            ├──▶ WorkQueue.bootstrap()    → dedup by eventId, buffer pending/processing
            └──▶ EventStore.bootstrap()   → bulk INSERT all
```

## Risks / Trade-offs

- **[Community dialect maintenance]** `@oorabona/kysely-duckdb` is single-maintainer. → *Mitigation:* Fallback path is a ~50 LOC custom dialect reusing Kysely's PostgreSQL query compiler. The spike validated the approach works.

- **[@duckdb/node-api version drift]** The dialect pins `@duckdb/node-api@1.4` as a direct dep while declaring `>=1.3.2` as peer. → *Mitigation:* Spike worked with 1.5.1. Monitor for breaking changes in the pre-stable API.

- **[Binary size]** DuckDB adds ~58MB to the runtime package. → *Mitigation:* Acceptable for server-side. Not shipped to clients.

- **[TIMESTAMPTZ returns strings]** DuckDB returns timestamps as locale-formatted strings, not Date objects. → *Mitigation:* The dashboard HTTP layer serializes to JSON anyway. If internal consumers need Dates, add a Kysely plugin.

- **[Startup time]** Rebuilding the full index from FS on every startup scales with event history. → *Mitigation:* DuckDB's bulk insert is fast for columnar storage. Can add batching or pruning of old archives if startup time becomes an issue.

- **[Recovery interface change]** Adding `latest` to bootstrap options is a cross-cutting interface change. → *Mitigation:* The flag is optional; existing consumers ignore it. Persistence and WorkQueue changes are minimal.
