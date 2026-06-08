## Why

Both prod and staging persistence live on the VPS's single 10 GB local-SSD root, which today sits at **97 % full (322 MB free)** — driven almost entirely by staging's **3.9 GB DuckDB event store** while prod holds 12 KB. Because the two envs share one filesystem, the disposable staging env can (and nearly does) exhaust the disk and take **prod down with it**, and the local SSD dies on every VPS rebuild (the documented "rebuild = total data loss" risk). Moving each env's data onto its own persistent Block Storage volume gives prod **durability across rebuilds**, **isolation** so staging can't starve prod, and **independent, live-resizable sizing**.

## What Changes

- Provision two Scaleway Block Storage (`sbs_5k`) volumes — one per env, 5 GB each — and attach them to the VPS via `additional_volume_ids` (a stop/start, **not** a VPS replacement; the root volume is untouched).
- Mount the prod volume at `/srv/wfe/prod` and the staging volume at `/srv/wfe/staging`. The prod volume carries `prevent_destroy = true` (the durable store); staging stays a plain resource (fresh-start friendly).
- Introduce a uniform host storage-activation pattern: **format/create in `managed_exec`** (`mkfs.ext4 -L <label>`, guarded by `blkid -p` so an already-formatted device is never reformatted) **→ activate via a systemd unit `managed_file`** (`srv-wfe-<env>.mount`), mounted by `LABEL=` with `nofail`.
- Migrate the swapfile to the same pattern: `fallocate`/`mkswap` in `managed_exec` → a `swapfile.swap` systemd unit, **retiring the imperative `/etc/fstab` append** (and the latent leaked-line wart on teardown).
- Add `ExecStartPre=/usr/bin/mountpoint -q /srv/wfe/<env>` to each app Quadlet so a missing/unmounted volume makes the container **fail loud** (down + `/readyz` red) instead of silently writing to the ephemeral root mountpoint.
- **BREAKING (operational):** applying this change **fresh-starts both envs** — the current prod (12 KB) and staging (3.9 GB) data on the local root is discarded; volumes start empty. Prod authors re-upload their bundles; staging auto-re-uploads via CI. Across **future** VPS replacements both envs' data now persists, so the rsync-and-restore migration ritual is retired.

## Capabilities

### New Capabilities
<!-- None — all changes are requirement-level edits to the existing infrastructure capability. -->

### Modified Capabilities
- `infrastructure`: add per-env Block Storage volumes to the single VPS; reframe per-env persistence from local-disk subdirectories to dedicated mounted block devices (the Quadlet bind-mount contract is unchanged); add the storage-activation pattern (format-if-empty + systemd `.mount`/`.swap` units, auto-clean) and the container mount guard; update the cloud-init replacement/migration note now that both envs' data survives a rebuild.

## Impact

- **Infra (`infrastructure/`):** `main.tf` (two `scaleway_block_volume` resources + `additional_volume_ids` + `prevent_destroy`), `host.tf` (new `managed_exec` format entries + `.mount`/`.swap` `managed_files`; swapfile entry reworked), `files/wfe.container.tmpl` (`ExecStartPre` mount guard).
- **Apply behaviour:** operator-driven `apply-infra`; a one-time **stop/start** (brief downtime for both envs) to attach the volumes. The pre-merge `plan (vps)` gate must be empty after apply.
- **Docs (`docs/infrastructure.md`):** topology, retire the rsync migration ritual, downgrade the "rebuild = total data loss" risk (now mitigated for both envs).
- **Cost:** ~€0.95/mo for 2 × 5 GB `sbs_5k` (5 K IOPS); root stays local (free). Volumes resize **up** live.
- **Not affected:** app/runtime code, the EventBus consumer pipeline, manifest format, the sandbox boundary, Caddy ACME state (stays on ephemeral root; re-issues cheaply).
- **Out of scope / follow-ups:** event-store retention (1-day staging, separate work), automated snapshots/off-box backups, `:idmap` as an eventual replacement for the `:U` recursive-chown-on-start.
