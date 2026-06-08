## Context

The EventStore persists one DuckDB row per invocation event to `<PERSISTENCE_PATH>/events.duckdb` and never deletes them. On the production VPS this file shares a single 10 GB local SSD with the OS, journald, Podman images, and both prod + staging data dirs, so unbounded growth eventually fills root and takes down the whole host. The runtime is a single process holding **one read-write DuckDB connection** (the "single-writer is a deployment contract" requirement); commits flow through it serially via an in-memory accumulator that commits per terminal invocation.

This change adds time-based retention that bounds the EventStore's steady-state size. It is deliberately the smallest mechanism that solves "stop the file growing forever," not a general data-lifecycle system.

## Goals / Non-Goals

**Goals:**
- Bound EventStore growth to roughly one configurable retention window of data.
- Configurable, opt-in, off by default.
- Never lose live data and never crash the runtime as a result of pruning.
- No new cross-component coupling or new lifecycle surface.

**Non-Goals:**
- Reclaiming disk already consumed by the current file (DELETE does not shrink a DuckDB file — see Decisions). Recovering current bloat is a one-time operator action.
- Size-based caps, per-tenant windows, queue-file retention.
- Infrastructure changes (separate block volume, filesystem project quotas). These are real complements for blast-radius containment but are tracked separately.

## Decisions

### Decision: Prune scope is the EventStore only

The EventStore is the dominant unbounded grower. Queue NDJSON files also grow append-only but hold **functional pending-item state**, so age-deleting their lines could drop unprocessed work — out of scope. Workflow bundles are bounded (one per owner/repo, overwritten on upload); logs go to stdout/journald (already vacuumed by the host `disk-cleanup.timer`).

### Decision: Time-based deletion only; no size cap

The literal ask is "keep the last X days/months." A size cap was considered to guarantee a hard ceiling, but with the delete-only mechanism below it cannot shrink the file anyway, so it would only bound the *logical* plateau — added complexity for marginal benefit on a steady cron+webhook workload. Dropped. If a burst ever pushes the plateau past the disk, the operator shortens `EVENT_STORE_RETENTION_DAYS`.

### Decision: DELETE-only, never rewrite — accept plateau, not shrink

**This is the central trade-off.** DuckDB has no reliable file-shrink command:
- `VACUUM` exists only for PostgreSQL syntax compatibility; it does not return space to the OS.
- `CHECKPOINT` frees deleted blocks into an internal free list that future inserts reuse, and truncates only *trailing* free blocks — so the file usually stays near its high-water mark.
- The only reliable way to return disk to the OS is a full file rewrite (`ATTACH` new + `COPY` + atomic swap), which transiently needs ~2× the surviving data in free space — impossible to bootstrap on an already-full disk.

So pruning **DELETEs** old invocations and **CHECKPOINTs**; the file *plateaus* (space reused) rather than shrinking. This bounds future growth, which is the actual goal. It does **not** recover the current bloat — that is handled out-of-band (Migration Plan). Alternatives (periodic rewrite, one-shot compaction CLI) were considered and rejected as too heavy and unable to run on a full disk.

### Decision: Fold retention into the EventStore (no separate RetentionService)

A standalone `RetentionService` (its own timer + `Service` lifecycle) was the initial design. It was rejected because it reaches into the EventStore's single-writer connection from a separate lifecycle, which manufactures three avoidable problems: (1) two write call sites racing on one connection, (2) a shutdown race between the service's `stop()` and `eventStore.drainAndClose()` running concurrently under `Promise.allSettled`, and (3) a prune error propagating through a `start()` promise into `main.ts`'s `onError`, which calls `shutdown(1)` and kills the process.

Folding pruning **into** the EventStore dissolves all three: one owner sequences the prune among its own commits; `drainAndClose()` clears its own timer during its own teardown; and prune errors are caught internally (like `commit-dropped`), with no `start()` promise to escalate through. This matches the existing architecture philosophy — the `event-store` spec already says other responsibilities "collapse into the EventStore." `prune({ olderThan })` is still exposed as a public method so it is directly unit-testable without timers.

### Decision: Delete whole invocations, anchored on `max("at")`

Deletion groups by invocation `id` and removes an invocation only when **all** its events are older than the cutoff (`HAVING max("at") < cutoff`), keeping call graphs intact for the dashboard. The cutoff compares against the **`at` column (TIMESTAMPTZ wall-clock)**, not `ts` — the spec defines `ts` as "BIGINT, monotonic µs," which is not safely comparable to wall-clock `now`. Anchoring on `max("at")` (most recent activity) means a long-running invocation with recent events is never half-deleted.

### Decision: Errors are logged, never thrown to a crash path; the interval is the retry

A prune is a write on the same connection as commits, with the same failure modes (I/O, lock contention, full disk). The EventStore already specifies "Bounded retry then drop on commit failure … the runtime SHALL NOT exit on commit-drop." Retention mirrors this: a failed prune logs `event-store.prune-failed` at error level and waits for the next interval tick (the tick *is* the retry). No inner retry loop — prunes are infrequent and an inner loop would only prolong holding the writer. A failed prune loses nothing (cleanup is merely deferred), making it strictly safer than a dropped commit.

### Decision: Single `EVENT_STORE_RETENTION_DAYS` knob, derived interval, off by default

`EVENT_STORE_RETENTION_DAYS` (integer days; unset or `0` = disabled) is the only retention config value. Opt-in is safer than opt-out for an irreversible delete. "6 months" is expressed as `180` — a single days knob covers days and months without a parser.

The prune **interval is derived** from the window rather than configured separately: the EventStore prunes 100× per window (every `retentionDays / 100` days = `retentionDays * 864_000` ms). This couples cadence to the policy — an invocation outlives its window by at most ~1% — and removes a redundant knob that could be misconfigured (e.g. an interval longer than the window). A separate `EVENT_STORE_RETENTION_INTERVAL_MS` was considered and rejected for that reason.

### Sequence: prune lifecycle

```
createEventStore({config})
  open connection, create table
  if config.retentionDays > 0:
      intervalMs = retentionDays * 864_000            // retentionDays/100 days
      timer = setInterval(intervalMs, tick)            // deferred first run; not awaited in factory
  return store

tick():                            // internal; never throws
  void safePrune()

safePrune():
  try:
    cutoff = now() - retentionDays
    n = await prune({olderThan: cutoff})               // serialized with commits on the one connection
    logger.info("event-store.prune-ok", {invocations:n, durationMs, ...})
  catch e:
    logger.error("event-store.prune-failed", {error:e})   // swallow — next tick retries

prune({olderThan}) -> count:       // PUBLIC, unit-testable
  DELETE FROM events
   WHERE id IN (SELECT id FROM events GROUP BY id HAVING max("at") < olderThan)
  CHECKPOINT
  return rowsAffectedInvocations

drainAndClose():
  clearInterval(timer)             // teardown owns its own timer
  ... existing SIGTERM drain + db.destroy() ...
```

## Risks / Trade-offs

- **DELETE does not reclaim current disk** → The first recovery is a one-time operator action (wipe `events.duckdb`), documented in the runbook. Steady-state thereafter plateaus below the disk size.
- **First prune on a large un-wiped DB briefly stalls event recording** → It is one single-transaction DELETE serialized ahead of live commits, so commits queue (latency) but never fail or lose data; triggers still execute. It is one-time and operator-initiated. The normal enable path (wipe first) avoids it entirely. Batched/chunked deletion is held as a future mitigation if the stall ever bites.
- **First prune contending with boot recovery** → The factory defers the first run rather than awaiting it, so recovery (which runs after `createEventStore` in `init()`) and server bind are never delayed.
- **Prune fails on a full disk (DELETE/CHECKPOINT needs WAL space)** → It logs and retries next tick; it never crashes the process (which under `Restart=always` would crash-loop and free nothing). The disk is recovered by the operator wipe, not by retention.
- **Process killed mid-prune at shutdown** → The DELETE is a single atomic transaction; an unclean kill rolls it back on next open (no partial deletion, no corruption) and it retries next boot. `drainAndClose()` must not add prune time to the SIGTERM drain budget, so no *new* prune starts once shutting down.
- **Shorter window reduces forensic/debug lookback** → Deliberate operator trade-off, off by default, documented so it is a conscious choice.

## Security

Checked against `runtime-config`'s "Security context" requirement (`SECURITY.md §4 Authentication`). Retention adds no HTTP route, no auth/authorization gate, no secret handling, and no sandbox global. `prune()` is a global system DELETE that never uses the scope-bound `query()`, so it cannot introduce a cross-`(owner, repo)` leak; no user can trigger it (env-gated, internal). The change is **orthogonal to the threat model** — no `SECURITY.md §4` edit is required, only the note that alignment was checked.

## Migration Plan

1. **Recover current bloat (one-time, manual):** stop the unit → `rm <data_dir>/events.duckdb <data_dir>/events.duckdb.wal` → restart (the table is recreated on boot). Documented in `docs/infrastructure.md`.
2. **Enable retention:** `retention_days` is set per-environment in `infrastructure/main.tf` (`local.envs`) and rendered into each Quadlet unit by `apps.tf` + `wfe.container.tmpl` — prod `90` (derived ~21.6h cadence), staging `1` (derived ~14.4 min). Applied operator-side via the `apply-infra` workflow. To tune, edit `retention_days` in `local.envs` and re-apply.
3. **Rollback:** unset `EVENT_STORE_RETENTION_DAYS` (or set `0`) and restart — pruning stops immediately; no schema or data-format change to revert.

## Open Questions

None — resolved during exploration.
