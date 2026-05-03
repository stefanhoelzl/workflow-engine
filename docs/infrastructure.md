# Infrastructure

Production runbook for the single-VPS deployment. Local-dev instructions live in `CLAUDE.md` (`pnpm dev` is the only local mode).

## Topology

One Scaleway VPS (Debian 12) hosts both prod and staging. Three rootless Podman + systemd Quadlet units:

- `caddy.service` — TLS-terminating reverse proxy. Binds `0.0.0.0:80` and `0.0.0.0:443`. Let's Encrypt certs via the built-in HTTP-01 ACME client; state on the host bind mount `/srv/caddy/data`.
- `wfe-prod.service` — image `ghcr.io/stefanhoelzl/workflow-engine:release`. Binds `127.0.0.1:8081 → :8080`. Persistence at `/srv/wfe/prod`.
- `wfe-staging.service` — image `ghcr.io/stefanhoelzl/workflow-engine:main`. Binds `127.0.0.1:8082 → :8080`. Persistence at `/srv/wfe/staging`.

URLs:

- Prod: <https://workflow-engine.webredirect.org>
- Staging: <https://staging.workflow-engine.webredirect.org>

DNS: Dynu A records owned by tofu, point at the VPS public IP (`scaleway_instance_ip` — stable across instance stop/start).

## Authentication

Caddy is a pure TLS terminator + reverse proxy. It performs no authentication, no forward-auth, no header injection. The workflow-engine app owns every URL prefix and mounts `sessionMiddleware` (`/dashboard/*`, `/trigger/*`) and `apiAuthMiddleware` (`/api/*`) in-process. See `openspec/specs/auth/spec.md` and `SECURITY.md §4`.

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
  dns.tf              # Dynu A records
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
2. Poll `https://staging.workflow-engine.webredirect.org/readyz` until `version.gitSha === ${{ github.sha }}`. Auto-update timer fires every 1 min.
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

VPS replacement destroys the local SSD root, including `/srv/wfe/<env>` (event-store) and `/srv/caddy/data` (ACME state). To preserve data across the rebuild:

```bash
# 1. Backup before applying.
rsync -aAX deploy@<host>:/srv/wfe/prod /tmp/prod-pre-apply-$(date +%F)
rsync -aAX deploy@<host>:/srv/caddy/data /tmp/caddy-pre-apply-$(date +%F)

# 2. Apply the change. tofu will plan a `-/+ destroy and then create
# replacement` for scaleway_instance_server.vps — that's expected.
tofu -chdir=infrastructure apply

# 3. Wait for the new VPS to come up. ssh in as deploy.

# 4. Restore data with correct ownership.
rsync -aAX /tmp/prod-pre-apply-<date>/ deploy@<host>:/tmp/restore-prod/
ssh deploy@<host> "sudo /usr/bin/install -d -m 0700 -o wfe-prod -g wfe-prod /srv/wfe/prod && sudo cp -a /tmp/restore-prod/. /srv/wfe/prod/ && sudo /usr/bin/chown -R wfe-prod:wfe-prod /srv/wfe/prod && rm -rf /tmp/restore-prod"

# 5. Restart services. (Caddy will re-issue ACME certs from scratch unless
# /srv/caddy/data was also restored.)
ssh deploy@<host> "sudo /usr/bin/runuser -u wfe-prod -- env XDG_RUNTIME_DIR=/run/user/$(id -u wfe-prod) /bin/systemctl --user restart wfe-prod.service"
ssh deploy@<host> "sudo /usr/bin/runuser -u wfe-caddy -- env XDG_RUNTIME_DIR=/run/user/$(id -u wfe-caddy) /bin/systemctl --user restart caddy.service"
```

For staging, data loss is acceptable; skip the rsync.

**Forcing a rebuild without a content edit.** If you need to re-bake the bootstrap minimum without changing the source (e.g., to rotate the in-memory session-sealing password by recycling all containers), run `tofu -chdir=infrastructure taint scaleway_instance_server.vps && tofu apply`. Same data-loss caveats; same rsync ritual applies.

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
- `TF_VAR_dynu_api_key` — Dynu API key for DNS records
- `TF_VAR_acme_email` — Let's Encrypt account email
- `GH_OAUTH_CLIENT_ID_PROD`, `GH_OAUTH_CLIENT_SECRET_PROD` — prod GitHub OAuth App
- `GH_OAUTH_CLIENT_ID_STAGING`, `GH_OAUTH_CLIENT_SECRET_STAGING` — staging GitHub OAuth App
- `GH_UPLOAD_TOKEN` — fine-grained PAT for `wfe upload` (staging only)

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
- Dynu CNAME not yet propagated → `dig` from an external resolver.
- Port 80 firewall rule missing → `sudo ufw status`.
- LE rate-limit hit (5 failed challenges/hour per domain) → wait 1 hour.

Caddy retries on its own backoff (default: every 9 min for the first hour, exponential thereafter).

**App OOM.**

Check: `journalctl -u wfe-prod -u wfe-staging | grep -i oom`.

Per-Quadlet `MemoryMax=350M` (per app on STARDUST1-S) keeps each app's blast radius contained to its own unit. The 1 GiB swapfile absorbs transient bursts. If OOM kills become recurrent:
1. Inspect the workload — sandbox worker leak? Action with unbounded buffer?
2. Bump `MemoryMax=` in `infrastructure/files/wfe.container.tmpl` and re-apply.
3. If both apps need more, upgrade the VPS commercial type (`var.instance_type`) and re-apply (instance is recreated).

**`/readyz` reports old `gitSha` after deploy.**

The auto-update timer hasn't ticked yet. Wait up to 60 s. If still stale after 5 min:
- Check the timer is enabled: `systemctl is-enabled podman-auto-update.timer`.
- Check the last run: `journalctl -u podman-auto-update.service --since "10 min ago"`.
- Force a pull: `sudo systemctl start podman-auto-update.service`.

## Risks (carry these in your head)

- **No backups.** `/srv/wfe/<env>` and `/srv/caddy/data` have no off-box copy. A VPS-loss event is total data loss until users re-upload bundles via `wfe upload`. Top-priority follow-up.
- **No rollback for infra.** Cutover is one-way; fix-forward is the only mode. App rollback (`git revert` + auto-update) is the fast path for app bugs.
- **Single VPS, single region.** Hardware failure causes downtime until manual re-provision.
- **Host kernel is the only isolation boundary** between prod and staging. Mitigated by `unattended-upgrades`.

## References

- `openspec/specs/infrastructure/spec.md`
- `openspec/specs/host-security-baseline/spec.md`
- `openspec/specs/ci-workflow/spec.md`
- `SECURITY.md §5`
