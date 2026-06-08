## 1. Config

- [x] 1.1 Add `EVENT_STORE_RETENTION_DAYS` to the Zod schema in `packages/runtime/src/config.ts` (`z.coerce.number().int().nonnegative().default(0)`) and expose it as `eventStoreRetentionDays` in the transform. (Single knob — the prune interval is derived from it, no separate env var.)
- [x] 1.2 Add config unit tests: default disables (value `0`), override parses, non-numeric rejected, negative rejected.

## 2. EventStore prune primitive

- [x] 2.1 Extend `EventStoreConfig` in `packages/runtime/src/event-store.ts` with `retentionDays`, and pass it from `main.ts`.
- [x] 2.2 Implement public `prune({ olderThan })`: single `DELETE FROM events WHERE id IN (SELECT id FROM events GROUP BY id HAVING max("at") < ?)` followed by `CHECKPOINT`, returning the deleted-invocation count. Compare against `at` (TIMESTAMPTZ), never `ts`. Serialize with commits so prune and a commit never run concurrently on the connection.
- [x] 2.3 Add `prune` to the `EventStore` interface and the factory return object; update the factory "exposes ..." scenario expectations.
- [x] 2.4 Unit-test `prune` directly: deletes fully-aged invocations, keeps a straddling call graph whole (`max(at)` newer than cutoff survives), returns correct count, no-op when nothing is aged.

## 3. Self-scheduling

- [x] 3.1 In the factory, when `retentionDays > 0`, start a `setInterval` (interval derived as `retentionDays * 864_000` ms = window/100) that calls an internal `safePrune()`; do not schedule when `retentionDays` is `0`/unset.
- [x] 3.2 Defer the first prune so it is not awaited in the factory (does not delay factory resolution, recovery, or server bind).
- [x] 3.3 Implement `safePrune()`: compute cutoff `now - retentionDays`, call `prune`, log `event-store.prune-ok { invocations, durationMs }` on success; catch all errors, log `event-store.prune-failed { error }`, never rethrow. No inner retry loop.
- [x] 3.4 In `drainAndClose`, `clearInterval` the retention timer before draining; ensure no new prune starts once shutting down (reuse/extend the existing `stopped` guard).
- [x] 3.5 Tests: retention disabled schedules nothing; an enabled tick prunes and logs `prune-ok`; a failing prune logs `prune-failed`, leaves the process running, and keeps the timer scheduled.

## 4. Crash / shutdown safety

- [x] 4.1 Test that `drainAndClose` clears the retention timer and no prune runs after it is invoked.
- [x] 4.2 Crash-recovery test: a `DELETE` interrupted before commit (process killed mid-prune) leaves the events table intact on reopen (atomic rollback — no partial deletion), and a fresh boot reschedules and re-prunes.

## 5. Docs

- [x] 5.1 `docs/infrastructure.md`: document the one-time current-bloat recovery (stop unit → `rm <data_dir>/events.duckdb <data_dir>/events.duckdb.wal` → restart) and a note that enabling retention on a large un-wiped DB may briefly lag event recording during the first prune.
- [x] 5.2 `docs/upgrades.md`: note the new optional `EVENT_STORE_RETENTION_DAYS` env var (off by default; interval derived; no tenant rebuild/re-upload required).

## 6. Verification (dev probe)

- [x] 6.1 Boot `pnpm dev --random-port --kill` with `EVENT_STORE_RETENTION_DAYS` set; confirm the deferred first prune and derived-interval ticks log `event-store.prune-ok` and that fresh events are retained. Confirm a boot with retention unset prunes nothing.
- [x] 6.2 Run `pnpm validate`.

## 7. Per-env infra wiring

- [x] 7.1 Add `retention_days` to each `local.envs` block in `infrastructure/main.tf` (prod = 90; staging = 1).
- [x] 7.2 Pass `retention_days` through the `templatefile` call in `infrastructure/apps.tf`.
- [x] 7.3 Render `Environment=EVENT_STORE_RETENTION_DAYS` in `infrastructure/files/wfe.container.tmpl`.
- [x] 7.4 `tofu fmt -recursive infrastructure/` and `tofu -chdir=infrastructure validate` pass.

## Cluster smoke (human)

This change templates one env var into the `wfe-<env>` Quadlet unit; verify on the VPS after the operator runs `apply-infra`:

- [ ] The `plan-infra` gate shows only the expected `Environment=EVENT_STORE_RETENTION_DAYS` addition to both `wfe-prod` and `wfe-staging` units (no resource recreation).
- [ ] After apply, `systemctl --user show wfe-staging -p Environment` (as `wfe-staging`) lists `EVENT_STORE_RETENTION_DAYS=1`; prod lists `90`.
- [ ] `journalctl --user -u wfe-staging | grep event-store.prune` shows `event-store.prune-ok` lines roughly every ~14 min; prod shows them roughly every ~21.6h.
- [ ] Both `/readyz` endpoints stay healthy across the unit restart.
