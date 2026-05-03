## ADDED Requirements

### Requirement: Privilege isolation: deploy administers; per-tenant wfe-* run unprivileged

The host SHALL maintain two distinct privileged-user classes with non-overlapping responsibilities:

- **`deploy`** — interactive operator and tofu-provisioner account. Sole user listed in sshd's `AllowUsers`. Has a NOPASSWD sudoers allowlist scoped to AT MOST the converge primitives needed to apply host configuration: `install`, `tee`, `rm`, `chmod`, `chown`, `systemctl`, `loginctl`, `runuser`, `usermod`, `useradd`, `userdel`, `ufw`, `apt-get`, `sysctl`, `swapon`/`swapoff`, `fallocate`, `mkswap`. Belongs to `adm` and `systemd-journal` for journal-read access without sudo. Runs no workload. The sudoers file (`/etc/sudoers.d/deploy`) is owned EXCLUSIVELY by cloud-init — the convergence mechanism does NOT manage it. Editing the allowlist requires `tofu taint scaleway_instance_server.vps` to re-bake the bootstrap minimum.

- **`wfe-prod`, `wfe-staging`, `wfe-caddy`** — rootless container runtime, one per Quadlet tenant. Each has its own non-overlapping subuid range listed in `/etc/subuid` and `/etc/subgid` (rendered from the managed-users declaration as managed_files entries). Each has `loginctl enable-linger` set, so its user-mode systemd starts at host boot. Each tenant's Quadlet runs as a **user-mode** systemd unit at `/home/<user>/.config/containers/systemd/<unit>.container`. Podman runs rootless under that tenant user. NONE of these users have SSH access (not in `AllowUsers`, no key, `nologin` shell). NONE have sudoers entries. NONE belong to privileged groups. The Quadlet's `User=` directive is NOT used for this purpose — that directive sets the in-container UID and would not change host-side process ownership.

The trust boundary between `deploy` and the `wfe-*` users is the Linux user-account boundary: `wfe-*` cannot become `deploy` (no su path; `deploy`'s password is locked, `~/.ssh` is mode 0700 owned by deploy; no sudoers entry for wfe-*; no Quadlet smuggling path because every Quadlet runs as a `wfe-*` user, not as deploy). The trust boundary that protects `deploy`'s broad privilege from a host-side attacker is the SSH-key boundary: deploy's private key lives off-host (operator's secret store, tofu state encrypted at rest), so a post-S1/I11 attacker landed on the host as `wfe-*` cannot impersonate deploy.

Adding a verb to deploy's sudoers SHALL require updating this requirement (friction-by-design, so the privilege envelope is reviewable and changes are explicit).

**Rationale**: Today's "scoped sudoers" requirement narrowed deploy's verbs but kept deploy as both the SSH user and the container runtime, so an attacker reaching deploy via S1/I11 already had access to deploy's allowlist (and to Quadlet smuggling for full root). Splitting the runtime off entirely makes the post-S1/I11 landing pad an unprivileged account, so deploy's allowlist no longer matters to the post-escape attacker — they cannot reach deploy without an off-host SSH key.

#### Scenario: wfe-* cannot SSH in

- **WHEN** sshd receives a connection attempt for user `wfe-prod`, `wfe-staging`, or `wfe-caddy`
- **THEN** the connection SHALL be rejected (user not in `AllowUsers`)

#### Scenario: wfe-* cannot sudo

- **GIVEN** a process running as one of the `wfe-*` users (e.g., from a container escape)
- **WHEN** it attempts `sudo <anything>`
- **THEN** sudo SHALL fail — there is no `/etc/sudoers.d/wfe-*` entry and `wfe-*` belongs to no sudoers-granting group

#### Scenario: wfe-* cannot pivot to deploy

- **GIVEN** a process running as one of the `wfe-*` users
- **WHEN** it attempts `su - deploy` or any escalation primitive
- **THEN** `su` SHALL fail (deploy's password is locked)
- **AND** deploy's `~/.ssh` SHALL not be readable by `wfe-*` (mode 0700 owned by deploy)
- **AND** there SHALL be no Quadlet smuggling path that yields deploy privilege (Quadlets all run as `wfe-*`)

#### Scenario: deploy's broad sudoers is reachable only via off-host SSH key

- **GIVEN** an attacker has on-host shell as one of the `wfe-*` users (via S1 → I11)
- **WHEN** they attempt to use deploy's privileges
- **THEN** they SHALL NOT be able to SSH as deploy from the host (deploy's private key is not on the host)
- **AND** they SHALL NOT be able to read or write deploy's home or `~/.ssh`
- **AND** they SHALL NOT be able to write to `/etc/sudoers.d/` (deploy-broad sudoers does not extend to wfe-*)

#### Scenario: Cross-tenant filesystem isolation

- **GIVEN** an attacker has on-host shell as `wfe-prod` (e.g., via S1 → I11 from the prod container)
- **WHEN** they attempt to read `/srv/wfe/staging/` or `/srv/caddy/data/`
- **THEN** the read SHALL fail — those directories are mode 0700 owned by `wfe-staging` and `wfe-caddy` respectively, and the attacker's UID has no read permission

## MODIFIED Requirements

### Requirement: Rootless Podman with subuid mapping

All long-running workloads (Caddy + every app instance) SHALL run as rootless Podman containers under a per-tenant unprivileged user (`wfe-prod` for the prod app, `wfe-staging` for the staging app, `wfe-caddy` for Caddy), each with its own non-overlapping subuid range listed in `/etc/subuid` and `/etc/subgid` (each at least 65536 ids). NONE of these users SHALL be a member of `wheel`, `sudo`, `docker`, `adm`, or `systemd-journal`. The `deploy` user SHALL NOT run any workload.

Each tenant's Quadlet SHALL run as a **user-mode** systemd unit (placed under `/home/<user>/.config/containers/systemd/`); the system-mode path `/etc/containers/systemd/` SHALL NOT be used for Podman containers. Each `wfe-*` user SHALL have `loginctl enable-linger` set so its user-mode systemd starts at host boot.

The subuid ranges SHALL be declared explicitly per managed-user entry and SHALL be stable across applies — auto-allocation is forbidden because alphabetical-order shifts when users are added or removed would invalidate existing on-disk subuid-mapped file ownership. Range overlaps between two managed users SHALL fail at plan time. The `/etc/subuid` and `/etc/subgid` files SHALL be managed via the convergence mechanism's `managed_files` entries (not via `usermod --add-subuids`), because `useradd` auto-allocates ranges that stack on top of explicit `usermod` ranges and break the cross-tenant isolation guarantee.

#### Scenario: Containers run as unprivileged per-tenant users on the host

- **GIVEN** the VPS has been provisioned and Quadlet units have started
- **WHEN** an operator runs `ps -eo user,comm | grep -E 'caddy|node'`
- **THEN** Caddy's process SHALL show `wfe-caddy` (or its mapped subuid) as its user
- **AND** the `wfe-prod` app's process SHALL show `wfe-prod` (or its mapped subuid)
- **AND** the `wfe-staging` app's process SHALL show `wfe-staging` (or its mapped subuid)
- **AND** no workload process SHALL show `root` or `deploy`

#### Scenario: Subuid ranges are allocated per-tenant and do not overlap

- **GIVEN** the in-place convergence mechanism has applied the managed-users entries
- **WHEN** the operator inspects `/etc/subuid`
- **THEN** entries SHALL exist for `wfe-prod`, `wfe-staging`, and `wfe-caddy`
- **AND** each entry's range SHALL be at least 65536 ids
- **AND** no two ranges SHALL overlap

### Requirement: Caddyfile and env-file directory layout

`/etc/caddy/` SHALL be created via the convergence mechanism with owner `deploy:deploy`, mode `0755` (Caddy reads `/etc/caddy/Caddyfile` via a read-only bind mount; world-readable mode is required so the wfe-caddy user-mode systemd can stat the dir for the bind mount to succeed).

`/etc/wfe/` SHALL be created with owner `deploy:deploy`, mode **`0711`** (NOT 0700). The `0711` mode (rwx--x--x) gives the directory's owner full access, denies others the ability to list directory contents, but allows others to TRAVERSE into the directory and `open()` named files within. This is required because each `wfe-<env>` user-mode systemd needs to read its own `/etc/wfe/<env>.env` via `EnvironmentFile=`. Per-file ownership (`0600` owned by `wfe-<env>:wfe-<env>`) prevents cross-tenant reads of the secret content.

Quadlet definitions live under each tenant's `/home/<user>/.config/containers/systemd/` (user-mode), NOT under `/etc/containers/systemd/`. The system-mode Quadlet directory is no longer used.

The data dirs `/srv/wfe/<env>` and `/srv/caddy/{data,config}` SHALL be owned by their corresponding `wfe-*` user (mode 0700), NOT by deploy. A deploy compromise does not directly grant access to runtime data and ACME secrets — a host-side attacker would need to additionally pivot to the tenant user (no path exists; deploy's sudoers does not include `runuser` against tenant users for SHELL purposes — only systemctl-via-runuser is allowed by the converge primitives).

Rationale for /etc/wfe mode 0711: tenants must traverse to read their own env file via `EnvironmentFile=`, but the directory listing itself is sensitive (filenames imply tenant identities). `0711` allows traversal without listing — the cross-tenant tenant cannot enumerate the dir to discover other tenants' env-file paths.

#### Scenario: /etc/wfe traversal allowed but listing denied

- **WHEN** a process running as `wfe-prod` attempts `ls /etc/wfe/`
- **THEN** the listing SHALL be denied (mode 0711 denies others-read on the directory itself)
- **AND** the same process SHALL succeed `cat /etc/wfe/prod.env` (it knows the filename and `0711` permits traversal; the file's `0600` mode + matching ownership grants read)
- **AND** the same process SHALL fail `cat /etc/wfe/staging.env` (the file's `0600` mode + non-matching ownership denies read)

#### Scenario: Data dirs are tenant-owned, not deploy-owned

- **WHEN** the operator inspects `/srv/wfe/prod`, `/srv/wfe/staging`, `/srv/caddy/data`
- **THEN** each SHALL be owned by the corresponding `wfe-<tenant>` user, not by `deploy`
- **AND** mode SHALL be `0700`

## REMOVED Requirements

### Requirement: Scoped NOPASSWD sudo for the deploy user

**Reason**: The scoped-sudo posture was load-bearing only because `deploy` was both the SSH/admin user AND the rootless container runtime — narrowing deploy's allowlist limited the blast radius of a sandbox/container escape (S1 → I11) that landed on deploy. With the new privilege-isolation split (per-tenant `wfe-*` users run all workloads; `deploy` is administrative-only), the post-S1/I11 attacker lands on `wfe-*`, which has no privilege at all. The defense-in-depth role of scoped sudoers is now provided by the user-account boundary itself: an unprivileged attacker cannot reach deploy without an off-host SSH key.

**Migration**: Replaced by "Privilege isolation: deploy administers; per-tenant wfe-* run unprivileged" (added above). The new requirement enumerates the broader allowlist deploy needs to apply host configuration AND specifies the trust boundary (SSH-key isolation, no su path, no Quadlet smuggling) that justifies the broader allowlist. Operator rule #8 in `SECURITY.md` (line 1843) is updated to read "NEVER add sudoers entries for wfe-*; deploy's allowlist is broad by design and may be extended only via a spec change".
