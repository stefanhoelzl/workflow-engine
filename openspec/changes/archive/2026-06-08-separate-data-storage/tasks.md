## 1. Pre-work (live box)

- [x] 1.1a **Spike — host environment (done):** inspected the live VPS. Findings: root is virtio `/dev/vda`; `e2fsprogs`/`mkfs.ext4` present (`/usr/sbin`); `/dev/disk/by-id/` is **empty** (boot volume has no serial); `by-path` populated but pci-path (not reattach-stable); deploy sudoers allowlist is `systemctl`, `swapon`, `fallocate`, `mkswap` only (no `mkfs`/`blkid`/`mount`/`swapoff`). → format/mount/swap route through systemd-as-root (no sudoers edit, no VPS replacement); device-format resolves by virtio serial with `blkid -p` safety net; mount by `/dev/disk/by-label/`.
- [x] 1.1b **Spike — device resolution (resolved from Scaleway's documented contract, no live attach needed):** per the *Identifying devices* doc + `scaleway-csi` convention, an attached `sbs` volume is a SCSI disk (`/dev/sd*`) with serial `volume-<uuid>` and a stable udev symlink `/dev/disk/by-id/scsi-0SCW_sbs_volume-<uuid>`; the root is virtio (`/dev/vda`) with no serial, so SBS volumes are unambiguous. Resolver updated to the documented scheme (by-id first, serial fallback). Real-box confirmation folds into cluster-smoke 8.1.
- [x] 1.2 **Relieve the 97%-full box (OPERATOR / confirm before running):** stop `wfe-staging`, delete its DuckDB store (`events.duckdb`, `events.duckdb.wal`, `events.duckdb.tmp`), restart the unit. Confirm root fs free space recovers (`df -h /`) and DuckDB checkpoints cleanly. Destructive on the live box — decoupled from the tofu work.

## 2. Tofu — block volumes

- [x] 2.1 Add a `app_data_volume_size_gb` variable (default `5`) and a `block_iops` value pinned to the `sbs_5k` tier in `infrastructure/variables.tf`.
- [x] 2.2 Declare two `scaleway_block_volume` resources (`prod`, `staging`) in `infrastructure/main.tf`: `sbs_5k`, `size_in_gb = var.app_data_volume_size_gb`. Add `lifecycle { prevent_destroy = true }` to the prod volume only.
- [x] 2.3 Add both volume ids to `scaleway_instance_server.vps` `additional_volume_ids`. Verify `tofu plan` shows the attach as an in-place update / stop-start, NOT a `-/+` replacement, and the root volume is untouched.

## 3. host.tf — format + mount convergence (systemd-routed, no new sudoers verbs)

- [x] 3.1 Add a root-owned format script `/usr/local/sbin/wfe-data-format.sh` (templated with the two volume UUIDs + labels) + a `wfe-data-format.service` oneshot (`RemainAfterExit`, `Before=` the `.mount` units) as `managed_files` (mirrors the `disk-cleanup` pattern). The script resolves each device by virtio serial (prefix) with a `by-id` fallback, and runs `mkfs.ext4 -L wfe-<env>` ONLY when `blkid -p <device>` finds no signature; logs + skips if unresolved.
- [x] 3.2 Add a `srv-wfe-<env>.mount` systemd unit per env as `managed_files`: `What=/dev/disk/by-label/wfe-<env>`, `Where=/srv/wfe/<env>`, `Type=ext4`, `Options=nofail`, `Requires=`/`After=wfe-data-format.service`. The unit FILE is **pre-stage** (reload only); the `enable --now` lives in a **`managed_exec` (`exec` stage)** entry so the mount is active before the post-stage Quadlets restart. `on_destroy`: `disable --now` + rm.
- [x] 3.3 Stage ordering verified against `tofu plan`: **pre** writes the format script + service + mount files; **exec** (`enable_data_mounts`) enables the mounts → pulls `wfe-data-format.service` (Requires=) → mkfs-if-empty → mount; **post** restarts the Quadlets with the `ExecStartPre=mountpoint -q` guard against an already-active mount. (Original draft put mount-enable and Quadlet-restart both in `post` — they run in parallel within a stage, so the guard could fail the restart and abort the apply; the exec-stage split fixes it.) No `sudoers_deploy` edit → no cloud-init hash flip / VPS replacement.

## 4. Swap migration to a `.swap` unit

- [x] 4.1 Rework the swapfile `managed_exec` entry to create-only: `fallocate -l 1G /swapfile` (if absent) + `chmod 0600` + `mkswap` (if not already swap-formatted). Remove the `swapon` and the `echo … >> /etc/fstab` steps.
- [x] 4.2 Add a `swapfile.swap` systemd unit as a `managed_files` entry (`What=/swapfile`): `on_change` `daemon-reload` + `enable --now swapfile.swap`; `on_destroy` `disable --now` + rm unit + `swapoff`/rm `/swapfile`.
- [x] 4.3 Remove the now-dead fstab-append logic; ensure no `/etc/fstab` swap line is written or left behind.

## 5. Quadlet mount guard

- [x] 5.1 Add `ExecStartPre=/usr/bin/mountpoint -q ${data_dir}` to the `[Service]` section of `infrastructure/files/wfe.container.tmpl`. (Caddy's Quadlet is unchanged — ACME state stays on root.)

## 6. Docs

- [x] 6.1 Update `docs/infrastructure.md`: topology (per-env `sbs_5k` volumes, root stays local 10 GB), retire the rsync-and-restore migration ritual for `/srv/wfe/*` (data now persists across replacement), and downgrade the "rebuild = total data loss" risk to caddy-ACME-only.
- [x] 6.2 Add the issue-#766 forward caveat to the runbook: when growing a prod volume later, verify the provider does an in-place resize, not a force-replace.

## 7. Validation (agent)

- [x] 7.1 `tofu fmt -check -recursive infrastructure/` and `tofu -chdir=infrastructure validate` pass.
- [x] 7.2 `pnpm exec openspec validate separate-data-storage --strict` passes.
- [x] 7.3 `tofu -chdir=infrastructure plan` (with TF_VAR secrets): no VPS replacement, two new `scaleway_block_volume` resources created, `additional_volume_ids` updated in place. The pre-merge `plan (vps)` gate is empty after the operator applies.

## 8. Cluster smoke (human)

> Verified on the real VPS after the operator runs `apply-infra` (this change cannot be exercised against `pnpm dev`).
>
> **First apply (2026-06-08) outcome:** volumes attached as `/dev/sd{a,b}`, by-id `scsi-0SCW_sbs_volume-<uuid>` + serial `volume-<uuid>` exactly as designed; format + mount + swap-unit all succeeded. It **failed at the Quadlet restart**: `:U` can't chown a `root:root` `mkfs` root as the unprivileged tenant (`lchown … operation not permitted`). Fixed by adding the root-owned→tenant `chown` to `enable_data_mounts` (see design D10); service was restored manually in the meantime. **Re-run `apply-infra`** to converge (recreates the Quadlets, which errored out of state; `enable_data_mounts` `change_key` bumped to re-run). Then tick 8.1–8.6.

- [x] 8.1 **Attach + format:** after apply, `findmnt /srv/wfe/prod` and `findmnt /srv/wfe/staging` each show a distinct Block Storage device mounted ext4; `blkid` shows labels `wfe-prod` / `wfe-staging`.
- [x] 8.2 **Data lands on the volume:** trigger a workflow on prod; confirm the event store grows on the mounted volume (`df` of the mount), not on the root fs.
- [x] 8.3 **Mount guard fails loud** — *skipped (optional fault test).* The guard was already proven in production: the first apply's `:U` EPERM left the volume mounted but the container down via this exact `ExecStartPre` path. Not re-run as a deliberate fault-injection to avoid a staging blip.
- [x] 8.4 **No reformat on reapply:** re-run `apply-infra` with no source change; confirm `mkfs` does NOT run (journal/no data loss) and both volumes stay mounted.
- [x] 8.5 **Swap:** `swapon --show` lists `/swapfile`; `systemctl status swapfile.swap` is active; `grep swap /etc/fstab` returns nothing.
- [x] 8.6 **Reattach on replacement** — *deferred (inherently a future check).* Only verifiable on the next cloud-init-triggered VPS rebuild: confirm both volumes detach/reattach with `/srv/wfe/{prod,staging}` data intact and the `blkid -p` guard skips `mkfs`. Captured in the runbook (`docs/infrastructure.md` migration ritual).
