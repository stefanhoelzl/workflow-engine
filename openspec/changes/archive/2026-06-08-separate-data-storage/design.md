## Context

The VPS hosts prod and staging as rootless Podman + Quadlet units, both persisting to `/srv/wfe/<env>` on the single 10 GB local-SSD root. Live inspection: root fs **97 % full (8.3/9.0 GB, 322 MB free)**; staging's DuckDB event store is **3.9 GB** (unbounded — no retention), prod is **12 KB**, system is **~3.5 GB** (/usr 1.3 GB, container images 715 MB, /var 436 MB). Staging — the disposable env — is starving the shared disk and is likely already failing to checkpoint DuckDB (a `.tmp` dir churns near full disk). Prod shares the fs, so staging's growth is a prod-availability risk.

Constraints:
- Instance is `STARDUST1-S` (1 vCPU / 1 GB RAM / 10 GB local SSD), Debian 13 (Trixie), Podman 5.x rootless, one user-mode tenant per env (`wfe-prod`, `wfe-staging`).
- Host config converges in place via the typed `managed_*` maps in `host.tf` (stages: users → dirs → packages → files_pre → exec → ufw → files_post). Editing managed entries must **not** replace the VPS.
- Scaleway Block Storage (`sbs_5k`): 5 GB minimum, resizable **up** live (down requires recreate), ~€0.095/GB/mo, persists independently of the instance.

## Goals / Non-Goals

**Goals:**
- Each env's persistence lives on its own persistent Block Storage volume, mounted at `/srv/wfe/<env>`.
- Prod data survives VPS replacement; a misconfigured/missing mount fails loud, never silently degrades durability.
- The apply is a stop/start, not a VPS replacement.
- A single, uniform host pattern for activating block devices and swap.

**Non-Goals:**
- Event-store retention/pruning (separate work; the real fix for staging's unbounded growth).
- Automated snapshots / off-box backups (distinct follow-up).
- Preserving current prod/staging data across this cutover (fresh-start both — accepted).
- Moving Caddy ACME state off the root (cheap to re-issue; stays ephemeral).
- Any app/runtime, EventBus, manifest, or sandbox change — the Quadlet bind-mount contract is unchanged.

## Decisions

### D1 — Block Storage for **both** envs (not local for staging)
Both `/srv/wfe/<env>` back onto `sbs_5k` volumes referenced via the instance's `additional_volume_ids`.

*Alternative considered — staging on a second local (`l_ssd`) volume (a 7 GB root + 3 GB staging split):* rejected after reviewing the Scaleway provider docs. A **local** additional volume forces: (a) the server `state` to be `stopped` for any `additional_volume_ids` change; (b) a two-apply detach-then-delete teardown; (c) a server-coupled replacement cycle on resize (provider issue #766); (d) state drift on rebuild, since a local volume dies with the instance while the tofu resource persists — requiring `replace_triggered_by` wiring. It would also force shrinking the root 10 GB → 7 GB, which **recreates the instance** (local root size change forces replacement). Block volumes are independent resources with none of this friction, keep the root untouched (apply = stop/start), and give staging durability for free. Cost delta is ~€0.48/mo — far cheaper than the operational complexity.

### D2 — Sizing: both at the 5 GB block minimum
Prod is 12 KB; staging needs <1 GB under the planned 1-day retention. Block resizes **up** live (no replacement), so there is no reason to pre-pay. Grow prod on demand later. (5 GB is the SBS floor; 3 GB isn't expressible on block, and is irrelevant given retention.) IOPS tier: **5 K** — STARDUST1-S caps block bandwidth low and the workload is CPU/RAM-bound; 15 K would be unusable headroom.

### D3 — `prevent_destroy` on prod only
The prod volume is the durable store: `lifecycle { prevent_destroy = true }` makes `tofu destroy` / accidental removal fail loud (mirrors the repo's "pinned" protection for prod-serving resources). Staging stays a plain resource so fresh-starts and recreation aren't blocked.

### D4 — Storage-activation pattern: format in a root systemd oneshot, activate via systemd units
Uniform across block devices and swap, with all privileged operations performed **by systemd as root** (no new sudoers verbs — see D9):
```
  data vol →  wfe-data-format.service (oneshot, root): mkfs.ext4 -L wfe-<env>
              (only if `blkid -p <dev>` finds NO signature)                     →  srv-wfe-<env>.mount
  swap     →  managed_exec: fallocate + chmod 0600 + mkswap (create-only)       →  swapfile.swap
```
- The `.mount`/`.swap`/`.service` units and the format script are `managed_files` → they inherit the convergence contract (content-hash trigger, `on_change` `daemon-reload` + `enable --now`, `on_destroy` `disable --now` + rm → **auto-clean**, no `/etc/fstab` residue). Enabling is via `systemctl`, which is already in the sudoers allowlist.
- The format service is `Before=`/`RequiredBy` the `.mount` units, so starting a mount pulls in the format first (at boot and at apply).
- Mount by `/dev/disk/by-label/wfe-<env>` (the udev symlink from the `mkfs -L` label) so the *mount* identification is filesystem-intrinsic; only the one-time *format* must locate the raw device (D7).
- `nofail` so a detached/missing volume never wedges boot.

*Alternative considered — single `managed_exec` (deploy + sudo) doing mkfs + fstab-append + mount:* rejected on two counts — it mirrors the swapfile's leaked-fstab-line wart, AND `mkfs`/`blkid`/`mount` are not in deploy's sudoers allowlist, so it would require editing `sudoers_deploy`, which flips the cloud-init hash and forces a VPS replacement. Routing through systemd-as-root avoids both.

### D9 — No new sudoers verbs (keep the apply a stop/start)
The deploy sudoers allowlist is `systemctl`, `swapon`, `fallocate`, `mkswap` only (verified on the live box). All privileged storage operations route through systemd units enabled via `systemctl`: `systemd` runs the format service (mkfs/blkid), performs the mount(), and activates swap — none of which need a new allowlisted binary. Editing `sudoers_deploy` is part of the cloud-init bootstrap minimum and would force a VPS replacement; this design avoids that, keeping the apply a stop/start. (Bonus: the `.swap` unit's `disable --now` deactivates swap via systemd, sidestepping the latent gap that `swapoff` is *not* in the allowlist while today's `managed_exec` swap teardown calls it.)

### D5 — `blkid -p` is the (only) format guard
`mkfs` runs **only** when `blkid -p <dev>` reports no existing filesystem/partition signature. This is the one place a convergence bug is catastrophic rather than recoverable (reformatting prod on every apply would silently destroy data). Opposite roles per volume:
```
                first apply          every later rebuild
  prod  (block)  empty → mkfs        has ext4 → SKIP → data survives ✓
  staging(block) empty → mkfs        has ext4 → SKIP (fresh-start is a manual wipe, not an auto-reformat)
```
A single `blkid -p` probe is deemed sufficient (no belt-and-suspenders second check).

### D6 — Container mount guard: `ExecStartPre=/usr/bin/mountpoint -q /srv/wfe/<env>`
With `nofail`, a mount failure lets boot proceed and leaves `/srv/wfe/<env>` as an empty dir on the **root** fs. Without a guard the container would start, `:U`-chown that bare dir, and silently write events to non-durable root storage while looking healthy. The `ExecStartPre` mountpoint check converts this to a loud failure (container down, `/readyz` red).

*Alternative considered — `RequiresMountsFor=/srv/wfe/<env>` in `[Unit]`:* rejected — the container is a **user-mode** (linger) unit and the `.mount` is a **system** unit; the user manager can't order against or pull in system mounts. `ExecStartPre` reads `/proc` mounts as the unprivileged tenant and Quadlet passes `[Service]` keys through, so it works.

### D7 — Device identification for the one-time format (resolved from Scaleway's documented contract)
Only the *first* format must locate the raw, unlabeled device; once `mkfs -L wfe-<env>` runs, mounting uses the stable `/dev/disk/by-label/` symlink. Per Scaleway's *Identifying devices* doc and the `scaleway-csi` driver convention, an attached Block Storage (`sbs`) volume appears as a **SCSI disk (`/dev/sd*`)** with vendor `SCW` / model `sbs`, a **serial of `volume-<uuid>`**, and a stable udev symlink **`/dev/disk/by-id/scsi-0SCW_sbs_volume-<uuid>`**. The local/root volume is virtio (`/dev/vda`) with no serial, so the SBS data volumes are unambiguous.

The format script resolves via the canonical by-id symlink first, with `/dev/disk/by-id/*volume-<uuid>` and `*<uuid>*` globs (robustness if the udev prefix shifts across provider versions — the `volume-<uuid>` infix is the stable part), then the SCSI serial as a final fallback. (Live-box note: `/dev/disk/by-id/` was *empty* when inspected because only the serial-less virtio boot volume was attached; udev populates `scsi-0SCW_sbs_volume-*` once an SBS volume is attached.)

This is also **fail-safe even if resolution is wrong**: the `blkid -p` guard (D5) refuses to `mkfs` any device with an existing signature (so the mounted root is never reformatted), and if nothing resolves the script logs and skips → the `by-label` mount finds nothing → the D6 `mountpoint` guard keeps the container down (loud), never silent data loss. The documented scheme removes the need for a pre-attach spike; cluster-smoke 8.1 confirms format+mount on the real box as the standard infra-change gate.

### D8 — Ordering within the convergence
```
  stage 2  managed_dir       /srv/wfe/{prod,staging} mountpoints exist (already declared)
  stage 5  managed_exec      NEW: mkfs-if-empty per volume  (+ swapfile create/mkswap)
  stage 7  managed_file_post .mount/.swap units installed + enabled; then Quadlets start
```
Mount activation must precede container start (else the container writes under the mountpoint and the mount shadows it). At boot this holds naturally (system mounts at `local-fs.target` precede linger user sessions); during apply the stage order enforces it; the D6 guard is the backstop.

### D10 — Hand the freshly-formatted mount root to the tenant before `:U` (apply-discovered)
The app Quadlet mounts `/srv/wfe/<env>:/data:Z,U`; the `:U` flag makes rootless podman **recursively chown the source into the tenant's subuid range** at container start. That chown is performed *as the unprivileged tenant*, so it only works if the tenant already owns the path. Pre-change, the mountpoint *directory* was `managed_dir`-owned by `wfe-<env>`, so `:U` worked. After this change the mountpoint is the **`mkfs`'d volume root, owned `root:root`** (with a `root`-owned `lost+found`) — the tenant can't chown it, and the container dies with `lchown /srv/wfe/<env>: operation not permitted`.

Fix: `enable_data_mounts` (exec stage, after mounting, before the post-stage Quadlet restart) does `chown -R <tenant> <mount>` + `chmod 0700`, **guarded on root-ownership** (`find -maxdepth 0 -uid 0`) so it runs only on a freshly-formatted volume — a reattached volume is already subuid-owned (from a prior `:U`) and is left untouched (no pointless recursive chown, no transient wrong ownership). `:U` then maps the tenant-owned tree into the subuid range as before. (This corrects the earlier assumption in D-series notes that `:U` alone sufficed.)

## Risks / Trade-offs

- **[Reformatting prod on a `blkid` bug → silent total prod loss]** → D5 guard is `mkfs`-only-if-empty; `prevent_destroy` (D3) blocks resource-level destruction; first-apply behaviour verified in cluster smoke.
- **[Mount fails, prod silently writes to ephemeral root]** → D6 `mountpoint -q` guard makes it fail loud; `/readyz` surfaces it.
- **[Provider mis-sequences detach on a future VPS replacement]** → both volumes are independent SBS resources (clean detach/reattach is the documented path); verified on the first real replacement (cluster smoke). `prevent_destroy` backstops prod.
- **[Growing prod later force-replaces the volume (provider issue #766)]** → forward caveat for `design`/runbook: when prod fills, verify the provider does an in-place API resize, not a force-replace, before applying. Not triggered by this change.
- **[Device-id path assumption wrong]** → D7 spike on the live box before finalizing the format script.
- **[`:U` recursive chown on every container start scales with data size]** → pre-existing (already chowns the dir today); becomes more noticeable as prod grows; `:idmap` is the eventual escape hatch (out of scope).
- **[Fresh-start discards 3.9 GB staging + 12 KB prod]** → accepted; staging is disposable (and the wipe relieves the 97 %-full box as the first implementation step), prod is ~empty and re-uploadable.

## Migration Plan

1. **Relieve the box first:** stop `wfe-staging`, delete its DuckDB store, restart — frees the disk and un-wedges DuckDB, decoupled from the tofu work.
2. **Spike:** on the live box, confirm the `/dev/disk/by-id/` path format for an attached SBS volume (D7).
3. **Apply (operator `apply-infra`):** create the two `sbs_5k` volumes, attach via `additional_volume_ids` (stop/start), converge format + `.mount`/`.swap` units, restart Quadlets with the mount guard. Both envs come back on empty volumes.
4. **Verify:** cluster smoke — volumes mounted at `/srv/wfe/<env>`, container guard refuses to start when unmounted, `/readyz` green, prod data lands on the volume (not root).
5. **Rollback:** fix-forward only (consistent with infra cutover policy). The pre-merge `plan (vps)` gate must be empty post-apply.
6. **Future replacement:** a cloud-init-triggered rebuild now detaches/reattaches both volumes; the rsync-and-restore ritual is retired.
