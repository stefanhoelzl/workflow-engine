## Context

The current `infrastructure/` project couples host configuration to VPS lifetime: any change to `cloud-init.yaml` flips a sha256 trigger that forces VPS replacement (`replace_triggered_by = [terraform_data.cloud_init]`). This is the only reliable way to re-bake host config because cloud-init runs only at first boot. The cost: routine edits to host config (sshd hardening, sudoers, fail2ban tuning, sysctl values, package list) destroy `/srv/wfe/<env>` data and `/srv/caddy/data` ACME state.

The current security posture concentrates risk on a single user: `deploy` is both the SSH/admin account AND the rootless container runtime. A successful sandbox break + container escape (S1 → I11, accepted as R-I18) lands the attacker on the same UID that already has scoped sudoers and is in `adm`/`systemd-journal`. The "scoped sudo" mitigation cited in `SECURITY.md` §I9 (line 1792) is partial defense-in-depth.

Stakeholder: single operator, single VPS (Scaleway STARDUST1-S, Debian 13 / Trixie), prod + staging colocated.

## Goals / Non-Goals

**Goals:**

- Edits to host configuration apply on the running VPS without destroying `/srv` data.
- Removal of a managed declaration removes the corresponding host artifact (auto-clean) — except for entries deliberately marked pinned (env files, production Quadlets) that must survive declaration removal.
- Per-tenant unprivileged users (`wfe-prod`, `wfe-staging`, `wfe-caddy`) become the rootless container runtime users; the post-sandbox-escape attacker lands as one of them and has no privilege on the host.
- `deploy` is administrative-only: SSH, sudo for converge primitives, journal access. Runs no workload.
- Adding a new tenant is a tofu-only operation (no cloud-init edit).
- `pnpm validate` passes; `tofu fmt -check` clean; smoke tests on a fresh staging VPS confirm the design end-to-end.

**Non-Goals:**

- **Drift detection.** The convergence mechanism does not detect or self-heal hand-edits made on the host between applies. Apply rewrites declared content from template, so drift self-heals on the next apply touching the entry.
- **Automatic package purge.** Removing a name from `managed_packages` does not `apt-get purge` the package. Apt state is shared with the host's own history; auto-purge would be hostile.
- **Multi-host fleet.** This design is scoped to one VPS. Patterns that earn their slot at N=1 are kept; patterns that only pay off at N>1 (centralized config, agent-based config management) are deferred.
- **Replacing tofu.** No move to Ansible, NixOS, Packer, or a custom Go provider. The implementation uses `hashicorp/null` provisioners only.
- **Eliminating cloud-init replacement entirely.** Cloud-init still triggers replacement when its content changes — but its content shrinks to the bootstrap minimum, which changes rarely (deploy user definition, sshd Port, ufw baseline).

## Decisions

### D1: Convergence mechanism is six typed maps + null_resource for_each

Six typed locals, each driving a `null_resource` resource with `for_each`:

```
managed_users      → wfe-prod, wfe-staging, wfe-caddy
managed_dirs       → /etc/wfe, /etc/caddy, /etc/containers/systemd, /srv/{wfe,caddy}/<...>
managed_packages   → apt list (podman, fail2ban, unattended-upgrades, curl, ca-certificates)
managed_files      → typed files with content; pre-stage and post-stage variants
managed_exec       → imperative one-shots (subuid, swapfile, service enables)
managed_ufw        → app-side firewall rules (80, 443)
```

Each entry carries a `triggers` map keyed by content/spec hash; null_resource replaces on hash flip → destroy provisioner of OLD instance runs, then create provisioner of NEW writes new content + on-change hook fires.

**Alternatives considered:**

- **Custom Go provider.** ~2–3 days to write and dev_overrides-deploy. Gives drift detection. Rejected: drift detection is a non-goal; one VPS doesn't justify a new dependency.
- **Adopt `neuspaces/system` provider.** Last push 2024-05, 43★, no `command` resource. Rejected: stale; gaps (no ufw, no sysctl, no swap) still need null_resource; uniform null_resource everywhere is simpler.
- **`loafoe/ssh` provider.** Active (2026-04). Imperative `ssh_resource` with `when_destroy`. Rejected: same model as null_resource, no extra capability for our shape.
- **Single bash bootstrap script over null_resource.** Smallest mechanism. Rejected: removing a declaration from the script does NOT auto-clean the host artifact (script is converge-forward-only). Cleanup-on-removal is a goal.
- **Ansible / pyinfra invoked from tofu.** Defensible at N>1 hosts. Rejected at N=1.

### D2: Two privileged-user classes, with per-tenant runtime users

- `deploy` — SSH+sudo+admin. Sole user in `AllowUsers`. Broad NOPASSWD sudoers (the converge primitives). Member of `adm`, `systemd-journal`. Runs no workload.
- `wfe-prod`, `wfe-staging`, `wfe-caddy` — rootless container runtime, one per tenant. `nologin` shell, no SSH key, no sudoers, in no privileged groups, each with its own non-overlapping subuid range.

Quadlets specify `User=wfe-<tenant>`. `/srv/wfe/<env>` and `/srv/caddy/{data,config}` are owned by the corresponding `wfe-*` user (mode 0700 for data dirs).

**Why three runtime users instead of one shared `wfe`:** shared single user means cross-tenant filesystem reads at host level — a wfe-prod container escape would read `/srv/wfe/staging` and ACME private keys in `/srv/caddy/data`. With per-tenant users + 0700 mode dirs, escape from one tenant cannot read another tenant's data without an additional kernel-CVE crossing the UID boundary. R-I18 in `SECURITY.md` is upgraded from "kernel-only isolation" to "kernel + UID-account isolation".

**Why deploy stays in cloud-init:** chicken-and-egg. tofu cannot SSH in to create deploy until deploy exists. `wfe-*` users do NOT have this constraint and live in `managed_users`.

**Sudoers split rationale:** `deploy`'s broad sudoers is safe because the post-S1/I11 attacker lands as `wfe-*`, not `deploy`. `wfe-*` cannot SSH (not in `AllowUsers`), cannot sudo (no sudoers entry), cannot pivot to deploy (deploy's password is locked, ~/.ssh is mode 0700, Quadlet smuggling targets only run as wfe-*). The trust boundary that protects deploy is the SSH-key boundary (deploy's private key lives off-host, on the operator's laptop / in tofu state).

**Alternatives considered:**

- **Single `wfe` user shared across tenants.** Rejected: maintains R-I18's "kernel-only" isolation; doesn't earn the security improvement that this rewrite is taking on anyway.
- **Wrapper script `/usr/local/bin/wfe-converge` with regex allowlist.** ~80 lines bash, sudoers reduces to one line. Rejected: per-tenant user split solves the same problem with Linux primitives instead of a custom binary.
- **Two SSH users (`deploy` + `provisioner`).** Rejected: user explicitly requested one SSH user.

### D3: Stage ordering

Convergence runs in 6 stages, expressed via `depends_on` between the per-stage null_resources:

```
1. users      (wfe-prod, wfe-staging, wfe-caddy)
2. dirs       (chowns require users to exist)
3. packages   (apt install)
4. files_pre  (sshd hardening, sudoers, fail2ban jail, sysctl, timer override, env files, Caddyfile)
5. exec       (subuid range, swapfile, service enables)
6. ufw        (80/443 rules)
7. files_post (Quadlets — wfe-prod/staging/caddy.container; their on-change daemon-reload + restart)
```

Tofu destroys in reverse order, which is exactly what we want for tenant removal: Quadlet stops first, then dirs, then user. If the operator removes a `managed_users` entry without also removing its Quadlet, `userdel` fails (process running) and apply errors out — fail-loud beats silent corruption.

### D4: Removal semantics: auto-clean (default) vs pinned (opt-in)

Each `managed_files` entry declares an `on_destroy` command:

- **Auto-clean** (default): `on_destroy = "sudo rm -f $path && <reload>"`. Removing the entry from source removes the file from host on next apply.
- **Pinned**: `on_destroy = ""`. Removing the entry from source leaves the host artifact in place. Used for: per-env secret env files (`/etc/wfe/<env>.env`), Quadlets running production traffic. Justification: removing these mid-flight kills running services; explicit teardown (manual rm + systemctl stop) is appropriate.

The `tasks.md` migration bullets list every entry's policy choice; reviewers see the decisions explicitly.

### D5: `null_resource` replace runs old destroy, then new create

When triggers change, tofu replaces the null_resource: old instance's destroy provisioner runs, then new instance's create. Practical implication: `on_destroy` must be safe to run on every content change, not only on true removal. Pattern:

- `on_destroy` removes the file (`sudo rm -f $path`).
- `on_create` writes the new content + runs the on-change hook.

End state after a content change: file written with new content, hook fired. Brief window where file is absent — fine for sshd drop-ins (sshd reads only on reload), sysctl.d (sysctl --system runs after), fail2ban jail (restart fail2ban runs after), Quadlets (daemon-reload + restart runs after).

### D6: Sudoers expansion: explicit allowlist of converge primitives

`deploy`'s `/etc/sudoers.d/deploy` (written by cloud-init) lists each verb explicitly:

```
deploy ALL=(root) NOPASSWD: /usr/bin/install
deploy ALL=(root) NOPASSWD: /usr/bin/tee
deploy ALL=(root) NOPASSWD: /usr/bin/rm
deploy ALL=(root) NOPASSWD: /usr/bin/chmod
deploy ALL=(root) NOPASSWD: /usr/bin/chown
deploy ALL=(root) NOPASSWD: /bin/systemctl
deploy ALL=(root) NOPASSWD: /usr/sbin/usermod
deploy ALL=(root) NOPASSWD: /usr/sbin/useradd
deploy ALL=(root) NOPASSWD: /usr/sbin/userdel
deploy ALL=(root) NOPASSWD: /usr/sbin/ufw
deploy ALL=(root) NOPASSWD: /usr/bin/apt-get
deploy ALL=(root) NOPASSWD: /usr/bin/sysctl
deploy ALL=(root) NOPASSWD: /usr/sbin/swapon
deploy ALL=(root) NOPASSWD: /usr/sbin/swapoff
deploy ALL=(root) NOPASSWD: /usr/bin/fallocate
deploy ALL=(root) NOPASSWD: /usr/sbin/mkswap
```

The list is the **maximum** privilege envelope. Adding a new converge primitive (e.g., `crontab` later) requires a spec change — friction-by-design. Implicit deny applies: any verb not on the list still requires the root password, which is locked.

### D7: Cloud-init bootstrap minimum

Cloud-init runs at first boot only and contains:

- `users:` block: deploy with operator's SSH key, lock_passwd, groups `[adm, systemd-journal]`, shell `/bin/bash`. (No `wfe-*` users — those land in `managed_users`.)
- `packages:` `[ufw, sudo]` (apt install only what cloud-init itself needs).
- `write_files:` deploy's sudoers; an sshd_config.d drop-in declaring `Port`, `AllowUsers deploy`, `PermitRootLogin no`, `PasswordAuthentication no`.
- `runcmd:` `systemctl restart ssh`, `sed` setting `DEFAULT_FORWARD_POLICY=ACCEPT` in `/etc/default/ufw`, ufw default deny incoming + default allow outgoing/routed + allow ssh_port + enable.

Cloud-init does NOT include: sysctl drop-in, podman-auto-update timer override, dirs under /srv, swapfile, subuid, fail2ban jail content, package list beyond ufw+sudo, app-side ufw rules, service enables for fail2ban/unattended-upgrades/podman-auto-update.timer.

### D8: Subuid ranges are explicit and stable

Each `managed_users` entry declares its subuid range as a literal string (`"100000-165535"`, `"165536-231071"`, `"231072-296607"`). Auto-allocation is rejected: alphabetical-order shifts when users are added/removed would corrupt existing on-disk file ownership.

A `precondition` in the `null_resource` validates that ranges don't overlap — apply fails at plan time if two entries collide.

### D9: User-mode Quadlets per tenant (with linger)

Each `wfe-*` user has `loginctl enable-linger` set so its user-mode systemd starts at host boot. Quadlets live at `/home/<user>/.config/containers/systemd/<unit>.container` (NOT `/etc/containers/systemd/`) and are picked up by the user-mode Quadlet generator. Podman runs rootless under the tenant user — that is what makes container escape land the attacker on the unprivileged tenant user, not on root.

The Quadlet's `User=` directive is NOT used. `User=` in Quadlet sets the IN-CONTAINER UID (passed to `podman --user`); it does not change which host user runs the container. Setting `User=wfe-<env>` would make Podman attempt to look up `wfe-<env>` inside the container's image (which doesn't exist) and fail. Host-level rootless requires user-mode Quadlets, full stop.

**Cross-user systemctl operations** from `deploy` are done via `sudo /usr/sbin/runuser -u <user> -- env XDG_RUNTIME_DIR=/run/user/$(id -u <user>) /bin/systemctl --user <verb> <unit>`. `runuser` requires a sudoers entry; XDG_RUNTIME_DIR is needed for systemctl --user to find the user session bus.

**Alternatives considered:**
- **System-mode Quadlets with `User=wfe-<env>`** — initial design. Doesn't deliver the security claim (Podman still runs as root on host) and the `User=` directive sets in-container UID, not host process UID. Rejected.
- **System-mode Quadlets with `--userns=keep-id`** — keeps in-container UID mapped to host UID via user namespace. Doesn't change WHO runs Podman. Rejected.
- **Adopt Podman quadlet user-mode generator with `--user` invocation** — exactly what we do. The `loginctl enable-linger` setup is the canonical Podman rootless deployment pattern.

### D10: Sudoers ownership stays in cloud-init, not the convergence mechanism

`/etc/sudoers.d/deploy` is written ONLY by cloud-init at first boot. It is NOT a `managed_files_host` entry. Editing the sudoers list triggers VPS re-bake (operator runs `tofu taint scaleway_instance_server.vps`).

**Why not in-place management:** an earlier iteration of this design managed sudoers via `null_resource.managed_sudoers` and `managed_files_host["sudoers_deploy"]`. Both versions hit a fatal lifecycle race:
- The old `managed_files_host["sudoers_deploy"]` destroy provisioner (when the entry was removed/re-keyed) ran `sudo rm -f /etc/sudoers.d/deploy` BEFORE the new `managed_sudoers` create provisioner had written the new file.
- Result: `/etc/sudoers.d/deploy` momentarily disappeared. Subsequent tofu operations needed `sudo install` etc. — all blocked because deploy had no NOPASSWD rules.
- Recovery would require root password to manually rewrite the file. **No root password is set by design** — the operator's recovery path is `tofu taint vps` + cloud-init re-bake.

The race is hard to eliminate while sudoers is in the convergence mechanism. Moving sudoers ownership to cloud-init eliminates the risk: cloud-init writes sudoers at first boot; the file lives unchanged across applies; tofu never deletes it.

**Trade-off**: editing the sudoers allowlist requires VPS replacement (rare event — adding a new converge primitive is ~once a year). Same as the original PINNED-and-aspirationally-managed approach but with the destructive race designed out.

### D11: `/etc/subuid` + `/etc/subgid` are managed_files, not via `usermod --add-subuids`

The original design used `usermod --add-subuids RANGE` in the `managed_user` create script to allocate the explicit range. This is broken: `useradd` auto-allocates a subuid range when creating a new user (per `/etc/login.defs` `SUB_UID_COUNT`), and `usermod --add-subuids` APPENDS rather than replaces. Each tenant ended up with TWO ranges in `/etc/subuid`:

```
wfe-prod:231072:65536      ← auto-allocated by useradd (collides with wfe-caddy intended)
wfe-prod:100000:65536      ← explicit, added by usermod
```

Podman uses the FIRST range listed for the user, which is the auto-allocated one — defeating the explicit-stable-range guarantee.

The fix: `/etc/subuid` and `/etc/subgid` are managed_files entries rendered from `local.managed_users`. Tofu writes the files atomically with deterministic content (sorted by user name), overwriting whatever `useradd` auto-allocated. The `usermod --add-subuids` line is removed from `managed_user`'s create script.

### D12: Workaround for `systemctl --user enable` on freshly-lingered users

`systemctl --user enable --now <unit>` fails with `Failed to enable unit: Unit /home/<user>/.config/systemd/user/timers.target.wants/<unit> does not exist` on a user whose linger was JUST enabled. The `--now` (start) part works; the `enable` (persistent symlink creation) fails cosmetically but consistently.

Workaround: skip `systemctl --user enable`. Manually create the wants/ symlink (which is exactly what `enable` would do) plus daemon-reload + start:

```bash
sudo runuser -u <user> -- /usr/bin/mkdir -p /home/<user>/.config/systemd/user/timers.target.wants
sudo runuser -u <user> -- /usr/bin/ln -sf /usr/lib/systemd/user/podman-auto-update.timer /home/<user>/.config/systemd/user/timers.target.wants/podman-auto-update.timer
sudo runuser -u <user> -- env XDG_RUNTIME_DIR=/run/user/$(id -u <user>) /bin/systemctl --user daemon-reload
sudo runuser -u <user> -- env XDG_RUNTIME_DIR=/run/user/$(id -u <user>) /bin/systemctl --user start podman-auto-update.timer
```

The wants/ dir itself is also a `managed_dir` entry (so its ownership is correct and `install -d` is idempotent across re-applies).

### D13: `install -d /a/b/c` enumerates parent directories explicitly

`install -d -m 0755 -o <user> /a/b/c` only sets ownership/mode on `c`; parents `a`, `b` are created with default ownership (root, mode 0755). For per-tenant `~/.config/...` subtrees this leaves the parent dirs root-owned, blocking the tenant from writing into them.

The fix: every directory level is enumerated as its own `managed_dir` entry. `install -d` updates ownership/mode on existing dirs (verified via coreutils source), so listing each level is both correct and idempotent.

### D14: Auto-clean for ALL managed entries, no PINNED exception

The original design had a `PINNED` opt-out (`on_destroy = ""`) for entries representing live runtime state — env files, Quadlets, subuid/subgid. Removed.

**Rationale**: the convergence contract is "removing a declaration removes the host artifact". Carving out exceptions creates two operator mental models (auto-clean, pinned) where one would do. The brief service interruption on edit-induced replace (destroy stops + removes; create writes + restarts) is acceptable for a single-VPS staging-grade deployment. Intentional teardown of a tenant requires removing the user, dirs, env file, AND Quadlet in the same apply — tofu's reverse-dependency destroy order ensures the Quadlet stops before the user is removed (fail-loud if the operator forgets a piece).

## Risks / Trade-offs

- **Cloud-init re-bake destroys local SSD root data.** Editing the cloud-init bootstrap minimum (deploy SSH key, sshd port, sudoers list, FORWARD policy) requires `tofu taint scaleway_instance_server.vps` to actually re-execute cloud-init on a fresh VPS. This wipes the local SSD root — `/srv/wfe/<env>` and `/srv/caddy/data` are lost. → Mitigation: operator runs the rsync-and-restore ritual documented in `docs/infrastructure.md` before applying; the VPS IP is preserved (separate `scaleway_instance_ip` resource), so DNS/CNAMEs don't need updating.

- **Scaleway treats `user_data` as API-mutable.** Editing cloud-init's content updates the user_data field on the instance via API but does NOT trigger replacement automatically and does NOT re-execute cloud-init. The change is effectively no-op until the operator taints. → Mitigation: explicitly documented in `docs/infrastructure.md` "Migration ritual" section; operator runbook makes this expectation clear.

- **Drift goes undetected.** Hand-edits on the host (e.g., emergency `sudoedit /etc/ssh/sshd_config.d/...`) are not detected by tofu plan. → Mitigation: convention is "any host edit must be mirrored in source"; subsequent apply that touches the entry rewrites declared content; threat is low at one operator with one shell user (deploy).

- **`null_resource` replace = destroy-then-create.** Brief gap during content change where the file is absent before being rewritten. For Quadlet/env-file entries this manifests as a brief service interruption (destroy stops + removes file; create writes + restarts via on_change). → Mitigation: ordering is safe for our entries (services don't continuously read drop-ins; reload/restart happens after re-create). The interruption is sub-second to a few seconds for the wfe-* tenants; staging-grade workload tolerates.

- **Sudoers expansion is broad.** `deploy` is effectively root via `sudo install` / `sudo tee`. → Mitigation: deploy is no longer the post-S1/I11 attacker landing pad (D2). With user-mode rootless Podman + per-tenant subuid ranges (D9, D11), container escape lands the attacker on the unprivileged `wfe-<env>` user, not on a UID with sudoers access. The privilege envelope is reachable only via off-host SSH key.

- **Cross-tenant isolation upgrade.** With user-mode Quadlets the cross-tenant filesystem-isolation property in R-I18 is now ACTUALLY delivered (per-tenant subuid ranges + 0700 data dirs + per-tenant host UID). A kernel CVE crossing UID boundaries (rare but real) is the residual. → Mitigation: unattended-upgrades + R-I18 in SECURITY.md acknowledging the residual.

- **Adding a converge primitive requires a sudoers edit AND VPS re-bake.** Sudoers ownership is in cloud-init (D10), so adding a new sudo verb is not in-place — requires `tofu taint`. Friction is intentional. → Mitigation: the typed-map shape covers ~all routine host-config concerns; new primitives are uncommon (estimated <1/year).

- **No root password by design.** The host has no root login path. If sudoers is somehow corrupted (race during apply, manual mistake), the recovery path is `tofu taint vps` + cloud-init re-bake — there is no in-place sudo recovery. → Mitigation: D10's design eliminates the convergence-mechanism race; sudoers is bootstrap-only and never deleted by tofu. Cloud-init writes the file at first boot, and it lives unchanged thereafter.

- **`systemctl --user enable` lifecycle quirk on freshly-lingered users.** Documented in D12. The wants/ symlink workaround eliminates the issue.

- **Operator UX shift for cross-user systemctl.** `systemctl status wfe-prod` (system-mode lookup) no longer finds the unit. Operator runs `sudo runuser -u wfe-prod -- env XDG_RUNTIME_DIR=/run/user/$(id -u wfe-prod) /bin/systemctl --user status wfe-prod.service`. Logs via `journalctl --user-unit wfe-prod` (or `journalctl _UID=$(id -u wfe-prod)`) — deploy's `adm`/`systemd-journal` group memberships still grant journal-read access. → Mitigation: documented in `docs/infrastructure.md`; could be wrapped in helper scripts later if friction becomes painful.

## Migration Plan

1. **Prep**: on the operator's laptop, `rsync -aAX deploy@prod:/srv/wfe/prod /tmp/prod-backup-<date>` (and same for staging if staging data matters).
2. **Land the change on a feature branch**. PR review covers: cloud-init shrink, new `managed_*` maps, `apps.tf`/`caddy.tf` rewritten in terms of `managed_files`, removal of `replace_triggered_by`, smoke-test bullets.
3. **Apply against staging first** (`tofu -chdir=infrastructure apply` with the staging tfvars). Expected plan: VPS replaced once (cloud-init content changed), then in-place changes for everything else. After apply: data dirs are empty (acceptable on staging), services come up clean.
4. **Verify staging smoke tests** (see `tasks.md`). Iterate on fixes if anything breaks.
5. **Migrate prod**: rsync-backup-and-restore protocol. Apply. Restore data. Verify.
6. **Steady state**: subsequent edits to host config no longer replace the VPS.

**Rollback**: revert the PR. Re-apply. The revert restores the old `replace_triggered_by` and the bigger cloud-init, replacing the VPS one more time. Data backup-and-restore protocol applies.

## Open Questions

(none currently open — all design decisions resolved during the explore phase)
