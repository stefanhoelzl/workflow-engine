## MODIFIED Requirements

### Requirement: Single Scaleway VPS

The project SHALL provision exactly one `scaleway_instance_server` resource of type `STARDUST1-S` (or larger; configurable via a variable). The image SHALL be Debian 13 (Trixie) — Debian 12 (Bookworm) ships Podman 4.3.1 which lacks Quadlet (introduced in 4.4); Trixie ships Podman 5.x with Quadlet. A `scaleway_instance_ip` SHALL be attached so the public IP survives stop/start cycles. The root volume SHALL be declared explicitly with `size_in_gb`, `volume_type` (local SSD, `l_ssd`), and `delete_on_termination` to avoid `(known after apply)` plan opacity.

The instance SHALL additionally attach two persistent Block Storage volumes (one per app env) via `additional_volume_ids`, each declared as a separate `scaleway_block_volume` resource (see *Per-env persistence on dedicated block volumes*). Because these are standalone resources, attaching them is an in-place `additional_volume_ids` update (a server stop/start), NOT a VPS replacement, and the root volume's `size_in_gb`/`volume_type` SHALL be left unchanged by this attachment. Editing the root volume's local-SSD `size_in_gb` (which forces instance recreation) is NOT part of attaching the data volumes.

#### Scenario: Single VPS exists after apply

- **WHEN** `tofu apply` completes successfully
- **THEN** exactly one Scaleway instance SHALL be running with the configured commercial type and image
- **AND** the instance's image SHALL be `debian_trixie` (or a label that ships Podman ≥ 4.4)
- **AND** the instance SHALL have exactly two Block Storage volumes attached via `additional_volume_ids` (the per-env data volumes)

#### Scenario: Attaching the data volumes does not replace the VPS

- **GIVEN** an existing provisioned VPS with the data volumes not yet attached
- **WHEN** the two `scaleway_block_volume` resources are added to `additional_volume_ids` and `tofu apply` runs
- **THEN** the plan SHALL NOT show `scaleway_instance_server.vps` being replaced
- **AND** the plan MAY show the server stopping/starting to perform the attach
- **AND** the root volume SHALL retain its existing `size_in_gb` and `volume_type`

### Requirement: Local-disk persistence per env

Each app SHALL run with `PERSISTENCE_PATH=/data` (via Quadlet `Environment=`) and a host bind mount at `/srv/wfe/<env>:/data:Z,U`. The `:U` flag is required: it makes Podman recursively chown the bind-mount source to the container's UID 65532 (mapped through the tenant's subuid range) at start time, otherwise the container process can't write to a source initially owned by `deploy`/`root`.

Each `/srv/wfe/<env>` path SHALL be the **mount point of that env's dedicated Block Storage volume** (see *Per-env persistence on dedicated block volumes*), not a plain subdirectory of the root filesystem. The two envs SHALL NOT share a persistence directory and SHALL NOT share a device. The Quadlet bind-mount line (`Volume=/srv/wfe/<env>:/data:Z,U`) is unchanged by this — the app/container layer is oblivious to whether the path is a directory or a mount point. The S3 backend env vars (`PERSISTENCE_S3_*`) SHALL NOT be set on this deployment.

#### Scenario: Per-env data lives on separate mounted devices

- **GIVEN** the VPS has been provisioned and the data volumes attached
- **WHEN** the operator inspects `/srv/wfe/` and the mount table
- **THEN** `prod/` and `staging/` SHALL each be a mount point backed by a distinct Block Storage volume
- **AND** no two envs SHALL resolve to the same backing device
- **AND** after the env's container has started, the mounted filesystem's contents SHALL be owned by the tenant's mapped UID (in-container UID 65532, chowned by Podman's `:U` option)

### Requirement: Cloud-init bootstraps the box

The Scaleway server SHALL receive a cloud-init `user_data` payload limited to the first-boot operations required for tofu to SSH in and apply the in-place convergence mechanism. Specifically, cloud-init SHALL:

- Create the `deploy` user (operator/admin) with the operator's authorized SSH key from `var.deploy_ssh_public_key`. Lock its password. Place it in groups `adm` and `systemd-journal` so the operator can run `journalctl -u <unit>` without sudo.
- Write `/etc/sudoers.d/deploy` granting `deploy` NOPASSWD access to the converge primitives enumerated in `host-security-baseline` §"Privilege isolation: deploy administers; per-tenant wfe-* run unprivileged". This file is owned EXCLUSIVELY by cloud-init — the convergence mechanism does NOT manage it (see the archived change `host-config-converge-in-place` design.md D10 for the destroy/create race rationale). Editing the sudoers list automatically triggers VPS replacement via the `terraform_data.cloud_init_bootstrap` content hash + `replace_triggered_by` lifecycle rule.
- Configure sshd via a drop-in to listen on the configured non-default port, restrict `AllowUsers` to `deploy` only, disable root login, disable password and keyboard-interactive auth, set `MaxAuthTries 3`, set `LoginGraceTime 20s`, and require key-based auth. Restart sshd.
- Install the apt packages required by cloud-init itself (`ufw`, `sudo`).
- Set `DEFAULT_FORWARD_POLICY=ACCEPT` in `/etc/default/ufw` so that rootless container egress (DNS, image pulls, ACME) traverses the Podman bridge.
- Enable ufw with `default deny incoming`, `default allow outgoing`, `default allow routed`, and ONLY the configured SSH port allowed inbound. App-side rules (80, 443) are added by the convergence mechanism (see `managed_ufw`).

Cloud-init SHALL NOT include any operation outside the bootstrap minimum above. Specifically, cloud-init SHALL NOT install application packages (`podman`, `fail2ban`, `unattended-upgrades`, `curl`, `ca-certificates`), write hardening drop-ins beyond the bootstrap sshd config, write fail2ban jails, write sysctl drop-ins, write podman-auto-update timer overrides, allocate subuid ranges (those come from managed_files for /etc/subuid + /etc/subgid), create directories under `/srv` or `/etc/wfe` or `/etc/caddy`, provision the swapfile, enable `fail2ban.service` / `unattended-upgrades.service`, or create the `wfe-*` container-runtime users. All of those SHALL be applied via the convergence mechanism.

The Scaleway provider treats `user_data` as API-mutable; without an explicit replace trigger, edits to the cloud-init template would update the metadata field on the existing instance without re-executing cloud-init (which runs only at first boot). The project SHALL therefore declare `resource "terraform_data" "cloud_init_bootstrap"` with `input = sha256(<rendered cloud-init content>)`, and `scaleway_instance_server.vps` SHALL declare `lifecycle { replace_triggered_by = [terraform_data.cloud_init_bootstrap] }`. Edits to bootstrap-minimum content (deploy SSH key, sshd hardening, sudoers, ssh_port, FORWARD policy) flip the hash → tofu plans a `-/+ destroy and then create replacement`. VPS replacement SHALL otherwise be triggered ONLY by changes to the underlying Scaleway resource shape (instance type, image, root volume).

Per-env persistence lives on detachable Block Storage volumes (see *Per-env persistence on dedicated block volumes*), so `/srv/wfe/{prod,staging}` data SHALL survive a VPS replacement automatically — the volumes detach from the destroyed instance and reattach to its replacement. No rsync-and-restore ritual is required to preserve env data across a rebuild. Only `/srv/caddy` ACME state remains on the ephemeral root and is re-issued by Caddy after a rebuild.

The `null_resource.wait_cloud_init` resource SHALL invoke `cloud-init status --wait || [ $? -eq 2 ]` followed by `cloud-init status | grep -q '^status: done$'`. cloud-init exits 2 on recoverable errors (deprecation warnings, Scaleway-Debian-image-specific module noise); these are benign and SHALL NOT block apply. The textual status field is the load-bearing assertion.

#### Scenario: First boot reaches an SSH-ready state

- **WHEN** the VPS finishes its first boot
- **THEN** `cloud-init status` SHALL report `done`
- **AND** sshd SHALL accept key-only logins for `deploy` only on the configured port, with root disabled, password auth disabled
- **AND** ufw SHALL be enabled with `default deny incoming` and only the configured SSH port allowed
- **AND** `id deploy` SHALL show membership in `adm` and `systemd-journal`

#### Scenario: Edits beyond bootstrap minimum do not replace the VPS

- **GIVEN** any in-place-managed configuration is edited (sshd hardening drop-in, fail2ban jail, sysctl, packages list, dirs, swap, ufw rules for 80/443, Quadlets, env files, etc.)
- **WHEN** `tofu apply` runs
- **THEN** the plan SHALL NOT show `scaleway_instance_server.vps` being replaced

#### Scenario: Edits to bootstrap minimum still replace the VPS

- **GIVEN** the operator edits cloud-init's bootstrap minimum (e.g., changes the configured SSH port or rotates the deploy public key in cloud-init)
- **WHEN** `tofu apply` runs
- **THEN** the plan SHALL show `scaleway_instance_server.vps` being replaced
- **AND** `/srv/wfe/{prod,staging}` data SHALL be intact after the rebuild because it lives on Block Storage volumes that detach and reattach (no off-host rsync required)

## ADDED Requirements

### Requirement: Per-env persistence on dedicated block volumes

The project SHALL declare one `scaleway_block_volume` resource per app env (`prod`, `staging`), each of type `sbs_5k` (5 000 IOPS tier), minimum size 5 GB, attached to the VPS via `additional_volume_ids`. The prod volume SHALL declare `lifecycle { prevent_destroy = true }` so `tofu destroy` or accidental removal fails loud; the staging volume SHALL be a plain resource (no `prevent_destroy`) so it remains freely re-creatable for fresh-starts.

Each volume SHALL be activated on the host via a uniform pattern owned by the in-place convergence mechanism:

- **Format (in a `managed_exec`-style one-shot):** the device SHALL be formatted `ext4` with a filesystem label `wfe-<env>` ONLY when `blkid -p <device>` reports no existing filesystem/partition signature. An already-formatted device SHALL NOT be reformatted. This guard is the sole protection against destroying existing data; a single `blkid -p` probe is sufficient.
- **Device identification:** the format step SHALL resolve the target device deterministically (e.g. via `/dev/disk/by-id/*<volume-id>*`), NOT by size (the two volumes share a size) and NOT by kernel device-order naming.
- **Mount (via a systemd `.mount` unit declared as a managed file):** a `srv-wfe-<env>.mount` unit SHALL mount the volume at `/srv/wfe/<env>` by `LABEL=wfe-<env>` with the `nofail` option (a detached/missing volume SHALL NOT wedge boot). The unit is a managed file: its `on_change` hook SHALL `daemon-reload` and `enable --now` the unit; its `on_destroy` hook SHALL `disable --now` and remove the unit. Mount configuration SHALL NOT be expressed as an `/etc/fstab` append.
- **Ordering:** the volume SHALL be mounted before the env's app container starts, so the container never writes into the bare mount point on the root filesystem.
- **Ownership handoff:** after mounting, a freshly-formatted volume root (owned `root:root` by `mkfs`, including `lost+found`) SHALL be `chown -R`'d to the env's tenant user and `chmod 0700`, so the container's `:U` bind-mount flag (which recursively chowns the source into the tenant's subuid range, performed as the unprivileged tenant) can operate. This chown SHALL be guarded on root-ownership so a reattached, already-subuid-owned volume is left untouched.

Each app Quadlet SHALL declare `ExecStartPre=/usr/bin/mountpoint -q /srv/wfe/<env>` so that, if the volume is not mounted, the container fails to start (loud failure surfaced by `/readyz`) rather than silently writing to non-durable root storage.

#### Scenario: First apply formats and mounts an empty volume

- **GIVEN** a freshly attached, unformatted Block Storage volume for an env
- **WHEN** `tofu apply` converges the host
- **THEN** the device SHALL be formatted `ext4` with label `wfe-<env>`
- **AND** `srv-wfe-<env>.mount` SHALL be active, mounting it at `/srv/wfe/<env>`
- **AND** the mount root SHALL be `chown`'d to the tenant so the container's `:U` flag succeeds
- **AND** the env's app container SHALL start and write its persistence under that mount

#### Scenario: Freshly formatted volume root is handed to the tenant

- **GIVEN** a newly `mkfs`'d volume whose root and `lost+found` are owned `root:root`
- **WHEN** the mount is enabled and the ownership handoff runs
- **THEN** the mount root SHALL be `chown -R`'d to the env's tenant user and `chmod 0700`
- **AND** the container's `:U` recursive chown into the subuid range SHALL succeed (no `operation not permitted`)
- **AND** a subsequently reattached, already-subuid-owned volume SHALL NOT be re-chowned

#### Scenario: An already-formatted volume is never reformatted

- **GIVEN** a Block Storage volume that already contains an `ext4` filesystem with data
- **WHEN** `tofu apply` converges the host (e.g. after a VPS replacement reattached the volume)
- **THEN** `blkid -p` SHALL detect the existing signature
- **AND** `mkfs` SHALL NOT run
- **AND** the prior data SHALL remain intact after mount

#### Scenario: Container refuses to start when its volume is unmounted

- **GIVEN** the env's Block Storage volume failed to attach or mount (and `nofail` allowed boot to continue)
- **WHEN** the env's app container unit is started
- **THEN** the `ExecStartPre` `mountpoint -q /srv/wfe/<env>` check SHALL fail
- **AND** the container SHALL NOT start
- **AND** no persistence SHALL be written to the bare mount point on the root filesystem

#### Scenario: Prod volume is protected from destruction

- **GIVEN** the prod `scaleway_block_volume` declares `prevent_destroy = true`
- **WHEN** an operator runs `tofu destroy` or removes the resource from source and applies
- **THEN** tofu SHALL refuse with a `prevent_destroy` error rather than deleting the volume

#### Scenario: Declaration removal cleans the mount unit

- **GIVEN** a `srv-wfe-<env>.mount` managed-file entry exists in tofu state
- **WHEN** the entry is removed from source and `tofu apply` runs
- **THEN** the apply SHALL `disable --now` the unit and remove `srv-wfe-<env>.mount` from the host
- **AND** no `/etc/fstab` line for `/srv/wfe/<env>` SHALL remain (none was ever written)

### Requirement: Swap activated via a systemd .swap unit

The swapfile SHALL be created in a `managed_exec`-style one-shot (`fallocate` the file, `chmod 0600`, `mkswap`, each idempotent) and activated via a `swapfile.swap` systemd unit declared as a managed file — NOT via an `/etc/fstab` swap line. The unit's `on_change` hook SHALL `daemon-reload` and `enable --now swapfile.swap`; its `on_destroy` hook SHALL `disable --now swapfile.swap` and remove the unit and the swapfile. Removing the declaration SHALL leave no `/etc/fstab` residue (none is written).

#### Scenario: Swap is active after apply

- **GIVEN** the VPS is provisioned and the change is applied
- **WHEN** the operator runs `swapon --show` on the host
- **THEN** `/swapfile` SHALL appear as active swap
- **AND** `systemctl status swapfile.swap` SHALL report the unit `active`

#### Scenario: Swap declaration removal cleans the host without fstab residue

- **GIVEN** the swap managed entries exist in tofu state
- **WHEN** the entries are removed from source and `tofu apply` runs
- **THEN** the apply SHALL `disable --now swapfile.swap`, remove the unit, and remove `/swapfile`
- **AND** `/etc/fstab` SHALL contain no swap line for `/swapfile`
