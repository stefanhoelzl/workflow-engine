## Why

The EventStore (`events.duckdb`) grows without bound — one row per invocation event, never deleted — and periodically fills the VPS's shared 10 GB disk, which takes down the whole host (sshd, journald, even the disk-cleanup timer) rather than just degrading the app. We need a configurable, time-based retention mechanism that bounds the EventStore's steady-state size.

## What Changes

- Add an opt-in, time-based retention policy to the EventStore: invocations whose most recent event is older than a configured window are deleted on a recurring schedule.
- Add a public `prune({ olderThan })` method to the EventStore that deletes whole invocations (grouped by `id`, anchored on `max("at")`) and issues a `CHECKPOINT`, serialized with commits on the single writer connection.
- The EventStore **self-schedules** pruning via an internal interval timer started in its factory when retention is enabled; there is no separate retention service.
- Add one config field: `EVENT_STORE_RETENTION_DAYS` (integer days; unset or `0` disables retention — the default). The prune interval is **derived** from the window (100 prunes per window, i.e. every `retentionDays / 100` days) — no separate interval knob.
- Prune failures are logged at error level and never propagate — they cannot crash the runtime — mirroring the existing "bounded retry then drop" commit posture. The interval tick is the retry.
- `drainAndClose()` clears the retention timer as part of its existing teardown.

- Wire `EVENT_STORE_RETENTION_DAYS` per-environment through the Quadlet template (`local.envs` → `apps.tf` → `wfe.container.tmpl`): **prod** = 90 days (derived ~21.6h cadence), **staging** = 1 day (derived ~14.4 min cadence).

Non-goals (explicitly out of scope):
- No reclamation of disk already consumed by the current file. DELETE does not shrink a DuckDB file; freed space is reused by future inserts, so the file **plateaus** rather than shrinking. Recovering the current bloat is a one-time operator action (wipe `events.duckdb`), documented in the runbook — not part of this change.
- No size cap, no per-tenant windows (the window is per *deployment*, not per owner/repo within a deployment), no queue-file retention, and no disk-isolation infra (block volume, filesystem quotas tracked separately). The only infra touch is templating the two env vars into the existing Quadlet unit.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `event-store`: add the `prune()` storage primitive and the self-pruning scheduler; `drainAndClose()` clears the retention timer.
- `runtime-config`: add `EVENT_STORE_RETENTION_DAYS` config field (prune interval derived from it, no separate knob); confirm threat-model alignment (orthogonal — see design.md).

## Impact

- **Code**: `packages/runtime/src/event-store.ts` (new `prune()`, internal scheduler, timer teardown), `packages/runtime/src/config.ts` (two new env vars + transform fields).
- **Config / ops**: one new `EVENT_STORE_RETENTION_DAYS` env var (optional; retention off by default in the runtime; prune interval derived from it). Set per-environment in `infrastructure/main.tf` (`local.envs`) and rendered into each Quadlet unit's `Environment=` via `apps.tf` + `wfe.container.tmpl`. Prod = `90`; staging = `1`.
- **Infra**: `infrastructure/main.tf`, `infrastructure/apps.tf`, `infrastructure/files/wfe.container.tmpl` (env-var templating only — no new resources, volumes, or quotas). Operator-applied via the `apply-infra` workflow; surfaces in the `plan-infra` gate.
- **Docs**: `docs/infrastructure.md` runbook — one-time `events.duckdb` wipe procedure for recovering current disk bloat, and a note that enabling retention on a large un-wiped DB may briefly lag event recording during the first prune.
- **No** changes to: `main.ts` wiring, the EventBus consumer pipeline, the sandbox boundary, the manifest format, HTTP routes, auth, or secrets. Not a breaking change.
