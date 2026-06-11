# Tasks

## 1. Quadlet template

- [x] 1.1 `infrastructure/files/wfe.container.tmpl`: add `PodmanArgs=--memory=${memory_max}` to `[Container]` with a comment documenting the invariant (payload-cgroup visibility; `Memory=` unsupported on Podman 5.4.2; do not reintroduce `[Service] MemoryMax=`).
- [x] 1.2 Remove `MemoryMax=${memory_max}` from `[Service]`.

## 2. Tofu values & descriptions

- [x] 2.1 `infrastructure/main.tf`: `memory_max` `"350M"` → `"350m"` in both `local.envs` entries (exact fidelity with the flag proven by `quadlet -dryrun` on the VPS; the value now feeds only `--memory`).
- [x] 2.2 `infrastructure/variables.tf`: `instance_type` description "per-Quadlet MemoryMax limits" → "per-Quadlet memory limits".

## 3. Docs

- [x] 3.1 `docs/infrastructure.md` App-OOM runbook: describe the payload-cgroup `--memory` mechanism (DuckDB self-sizes to 80 % of it) and point the bump knob at `memory_max` in `infrastructure/main.tf`.
- [x] 3.2 `SECURITY.md`: update the three per-Quadlet memory-ceiling mentions (I5 mitigation bullet, R-I3 residual row, production posture item 3) to the payload-cgroup mechanism and correct the stale values (700M/128M/2 GB → 350m per app, 80M Caddy, 1 GB RAM); update agent rule 11's "set `MemoryMax=`" guidance.

## 4. Validation

- [x] 4.1 `pnpm exec openspec validate payload-cgroup-memory-budget` passes.
- [x] 4.2 `pnpm validate` passes (includes `tofu fmt -check` + `tofu validate`).

## Cluster smoke (human)

The pre-merge `plan-infra` gate will show a non-empty plan until the operator applies; surface "needs `apply-infra`" in the PR summary.

- [x] As `wfe-staging`: remove the live hotfix drop-in `rm /home/wfe-staging/.config/containers/systemd/wfe-staging.container.d/10-memory-experiment.conf` (and the now-empty `.d` dir) + `systemctl --user daemon-reload`. Do this before/with the apply — if it lingers, `--memory` is passed twice (same value, last wins, harmless but messy).
- [x] Run the `apply-infra` workflow. Both `wfe-staging` and `wfe-prod` Quadlet files change → both units restart (one-time session invalidation on prod, accepted).
- [x] `podman exec wfe-staging cat /sys/fs/cgroup/memory.max` → `367001600` (same check on prod with `wfe-prod`).
- [x] `systemctl --user show wfe-staging.service -p MemoryMax` (as `wfe-staging`) → `MemoryMax=infinity` (parent no longer capped).
- [x] `journalctl --user -u wfe-staging | grep -i oom` since the restart → empty.
