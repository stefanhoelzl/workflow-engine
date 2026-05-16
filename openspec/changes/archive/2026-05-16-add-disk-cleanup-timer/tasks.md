## 1. Author the cleanup script template

- [x] 1.1 Create `infrastructure/files/disk-cleanup.sh.tmpl` with `#!/usr/bin/env bash`, `set -euo pipefail`, and three reclaim sections in order: `apt-get clean`, `journalctl --vacuum-size=200M --vacuum-time=14d`, and a `for u in ${tenants}; do runuser -u "$u" -- env XDG_RUNTIME_DIR=/run/user/$(id -u "$u") podman image prune -a -f; done` loop. (`-a` so the prune catches both previous `:main` digests AND tagged-but-unused side-images; `-f` skips confirmation.)
- [x] 1.2 The template interpolates `${tenants}` from the same source of truth `host.tf` uses for the rootless tenant list (currently `wfe-prod wfe-staging wfe-caddy`). If `host.tf` already has a `locals.managed_users` (or similar) list, drive the interpolation from that list rather than hardcoding — no second source of truth. *(Driven from `local.tenants` via `join(" ", local.tenants)` in the `templatefile()` call — same list that already drives the per-tenant podman timer overrides.)*
- [x] 1.3 Echo a one-line header at the top of each section (`echo "[disk-cleanup] apt-get clean"`, etc.) so `journalctl -u disk-cleanup.service` shows clear phase boundaries.

## 2. Author the systemd unit files

- [x] 2.1 Create `infrastructure/files/disk-cleanup.service` as a `Type=oneshot` unit running `ExecStart=/usr/local/sbin/disk-cleanup.sh` as root. No `User=` (defaults to root). Add a `Description=` line.
- [x] 2.2 Create `infrastructure/files/disk-cleanup.timer` with `OnCalendar=*-*-* 03:30:00 UTC`, `Persistent=true`, `RandomizedDelaySec=15min`, `Unit=disk-cleanup.service`, `[Install] WantedBy=timers.target`. Add a `Description=` line.

## 3. Wire the three files into `host.tf`'s managed-file convergence

- [x] 3.1 Add a managed-file entry `disk_cleanup_script` writing the rendered `disk-cleanup.sh.tmpl` to `/usr/local/sbin/disk-cleanup.sh`, mode `0755`, owner/group `root`, `sudo = true`, `stage = "pre"`, `on_change = ""` (no follow-up needed; the unit re-reads the script every firing), `on_destroy = "sudo /usr/bin/rm -f /usr/local/sbin/disk-cleanup.sh"`.
- [x] 3.2 Add a managed-file entry `disk_cleanup_service` writing `disk-cleanup.service` to `/etc/systemd/system/disk-cleanup.service`, mode `0644`, owner/group `root`, `sudo = true`, `stage = "pre"`, `on_change = "sudo /bin/systemctl daemon-reload"`, `on_destroy = "sudo /usr/bin/rm -f /etc/systemd/system/disk-cleanup.service && sudo /bin/systemctl daemon-reload"`.
- [x] 3.3 Add a managed-file entry `disk_cleanup_timer` writing `disk-cleanup.timer` to `/etc/systemd/system/disk-cleanup.timer`, mode `0644`, owner/group `root`, `sudo = true`, **`stage = "post"`** (deviation from drafted "pre" — see 3.4), `on_change = "sudo /bin/systemctl daemon-reload && sudo /bin/systemctl enable --now disk-cleanup.timer"`, `on_destroy = "sudo /bin/systemctl disable --now disk-cleanup.timer 2>/dev/null || true; sudo /usr/bin/rm -f /etc/systemd/system/disk-cleanup.timer && sudo /bin/systemctl daemon-reload"`. (The destroy joins `disable` and `rm` with `;` rather than `&&` so a destroy on a host where the timer was never created still progresses to the rm + reload — mirrors the per-tenant timer-override destroy semantics.)
- [x] 3.4 Confirm the three entries respect the dependency order. *(Verified by inspecting `infrastructure/main.tf:426`: `null_resource.managed_file_pre` uses `for_each`, which Terraform processes concurrently with no ordering guarantee between instances. `null_resource.managed_file_post` has `depends_on = [managed_file_pre, managed_exec, managed_ufw]`. Resolution: script + .service in `pre`, .timer in `post`. This guarantees that by the time the timer's `enable --now` runs — which under `Persistent=true` may trigger an immediate catch-up firing if today's 03:30 UTC has already passed — both `/usr/local/sbin/disk-cleanup.sh` and `/etc/systemd/system/disk-cleanup.service` are already installed and `daemon-reload` has been run.)*

## 4. Validate the openspec change

- [x] 4.1 Run `pnpm exec openspec validate add-disk-cleanup-timer --strict`. Resolve any structural issues before opening the PR. *(Reports `valid`.)*
- [x] 4.2 Run `pnpm exec openspec show add-disk-cleanup-timer` and confirm the proposal, tasks, and infrastructure spec delta render.

## 5. Validate the infra plan

- [x] 5.1 Run `tofu fmt -check -recursive infrastructure/` — must be clean. *(Clean — no diff.)*
- [x] 5.2 Run `tofu -chdir=infrastructure validate` — must succeed. *(Reports `Success! The configuration is valid.`)*
- [x] 5.3 Run `tofu -chdir=infrastructure plan` against the real backend (operator-driven, NOT agent). The plan SHALL show exactly three adds (the three managed-file entries) and zero replacements/destroys. Attach the plan summary to the PR description. *(Operator ran on 2026-05-16: `Plan: 3 to add, 0 to change, 0 to destroy.` — exactly `managed_file_pre["disk_cleanup_script"]`, `managed_file_pre["disk_cleanup_service"]`, `managed_file_post["disk_cleanup_timer"]`.)*

## 6. Open the PR

- [ ] 6.1 Push the branch and open a PR. Title: `infra: add daily disk-cleanup timer (apt cache + journal vacuum + dangling-image prune)`.
- [ ] 6.2 PR body: link to this openspec change, summarize the May 12 incident, paste the `plan-infra` output (three adds, zero replacements).
- [ ] 6.3 Confirm `plan-infra` CI gate is green. Confirm `pnpm validate` is green (the change touches infra config only; the JS/TS validate suite is unaffected but must still pass).

## 7. Operator: deploy and verify on the VPS

- [ ] 7.1 After merge to `main`, operator runs the `apply-infra` `workflow_dispatch` workflow.
- [ ] 7.2 SSH to the VPS (`deploy@<ip> -p <ssh_port>`) and run:
  - `systemctl status disk-cleanup.timer` → `Loaded: loaded`, `Active: active (waiting)`.
  - `systemctl list-timers disk-cleanup.timer` → next firing is within the next 24h at ~03:30 UTC.
  - `systemctl cat disk-cleanup.service` and `systemctl cat disk-cleanup.timer` → contents match the templates.
  - `ls -la /usr/local/sbin/disk-cleanup.sh` → mode `0755`, owner `root`.
- [ ] 7.3 Force one firing as a smoke test: `sudo systemctl start disk-cleanup.service`. Then `journalctl -u disk-cleanup.service -n 50 --no-pager` SHALL show all three sections completed with exit `Status=0/SUCCESS`. `df -h /` SHALL show the same or reduced usage versus before the firing.
- [ ] 7.4 Record the smoke result under `## Cluster smoke (human)` below.

## Cluster smoke (human)

- [ ] Operator: paste output of `systemctl status disk-cleanup.timer`, `systemctl list-timers disk-cleanup.timer`, and the `journalctl -u disk-cleanup.service` from the forced firing here.
- [ ] Operator: confirm `df -h /` before vs after the firing — record the delta.
- [ ] Operator: re-run `tofu plan` after apply — MUST be empty (idempotency check for the convergence mechanism).
