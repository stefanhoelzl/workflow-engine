## Why

Staging was OOM-killed 27 times over ~2.5 days, each kill rotating the in-memory session-sealing key (logins succeeded, then immediately broke against the restarted container). Root cause: the per-env memory budget is declared as `MemoryMax=` in the `[Service]` section of the app Quadlet. That lands on the systemd *service* cgroup — the parent of the container payload cgroup — so from inside the container `/sys/fs/cgroup/memory.max` reads `max`. DuckDB 1.5.2 (cgroup-aware, but only of its own cgroup) sized its buffer pool to 80 % of the host's ~962 MiB ≈ 770 MiB, more than 2× the 350M cap one level up; memory climbed until the kernel SIGKILLed the unit. A live drop-in experiment on the VPS (`PodmanArgs=--memory=350m`) confirmed the fix: the payload cgroup showed `memory.max=367001600`, DuckDB self-sized to ~280 MiB, and the kills stopped.

## What Changes

- The app Quadlet template enforces the memory budget on the container **payload** cgroup via `PodmanArgs=--memory=${memory_max}` (Quadlet's `Memory=` key is unsupported on Podman 5.4.2), replacing the `[Service] MemoryMax=` line. The budget becomes visible inside the container, so software that auto-sizes from detected memory (DuckDB, V8) sizes against the real limit instead of host RAM.
- No systemd memory key remains on the app units' parent service cgroup. (A parent `MemoryMax=` alongside the payload cap would trip first — payload usage charges up to the parent, which also holds conmon — re-arming the systemd-kill semantics that rotated the session key. `MemoryHigh=` was considered and rejected: a runaway would degrade into an indefinitely thrashing unit instead of a clean restart.)
- The Caddy unit keeps `MemoryMax=` — no auto-sizing software runs inside it, so the parent-level ceiling is sufficient there.
- `memory_max` stays the single per-env source of truth in `local.envs` (`infrastructure/main.tf`); the value is lowercased to `350m` to match the flag spelling proven by `quadlet -dryrun` on the VPS.
- The kernel cgroup is the contract between the layers: infra publishes the budget into the payload cgroup; code reads it back from the kernel. No explicit in-app sizing (e.g. DuckDB `SET memory_limit`) is added — DuckDB's 80 %-of-cgroup self-sizing is trusted.

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
- `host-security-baseline`: the "Per-Quadlet resource ceilings" requirement changes from "every unit SHALL declare `MemoryMax=`" to: app units SHALL enforce the budget on the container payload cgroup (`PodmanArgs=--memory=`) and SHALL NOT declare a parent `[Service]` memory key; the Caddy unit keeps `MemoryMax=`. The blast-radius scenario's kill semantics move from systemd-kills-the-unit to kernel-OOM-within-the-payload-cgroup; a new scenario asserts the budget is visible from inside the container.

## Impact

- **Infra (`infrastructure/`):** `files/wfe.container.tmpl` (move the cap from `[Service] MemoryMax=` to `[Container] PodmanArgs=--memory=`), `main.tf` (`memory_max` value casing), `variables.tf` (description wording).
- **Apply behaviour:** operator-driven `apply-infra`. Both app Quadlet files change content, so **both units restart** — one-time session invalidation on prod (accepted; prod carries the same latent bug). The operator removes the manual staging drop-in `10-memory-experiment.conf` (the live hotfix) as part of the rollout; if it lingered, `--memory` would simply be passed twice with the same value.
- **Docs:** `docs/infrastructure.md` App-OOM runbook (mechanism + bump knob now `memory_max` in `main.tf`); `SECURITY.md` I5 mitigation bullets (mechanism + stale 700M/128M/2 GB values corrected).
- **Not affected:** runtime/package code, the Caddy quadlet, the infrastructure capability spec (its `MemoryMax` mention is an illustrative example of "any content edit" and stays valid).
- **Out of scope / follow-ups:** reservation-based DuckDB `SET memory_limit` sizing inside the EventStore (explicitly rejected for now — DuckDB self-sizing is trusted); `CPUQuota=` (unchanged, still deferred).
