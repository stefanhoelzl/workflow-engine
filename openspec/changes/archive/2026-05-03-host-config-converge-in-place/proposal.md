## Why

Today every edit to `infrastructure/cloud-init.yaml` flips a sha256 trigger that forces full VPS replacement (`replace_triggered_by = [terraform_data.cloud_init]`). This wipes `/srv/wfe/<env>` event-store data and `/srv/caddy/data` ACME state on routine host-config tweaks (sshd hardening, fail2ban tuning, sysctl, sudoers, package list). Replacement was the only way to re-bake host config because cloud-init runs only at first boot. The migration goal is: **edit host config, apply, keep the data**.

A second goal piggy-backs: today the `deploy` user runs both interactive admin tasks AND every container, so a sandbox/container escape (S1 → I11, accepted as R-I18) lands directly on the same UID that has SSH keys + sudoers — collapsing the post-escape blast radius to whatever sudoers allows. Splitting the runtime into separate unprivileged users per tenant moves the post-escape landing pad off the privileged account entirely.

## What Changes

- **BREAKING**: cloud-init shrinks from ~150 lines to the bootstrap minimum needed for tofu to SSH in (deploy user + sudoers + sshd hardening + ufw allow-ssh-only + FORWARD_POLICY). Everything else (fail2ban jail, sysctl drop-ins, packages, dirs, swapfile, subuid/subgid, service enables, app-side ufw rules, per-tenant users, Quadlets, env files, podman-auto-update timer overrides) moves to a tofu-state-tracked **in-place convergence mechanism** that runs over SSH on the existing VPS.
- **BREAKING**: `replace_triggered_by = [terraform_data.cloud_init]` is removed. Scaleway treats `user_data` as API-mutable so cloud-init edits update the field in place; cloud-init only re-runs on a fresh VPS, so re-baking the bootstrap minimum requires `tofu taint scaleway_instance_server.vps` (operator action, with the rsync-and-restore migration ritual).
- **BREAKING**: per-tenant unprivileged users — `wfe-prod`, `wfe-staging`, `wfe-caddy` — are introduced as the rootless container runtime users. Each has its own non-overlapping subuid range, has `loginctl enable-linger` enabled (so user systemd starts at boot), and runs its Quadlet as a **user-mode** systemd unit at `/home/<user>/.config/containers/systemd/<unit>.container`. Podman runs rootless under each tenant user — that is what makes container escape land the attacker on the unprivileged user, not on root. The `deploy` user no longer runs any workload; it is administrative-only.
- **BREAKING**: `deploy`'s NOPASSWD sudoers expands from the current systemctl-only allowlist to a broad converge-primitives allowlist: `install`, `tee`, `rm`, `chmod`, `chown`, `systemctl`, `loginctl`, `runuser`, `useradd`/`usermod`/`userdel`, `ufw`, `apt-get`, `sysctl`, `swapon`/`swapoff`, `fallocate`, `mkswap`. Acceptable because deploy is no longer the post-sandbox-escape landing pad — `wfe-*` are. Sudoers is owned by cloud-init only (NOT by the convergence mechanism); editing the allowlist triggers VPS re-bake (`tofu taint`). Reason: a destroy/create race in managing sudoers via the convergence mechanism could leave the host with no NOPASSWD rules and no recovery path (no root password is set by design).
- New typed declaration shape in `infrastructure/`: `managed_users`, `managed_dirs`, `managed_packages`, `managed_files` (with `pre`/`post` stages), `managed_exec`, `managed_ufw`. Per-entry `on_change` and `on_destroy` hooks. **All entries are auto-clean by default** — removing an entry from configuration removes the host artifact (file removed, ufw rule deleted, swap deactivated, user removed) on next apply.
- `/etc/subuid` and `/etc/subgid` are managed via `managed_files` (rendered from `local.managed_users`) — NOT via `usermod --add-subuids` in the user-create step. `useradd` auto-allocates ranges that stack on top of explicit ones, leading to overlapping cross-tenant ranges that break the filesystem-isolation property.
- `/etc/wfe/` is mode `0711` (not `0700`) so each tenant's user-mode systemd can traverse the directory to open its own `<env>.env` file via `EnvironmentFile=`. Per-file ownership (mode `0600`, owner `wfe-<env>`) prevents cross-tenant reads of secret content.
- Per-tenant podman-auto-update is enabled via user-mode `podman-auto-update.timer` (each tenant runs its own; system-mode timer is no longer used). Per-tenant timer override at `/home/<user>/.config/systemd/user/podman-auto-update.timer.d/override.conf` keeps the OnCalendar=minutely cadence.
- Per-tenant container users are created/destroyed via the convergence mechanism, NOT cloud-init — adding a tenant is a pure tofu-side operation.
- App-side firewall rules (80/443) move from cloud-init into `managed_ufw`, additive on top of cloud-init's ssh-only baseline.
- Updates to `SECURITY.md` §I9, R-I18, rule #8 to cite the new privilege-isolation framing. With user-mode rootless Podman + per-tenant subuid ranges, the cross-tenant filesystem-isolation property in R-I18 is now actually delivered (was kernel-only previously).

## Capabilities

### New Capabilities

(none — this change is fully covered by deltas to existing capabilities)

### Modified Capabilities

- `infrastructure`: removes "Cloud-init changes force VPS replacement"; rewrites "Cloud-init bootstraps the box" to a bootstrap minimum; adds "Host configuration converges in place" and "Managed user accounts"; rewrites "Quadlet units" and "Per-env secret env files" to refer to the convergence mechanism as the implementation substrate, with user-mode Quadlets under linger-enabled per-tenant accounts.
- `host-security-baseline`: rewrites "Rootless Podman with subuid mapping" for per-tenant users running user-mode rootless Podman; replaces "Scoped NOPASSWD sudo for the deploy user" with "Privilege isolation: deploy administers; per-tenant wfe-* run unprivileged"; updates "Quadlet + Caddyfile config dirs writable by deploy" rationale.

## Impact

- **Files**: `infrastructure/cloud-init.yaml` shrinks; `infrastructure/main.tf` gains the unified convergence resources; `infrastructure/{apps,caddy,host}.tf` reorganize around typed maps; new templates under `infrastructure/files/` for sshd hardening, fail2ban jail, sysctl drop-in, podman-auto-update timer override, sudoers/deploy.
- **Specs**: `openspec/specs/infrastructure/spec.md` and `openspec/specs/host-security-baseline/spec.md` substantially rewritten.
- **SECURITY.md**: §I9 mitigation paragraph, R-I18, operator rule #8, asset table, and §I9 mitigation list all updated to reflect the new privilege boundary.
- **Migration cost**: the cloud-init re-bake (`tofu taint scaleway_instance_server.vps`) destroys the local SSD root volume; `/srv/wfe/<env>` and `/srv/caddy/data` are wiped. Operator runs the rsync-and-restore ritual (documented in `docs/infrastructure.md`) to preserve data across the one-time migration.
- **No runtime API impact**. Workflow uploads, dashboard, auth, sandbox surface — all unaffected.
- **Operator UX**: SSH-as-deploy unchanged. `journalctl -u wfe-prod` (system-mode lookup) is replaced by `journalctl --user-unit wfe-prod` or per-tenant `sudo runuser -u wfe-prod -- env XDG_RUNTIME_DIR=/run/user/$(id -u wfe-prod) /bin/systemctl --user status wfe-prod.service`. Container introspection (`podman ps`) now requires `sudo -u wfe-<env> podman ps` (or via runuser) instead of running as deploy directly. Operator no longer needs the root password — `tofu taint` is the bootstrap-recovery path.
- **Drift detection**: explicitly out of scope for the convergence mechanism. Hand-edits on the host are NOT detected by tofu plan; subsequent apply that touches the entry rewrites declared content from template (drift self-heals on next change).
- **Service interruption on edits**: every Quadlet/env-file edit causes a brief stop+restart on the affected tenant (auto-clean destroy stops + removes the file; create writes + on_change reloads + restarts). Acceptable per the "in-place converge" contract; staging-grade workload.
