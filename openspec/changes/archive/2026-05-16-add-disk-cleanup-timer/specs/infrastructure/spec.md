## ADDED Requirements

### Requirement: Daily disk cleanup service

The infrastructure project SHALL manage a root-owned systemd oneshot service `disk-cleanup.service` and a sibling `disk-cleanup.timer` on the VPS. The timer SHALL fire once per day with `Persistent=true` so a missed firing (host off, suspended, or upgrading) is caught on the next boot rather than skipped. The service SHALL execute a single script that performs the following reclaim steps in order, each idempotent and safe to no-op when nothing is reclaimable:

1. `apt-get clean` — removes downloaded package archives from `/var/cache/apt/archives/`. SHALL NOT remove installed packages or alter `dpkg` state.
2. `journalctl --vacuum-size=200M --vacuum-time=14d` — caps the persistent systemd journal at 200 MB AND drops entries older than 14 days. Both thresholds SHALL apply (whichever bites first).
3. For each rootless tenant managed by this project (currently `wfe-prod`, `wfe-staging`, `wfe-caddy`): `runuser -u <tenant> -- podman image prune -a -f`. The `-a` flag SHALL be used so the prune removes every image not referenced by a container, not just dangling (`<none>:<none>`) images — this reclaims both previous `:main` digests left behind by auto-update AND any tagged-but-unused side-images. Running containers' images SHALL NOT be pruned (podman enforces this via in-use references).

The unit's three files — `/etc/systemd/system/disk-cleanup.service`, `/etc/systemd/system/disk-cleanup.timer`, and `/usr/local/sbin/disk-cleanup.sh` — SHALL be declared as managed-file entries inside the existing `host.tf` convergence mechanism so they participate in the in-place apply semantics defined by *Host configuration converges in place*. The `on_change` hook for the timer file SHALL `systemctl daemon-reload` and `systemctl enable --now disk-cleanup.timer`. The `on_destroy` hooks SHALL `systemctl disable --now disk-cleanup.timer` before removing the files so declaration removal cleans the host.

The timer SHALL NOT run as the `deploy` user or any rootless tenant. It SHALL run as root because `apt-get clean` and `journalctl --vacuum-*` require root and because invoking `runuser` to reach each tenant's user systemd requires root.

#### Scenario: Timer is active after apply

- **GIVEN** the VPS is provisioned and the change is applied via `tofu apply`
- **WHEN** an operator runs `systemctl status disk-cleanup.timer` on the host
- **THEN** the timer SHALL report `Loaded: loaded` and `Active: active (waiting)`
- **AND** `systemctl list-timers disk-cleanup.timer` SHALL show the next firing within the next 24 hours

#### Scenario: First firing produces an observable run

- **GIVEN** the timer has been enabled and a fire window has elapsed
- **WHEN** the operator runs `journalctl -u disk-cleanup.service --since "-25h"`
- **THEN** the journal SHALL contain at least one invocation of `disk-cleanup.service`
- **AND** that invocation SHALL exit `Status=0/SUCCESS`

#### Scenario: Unused rootless images are reclaimed

- **GIVEN** `podman-auto-update.timer` has moved the `:main` tag forward on a tenant since the last cleanup, leaving the previous digest as an unreferenced image
- **WHEN** the next `disk-cleanup.service` firing completes
- **THEN** `runuser -u <tenant> -- podman images --filter dangling=true` SHALL return no images for that tenant
- **AND** the previous `:main` digest SHALL no longer be present in `runuser -u <tenant> -- podman images --all`
- **AND** `runuser -u <tenant> -- podman images <repo>:main` SHALL still show the current tagged image (it is in use by the running container and was not pruned)

#### Scenario: Images held by running containers are never pruned

- **GIVEN** each rootless tenant runs exactly one long-lived container under a Quadlet, holding a reference to its image
- **WHEN** `disk-cleanup.service` runs (with `podman image prune -a -f`)
- **THEN** the image currently referenced by each tenant's running container SHALL remain in that tenant's rootless image store
- **AND** the running container SHALL NOT be restarted, stopped, or otherwise disturbed by the prune

#### Scenario: Journal stays bounded

- **GIVEN** the persistent journal at `/var/log/journal` is larger than 200 MB OR contains entries older than 14 days
- **WHEN** `disk-cleanup.service` runs
- **THEN** after the run `du -sh /var/log/journal` SHALL report a size no greater than 200 MB (plus the size of the *current* active journal file, which `--vacuum-size` does not touch)
- **AND** `journalctl --list-boots` SHALL NOT include boots whose newest entry is older than 14 days

#### Scenario: apt cache is emptied without altering installed packages

- **GIVEN** `/var/cache/apt/archives/` contains downloaded `.deb` files
- **WHEN** `disk-cleanup.service` runs
- **THEN** `/var/cache/apt/archives/` SHALL contain no `.deb` files (only the `partial/` and `lock` artifacts that `apt-get clean` leaves in place)
- **AND** `dpkg -l` SHALL list exactly the same packages as before the run

#### Scenario: Persistent firing catches a missed window

- **GIVEN** the VPS was powered off across the scheduled `OnCalendar` fire time
- **WHEN** the VPS boots and the timer becomes active
- **THEN** the timer SHALL fire `disk-cleanup.service` once shortly after boot (due to `Persistent=true`)
- **AND** subsequent firings SHALL resume on the daily schedule

#### Scenario: Declaration removal cleans the host

- **GIVEN** the change has been applied and the three managed-file entries exist in tofu state
- **WHEN** the three entries are removed from `host.tf` and `tofu apply` runs
- **THEN** the apply SHALL stop and disable `disk-cleanup.timer`
- **AND** the apply SHALL remove `/etc/systemd/system/disk-cleanup.service`, `/etc/systemd/system/disk-cleanup.timer`, and `/usr/local/sbin/disk-cleanup.sh` from the host
- **AND** `systemctl status disk-cleanup.timer` SHALL report `Loaded: not-found`

#### Scenario: Script failure is contained

- **GIVEN** one of the reclaim steps fails on a single firing (e.g. `podman image prune` errors for one tenant)
- **WHEN** the service exits non-zero
- **THEN** the failure SHALL be recorded in `journalctl -u disk-cleanup.service`
- **AND** the timer SHALL remain enabled and SHALL fire again at the next scheduled time
- **AND** no other systemd unit SHALL be restarted, stopped, or marked failed as a side effect
