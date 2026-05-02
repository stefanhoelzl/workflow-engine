# host-security-baseline Specification

## Purpose
TBD - created by archiving change migrate-to-vps. Update Purpose after archive.
## Requirements
### Requirement: Rootless Podman with subuid mapping

All long-running workloads (Caddy + every app instance) SHALL run as rootless Podman containers under the `deploy` user, each with its own subuid range allocated in `/etc/subuid` and `/etc/subgid`. The `deploy` user SHALL NOT be a member of `wheel`, `sudo`, or `docker` groups.

#### Scenario: Containers run as non-root on the host

- **GIVEN** the VPS has been provisioned and Quadlet units have started
- **WHEN** an operator runs `ps -eo user,comm | grep -E 'caddy|node'`
- **THEN** every workload process SHALL show `deploy` (or the per-unit subuid) as its user
- **AND** no workload process SHALL show `root`

#### Scenario: Subuid range is allocated for the deploy user

- **GIVEN** the cloud-init has completed
- **WHEN** the operator inspects `/etc/subuid`
- **THEN** an entry for `deploy` SHALL exist with a contiguous range of at least 65536 ids

### Requirement: Host firewall default-deny

The host firewall SHALL default-deny all inbound traffic and explicitly allow only `80/tcp`, `443/tcp`, and the configured SSH port. Outbound traffic SHALL be unrestricted. The FORWARD chain SHALL be set to ACCEPT (`DEFAULT_FORWARD_POLICY="ACCEPT"` in `/etc/default/ufw`, plus `ufw default allow routed`) so that containers on the Podman bridge network (`10.88.0.0/16` by default) can egress to the public Internet — without this, container DNS lookups, image pulls, and Caddy ACME requests are silently dropped at the FORWARD chain. The INPUT chain stays default-deny; this loosens FORWARD only.

#### Scenario: Unprivileged ports are not reachable from outside

- **GIVEN** the firewall is active
- **WHEN** a remote scan probes ports `81`, `8080`, `8081`, `8082`, `5432`, etc.
- **THEN** every probe SHALL fail (filtered or refused)

#### Scenario: 80, 443, and the SSH port are reachable

- **WHEN** a remote client probes `80/tcp`, `443/tcp`, and the configured SSH port
- **THEN** each connection SHALL succeed

### Requirement: Workload binds restricted to loopback

Every **app** Quadlet unit SHALL publish its container port only on `127.0.0.1` of the host (`PublishPort=127.0.0.1:<host>:<container>`). Caddy SHALL be the sole process bound to `0.0.0.0:80`, `0.0.0.0:443`, and `0.0.0.0:443/udp`; Caddy uses `Network=host` (not bridge networking with PublishPort) so it can reach the apps on `127.0.0.1:<port>` without bridge-loopback isolation.

#### Scenario: App ports are not externally reachable

- **GIVEN** the apps are running
- **WHEN** a remote client probes `<vps-ip>:8081` and `<vps-ip>:8082`
- **THEN** every probe SHALL fail
- **AND** the same ports SHALL be reachable when `curl` is run from the VPS itself against `127.0.0.1:8081` / `127.0.0.1:8082`

### Requirement: Unprivileged port floor lowered for Caddy

The host SHALL set `net.ipv4.ip_unprivileged_port_start=80` so the rootless Caddy container can bind ports 80 and 443. The sysctl SHALL be applied via `/etc/sysctl.d/` so it persists across reboots.

#### Scenario: Sysctl persists after reboot

- **GIVEN** the sysctl has been applied via cloud-init
- **WHEN** the VPS is rebooted
- **THEN** `sysctl net.ipv4.ip_unprivileged_port_start` SHALL print `80`

### Requirement: Per-Quadlet resource ceilings

Every app Quadlet unit SHALL declare `MemoryMax=`. The Caddy unit SHALL declare `MemoryMax=`. Values SHALL be sized so the sum across all units, plus a kernel + page-cache reserve of at least 256 MB, does not exceed the VPS's physical RAM. (`CPUQuota=` is not currently set; STARDUST1-S has 1 shared vCPU and CPU contention has not been observed to cause issues — add per-unit quotas if a noisy-neighbour symptom appears.)

#### Scenario: A runaway workload does not OOM its neighbour

- **GIVEN** the units have started with their declared `MemoryMax`
- **WHEN** one app instance consumes memory beyond its `MemoryMax`
- **THEN** systemd SHALL OOM-kill that unit only
- **AND** the other app instance and Caddy SHALL continue running

### Requirement: Swapfile

The VPS SHALL provision a 1 GiB swapfile at `/swapfile`, persisted in `/etc/fstab`. STARDUST1-S has 1 GB physical RAM; per-Quadlet `MemoryMax=` keeps individual workloads bounded, but the swapfile absorbs transient bursts (Node sandbox spawns, page cache pressure, apt upgrades) without OOM-killing a unit. The swapfile creation in cloud-init SHALL be idempotent (skip if `/swapfile` already exists).

#### Scenario: Swapfile is active after boot

- **GIVEN** the VPS has finished cloud-init
- **WHEN** the operator runs `swapon --show`
- **THEN** `/swapfile` SHALL appear with size 1 GiB

### Requirement: Scoped NOPASSWD sudo for the deploy user

The `deploy` user SHALL be granted NOPASSWD sudo via `/etc/sudoers.d/deploy` exclusively for the following commands:

- `/usr/bin/systemctl daemon-reload`
- `/usr/bin/systemctl {start,stop,restart,status} wfe-prod.service`
- `/usr/bin/systemctl {start,stop,restart,status} wfe-staging.service`
- `/usr/bin/systemctl {start,stop,restart,status} caddy.service`
- `/usr/bin/systemctl {start,stop,restart,status} podman-auto-update.service`
- `/usr/bin/systemctl {start,stop,restart,status} podman-auto-update.timer`

The sudoers file SHALL NOT grant `ALL` or any wildcard form. Anything outside this list SHALL require root password authentication.

#### Scenario: Deploy user can restart wfe units without a password

- **GIVEN** an SSH session as `deploy`
- **WHEN** `sudo systemctl restart wfe-prod.service` is run
- **THEN** the command SHALL succeed without prompting for a password

#### Scenario: Deploy user cannot edit /etc files via sudo

- **GIVEN** an SSH session as `deploy`
- **WHEN** `sudo cat /etc/shadow` is attempted
- **THEN** sudo SHALL prompt for a password (and fail since `deploy` has no password)

### Requirement: SSH hardening

The sshd configuration SHALL:

- Listen on a non-default port (configurable, default 2222) — port 22 SHALL NOT be open in the firewall.
- Disable root login over SSH (`PermitRootLogin no`).
- Disable password and keyboard-interactive auth (`PasswordAuthentication no`, `KbdInteractiveAuthentication no`).
- Restrict accepted users to `deploy` only (`AllowUsers deploy`).
- Set `MaxAuthTries 3` and `LoginGraceTime 20s`.

#### Scenario: Root SSH is rejected

- **WHEN** an attacker attempts `ssh root@<vps-ip>` on the configured SSH port
- **THEN** the connection SHALL be closed by the server with no auth opportunity

#### Scenario: Password auth is rejected

- **WHEN** a client connects to the SSH port with key-based auth disabled and presents a password
- **THEN** authentication SHALL fail without prompting

#### Scenario: A non-deploy user is rejected even with a valid key

- **GIVEN** another local account `bob` with a valid SSH key in its authorized_keys
- **WHEN** `ssh bob@<vps-ip>` is attempted on the configured SSH port
- **THEN** the connection SHALL be rejected by the AllowUsers policy

### Requirement: fail2ban with sshd jail

`fail2ban` SHALL be installed and enabled with the `sshd` jail active. After 5 failed authentication attempts within the jail's findtime window the source IP SHALL be banned for at least 1 hour.

#### Scenario: Brute-forcer is banned

- **WHEN** an IP makes 5 failed SSH auth attempts within fail2ban's findtime
- **THEN** subsequent connections from that IP to the SSH port SHALL be dropped at the firewall
- **AND** `fail2ban-client status sshd` SHALL list the IP as banned

### Requirement: Secret env file modes

Every per-env secret file at `/etc/wfe/<env>.env` SHALL be mode `0600` and owned by `deploy:deploy`. The parent directory `/etc/wfe/` SHALL be mode `0700` and owned by `deploy:deploy`.

#### Scenario: Secret files are not world-readable

- **WHEN** an operator runs `ls -l /etc/wfe/`
- **THEN** every `*.env` entry SHALL show mode `-rw-------` (0600) and owner `deploy deploy`
- **AND** the directory itself SHALL show mode `drwx------` (0700)

### Requirement: Quadlet + Caddyfile config dirs writable by deploy

`/etc/containers/systemd/` and `/etc/caddy/` SHALL be created at cloud-init time with owner `deploy:deploy` and mode `0755`. Rationale: tofu's SSH provisioners drop Quadlet `.container` files and the Caddyfile into these dirs; running them through `sudo install` would require widening the deploy NOPASSWD allowlist to cover `install`, which weakens the scoped sudo posture. Podman reads `/etc/containers/systemd/` as root at boot regardless of dir ownership; Caddy reads `/etc/caddy/Caddyfile` via a read-only bind mount.

#### Scenario: Provisioners write Quadlet files without sudo

- **GIVEN** the operator runs `tofu apply`
- **WHEN** the SSH provisioner executes `install -m 0644 /tmp/wfe-prod.container /etc/containers/systemd/wfe-prod.container`
- **THEN** the install SHALL succeed without sudo

### Requirement: Operator log access via group membership

The `deploy` user SHALL be a member of the `adm` and `systemd-journal` groups so that `journalctl -u wfe-prod -u wfe-staging -u caddy` works without sudo. The NOPASSWD sudo allowlist is intentionally narrow (systemctl operations only); broadening it to include `journalctl` would mix log access with privileged actions and complicate the audit story.

#### Scenario: Operator reads journal without sudo

- **GIVEN** an SSH session as `deploy`
- **WHEN** `journalctl -u wfe-prod.service --no-pager -n 50` is run
- **THEN** the command SHALL succeed and emit recent journal lines for the unit

### Requirement: Unattended security upgrades

The VPS SHALL run an unattended-upgrades-equivalent service that automatically applies security updates from the OS distribution's security suite. Reboot-on-kernel-update SHALL NOT be automatic; the operator manually reboots after kernel CVE patches.

#### Scenario: Security update lands without operator action

- **GIVEN** a Debian security advisory publishes a fix for an installed package
- **WHEN** the next unattended-upgrades cycle runs
- **THEN** the package SHALL be upgraded automatically
- **AND** an entry SHALL appear in `/var/log/unattended-upgrades/unattended-upgrades.log`

