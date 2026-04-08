## 1. Dependencies

- [x] 1.1 Add `@duckdb/node-api`, `@oorabona/kysely-duckdb`, and `kysely` to the runtime package (`@datazod/zod-sql` dropped — requires Zod 3, project uses Zod 4; using raw SQL DDL instead)

## 2. BusConsumer Interface Change

- [x] 2.1 Extend bootstrap options type in `event-bus/index.ts` with `latest?: boolean`

## 3. Persistence Recovery Expansion

- [x] 3.1 Modify `recover()` to scan both `pending/` and `archive/` directories
- [x] 3.2 Yield non-latest events (intermediate state transitions) with `{ latest: false }`
- [x] 3.3 Yield latest events (deduplicated current state per event) with `{ latest: true }`
- [x] 3.4 Update recovery tests for new yield format and both-directory scanning

## 4. WorkQueue Bootstrap Dedup

- [x] 4.1 Modify `bootstrap()` to skip when `latest: false`
- [x] 4.2 Implement event ID deduplication when `latest: true` (last occurrence wins, then filter to pending/processing)
- [x] 4.3 Add tests for latest flag behavior (skip non-latest, dedup on latest, filter after dedup)

## 5. EventStore Implementation

- [x] 5.1 Create `event-bus/event-store.ts` with `createEventStore()` factory — DuckDB in-memory setup and raw SQL DDL (zod-sql dropped due to Zod 4 incompatibility)
- [x] 5.2 Implement `handle()` with INSERT and non-fatal error handling (try/catch + log)
- [x] 5.3 Implement `bootstrap()` with bulk INSERT for all events (ignores latest flag)
- [x] 5.4 Implement `query` property as pre-scoped read-only `SelectQueryBuilder` on events table
- [x] 5.5 Re-export `sql` and necessary Kysely types from the module
- [x] 5.6 Add unit tests for handle (insert, append-only, error handling), bootstrap (bulk insert, empty array), and query (WHERE, GROUP BY, expression builders)

## 6. Wiring

- [x] 6.1 Wire EventStore as third (last) consumer in `main.ts` bus creation
- [x] 6.2 Update recovery loop in `main.ts` for new `recover()` yield shape (`{ events, latest }`)
- [x] 6.3 Add integration test for full recovery flow: persistence → bootstrap → EventStore queryable
