## Context

The runtime opens one libSQL client (`buildSqlClient` over `DATABASE_URL`) and wraps it in two `Kysely` instances — `Kysely<EventDatabase>` and `Kysely<QueueDatabase>` — one per store. Today each store's factory ensures its own schema at construction:

- `createEventStore` → `CREATE TABLE IF NOT EXISTS events` + `CREATE INDEX IF NOT EXISTS events_dash_idx`.
- `createQueueStore` → `CREATE TABLE IF NOT EXISTS queue_items` + `CREATE INDEX IF NOT EXISTS queue_items_tuple_seq_idx`.

There is **no migration machinery** anywhere in the tree — no Kysely `Migrator`, no `PRAGMA user_version` ladder, no `schema_migrations` table, no `ALTER TABLE`. `IF NOT EXISTS` can create a *missing* table but can never *evolve* an existing one, so every prior schema change wiped the data (documented as DATA LOSS in `docs/upgrades.md`). Both staging and prod now run against a live **managed Bunny Database** (remote libSQL) whose `queue_items` table already exists and holds live rows.

The immediate forcing function is the follow-on `add-keyed-queue` change, which must add a `key` column to `queue_items` on those live databases without discarding their contents. That is impossible without a migration runner. This change builds the runner; `add-keyed-queue` is its first non-baseline migration.

The runtime is a **single-file SSR bundle**: `vite.config.ts` sets `build.ssr = "src/main.ts"` with `noExternal: true`, inlining everything into `dist/main.js` (only `@libsql/client` and the QuickJS wasm stay external). Post-bundle, `import.meta.url` resolves to `dist/main.js`; there is no source-tree layout at runtime.

## Goals / Non-Goals

**Goals:**
- A versioned, ordered, forward-only migration runner that executes once at boot, before either store opens.
- Lossless evolution of the existing, currently-unversioned live databases (no wipe, no operator step beyond deploying the image).
- A single source of truth for all libSQL DDL (both stores' tables and indexes).
- Fail-closed: a migration error crashes boot before the runtime serves traffic.
- Zero new dependency, zero new env var, zero SDK/manifest/workflow-author-visible change.

**Non-Goals:**
- Down migrations / programmatic rollback (roll-forward only; app rollback is revert-the-tag-and-redeploy).
- A general-purpose CLI for authoring/running migrations out of band. Migrations run only at boot, in-process.
- Multi-writer coordination beyond what a single always-on instance needs (`autoscaling_max = 1` today).
- Any change to the *shape* of the current schema. `0001` reproduces today's schema exactly; the `key` column is `add-keyed-queue`'s migration, not this change's.
- Touching the sandbox boundary. This is host-only infrastructure; no new surface is exposed to sandboxed actions.

## Decisions

### D1 — Kysely `Migrator` over a bespoke `PRAGMA user_version` ladder

Use Kysely's built-in `Migrator`. It ships in the already-present `kysely` package (no new dependency), tracks applied versions in `kysely_migration` + `kysely_migration_lock`, wraps each migration in a transaction where the dialect supports it, and integrates with the `Kysely` instances already constructed in `main.ts`.

*Alternative considered:* a hand-rolled ladder reading/writing `PRAGMA user_version` (an int in the SQLite file header, 0 on existing DBs), switching on it to run ordered DDL steps. ~40 lines, no tracking tables. Rejected because it is bespoke code we own and test ourselves, with no per-migration transaction wrapper and no lock — reinventing what `Migrator` already provides for free.

### D2 — In-code static `MigrationProvider`, not `FileMigrationProvider`

Supply migrations through a custom `MigrationProvider` whose `getMigrations()` returns an object literal mapping version keys to migration modules:

```
{ "0001_initial": m0001, /* future: "0002_queue_key": m0002 */ }
```

The modules live at `packages/runtime/src/migrations/*.ts` and are imported by `migrations/index.ts`, so they bundle into `dist/main.js` like all other code.

*Alternative considered:* Kysely's stock `FileMigrationProvider`, which `fs.readdir`s a migrations directory at runtime. Rejected — the single-file SSR bundle has no such directory on disk, and `import.meta.url` points at `dist/main.js`. A file-based provider would find nothing (or the wrong tree). The static provider is the standard pattern for bundled apps.

### D3 — Idempotent `0001_initial` baselines the live unversioned databases

`0001_initial.up(db)` reproduces the *current* schema — `events`, `queue_items`, and both indexes — using `CREATE TABLE/INDEX IF NOT EXISTS`, identical to what the stores execute today.

On first boot after the upgrade, `Migrator` finds no `kysely_migration` rows (the tracking tables don't exist yet), creates them, and runs `0001`. Against the live databases every statement is a no-op (the objects already exist) and `0001` is simply recorded as applied. Against a fresh database `0001` builds the baseline. Subsequent migrations (`0002…`) then evolve from a known, recorded baseline.

*Alternative considered:* detect an existing-but-unversioned database and *stamp* it as "migrated through 0001" without running it, letting `0001` be authored as plain (non-idempotent) `CREATE TABLE`. Rejected — it requires bespoke detection logic Kysely does not provide, with more ways to get the baseline subtly wrong. The idempotent-`0001` technique is safe by construction and needs no detection.

### D4 — Centralize all schema DDL in migrations; stores stop creating schema

Remove the `CREATE TABLE/INDEX` execution from both `createEventStore` and `createQueueStore`. After this change the migration runner is the *only* code that issues DDL; the stores open against a database whose schema is already guaranteed.

*Alternative considered:* leave the stores doing `CREATE … IF NOT EXISTS` as their baseline and let the migrator apply only incremental deltas on top. Rejected — that splits schema ownership across two mechanisms (stores own the baseline, migrator owns deltas), which is exactly the coupling a migration framework exists to eliminate. Centralizing is the reason to build the framework at all. The cost is a wider blast radius (event-store and its tests change even though the keyed-queue work is queue-only), accepted deliberately.

### D5 — Forward-only; no `down()`

Migrations expose only `up()`. This matches the deploy model: there is no programmatic rollback path in production — app rollback is `git revert` of the deploying tag followed by a redeploy of the prior image. A reverted binary tolerates a *newer* schema: added columns carry a `DEFAULT`, and old inserts that omit them still succeed. A `down()` that dropped columns/tables would actively destroy data on rollback, so authoring one would be a net risk for a path we never exercise.

### D6 — The migrator runs on its own `Kysely` instance

Construct a dedicated `Kysely` instance for the migrator over the same libSQL client, rather than reusing `eventDb` or `queueDb`. Migrations issue DDL via raw `sql` template tags, so the instance's type parameter is irrelevant; a dedicated instance keeps the runner uncoupled from either store's typed schema and avoids implying that one store "owns" cross-cutting migrations. All three `Kysely` instances share the one client, whose lifecycle `main.ts` still owns.

### D7 — Boot ordering and failure semantics

`main.ts` sequence becomes: `buildSqlClient` → construct the migrator `Kysely` → `migrator.migrateToLatest()` → *then* `createEventStore` / `createQueueStore`. `migrateToLatest()` returns `{ error, results }`; on a non-`ok` result (or thrown error) the runtime logs the failing migration and **throws**, aborting boot before any store opens or any HTTP listener binds — the same fail-closed posture as config parsing. `/readyz` never reports ready on a database whose migrations did not complete.

### D8 — Tests exercise the migrator, not a divergent `CREATE TABLE`

The store test-utils (`test-utils/event-store.ts`, `test-utils/queue-store.ts`) currently rely on the store factory to build schema. Since D4 removes that, the test-utils run `migrateToLatest()` against the in-memory/file libSQL database before returning a store. Tests therefore validate the exact schema path prod uses, and a migration that is wrong is caught by the existing store test suites rather than by a parallel test-only DDL.

## Risks / Trade-offs

- **`0001` drifts from the real current schema** → If `0001`'s `CREATE TABLE` text does not exactly match what the live databases already contain, the `IF NOT EXISTS` no-op hides the divergence (the existing table wins) on old DBs but a *fresh* DB gets `0001`'s version — a silent split-brain. Mitigation: `0001` is authored by copying the stores' existing `CREATE_TABLE_DDL`/`CREATE_INDEX_DDL` verbatim, and an event-store schema-shape scenario (`PRAGMA table_info`) already asserts the resulting columns/indexes; that scenario now runs against the migrated schema.

- **Transactional-DDL assumptions on libSQL** → Kysely wraps each migration in a transaction when the dialect supports it. Most SQLite/libSQL DDL (`CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE ADD COLUMN`) is transaction-safe, but not all DDL is. Mitigation: keep migrations to transaction-safe statements; if a future migration needs non-transactional DDL, handle it explicitly then rather than pre-solving now.

- **Lock table on remote libSQL** → `Migrator` acquires an advisory lock via `kysely_migration_lock`. On a single always-on instance there is never contention, so the lock is belt-and-suspenders; it is harmless and future-proofs a hypothetical second writer. No mitigation needed, noted for completeness.

- **Wider blast radius than the feature** (D4) → event-store code and tests change for a queue-driven need. Mitigation: the change is mechanical (delete DDL, add the migrator call) and covered by the existing event-store test suite, which now runs against the migrated schema.

- **Boot latency** → One extra round-trip set at startup (create tracking tables + run/record migrations). Against a remote Bunny Database this is a handful of statements, bounded and one-time per boot, not proportional to data size. Negligible next to existing boot work.

## Migration Plan

1. Land `packages/runtime/src/migrations/` (`index.ts` + `0001_initial.ts`) and the runner module.
2. Wire `migrateToLatest()` into `main.ts` before the stores open; remove the stores' DDL; update the store test-utils to migrate first.
3. Deploy. On first boot in each environment: `Migrator` creates `kysely_migration` + `kysely_migration_lock`, runs `0001` as a recorded no-op against the live schema, and the stores open unchanged. No data movement, no operator step.
4. **Rollback:** `git revert` the deploying tag and redeploy the prior image. The reverted runtime does not consult the tracking tables (it uses its own `CREATE … IF NOT EXISTS`), and the two extra tables it ignores are inert. No data is lost because `0001` changed nothing.
5. `docs/upgrades.md` gains an entry: additive, no tenant rebuild, no DATA-LOSS marker; note the two new tracking tables.
