## Why

The single Scaleway VPS has a 9 GB root disk shared by Debian (1.3 GB `/usr`), 1 GB swap, the systemd journal, the apt cache, and three rootless podman image stores (~340 MB per tenant, duplicated because rootless storage isn't shared). On 2026-05-12 staging filled the disk via a 4.1 GB `events.duckdb` (separate fix in flight — bounded error serialization + EventStore retention), and once `/` hit 100% podman could no longer write its own container DB. `wfe-staging` exited with status 125 / "database or disk is full", systemd burned through 87 restart attempts in under a minute, hit the `StartLimit`, and the unit stayed `failed` for four days until manual intervention.

The EventStore growth was the trigger, but the structural fragility was the same disk: nothing on the host reclaims slack. The systemd journal grows unbounded by default (`/var/log/journal` was 356 MB after a few weeks; the failed-restart loop alone wrote a chunk of that). `/var/cache/apt` accumulates downloaded `.deb` files indefinitely (228 MB). `podman-auto-update.timer` pulls a new `:main` tag every minute and leaves the previous digest behind as a dangling image — under steady deploys that's ~340 MB of orphan layers per tenant per release cycle. None of these reclaim themselves on Debian Trixie + rootless podman; an operator has to remember.

A daily cleanup unit closes that gap. It doesn't fix the EventStore class of bug, but it widens the slack between "app misbehaves" and "podman wedges" from "hours" to "many days," and it eliminates one entire category of recurring ops toil (manual `podman image prune` after deploys).

## What Changes

- New tofu-managed root-owned systemd oneshot `disk-cleanup.service` plus `disk-cleanup.timer` (daily at 03:30 UTC, `Persistent=true`, small randomized delay) that runs `/usr/local/sbin/disk-cleanup.sh`.
- The script does three things, each safe to no-op when there's nothing to reclaim:
  1. `apt-get clean` — empties `/var/cache/apt/archives/`. Doesn't remove installed packages; only the cached download artifacts.
  2. `journalctl --vacuum-size=200M --vacuum-time=14d` — caps the persistent journal at 200 MB AND drops entries older than 14 days. Whichever threshold bites first wins; both apply.
  3. For each managed rootless tenant (`wfe-prod`, `wfe-staging`, `wfe-caddy`): `runuser -u <tenant> -- podman image prune -a -f`. `-a` removes every image not currently held by a running container (not just dangling); `-f` skips the confirmation prompt. Running containers hold a reference to their image, so the image currently in use is structurally unprunable. The previous digest of `:main` becomes both untagged AND unreferenced once auto-update moves the tag forward, so `-a` reclaims it — same result as `-f`-only for our floating-tag deployment, but `-a` also catches *tagged-but-unused* leftovers (e.g. a side-image pulled for ad-hoc debugging and never cleaned). Rollback by re-pulling `:main` from `ghcr.io` always works regardless of local cache state.
- The unit runs as root. No new sudoers entry is required (it doesn't use the `deploy` user). The existing managed-file convergence in `host.tf` writes the three files (`/etc/systemd/system/disk-cleanup.service`, `/etc/systemd/system/disk-cleanup.timer`, `/usr/local/sbin/disk-cleanup.sh`) with `on_change` hooks that `daemon-reload` and `enable --now` the timer; `on_destroy` hooks disable and remove the unit so declaration removal cleans the host.
- Three managed-file entries in `infrastructure/host.tf` plus three new template files under `infrastructure/files/`. No new variables, no new resources, no Quadlet changes, no Caddyfile changes, no app-image changes.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `infrastructure`: gains a new requirement — *Daily disk cleanup service* — declaring that the project SHALL manage a root-owned systemd timer that runs `apt-get clean`, vacuums the systemd journal to 200 MB / 14 days, and prunes unused rootless podman images for each managed tenant. Encodes the contract that the host reclaims its own slack daily, so a single-instance misbehaviour cannot wedge podman by filling the rootfs over a weekend.

## Impact

- **Infra**: `infrastructure/host.tf` gains three managed-file entries (root sudoers already cover `/usr/bin/install`, `/usr/bin/tee`, etc. used by the convergence mechanism). New template files `infrastructure/files/disk-cleanup.service`, `infrastructure/files/disk-cleanup.timer`, `infrastructure/files/disk-cleanup.sh.tmpl` (the `.tmpl` interpolates the tenant list). `tofu fmt -check -recursive infrastructure/` and `tofu -chdir=infrastructure validate` continue to pass; `plan-infra` on the PR SHALL show three adds and zero replacements.
- **Runtime / SDK / sandbox / specs other than `infrastructure`**: unaffected. No code changes; no `demo.ts` change.
- **Operator workflow**: `apply-infra` deploys the timer; after apply, `systemctl status disk-cleanup.timer` should show `Active: active (waiting)` and `systemctl list-timers | grep disk-cleanup` should show next firing tomorrow at 03:30 UTC. First run is observable via `journalctl -u disk-cleanup.service`.
- **Operational risk**: low.
  - `apt-get clean` is widely used in CI/container builds; it only removes downloaded `.deb` files, never package state.
  - `journalctl --vacuum-size` is the canonical journal-rotation knob; it preserves the most recent entries up to the size cap. 200 MB is ~1 month of normal traffic on this box (current journal was 356 MB for several weeks of activity including the 87-restart loop).
  - `podman image prune -a -f` removes every image not referenced by a running container. Quadlet sets `--rm` and each tenant runs exactly one long-lived container, so the only referenced image per tenant is the current `:main` digest — that one is structurally unprunable. Everything else (previous `:main` digests after auto-update, any side-image pulled for debugging) goes. The rollback path that matters (re-pull from `ghcr.io`) is unaffected; ghcr retains tagged manifests independent of local cache.
  - Worst case (script bug): the timer fails, journal gets a `disk-cleanup.service: Failed` entry, disk doesn't get cleaned. Nothing breaks; we're back to where we started before this change.
- **Out of scope** (explicitly):
  - The EventStore retention / bounded error-payload fix. That's the actual *cause* of the May 12 incident and lives in a separate change against `event-store`. This change is purely defence-in-depth for the host.
  - Resizing the root volume. Possible follow-up if even the cleaned baseline grows past comfort, but a tofu disk-resize on Scaleway needs a reboot and is not warranted by current numbers (4.5 GB used after cleanup; ~50% slack).
  - Moving persistence (`/srv/wfe/<env>`) off the root volume to its own block device. Better long-term answer but a bigger change with `:U` chown semantics implications; deferred.
  - Switching to digest-pinned image references with explicit rotation (which would replace tag-following + dangling-prune with explicit tag housekeeping). Different deployment model; out of scope.
  - Pruning *stopped* containers, volumes, build cache. The rootless tenants don't accumulate stopped containers (Quadlet uses `--rm`) and don't use volumes or build cache, so there's nothing to prune.
