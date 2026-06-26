# Infrastructure

Production runbook for the single-VPS deployment. Local-dev instructions live in `CLAUDE.md` (`pnpm dev` is the only local mode).

## Topology

One Scaleway VPS (Debian 12) hosts both prod and staging. Three rootless Podman + systemd Quadlet units:

- `caddy.service` — TLS-terminating reverse proxy. Binds `0.0.0.0:80` and `0.0.0.0:443`. Let's Encrypt certs via the built-in HTTP-01 ACME client; state on the host bind mount `/srv/caddy/data`.
- `wfe-prod.service` — image `ghcr.io/stefanhoelzl/workflow-engine:release`. Binds `127.0.0.1:8081 → :8080`. Persistence at `/srv/wfe/prod` (a dedicated Block Storage volume).
- `wfe-staging.service` — image `ghcr.io/stefanhoelzl/workflow-engine:main`. Binds `127.0.0.1:8082 → :8080`. Persistence at `/srv/wfe/staging` (a dedicated Block Storage volume).

URLs:

- Prod: <https://workflow-engine.stho.net>
- Staging: <https://staging.workflow-engine.stho.net>

DNS: Bunny DNS records owned by tofu under the `stho.net` zone (referenced via a `data "bunnynet_dns_zone"` lookup; the zone itself is owned out-of-band). Prod is an A record at the VPS public IP (`scaleway_instance_ip` — stable across instance stop/start); staging is a CNAME at the Bunny Magic Containers CDN host.

## Storage

| Device | Type | Mount | Survives VPS replacement? |
| --- | --- | --- | --- |
| root | local SSD (`l_ssd`, 10 GB) | `/` (OS, container images, `/srv/caddy` ACME) | No — rebuilt by cloud-init |
| prod data | Block Storage (`sbs_5k`, 5 GB) | `/srv/wfe/prod` | **Yes** — `scaleway_block_volume.prod`, `prevent_destroy = true` |
| staging data | Block Storage (`sbs_5k`, 5 GB) | `/srv/wfe/staging` | **Yes** — `scaleway_block_volume.staging` (plain, re-creatable) |

The two data volumes are standalone `scaleway_block_volume` resources attached via the instance's `additional_volume_ids` (a stop/start, not a rebuild). Activation is fully systemd-routed so it needs no new sudoers verbs:

- `wfe-data-format.service` (root oneshot) runs `/usr/local/sbin/wfe-data-format.sh`, which `mkfs.ext4 -L wfe-<env>` a volume **only when `blkid -p` finds no signature** — a reattached/already-formatted volume is never reformatted. It resolves the raw device by matching the volume UUID against the block device's virtio serial (`/dev/disk/by-id` is empty on this instance).
- `srv-wfe-<env>.mount` units mount by `/dev/disk/by-label/wfe-<env>` with `nofail`, ordered `After=`/`Requires=` the format service.
- Each app Quadlet has `ExecStartPre=/usr/bin/mountpoint -q /srv/wfe/<env>`: if the volume isn't mounted the container stays **down** (loud, `/readyz` red) rather than silently writing to the ephemeral root.
- Swap is likewise a `swapfile.swap` unit (systemd does the `swapon`); there is no `/etc/fstab` swap line.

Volumes resize **up** live (`size_in_gb`); resizing **down** requires recreate. **Caveat (provider issue #766):** when growing a data volume later, confirm the plan shows an in-place resize, not a force-replace of the volume (which would couple to the server and deadlock); if it force-replaces, resize via the Scaleway API/console out-of-band and reconcile.

## Authentication

Caddy is a pure TLS terminator + reverse proxy. It performs no authentication, no forward-auth, no header injection. The workflow-engine app owns every URL prefix and mounts `sessionMiddleware` (`/invocations/*`, `/trigger/*`) and `apiAuthMiddleware` (`/api/*`) in-process. See `openspec/specs/auth/spec.md` and `SECURITY.md §4`.

## Tofu layout

Single flat project at `infrastructure/`:

```
infrastructure/
  Dockerfile          # app image (built by GHA, not by tofu)
  main.tf             # backend, providers, server, IP, security group
  variables.tf
  cloud-init.yaml     # bootstrap minimum: deploy user, sudoers, sshd port, ufw allow-ssh, FORWARD policy
  host.tf             # in-place host config: managed_users (wfe-prod/staging/caddy),
                      # managed_dirs, managed_packages, managed_files (sshd hardening,
                      # fail2ban jail, sysctl, podman timer override), managed_exec
                      # (swap, service enables), managed_ufw (80/443)
  caddy.tf            # Caddy quadlet + Caddyfile
  apps.tf             # wfe-prod + wfe-staging quadlets + env-file delivery
  dns.tf              # Bunny DNS records (A prod, CNAME staging)
  outputs.tf
  files/              # Quadlet + Caddyfile templates
```

Run from the repo root:

```
tofu -chdir=infrastructure init
tofu -chdir=infrastructure plan
tofu -chdir=infrastructure apply
```

State backend: Scaleway Object Storage (S3-compatible). Client-side encrypted via `TF_VAR_state_passphrase` (pbkdf2 + AES-GCM).

## Deploys (no tofu involved)

`deploy-staging.yml` runs on push to `main`:
1. Build + push `ghcr.io/stefanhoelzl/workflow-engine:main` (with `--build-arg GIT_SHA=${{ github.sha }}`).
2. Poll `https://staging.workflow-engine.stho.net/readyz` until `version.gitSha === ${{ github.sha }}`. Auto-update timer fires every 1 min.
3. Run `wfe upload` for the demo workflows.

`deploy-prod.yml` runs on push to `release`, gated by `environment: production` (required reviewer):
1. Build + push `ghcr.io/stefanhoelzl/workflow-engine:release`.
2. Poll `/readyz` for SHA convergence.

The `release` branch is protected (no force-push, no delete). Promote to prod with `git cherry-pick <sha> && git push origin release`.

The VPS's `podman-auto-update.timer` (1-min interval) does the actual rotation: it queries the registry HEAD for the configured tag, compares the manifest digest to the running container, and `systemctl restart`s the unit on diff.

**Rollback.** `git revert <bad-sha>` on the affected branch → CI rebuilds and re-pushes the same tag → box auto-updates within ~1 min. There is no rollback strategy for *infra* changes (cutover is one-way) — for app bugs, the revert path is fast.

## Apply infra (operator-driven)

Tofu apply runs only on operator action (no scheduled or push-based mutation). All `TF_VAR_*` values are sourced from GHA secrets / the operator's local secret store; bytes never land on the runner's filesystem.

Per-env env-file content is rendered inline in `local.env_files` (apps.tf) from `TF_VAR_*` values, fed into the unified `managed_files_apps["wfe_env_<env>"]` map entry, and written to the host via `provisioner "file" { content = ... }`. The bytes do enter tofu state, but state is AES-GCM-encrypted at rest via `main.tf`'s `encryption {}` block (passphrase from `TF_VAR_state_passphrase`). The map entry's content-hash trigger flips on secret rotation → file is rewritten to `/etc/wfe/<env>.env` → `wfe-<env>.service` is restarted by the on-change hook.

## Editing host config in place

Most host-config edits — sshd hardening, fail2ban tuning, sysctl values, package list, dirs, swap, app-side ufw rules, Quadlet content, env files — converge on the running VPS via the typed maps in `host.tf`, `apps.tf`, and `caddy.tf`. Edit the relevant `local.managed_*` entry, run `tofu apply`, the change applies over SSH without VPS replacement. `/srv/wfe/<env>` data and `/srv/caddy/data` ACME state survive.

Stage order (each stage's null_resource depends on the previous):

```
users → dirs → packages → files_pre → exec → ufw → files_post
```

Removal semantics:
- **Auto-clean** entries (default): removing the declaration removes the host artifact on next apply.
- **Pinned** entries (`on_destroy = ""`): per-env env files and Quadlets serving production traffic. Removing them from source does NOT remove them from the host — explicit operator teardown (manual rm + systemctl stop) is required.

What still triggers VPS replacement:

- Edits to the cloud-init bootstrap minimum (deploy user, deploy SSH key, sshd Port, ufw baseline, FORWARD policy, sudoers allowlist verbs).
- Edits to the underlying Scaleway resource shape (`var.instance_type`, `var.instance_image`, root volume size).

Adding a new tenant (e.g., `wfe-experimental`) is a tofu-only operation: add an entry to `local.managed_users` (with a non-overlapping subuid range), add data dirs to `local.managed_dirs` owned by the new user, add an env-file + Quadlet entry to `local.managed_files_apps`, apply.

## Migration ritual: surviving a cloud-init edit

When you do need to edit the cloud-init bootstrap minimum (rare — SSH key rotation, sshd port change, sudoers verb addition, FORWARD policy change), `tofu apply` automatically replaces the VPS. The trigger is a sha256 of the rendered cloud-init content, captured by `terraform_data.cloud_init_bootstrap`; when the hash flips, `lifecycle { replace_triggered_by = [...] }` on `scaleway_instance_server.vps` forces replacement. (Without this, the Scaleway provider would just update `user_data` in place — but cloud-init only runs at first boot, so the new content would never take effect.)

VPS replacement destroys the local SSD root — but **`/srv/wfe/{prod,staging}` now live on Block Storage volumes, which detach from the destroyed instance and reattach to its replacement, so env data survives the rebuild with no rsync ritual.** On the new box the `wfe-data-format.service` sees the existing filesystem (`blkid -p`) and skips `mkfs`; the `srv-wfe-<env>.mount` units remount by label. The only ephemeral state is `/srv/caddy/data` (ACME), which Caddy re-issues automatically.

```bash
# 1. (Optional) back up ACME state to avoid a re-issue round; env data needs no backup.
rsync -aAX deploy@<host>:/srv/caddy/data /tmp/caddy-pre-apply-$(date +%F)

# 2. Apply the change. tofu will plan a `-/+ destroy and then create
# replacement` for scaleway_instance_server.vps — that's expected. The
# scaleway_block_volume.{prod,staging} resources are NOT replaced; they detach
# and reattach. (prevent_destroy on prod is an extra guard.)
tofu -chdir=infrastructure apply

# 3. Wait for the new VPS to come up. The data volumes reattach and remount
# automatically; verify with `findmnt /srv/wfe/prod /srv/wfe/staging`.
```

**Forcing a rebuild without a content edit.** If you need to re-bake the bootstrap minimum without changing the source (e.g., to rotate the in-memory session-sealing password by recycling all containers), run `tofu -chdir=infrastructure taint scaleway_instance_server.vps && tofu apply`. Env data on the Block Storage volumes survives; only `/srv/caddy/data` is re-issued.

**When to run apply-infra.** Any PR touching `infrastructure/`. The pre-merge `plan (vps)` gate fails if the plan is non-empty, so the operator runs `apply-infra` from the feature branch *before* requesting review.

## Pre-merge plan gate

`.github/workflows/plan-infra.yml` runs on every PR to `main`. Single job named `plan (vps)`:

- `tofu init && tofu plan -detailed-exitcode -lock=false -no-color` with all `TF_VAR_*` secrets piped from GHA secrets so the plan can render every `managed_files_*` entry's content-hash trigger.
- Pipes the plan into `$GITHUB_STEP_SUMMARY`.
- Exit 0 = pass; 1 (error) or 2 (changes pending) = fail.

The repo ruleset on `main` requires `plan (vps)` to pass. There is no per-PR bypass; if the gate is broken, an admin temporarily disables the ruleset via `gh api PUT`, merges the fix, and re-enables.

## Required GitHub Actions secrets and variables

Secrets:

- `TF_VAR_state_passphrase` — client-side state encryption
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` — Scaleway Object Storage credentials for the S3 backend
- `SCW_ACCESS_KEY`, `SCW_SECRET_KEY`, `SCW_DEFAULT_PROJECT_ID`, `SCW_DEFAULT_ORGANIZATION_ID` — Scaleway provider credentials
- `TF_VAR_acme_email` — Let's Encrypt account email
- `GH_OAUTH_CLIENT_ID_PROD`, `GH_OAUTH_CLIENT_SECRET_PROD` — prod GitHub OAuth App
- `GH_OAUTH_CLIENT_ID_STAGING`, `GH_OAUTH_CLIENT_SECRET_STAGING` — staging GitHub OAuth App
- `GH_UPLOAD_TOKEN` — fine-grained PAT for `wfe upload` (staging only)
- `BUNNYNET_API_KEY` — bunny.net account API key. Used by `deploy-staging.yml` (rolls the Magic Containers app via the image-digest PATCH) and mapped to `TF_VAR_bunnynet_api_key` in `plan-infra.yml`/local apply (the `bunnynet` provider). Must be a full-access account key — "team member API keys are not supported" by the provider.

Variables:

- `AUTH_ALLOW_PROD`, `AUTH_ALLOW_STAGING` — `AUTH_ALLOW` value per env

## SSH access

```
ssh -p 2222 deploy@<vps-ip>
```

The `deploy` user is the only SSH-able account (administrative role). Root login is disabled. Password auth is disabled. `fail2ban` bans the IP after 5 failed auths in 10 min.

The deploy keypair is generated by tofu (`tls_private_key.deploy`, ED25519) and stored only in tofu state, AES-GCM-encrypted via `TF_VAR_state_passphrase`. There is no off-host operator copy. Retrieve the private key for emergency SSH access with:

```
tofu -chdir=infrastructure output -raw deploy_ssh_private_key > ~/.ssh/wfe_deploy
chmod 600 ~/.ssh/wfe_deploy
ssh -i ~/.ssh/wfe_deploy -p 2222 deploy@<vps-ip>
```

State-passphrase loss = no SSH-key fallback. `/srv/wfe/<env>` and `/srv/caddy/data` have no off-box backup (line ~246 follow-up), so a state-passphrase-loss event today is total data loss until the off-box backup follow-up lands.

Container workloads run as separate per-tenant users (`wfe-prod`, `wfe-staging`, `wfe-caddy`) — none of them have SSH access (`AllowUsers deploy` only), no sudoers, no privileged group memberships. A successful sandbox+container escape lands the attacker on one of these unprivileged tenant users with no path to escalate to deploy.

Once on the box:

- Inspect logs: `journalctl -u wfe-prod -u wfe-staging -u caddy --since "1 hour ago"`
- Check unit status: `systemctl status wfe-prod wfe-staging caddy`
- Check auto-update: `journalctl -u podman-auto-update.service` and `systemctl list-timers podman-auto-update.timer`
- Force a deploy now: `sudo systemctl start podman-auto-update.service`
- Inspect Caddy ACME state: `ls -la /srv/caddy/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/`
- Inspect persistence: `sudo ls /srv/wfe/{prod,staging}/` (mode 0700 owned by the corresponding `wfe-<env>` user — sudo needed to read as deploy)
- Inspect a tenant's containers: `sudo -u wfe-prod podman ps` (deploy can sudo to any user via the broad allowlist)

The `deploy` user has NOPASSWD sudo for the converge primitives the in-place mechanism needs: `install`, `tee`, `rm`, `chmod`, `chown`, `systemctl`, `useradd`/`usermod`/`userdel`, `ufw`, `apt-get`, `sysctl`, `swapon`/`swapoff`, `fallocate`, `mkswap` (full list in `infrastructure/files/sudoers_deploy`). This is effectively root-by-sudo. The trust boundary that protects this privilege from a host-side attacker is the **SSH-key boundary**: deploy's private key lives only in tofu state at rest, AES-GCM-encrypted. The post-S1/I11 attacker lands as `wfe-*` (unprivileged), not as deploy. See `SECURITY.md` §"Privilege isolation" and `openspec/specs/host-security-baseline/spec.md`.

## Secret rotation

GitHub OAuth client secret (or any other env-file value):

1. Update the GHA secret in repo settings.
2. Re-run `apply-infra` (workflow_dispatch).
3. The `managed_files_apps["wfe_env_<env>"]` content-hash trigger detects the change; tofu rewrites `/etc/wfe/<env>.env`; the on-change hook restarts the affected unit.

SSH deploy key:

1. `tofu -chdir=infrastructure taint tls_private_key.deploy` — marks the key for re-generation on the next apply.
2. Take the rsync backup of `/srv/wfe/<env>` and `/srv/caddy/data` per the VPS-replacement ritual above (the new public key flips the cloud-init bootstrap hash → VPS is replaced).
3. `tofu -chdir=infrastructure apply` — generates a fresh ED25519 keypair, replaces the VPS, runs the in-place convergence against the new instance.
4. Restore `/srv` data per the rsync-and-restore ritual.
5. Old key is invalidated the moment the new VPS finishes cloud-init. New private key is in tofu state; retrieve via `tofu -chdir=infrastructure output -raw deploy_ssh_private_key` if needed for ad-hoc SSH.

## Caddy upgrades

Bump `var.caddy_image` in `infrastructure/variables.tf` (or override via tfvars) to the new tag. Re-run `apply-infra`. The `caddy.service` unit is restarted; ACME state on `/srv/caddy/data` survives (it's a host bind mount). Major-version bumps: review the Caddy changelog for breaking Caddyfile-syntax changes first.

## Failure modes

**Auto-update timer stuck.**

Check `journalctl -u podman-auto-update.service`. Common causes:
- Image tag not yet visible on ghcr.io (race with `docker push`).
- ghcr.io rate-limiting (anonymous IP-scoped). Wait or retry.
- Container failing to start after pull (env file missing, port collision). Check `journalctl -u wfe-prod`.

Force a manual pull + restart:
```
sudo systemctl start podman-auto-update.service
```

**Caddy can't obtain a cert.**

```
journalctl -u caddy -f | grep -E 'certificate|acme|err'
```

Common causes:
- Bunny DNS record not yet propagated → `dig` from an external resolver.
- Port 80 firewall rule missing → `sudo ufw status`.
- LE rate-limit hit (5 failed challenges/hour per domain) → wait 1 hour.

Caddy retries on its own backoff (default: every 9 min for the first hour, exponential thereafter).

**App OOM.**

Check: `journalctl -u wfe-prod -u wfe-staging | grep -i oom`.

Each app's memory budget is a hard cap on the container *payload* cgroup (`PodmanArgs=--memory=` in the Quadlet, fed by `memory_max` in `local.envs`), so it is visible from inside the container as `/sys/fs/cgroup/memory.max` — software that auto-sizes from detected memory (e.g. V8's heap) sees the real budget instead of host RAM. It also keeps each app's blast radius contained to its own unit on STARDUST1-S. The 1 GiB swapfile absorbs transient bursts. If OOM kills become recurrent:
1. Inspect the workload — sandbox worker leak? Action with unbounded buffer?
2. Bump `memory_max` in `infrastructure/main.tf` (`local.envs`) and re-apply.
3. If both apps need more, upgrade the VPS commercial type (`var.instance_type`) and re-apply (instance is recreated).

**`/readyz` reports old `gitSha` after deploy.**

The auto-update timer hasn't ticked yet. Wait up to 60 s. If still stale after 5 min:
- Check the timer is enabled: `systemctl is-enabled podman-auto-update.timer`.
- Check the last run: `journalctl -u podman-auto-update.service --since "10 min ago"`.
- Force a pull: `sudo systemctl start podman-auto-update.service`.

## EventStore retention & disk recovery

The EventStore (`<data_dir>/events.db`, libSQL) appends one row per invocation event and, by default, never deletes them. On the shared root volume this grows unbounded and can fill the disk. Two independent levers:

**1. Bound future growth — opt-in time-based retention.**

Set on the app's Quadlet unit (`Environment=` in `wfe.container.tmpl`, or `/etc/wfe/<env>.env`):

- `EVENT_STORE_RETENTION_DAYS` — integer days; invocations whose most recent event is older than this are pruned. **Unset or `0` disables retention** (the default). Six months = `180`. The prune interval is **derived** from this — the runtime prunes 100× per window (every `retentionDays / 100` days), so there is no separate interval knob. (Prod `90` → ~21.6h cadence; staging `1` → ~14.4 min.)

The runtime self-prunes on this schedule: it deletes whole invocations older than the window in a single transaction. A failed prune logs `event-store.prune-failed` and retries on the next tick; it never crashes the runtime. A successful run logs `event-store.prune-ok { invocations, durationMs }`.

> **Important:** `DELETE` does **not** shrink the `events.db` file on disk — libSQL/SQLite reuses the freed pages for future writes, so the file *plateaus* at roughly one retention window's worth of data rather than returning space to the OS. Retention bounds *future* growth; it does **not** recover disk already consumed (see lever 2; `VACUUM` would reclaim it but is not run automatically).

> **First prune on a large DB:** if you enable retention on an already-bloated `events.db` without wiping it first, the first prune is a single large `DELETE` that briefly serializes ahead of live event commits — event recording can lag for the duration (triggers still execute; nothing is lost). Prefer the wipe below before enabling on a bloated DB.

**2. Recover disk already consumed — one-time wipe.**

Because `DELETE` won't return space, recover a full disk by recreating the DB file (loses historical invocation events):

```
# as the app's host user (e.g. wfe-prod), per environment
systemctl --user stop wfe-prod
rm -f /srv/wfe/prod/events.db /srv/wfe/prod/events.db-wal /srv/wfe/prod/events.db-shm
systemctl --user start wfe-prod
```

The events table is recreated empty on boot. After this one-time reset, enable lever 1 so the file plateaus instead of growing again. (Sizing the volume to fit the plateau, or isolating `/srv/wfe` on its own volume, is the durable blast-radius fix and is tracked separately.)

## Database connection (`DATABASE_URL`) & the remote-libSQL flip

The libSQL connection for the EventStore + per-workflow queues is named by **three env vars** (parsed in `packages/runtime/src/config.ts`):

- `DATABASE_URL` — **required**. `file:…` = embedded on-disk; `libsql://…`/`https://…` = remote libSQL service (Bunny Database). No derivation from `PERSISTENCE_PATH` (which still roots the `workflows/` bundle tree).
- `DATABASE_WAL` — embedded-only `PRAGMA journal_mode=WAL` toggle (default `false`). Keep it `true` for any embedded deployment so out-of-process readers (operator tooling, the e2e harness) can read while the runtime writes; without WAL, libSQL uses rollback-journal mode where readers and the writer block each other.
- `DATABASE_AUTH_TOKEN` — remote auth token. Sealed secret (redacted in logs/plan output); its presence selects the remote client variant.

Today **all environments run embedded**: the VPS Quadlet template and `bunny-staging.tf` set `DATABASE_URL=file:/data/events.db` + `DATABASE_WAL=true`. `main.ts` builds one `@libsql/client` from these and injects it into both Kysely stores; the remote variant is the same dialect over the network.

### Flipping an environment to a remote Bunny Database (future cutover)

This is a deliberate, staging-first operation — **not** done by the prep change that introduced the seam.

1. **Provision** a Bunny Database (remote libSQL) instance in the target region; obtain its `libsql://…` URL and an auth token.
2. **Staging first.** On the staging app set `DATABASE_URL=libsql://…` and add `DATABASE_AUTH_TOKEN=…` as a **secret** (env-file / sealed TF var on the VPS; a `sensitive` env on Magic Containers). **Remove `DATABASE_WAL`** (or leave it `false`) — setting `DATABASE_AUTH_TOKEN` together with `DATABASE_WAL=true` fails closed at boot.
   - Common mistake: a `libsql://` URL **without** the token does *not* fail at config parse — it routes to the embedded code path and surfaces a confusing connect/runtime error. Always set the token in the same change as the remote URL.
3. **Verify** against the pre-prod checklist below before touching prod.
4. **Prod.** Repeat on the prod app once staging is healthy.
5. **Rollback.** Revert the env back to `DATABASE_URL=file:/data/events.db` + `DATABASE_WAL=true` and restart. The local `events.db` resumes (its data is independent of the remote service; both directions are accept-loss on the local volume).

### Pre-prod verification checklist (Bunny Database is public preview)

The libSQL client deps keep caret ranges (`@libsql/client ^0.8.0`, `@libsql/kysely-libsql ^0.4.1`); the preview service can churn, so before pointing prod at it, confirm on staging:

- **Cold-start latency.** Bunny Database spins down when idle; measure the first dashboard read after an idle period. There is **no read-path retry** in the runtime today — a cold-start surfaces as a failed query the user must retry. If this bites, add read-path retry (tracked, not built).
- **Auth-token rotation.** Confirm rotating `DATABASE_AUTH_TOKEN` + restart reconnects cleanly.
- **TLS / region.** Confirm the remote endpoint's TLS and that its region matches the app region (latency + data residency).
- **Hrana protocol negotiation.** Confirm the pinned client version negotiates against Bunny's libSQL server (run a real query through both stores). The transport follows the URL scheme — `libsql://` uses a long-lived WebSocket (which an idle spin-down may kill), `https://` is stateless per request; pick via the URL scheme and verify whichever you choose survives an idle cycle.
- **Single-writer.** Remote libSQL has **no** file-level write exclusion at all; the single-writer guarantee rests **entirely** on the instance-count pin (`autoscaling_min=max=1`, sequential rollout). Confirm no config path can run two instances against the same remote DB. An app-level lease/fence is a future option, not built.

## SDK publishing to npm

`@workflow-engine/sdk` and `@workflow-engine/core` publish to npm on every push to `release` whose diff touches `packages/sdk` or `packages/core`. Auth is via npm trusted publishing (OIDC) — there is no long-lived `NPM_AUTOMATION_TOKEN` in repo secrets. Workflow: `.github/workflows/deploy-prod.yml` job `publish-npm`.

### Versioning (CalVer)

Versions are computed by CI as `YYYY.M.PATCH` (e.g. `2026.5.0`, `2026.5.1`, `2026.6.0`). The `version` field in `packages/{core,sdk}/package.json` is a permanent placeholder `0.0.0-dev`; CI rewrites it in-place at publish time and does not commit the change back. After a successful publish, CI tags the commit `v$VERSION` and pushes the tag — the tag is the diff anchor for the next run's "is a publish needed?" gate.

### Bootstrap (one-time per package — required before automated publish works)

npm trusted publishing cannot publish a package's first version (npm/cli#8544). Bootstrap each package once with a temporary token, then never again:

1. In the npm UI, generate a short-lived classic automation token for the `@workflow-engine` org. Pick the shortest available expiry. Do NOT add it to repo secrets.
2. Locally, `npm login` (or `NPM_TOKEN=… npm publish`) and publish a minimal `0.0.0-init` placeholder for the package — a `package.json` with `name`, `version: "0.0.0-init"`, `repository`, `license`, plus an empty `index.js`.
3. On `https://www.npmjs.com/package/@workflow-engine/<pkg>/access` (or via `npm trust github @workflow-engine/<pkg> --yes` on npm ≥ 11.10), add a GitHub Actions trusted publisher pinned to:
   - Repository: `stefanhoelzl/workflow-engine`
   - Workflow: `.github/workflows/deploy-prod.yml`
   - Branch: `release`
   - Environment: `production`
4. `npm deprecate @workflow-engine/<pkg>@0.0.0-init "bootstrap placeholder, do not install"`.
5. Repeat 2–4 for the other package.
6. Revoke the temporary classic token in the npm UI.

After this, no long-lived credential exists anywhere and the next push to `release` (with changes in `packages/sdk` or `packages/core`) will publish `2026.M.0`.

### Rebinding (if the workflow path or branch changes)

The trusted-publisher binding is exact: it pins to the workflow file path AND the branch AND the environment. If you rename `.github/workflows/deploy-prod.yml`, move the publish to a non-`release` branch, or rename the `production` GitHub Actions environment, publishes will fail with `OIDC token does not match the configured trusted publisher`. Update the binding on `https://www.npmjs.com/package/@workflow-engine/<pkg>/access` for both packages.

### Bad publish recovery

`npm publish` rejects republishing an already-published version. Fix a bad publish with `npm deprecate @workflow-engine/<pkg>@<bad-version> "<reason>"` (which keeps the version installable but warns). Unpublish (`npm unpublish`) is only available within 72 hours of publish and should be a last resort. The next intentional source change to `packages/sdk` or `packages/core` produces a new CalVer that supersedes the deprecated one.

## Granting a new external author access (`AUTH_ALLOW`)

`AUTH_ALLOW` is a comma-separated string of provider-prefixed identifiers (e.g. `github:org:acme,github:user:alice`) read at runtime boot. It is materialized from the `AUTH_ALLOW_PROD` and `AUTH_ALLOW_STAGING` GitHub Actions repository variables. To onboard a new external author:

1. Confirm the author's GitHub identity. Their owner namespace must be either their own GitHub login (`github:user:<login>`) OR a GitHub org they're a member of (`github:org:<org>`).
2. Append the entry to the relevant `AUTH_ALLOW_*` GitHub Actions variable. Example: `github:org:acme` → add `,github:user:bob` to onboard `bob`.
3. Re-deploy by pushing to `main` (staging) or `release` (prod). The runtime reads the variable at boot.
4. Tell the author to install the SDK (`npm install @workflow-engine/sdk`), mint a GitHub PAT with the **`read:org`** scope (fine-grained tokens: "Members: read" on the org), and run `npx wfe upload --owner <their-namespace> --token <PAT>`. The runtime calls `/user` and `/user/orgs` to populate `user.orgs` and enforces `isMember(user, owner)`. A token without `read:org` returns an empty `orgs` array → membership check fails → 404 (deliberately indistinguishable from "owner does not exist", to prevent enumeration).

## Risks (carry these in your head)

- **No off-box backups / snapshots.** `/srv/wfe/{prod,staging}` now persist across VPS replacement (Block Storage volumes; prod is `prevent_destroy`), so a rebuild is no longer data loss. But there is still no snapshot or off-box copy, so an accidental volume delete or a Block Storage-side loss is unrecovered until users re-upload bundles via `wfe upload`. Scheduled snapshots are the remaining follow-up. `/srv/caddy/data` remains ephemeral (auto-re-issued).
- **No rollback for infra.** Cutover is one-way; fix-forward is the only mode. App rollback (`git revert` + auto-update) is the fast path for app bugs.
- **Single VPS, single region.** Hardware failure causes downtime until manual re-provision.
- **Host kernel is the only compute/memory isolation boundary** between prod and staging (disk is now isolated — each env has its own Block Storage volume, so neither can exhaust the other's space). Mitigated by `unattended-upgrades`.

## Staging on bunny.net Magic Containers (spike)

Staging is being trialled on **bunny.net Magic Containers** in parallel with the VPS. This is a spike to develop intuition about the platform; **prod stays entirely on the VPS**. The VPS staging stack (`wfe-staging.container`, `/etc/wfe/staging.env`, the `/srv/wfe/staging` volume + mount, the Caddy `staging.*` site block) is **kept running, unedited, as a live warm fallback** (still auto-pulling `:main`). See `openspec/changes/staging-bunny-magic-containers/` for the full design.

### What tofu manages

`infrastructure/bunny-staging.tf` declares (via the `bunnynet` provider, pinned `~> 0.15`, key `var.bunnynet_api_key` ← `BUNNYNET_API_KEY`):

- One `bunnynet_compute_container_app` `wfe-staging`: image `ghcr.io/stefanhoelzl/workflow-engine:main` (public registry resolved via the `bunnynet_compute_container_imageregistry` data source — `username = ""`, no token), `autoscaling_min = max = 1`, region `DE` (Frankfurt), `image_pull_policy = "Always"` (no pinned digest), a `/data` volume, a `/readyz` readiness probe, and an env block that mirrors the VPS staging Quadlet (including reuse of `random_bytes.secrets_key["staging"]` so bundles unseal against either backend).
- A **CDN** endpoint (`origin_ssl = false`) for managed HTTPS — the staging replacement for Caddy's TLS termination.

**Live:** staging resolves via the Bunny DNS CNAME (`dns.tf`) to the app's CDN pull-zone host, and `deploy-staging.yml` rolls it forward by PATCHing the container image digest. The custom hostname's managed TLS is brought up by a two-step targeted apply (DNS records first, then a full apply once `dig` confirms propagation) — see the load-bearing `bunnynet_pullzone_hostname` comment in `bunny-staging.tf`.

### Durability — accept-loss

bunny volumes are **public preview**: **no backups, no replication**, and reattachment across a reschedule is **not guaranteed** (a node disk replacement yields an empty volume). There is **no recovery path**. This is accepted: staging data is low-stakes and `deploy-staging.yml` re-uploads the demo bundles on every deploy, so an empty-volume event is largely self-healing for bundles and only loses low-stakes event history.

### Deploy & drift control

`deploy-staging.yml` builds/pushes `:main`, captures the pushed **digest**, resolves the app id by name, then rolls the app via the official `BunnyWay/actions/container-update-image` action **pinned to a commit SHA** (`…@671d620…` = `0.2.2`; SHA-pinned because it receives `BUNNYNET_API_KEY`), passing `image_tag: main` + `image_digest: <digest>`, then polls `/readyz` for `gitSha`. **Updating the container image is the only documented rolling-update trigger** — a `/deploy` or `/restart` call does *not* re-pull — so a changing digest per deploy is required. (An inline `curl` PATCH of `/mc/apps/{id}/containers/{cid}` is an equivalent dependency-free alternative.)

Because CI/Bunny mutate container-image fields out-of-band and the provider manages them as attributes, the app resource declares `lifecycle { ignore_changes = [container[0].image_tag, container[0].image_digest, container[0].image_pull_policy] }`. CI owns the digest; Bunny's deploy/rolling-update also resets `image_pull_policy` to its default `IfNotPresent` (harmless under digest-pinning — each deploy pins a new digest that isn't present and so is pulled). TF stops managing all three so neither a deploy nor a `tofu apply` fights the other. This keeps the `plan-infra` empty-plan gate green after every deploy. Requires the `BUNNYNET_API_KEY` GitHub Actions secret (also used as `TF_VAR_bunnynet_api_key` by `plan-infra`/`apply-infra`).

### Readiness probe MUST be /livez, not /readyz

The Bunny `readiness_probe` targets **`/livez`** (pure process-liveness), NOT `/readyz`. `/readyz` runs deep checks that self-reach the app's own public `BASE_URL` (`domain` → `…/healthz`, `webhooks` → `…/webhooks/`). During a deploy Bunny serves a "We're deploying" **503** on that hostname *until* readiness passes — so gating readiness on `/readyz` **deadlocks**: the pod boots and listens fine but can never satisfy its own self-check, and Bunny retries the pod forever (staging stuck serving 503). `/livez` returns 200 the moment the process listens → the pod goes ready → Bunny routes → and then `/readyz`'s self-checks pass. The deploy pipeline still polls `/readyz` (the full-health + gitSha gate); only Bunny's traffic-gating probe uses `/livez`. Note Bunny's `min=max=1` deploys have a brief 503 downtime window (it can't run the new pod alongside the old with one node-bound volume) — acceptable for staging.

### Switching staging back to the VPS

There is **no `staging_backend` toggle variable** (low expected bounce). To revert: change the `staging.workflow-engine.stho.net` record in `dns.tf` from a CNAME (Bunny CDN host) back to an A record at the VPS IP and `tofu apply`. The VPS staging app is still live on current `:main`, and Caddy re-issues the staging cert automatically once DNS points back. The plan shows only that one record changing.

### SQL engine memory

libSQL (SQLite) does **not** auto-size a buffer pool to host RAM the way DuckDB did — its page cache is small and bounded (default a few MiB), so the DuckDB "sized to 80% of host RAM and got OOM-killed" failure mode no longer applies and no `memory_limit` knob is needed. The per-container `--memory=` cap remains load-bearing for the *runtime as a whole* (notably V8's heap; see the Quadlet template comment and "App OOM" above), just not for the SQL engine specifically.

## References

- `openspec/specs/infrastructure/spec.md`
- `openspec/specs/host-security-baseline/spec.md`
- `openspec/specs/ci-workflow/spec.md`
- `SECURITY.md §5`
