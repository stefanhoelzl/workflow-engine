## Context

The runtime persists invocation lifecycle events (`event-store`) and per-workflow FIFO queues (`queues`) in a single embedded DuckDB file at `<PERSISTENCE_PATH>/events.duckdb`, accessed through Kysely + the `@oorabona/kysely-duckdb` dialect. Both stores are already clean factory-produced interfaces (`EventStore`, `QueueStore`); nothing else in the codebase touches DuckDB directly. The longer-term goal is durable external SQL (Bunny Database = libSQL). This change does the **engine swap to libSQL on-disk only**; pointing prod at remote libSQL is a separate, later change.

The spec corpus carries pre-existing rot from two earlier removals that never fully reconciled: a DuckLake→plain-DuckDB migration (Parquet/`ATTACH`/checkpoint language stranded in `event-store`, `storage-backend`, `persistence`, `runtime-config`, `e2e-test-framework`) and an S3-backend/`locator()` removal (the S3 backend, `StorageBackend.locator()`, and `PERSISTENCE_S3_*` exist only in specs, not in code — the code's `StorageBackend` is `init/write/read/list` over `fs.ts` only).

Both code-correctness and scaling were verified before proposing (see Decisions).

## Goals / Non-Goals

**Goals:**
- Replace DuckDB with libSQL as the embedded on-disk SQL engine for `event-store` and `queues`, with zero data migration (accept-loss).
- Keep `Kysely<Database>` as the single seam; reuse the official `@libsql/kysely-libsql` dialect (no bespoke dialect).
- Make the later "remote Bunny" change a pure connection-config flip.
- Reconcile persistence/storage/config specs to code reality within a bounded blast radius.

**Non-Goals:**
- Remote libSQL / Bunny Database wiring, `DATABASE_URL`/auth-token config, cold-start read retries, remote single-writer treatment — all deferred to the later change.
- Data migration from DuckDB. Existing event/queue data is discarded.
- Any change to the sandbox boundary, EventBus consumer pipeline, or workflow manifest.
- Repo-wide spec cleanup beyond the persistence/storage/config/test/infra capabilities edited here.

## Decisions

### D1 — Replace DuckDB with libSQL everywhere (on-disk), not "DuckDB dev / libSQL prod"
libSQL runs both embedded (`file:` URL) and remote with one client API, so a single engine serves dev, test, and prod-on-VPS. One dialect, one SQL behaviour, no dev/prod divergence. **Alternative rejected:** keeping DuckDB for dev — needs two dialects and lets bugs hide in the gap.

### D2 — Reuse the official `@libsql/kysely-libsql` dialect; inject a `file:` client
`LibsqlDialect` reuses Kysely's built-in `SqliteAdapter` / `SqliteQueryCompiler` / `SqliteIntrospector` (so all SQL generation is stock, battle-tested Kysely SQLite) and accepts a pre-built `@libsql/client` via `{ client }`. The dialect's documented "no `file:`" limitation applies only to its URL-string constructor — the client-injection path does no URL parsing, and `@libsql/client`'s `createClient({ url: "file:…" })` supports local files natively. It also implements transactions (`client.transaction()`), which the prune needs. **Alternatives rejected:** (a) a hand-written ~100–150-line dialect — unnecessary, the official one is the same driver glue, maintained; (b) `better-sqlite3` + Kysely's built-in `SqliteDialect` — that's SQLite-the-engine, not libSQL, and would mean a second engine swap later; (c) `@coji/kysely-libsql` community fork — not needed once we inject our own client into the official dialect.

### D3 — Factories take `db: Kysely<Database>`; `main.ts` owns the client
`main.ts` constructs the libSQL client from `file:${PERSISTENCE_PATH}/events.db`, builds the two Kysely instances, and passes each into `createEventStore` / `createQueueStore`. Stores stop importing any DB driver and become testable against any dialect (incl. `:memory:`). DDL and `ping()` move from raw `conn.run()` to Kysely `sql\`…\`.execute(db)`.

### D4 — Schema portability rewrites (verified on real SQLite 3.45)
- `at` / `enqueuedAt`: `TIMESTAMPTZ` → `TEXT` (ISO-8601). `at` is already an ISO string in code; `enqueuedAt` is written `.toISOString()`. Lexicographic ordering == chronological for fixed-format ISO strings (verified, incl. ms and multi-day spans). Drop the `::TIMESTAMPTZ` casts and the DuckDB `{micros: bigint}` decode.
- `queue_items.seq`: `CREATE SEQUENCE` + `nextval()` → `INTEGER PRIMARY KEY AUTOINCREMENT`. The `AUTOINCREMENT` keyword is required to prevent rowid **reuse** after the DELETEs that popping causes; verified that monotonicity holds across pops. FIFO pop = `DELETE … WHERE seq = (SELECT … ORDER BY seq LIMIT 1) RETURNING *`. Composite PK is replaced by the index in D5.
- `item` / event JSON columns: `JSON` → `TEXT` (the app already stringifies/parses in JS).
- Prune: drop `CHECKPOINT` (DuckDB-specific; libSQL/SQLite manages its own WAL). Wrap the `count + DELETE` in a single transaction.

### D5 — Add composite read index `events(owner, repo, kind, "at")`
Benchmarked at 480k events / 72 MB with a skewed hot repo (100k `trigger.request`): with only the existing `(owner, repo)` index, hot-repo dashboard reads are ~50–67 ms each (a page fires 3–5 sequentially); the composite index drops them to <0.1 ms. DuckDB's columnar engine masked the missing index; libSQL is a row store and needs it. Queue queries are already sub-millisecond on the existing tuple index — no change.

### D6 — Single-writer is a deployment contract (document-only)
Drop the DuckDB exclusive-file-lock mechanism and its "second writer fails fast" scenario. The single-instance guarantee already rests on the deployment shape for independent reasons (in-memory auth session sealing, in-memory registry, in-memory cron). Infra pins it: VPS Quadlet rotates sequentially with no overlap window, and `bunny-staging.tf` sets `autoscaling_min = autoscaling_max = 1`, `regions_max_allowed = 1`. Note honestly that embedded libSQL (unlike DuckDB) does not lock at open, so the backstop is now assumed, not enforced — acceptable given the infra pin. The remote "no lock at all" treatment belongs to the later Bunny change.

### D7 — Config: derive the DB path from `PERSISTENCE_PATH`, add no env var
`PERSISTENCE_PATH` stays (it also roots tenant bundles via `createFsStorage`). The libSQL file is `file:${PERSISTENCE_PATH}/events.db`. `DATABASE_URL` / `DATABASE_AUTH_TOKEN` are deferred to the Bunny change so all remote config lands cohesively in one place. Remove the dead `EVENT_STORE_CHECKPOINT_*` vars now.

### D8 — Spec cleanup boundary: persistence-bounded sweep
Editing the DB requirements forces sweeping stratum-1 DuckLake rot in the same files (can't coherently half-edit). Stratum-2 S3/`locator()`/`PERSISTENCE_S3_*` fiction lives in the same `storage-backend` / `runtime-config` files and is dead in code, so remove it here too. Boundary stops at persistence/storage/config/test/infra capabilities; no repo-wide hunt.

### D9 — Tests read via libSQL, not file copies
Test helpers create temp `file:` URLs instead of temp DuckDB instances. The e2e harness opens a **second** `@libsql/client` read connection on the live file (WAL allows concurrent readers) instead of copying the DuckDB file (DuckDB's exclusive-lock workaround), dropping the snapshot logic in `events.ts` / `scenario.ts`.

## Risks / Trade-offs

- **`@libsql/kysely-libsql` ↔ `kysely ^0.28` version compatibility** → Pin a compatible dialect version; an early implementation task wires the dialect and runs the real Kysely query chains (the verification harness validated SQLite SQL semantics, not Kysely-emitted SQL through the dialect).
- **Lexicographic timestamp ordering depends on uniform ISO format** → Enforced by always writing `Date.prototype.toISOString()` (fixed `…Z`, ms precision); covered by an event-store ordering test.
- **`AUTOINCREMENT` rowid reuse if the keyword is omitted** → Schema mandates `INTEGER PRIMARY KEY AUTOINCREMENT`; a queue test asserts seq is not reused after a pop.
- **Single-writer is now assumed, not lock-enforced** → Accepted: instance count pinned to 1 in infra (D6); no app-level fence in this change.
- **Accept-loss on cutover** → Documented in `docs/upgrades.md`; operators wipe stale `events.duckdb`. No rollback of data — rollback = redeploy the DuckDB image (data already discarded either way).
- **Spec sweep touches many files** → Bounded by D8; each delta is a faithful MODIFIED/REMOVED of an existing requirement, not a rewrite of behaviour beyond the engine swap.

## Migration Plan

1. Land code + spec deltas + dependency swap.
2. Deploy: new image carries the libSQL native binding; runtime creates `events.db` with fresh schema on boot. Operators delete any stale `events.duckdb` / `events.duckdb-wal` and the `events/` Parquet dir if present (`docs/upgrades.md`).
3. No data migration; existing event/queue history is discarded (accept-loss).
4. Rollback: redeploy the prior DuckDB image (its data was already discarded; both directions start fresh).

## Open Questions

None blocking. The remote-Bunny follow-up change owns: `DATABASE_URL`/`DATABASE_AUTH_TOKEN`, cold-start read retries, remote single-writer treatment, and the Bunny env/secret wiring.
