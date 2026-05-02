## Context

The `event-store-ducklake` change (archived 2026-04-30) introduced DuckLake as the durable archive format on the assumption that the catalog could live on S3. The parent `remove-s3` branch removes S3 entirely. With FS-only persistence, DuckLake is reduced to "DuckDB-with-extra-steps": a separate Parquet directory partitioned by `(owner, repo)`, an `INSTALL ducklake; LOAD ducklake;` extension load, an `ALTER TABLE … SET PARTITIONED BY` step, a checkpoint loop with three thresholds, and a SQL composer that branches on locator kind. None of it earns its keep against a single local file.

Plain DuckDB also unlocks two improvements DuckLake explicitly forbids: a `PRIMARY KEY (id, seq)` constraint on the events table, and exclusive file locking that fails a second writer fast instead of silently corrupting state.

## Goals / Non-Goals

**Goals:**
- Replace DuckLake with plain DuckDB while keeping the public `EventStore` surface (`record`, `query`, `hasUploadEvent`, `ping`, `drainAndClose`) byte-for-byte equivalent.
- Promote idempotency from a convention (accumulator pre-eviction) to a database constraint (`PRIMARY KEY (id, seq)`).
- Delete the bespoke checkpoint loop and its three operator-facing knobs; rely on DuckDB's implicit WAL semantics.
- Remove the last code path that referenced S3 in the event-store layer — `StorageLocator`, `locator()`, and `storage/s3.ts`.

**Non-Goals:**
- Per-event durability or per-invocation transactions. The accumulator-then-commit model is preserved; transactions stay implicit (single multi-row INSERT auto-committed by DuckDB).
- Migration of historical DuckLake data. Operators who care about prior events keep the old `events/` Parquet directory around and query it manually with DuckDB; no automated import.
- Cleanup of OpenTofu modules (`s2`, UpCloud persistence bucket) — separate follow-up under the `remove-s3` branch.
- Renaming `PERSISTENCE_PATH`. Existing Helm/compose references stay valid.

## Decisions

### Decision 1: Single shared writer connection, accumulator-in-RAM

**What:** Keep the current model — one DuckDB connection, one in-memory `Map<id, PendingInvocation>` accumulator, one multi-row `INSERT INTO events VALUES (…)` per terminal kind. DuckDB auto-commits the single statement atomically.

**Why:** A per-invocation transaction was considered (one connection per in-flight invocation, opened on first event, committed on terminal). It would write each event the moment it was emitted and use DuckDB's MVCC to hide in-flight invocations from readers — a clean implementation of "only complete invocations are visible". The cost is N concurrent DuckDB connections and per-event INSERT overhead, neither of which buys observable behaviour over the existing accumulator model: accumulator-in-RAM already achieves "only complete invocations visible" by holding events out of the DB until terminal. The simpler model wins.

**Alternatives:**
- **Per-invocation transaction with N connections.** Stronger crash-recovery fidelity (committed-WAL records exist for events emitted before terminal, just invisible until commit). Connection cost and write overhead don't pay for behaviour we can't observe.
- **Bounded connection pool.** Splits the difference. Reintroduces an accumulator for queue-overflow. Worst of both worlds.

### Decision 2: `PRIMARY KEY (id, seq)`, fatal on conflict

**What:** Declare `PRIMARY KEY (id, seq)` on the events table. On commit-retry, treat PK violation as fatal: log `event-store.commit-dropped` with the PK error and do not retry. Transient errors (file I/O, lock contention) keep the existing exponential-backoff retry.

**Why:** Pre-eviction makes a PK conflict structurally impossible — the accumulator entry is removed before the retry loop runs, and the events list is captured locally. A PK conflict therefore signals a logic bug (e.g. duplicate emission from the executor), and retrying it would just fail identically. Fatal-log-and-drop surfaces the bug without crashing the runtime.

**Alternatives:**
- **`INSERT … ON CONFLICT (id, seq) DO NOTHING`.** Hides bugs. Tolerates spurious duplicates from any future code path that mis-emits events. Rejected.
- **Retry on PK violation.** Identical failure each attempt; wastes the retry budget. Rejected.
- **Drop the PK entirely (today's behaviour).** Loses the database-level invariant. The whole point of leaving DuckLake is being able to declare it. Rejected.

### Decision 3: No checkpoint timer

**What:** Delete the periodic CHECKPOINT timer, the catalog-bytes stat helper, the inlined-rows counter, and the three `EVENT_STORE_CHECKPOINT_*` env vars. Do not call `CHECKPOINT` explicitly anywhere — including in `drainAndClose()`.

**Why:** DuckDB folds the WAL into the main DB on graceful close (`db.destroy()`) and auto-checkpoints during runtime when the WAL exceeds `wal_autocheckpoint` (~16 MiB). Walking the failure modes:

| Scenario | WAL outcome |
|---|---|
| Quiet runtime, graceful restart | WAL folded on close. Cold start sees empty WAL. |
| Busy runtime, graceful restart | Auto-checkpoint at 16 MiB during runtime; close folds the rest. |
| Quiet runtime, SIGKILL | WAL has small uncommitted+committed mix. Reopen replays committed, drops uncommitted. |
| Busy runtime, SIGKILL | WAL up to 16 MiB. Reopen replays. Brief startup delay (ms). |
| Many sequential SIGKILLs | Each reopen folds WAL → main. WAL never grows across restarts. |

No scenario produces unbounded WAL growth or unrecovered state. An explicit timer or close-time CHECKPOINT call would add code without changing observable behaviour.

### Decision 4: Single-writer becomes fail-fast, not silent-corrupt

**What:** Rewrite the existing single-writer requirement in the spec. The deployment contract (one Quadlet `wfe-<env>.container` unit per env on a single VPS, sequential auto-update via `podman-auto-update.timer`) is already encoded in the `infrastructure` capability. The event-store requirement now points at it and adds the file-lock failure mode as defence-in-depth, instead of carrying its own K8s-era deployment vocabulary (`replicas: 1`, `strategy: Recreate`, "rolling deploys").

**Why:** Two things flipped between the DuckLake era and now. (1) The corruption failure mode changed: dual-writer S3 PUTs would silently overwrite a concurrent writer's catalog; DuckDB's exclusive file lock fails the second opener fast instead. (2) The deployment shape changed: `podman-auto-update.timer` does sequential stop→pull→start of the same Quadlet unit, so there is no parallel-running window where two containers could race for the lock. The "rolling deploy" justification that K8s `strategy: Recreate` carried is moot under Quadlet — there is no orchestrator that could ever spawn a parallel container for the same env.

Drop the `Catalog PUT does not include If-Match` scenario (S3-specific). Add a `Second writer fails fast on file lock` scenario.

**Side effect:** `SECURITY.md` was largely rewritten by the 2026-05-02 VPS migration; the "silently corrupt" wording is already gone. The follow-up task is verification, not authoring.

### Decision 5: `createEventStore({ persistenceRoot, … })`

**What:** EventStore takes `persistenceRoot: string` and joins `events.duckdb` internally. No `StorageBackend`, no `StorageLocator`.

**Why:** EventStore was the sole consumer of `locator()`. WorkflowRegistry uses `read`/`write`/`list` from the same backend, but never `locator()`. Decoupling EventStore from the abstraction lets us delete `StorageLocator` and the `locator()` method entirely, narrowing the backend interface.

**Alternatives:**
- **`dbPath: string` directly.** Caller (`main.ts`) joins `events.duckdb`. Marginally more flexible (e.g. tests could pass `:memory:`). The filename convention belongs to EventStore though; `persistenceRoot` keeps that knowledge in one place. Rejected as a wash.
- **Keep `backend: StorageBackend`, read root via `locator()`.** Minimises call-site churn but leaves the locator type alive solely for one root-string read. Rejected.

## Constraints inherited from DuckDB

- **Per-env data dir on local-block storage.** Each env's persistence directory (`/srv/wfe/<env>` bind-mounted into the container as `/data`) lives on the VPS root volume. The two envs SHALL NOT share a persistence directory — already an `infrastructure`-capability invariant. DuckDB's WAL and lock semantics assume single-host, single-process per file; that's the provided shape. A future migration to shared-network storage (NFS, CephFS, or a multi-node setup) would require revisiting the storage layer entirely.
- **WAL management is implicit.** DuckDB auto-checkpoints when the WAL exceeds `wal_autocheckpoint` (default ~16 MiB) and folds it into the main DB on graceful close. We add no timer or explicit CHECKPOINT call.
- **Single-writer is structurally enforced.** Exactly one Quadlet unit per env, sequential auto-update on the same unit (no overlap window). DuckDB's exclusive file lock provides defence-in-depth: a misconfigured second opener fails fast with a lock error.

## Risks / Trade-offs

- **No automated migration.** Operators with prior DuckLake-era data lose dashboard access to it after the upgrade. Acceptable: the parent `remove-s3` branch already implies a clean cutover; if any operator needs the data they can attach the legacy `events/` Parquet directory manually with DuckDB.
- **Cold-start path is now `events.duckdb` open + WAL replay.** No catalog fetch, no extension load. Should be faster than DuckLake but is technically a different code path; no test added (the existing cold-start integration test in `packages/tests/test/02-cold-start-from-catalog.test.ts` already covers it via observable behaviour).
- **PK violation surfaces logic bugs loudly.** A future change that mis-emits an event will now fail-drop the invocation rather than silently double-insert. This is the intended behaviour but could surprise a developer who lands a regression and sees the dashboard losing invocations rather than seeing duplicate rows.

## Migration Plan

Clean cut. No automated migration. On first boot under the new code:

1. EventStore opens (or creates) `<PERSISTENCE_PATH>/events.duckdb` as a plain DuckDB file. If a DuckLake-era `events.duckdb` exists at the same path, DuckDB attempts to open it as a regular DuckDB database. The DuckLake catalog is itself a DuckDB file with internal tables describing the lakehouse; opening it as a plain DuckDB database is well-defined but the `events` table inside would be the DuckLake catalog's internal schema, not the runtime's events table. The `CREATE TABLE IF NOT EXISTS events (…)` on first boot is the boundary: if the legacy file shadows the new schema, the runtime fails to start with a clear DuckDB error. Operators clean up the legacy file (`rm <PERSISTENCE_PATH>/events.duckdb`) and restart.
2. The legacy `<PERSISTENCE_PATH>/events/` Parquet directory is left untouched. Operators reclaim disk on their own schedule.
3. No data is preserved across the migration. This matches the `remove-s3` branch posture.

`docs/upgrades.md` documents the cleanup steps.

## Open Questions

None. All branches resolved during the design interview.
