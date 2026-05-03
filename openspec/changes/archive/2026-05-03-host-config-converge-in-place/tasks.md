## 1. Cloud-init shrink

- [x] 1.1 Reduce `infrastructure/cloud-init.yaml` to the bootstrap minimum: `deploy` user (groups `adm`, `systemd-journal`); `packages: [ufw, sudo]`; `/etc/sudoers.d/deploy` with the broad converge allowlist; sshd hardening drop-in (Port, AllowUsers deploy, no root, no password, no kbd-interactive); restart sshd; `sed` for `DEFAULT_FORWARD_POLICY=ACCEPT`; ufw default-deny + allow ssh_port + enable.
- [x] 1.2 Remove from cloud-init: subuid range, sysctl drop-in, podman-auto-update timer override, fail2ban jail content, app package install (podman/fail2ban/unattended-upgrades/curl/ca-certificates), all dirs under `/srv` and `/etc/wfe` and `/etc/containers/systemd` and `/etc/caddy`, swapfile, fail2ban + unattended-upgrades + podman-auto-update.timer service enables, ufw rules for 80/443.
- [x] 1.3 Remove the `users:` entry for any wfe-* container-runtime user (those are now created by the convergence mechanism).
- [x] 1.4 Verify cloud-init template renders cleanly (standalone `tofu plan` output rendered the templated YAML with `Port 2222` and the full sudoers list correctly indented under `content: |` blocks).

## 2. Convergence mechanism scaffolding

- [x] 2.1 Add new template files under `infrastructure/files/`: `sshd_hardening.conf.tmpl`, `fail2ban_jail.conf.tmpl`, `sysctl_unprivileged.conf`, `podman_timer_override.conf`, `sudoers_deploy` (full allowlist; cloud-init writes a bootstrap copy from this file via `file()`, host.tf reasserts via `templatefile`/`file` — same source).
- [x] 2.2 Create `infrastructure/host.tf` containing `local.managed_users` (the three `wfe-*` entries with explicit subuid ranges 100000-165535, 165536-231071, 231072-296607), `local.managed_dirs`, `local.managed_packages`, `local.managed_files_host`, `local.managed_exec`, `local.managed_ufw`.
- [x] 2.3 Add a `precondition` block on `null_resource.managed_user` validating that no two declared subuid ranges overlap.
- [x] 2.4 Add the unified `null_resource` definitions to `infrastructure/main.tf`: `managed_user`, `managed_dir`, `managed_packages`, `managed_file_pre`, `managed_exec`, `managed_ufw`, `managed_file_post`. Wired `depends_on` between stages.
- [x] 2.5 Each resource's `triggers` map carries `instance`, content/spec hash, plus the SSH connection fields via `merge(local.ssh_triggers, {...})` so destroy-time provisioners can read SSH config from `self.triggers.*` (terraform forbids destroy provisioners from referencing non-self attributes).

## 3. Migrate apps.tf

- [x] 3.1 In `apps.tf`, replaced `null_resource.wfe_quadlet` and `null_resource.wfe_env_file` with `local.managed_files_apps` entries (env files stage `pre`, Quadlets stage `post`, both PINNED).
- [x] 3.2 Added `User=${runtime_user}` to `infrastructure/files/wfe.container.tmpl`; `runtime_user` field added to `local.envs` in main.tf.
- [x] 3.3 `random_bytes.secrets_key` and `local.env_files`/`local.quadlets` declarations preserved (only the templatefile var list grew by `runtime_user`).

## 4. Migrate caddy.tf

- [x] 4.1 In `caddy.tf`, replaced `null_resource.caddyfile` and `null_resource.caddy_quadlet` with `local.managed_files_caddy` entries (Caddyfile stage `pre` auto-clean, Quadlet stage `post` PINNED).
- [x] 4.2 Added `User=wfe-caddy` to `infrastructure/files/caddy.container.tmpl`.

## 5. main.tf cleanup

- [x] 5.1 Removed `resource "terraform_data" "cloud_init"` from `main.tf`.
- [x] 5.2 Removed the `lifecycle { replace_triggered_by = [terraform_data.cloud_init] }` block from `scaleway_instance_server.vps`.
- [x] 5.3 `scaleway_instance_server.vps`'s `user_data` still derives from cloud-init template content; only the replace trigger is gone.
- [x] 5.4 Each entry in `locals.envs` now has `runtime_user = "wfe-${name}"`.
- [x] 5.5 Caddy's runtime user `wfe-caddy` is hardcoded in `caddy.container.tmpl` (single tenant — no parameterization needed).

## 6. variables.tf

- [x] 6.1 No new variables required.
- [x] 6.2 No stale comments referencing the scoped-sudoers posture in `variables.tf`.

## 7. Pre-merge validation

- [x] 7.1 `tofu fmt -check`, `tofu validate`, `pnpm lint`, `pnpm check` all pass. (`pnpm test` not run — this PR doesn't touch any TS code.)
- [ ] 7.2 `tofu -chdir=infrastructure plan` against the existing remote state — requires backend credentials, run by operator before merge. Expected plan: `scaleway_instance_server.vps` REPLACED once (cloud-init content changed), all in-place changes for managed_users/dirs/packages/files/exec/ufw.
- [x] 7.3 OpenSpec validation passes.

## 8. Cluster smoke (human, on staging)

- [ ] 8.1 Rsync staging data off-host: `rsync -aAX deploy@staging.workflow-engine.webredirect.org:/srv/wfe/staging /tmp/staging-pre-migration-<date>` (best-effort backup; staging data loss is acceptable but capture it for inspection).
- [ ] 8.2 `tofu -chdir=infrastructure apply` against the staging tfvars. Verify the plan replaces the VPS once, then converges everything else.
- [x] 8.3 After apply, `cloud-init status` reports `done`. ssh as deploy works; ssh as `wfe-*` would fail (no AllowUsers entry, no key, nologin shell). Verified live.
- [x] 8.4 `id wfe-prod`, `id wfe-staging`, `id wfe-caddy` each show no privileged groups; `getent passwd wfe-prod` shows `/usr/sbin/nologin`. Verified live.
- [x] 8.5 `cat /etc/subuid` shows exactly three non-overlapping ranges (100000-, 165536-, 231072-) one per wfe-* user. (Required a follow-up apply that switched from `usermod --add-subuids` to managed_files-rendered `/etc/subuid` + `/etc/subgid`.)
- [x] 8.6 Per-tenant user-mode systemctl checks (`sudo runuser -u <user> -- env XDG_RUNTIME_DIR=/run/user/$(id -u <user>) /bin/systemctl --user is-active <unit>`): all three active. `ps -eo user,comm` shows `wfe-caddy`, `wfe-prod`, `wfe-staging` for caddy/conmon/podman processes; NOT deploy or root.
- [x] 8.7 `ufw status numbered` shows ssh_port (from cloud-init), 80/tcp, 443/tcp (from managed_ufw). (Required one manual `ufw allow 80/tcp` re-add — see footnote on the suspected race; not reproduced in subsequent applies.)
- [x] 8.8 `swapon --show` shows `/swapfile` 1G.
- [x] 8.9 `cat /proc/sys/net/ipv4/ip_unprivileged_port_start` returns `80`.
- [x] 8.10 fail2ban + unattended-upgrades active (system-mode); podman-auto-update.timer active per-tenant in user-mode (`systemctl --user --machine=wfe-prod@.host status podman-auto-update.timer` etc.).
- [x] 8.11 `ls -ld /srv/wfe/{prod,staging} /srv/caddy/{data,config}` shows mode `0700` owned by the corresponding `wfe-*` user. Verified live.
- [x] 8.12 `ls -l /etc/wfe/{prod,staging}.env` shows mode `0600` owned `wfe-<env>:wfe-<env>` (NOT deploy — corrected from original task spec). Parent `/etc/wfe` is mode `0711` (also corrected; was 0700). User-mode systemd reads via `EnvironmentFile=`; container process runs as wfe-<env>.
- [ ] 8.13 curl `https://staging.workflow-engine.webredirect.org/healthz` from off-host → 200, valid Let's Encrypt cert. (Operator to verify; healthz on local 127.0.0.1:8082 returns 200 from the box.)

## 9. Iteration smoke (human, on staging)

- [ ] 9.1 Edit `fail2ban_jail.conf.tmpl` (e.g., bantime: 1h → 2h). `tofu apply`. Verify: NO VPS replacement, fail2ban jail file content updated on host, fail2ban restarted (`systemctl show fail2ban -p ActiveEnterTimestamp` recent), `/srv/wfe/staging` data unchanged.
- [ ] 9.2 Add a stub key to `local.managed_ufw` (`tcp9999 = { port = 9999, proto = "tcp" }`). Apply. `ufw status` shows 9999. Remove the key. Apply. `ufw status` no longer lists 9999.
- [ ] 9.3 Edit `wfe.container.tmpl` (e.g., MemoryMax 350M → 400M). Apply. Verify: NO VPS replacement, only `wfe-staging.service` restarts (prod and caddy unaffected), new MemoryMax visible via `systemctl show wfe-staging -p MemoryMax`.

## 10. Removal smoke (human, on staging)

- [ ] 10.1 Comment out the `fail2ban_jail` entry in `local.managed_files_host` (auto-clean entry). Apply. Verify: `/etc/fail2ban/jail.d/sshd.local` removed; fail2ban restarted (loads default config; sshd jail is gone). Restore the entry, re-apply, verify file restored.
- [ ] 10.2 Comment out `local.managed_users["wfe-staging"]` AND `local.managed_files_apps["wfe_env_staging"]` AND `local.managed_files_apps["wfe_quadlet_staging"]` AND `local.managed_dirs["/srv/wfe/staging"]` in the same apply. Verify: tenant teardown succeeds (Quadlet stops first via reverse-dependency-order destroy; user removed last). Restore all entries, verify tenant comes back online.
- [ ] 10.3 Comment out ONLY `local.managed_users["wfe-staging"]` (without removing the Quadlet). Apply. Verify: apply errors out at `userdel` (process running). Restore the user entry. Confirms fail-loud removal protection.

## 11. Plan-time validation smoke

- [ ] 11.1 Edit `local.managed_users` to give `wfe-prod` and `wfe-staging` overlapping subuid ranges. `tofu plan`. Verify: plan FAILS at the precondition with a message identifying the overlap. Revert.

## 12. Production migration

- [ ] 12.1 `rsync -aAX deploy@workflow-engine.webredirect.org:/srv/wfe/prod /tmp/prod-pre-migration-<date>` and same for `/srv/caddy/data` (ACME state — losing this means re-issuance of certs, which is fine but adds rate-limit pressure).
- [ ] 12.2 Verify the rsync backup is complete and readable on the operator's machine (size, file count, sample event-store file).
- [ ] 12.3 `tofu -chdir=infrastructure apply` against the prod tfvars. VPS replaces once. Verify cloud-init done, all services up.
- [ ] 12.4 Restore prod data: `rsync -aAX /tmp/prod-pre-migration-<date>/ deploy@workflow-engine.webredirect.org:/srv/wfe/prod/`. Verify ownership: must be `wfe-prod:wfe-prod` mode 0700 (`sudo chown -R wfe-prod:wfe-prod /srv/wfe/prod`).
- [ ] 12.5 Restore Caddy ACME state (`/srv/caddy/data` → `wfe-caddy:wfe-caddy` mode 0700). Skip if happy to let Caddy re-issue from scratch.
- [ ] 12.6 `systemctl restart wfe-prod.service caddy.service`. Verify prod healthz returns 200 and certs are valid (from restored or freshly-issued state).
- [ ] 12.7 Spot-check event-store integrity: trigger a known workflow and confirm new events append correctly to the restored persistence dir.

## 13. SECURITY.md updates

- [x] 13.1 §I9 mitigation paragraph rewritten to "Privilege isolation: deploy administers, per-tenant `wfe-*` run unprivileged"; the post-S1/I11 attacker landing pad framing now explicit. Old "Scoped NOPASSWD sudo" wording removed.
- [x] 13.2 R-I18 updated: per-tenant `wfe-*` users provide host-level filesystem isolation; kernel CVE crossing UID boundaries is the residual.
- [x] 13.3 Operator rule #8 rewritten: NEVER add sudoers for `wfe-*`; deploy's allowlist is broad by design; broadening requires a spec change.
- [x] 13.4 Asset table (lines 1753-1757) updated: Caddy → `wfe-caddy`, wfe-prod → `wfe-prod`, wfe-staging → `wfe-staging`.
- [x] 13.5 Mitigation list bullet for "Rootless Podman + per-Quadlet subuid mapping" rewritten to per-tenant unprivileged users with cross-tenant filesystem isolation.
- [x] 13.6 Additional cleanup: I9 threat row, R-I19, secret rotation procedure (#7), rule #4 (`local_file`/`local_sensitive_file` instead of stale `source =` claim), rule #9 step b, rule #11 (Quadlet authoring → `managed_files_*` map + dedicated `User=`).

## 14. CLAUDE.md / docs touch-up

- [x] 14.1 Updated `docs/infrastructure.md`: cloud-init.yaml line, secret-rotation paragraph, Apply infra section (no more `apply-infra.yml`-specific heredoc step, since that workflow doesn't exist), SSH access section (deploy administrative-only, per-tenant `wfe-*` users), sudo paragraph, secret-rotation step #3, SSH-key-rotation step #3 (now requires VPS replacement + rsync ritual). Added new sections: "Editing host config in place" (stage order, removal semantics, what triggers VPS replacement) and "Migration ritual: surviving a cloud-init edit" (rsync-and-restore protocol).
- [x] 14.2 No `User=deploy` references in `docs/dev-probes.md`.
- [x] 14.3 `CLAUDE.md` "Pre-merge infra plan gate" wording is unaffected — agents still don't run `tofu apply`; the operator does.

## 15. Design corrections discovered during implementation

These corrections to the original design were discovered during the staging apply iterations. Each is documented in design.md (D9–D14) and reflected in the spec deltas:

- [x] 15.1 **User-mode Quadlets, not `User=` directive.** Quadlet's `User=` sets the in-container UID (passed to `podman --user`), not the host process user. Original design said system-mode + `User=wfe-<env>`; that fails (no `wfe-prod` user inside the distroless image). Fix: place Quadlets at `/home/<user>/.config/containers/systemd/`, enable linger, run as the user via user-mode systemd. (D9)
- [x] 15.2 **Sudoers stays in cloud-init only, not in managed_files.** Race between `null_resource.managed_sudoers` create and the OLD `managed_file_pre["sudoers_deploy"]` destroy could leave the host with no NOPASSWD rules and no recovery path (no root password). Fix: remove `null_resource.managed_sudoers`; sudoers is bootstrap-only; allowlist edits require `tofu taint`. (D10)
- [x] 15.3 **`/etc/subuid` + `/etc/subgid` as managed_files, not via `usermod --add-subuids`.** `useradd` auto-allocates, `usermod --add-subuids` stacks on top. Each tenant ended up with two ranges; podman picks the first (auto-allocated). Fix: render `/etc/subuid` + `/etc/subgid` from `local.managed_users`, write atomically as managed_files entries. (D11)
- [x] 15.4 **Workaround for `systemctl --user enable` lifecycle quirk.** On freshly-lingered users, `enable` fails to create the wants/ symlink even though the unit is loaded. Fix: skip `enable`, manually create the symlink via `runuser ... ln -sf ...` then `start`. (D12)
- [x] 15.5 **`install -d /a/b/c` only sets ownership on `c`.** Parents `a`, `b` are created with default ownership (root, mode 0755). For per-tenant `~/.config/...` subtrees this leaves parent dirs root-owned, blocking the tenant from writing into them. Fix: enumerate every directory level as its own `managed_dir` entry. (D13)
- [x] 15.6 **`/etc/wfe` mode 0711, not 0700.** The original 0700 made tenants unable to traverse the directory to read their own env files via user-mode `EnvironmentFile=`. Fix: 0711 (deny listing for others, allow traversal); per-file `0600` ownership prevents cross-tenant secret reads. (Spec delta in host-security-baseline)
- [x] 15.7 **All managed entries are auto-clean; no PINNED.** Original design had PINNED opt-out for env files / Quadlets / subuid. Removed for uniformity — the convergence contract is "removing a declaration removes the artifact". Brief service interruption on edit-induced replace is acceptable for this single-VPS staging-grade deployment. (D14)
- [x] 15.8 **No root password by design; recovery via `tofu taint vps`.** Host has no root login. If the bootstrap minimum is somehow broken (e.g., a sudoers race), recovery is to taint the VPS and let cloud-init re-bake. Documented in design.md Risks; no operational impact at steady state.
- [x] 15.9 **Scaleway treats `user_data` as API-mutable.** Editing cloud-init updates the field on the existing instance but does NOT re-execute cloud-init (which runs only at first boot). To re-bake the bootstrap minimum: `tofu taint scaleway_instance_server.vps`. Documented explicitly in `docs/infrastructure.md` "Migration ritual".
