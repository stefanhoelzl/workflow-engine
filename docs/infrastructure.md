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
  cloud-init.yaml     # bootstraps deploy user, podman, sshd, ufw, fail2ban, sysctls
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

`apply-infra.yml` runs only on `workflow_dispatch`. Operator triggers it via the GitHub Actions UI. The workflow:

1. Renders per-env env files at `/tmp/wfe-secrets/<env>.env` on the runner from GHA secrets (`GH_OAUTH_CLIENT_ID_PROD`, `GH_OAUTH_CLIENT_SECRET_PROD`, `AUTH_ALLOW_PROD`, etc.) via `umask 077` heredoc.
2. Runs `tofu init && tofu apply` against `infrastructure/`.
3. Always cleans up `/tmp/wfe-secrets/`.

Tofu's `null_resource.wfe_env_file` uses `provisioner "file"` with `source = "/tmp/wfe-secrets/<env>.env"`. The bytes are read at apply time and streamed over SSH; only the file's md5 hash and the path string land in state. No plaintext secret ever enters tofu state.

**When to run apply-infra.** Any PR touching `infrastructure/`. The pre-merge `plan (vps)` gate fails if the plan is non-empty, so the operator runs `apply-infra` from the feature branch *before* requesting review.

## Pre-merge plan gate

`.github/workflows/plan-infra.yml` runs on every PR to `main`. Single job named `plan (vps)`:

- Renders dummy empty env files at `/tmp/wfe-secrets/{prod,staging}.env` so `filemd5(...)` triggers can evaluate.
- `tofu init && tofu plan -detailed-exitcode -lock=false -no-color`.
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
- `TF_VAR_deploy_ssh_public_key`, `TF_VAR_deploy_ssh_private_key` — keypair for the `deploy` user
- `GH_OAUTH_CLIENT_ID_PROD`, `GH_OAUTH_CLIENT_SECRET_PROD` — prod GitHub OAuth App
- `GH_OAUTH_CLIENT_ID_STAGING`, `GH_OAUTH_CLIENT_SECRET_STAGING` — staging GitHub OAuth App
- `GH_UPLOAD_TOKEN` — fine-grained PAT for `wfe upload` (staging only)

Variables:

- `AUTH_ALLOW_PROD`, `AUTH_ALLOW_STAGING` — `AUTH_ALLOW` value per env

## SSH access

```
ssh -p 2222 deploy@<vps-ip>
```

The `deploy` user is the only SSH-able account. Root login is disabled. Password auth is disabled. `fail2ban` bans the IP after 5 failed auths in 10 min.

Once on the box:

- Inspect logs: `journalctl -u wfe-prod -u wfe-staging -u caddy --since "1 hour ago"`
- Check unit status: `systemctl status wfe-prod wfe-staging caddy`
- Check auto-update: `journalctl -u podman-auto-update.service` and `systemctl list-timers podman-auto-update.timer`
- Force a deploy now: `sudo systemctl start podman-auto-update.service`
- Inspect Caddy ACME state: `ls -la /srv/caddy/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/`
- Inspect persistence: `ls /srv/wfe/{prod,staging}/`

The `deploy` user has NOPASSWD sudo only for `systemctl <verb> <unit>.service` on the wfe / caddy / podman-auto-update units, and `systemctl daemon-reload`. Anything broader requires the root password.

## Secret rotation

GitHub OAuth client secret (or any other env-file value):

1. Update the GHA secret in repo settings.
2. Re-run `apply-infra` (workflow_dispatch).
3. The `null_resource.wfe_env_file` `filemd5` trigger detects the change; tofu re-runs the file + remote-exec provisioners; the affected unit restarts.

SSH deploy key:

1. Generate a new keypair locally.
2. Update `TF_VAR_DEPLOY_SSH_PUBLIC_KEY` and `TF_VAR_DEPLOY_SSH_PRIVATE_KEY` GHA secrets together.
3. Re-run `apply-infra`. Cloud-init re-runs the deploy-user authorized_keys write; the new key takes effect immediately.
4. Old key is invalidated as soon as the new authorized_keys file lands.

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
