## 1. Pre-work: Dockerfile + /readyz wiring

- [x] 1.1 Add `ARG GIT_SHA` to `Dockerfile` and `ENV APP_GIT_SHA=${GIT_SHA}` so the running image embeds the SHA. Default to `dev` when the arg is unset (`ARG GIT_SHA=dev`).
- [x] 1.2 Update `.github/actions/docker-build` composite action (or its wrapping calls) to forward `--build-arg GIT_SHA=${{ github.sha }}`.
- [x] 1.3 Add a unit test in `packages/runtime/src/health.test.ts` confirming `/readyz` body contains `version.gitSha === <APP_GIT_SHA>` and defaults to `"dev"` when unset.
- [x] 1.4 Make ghcr.io packages `workflow-engine` public via `gh api`. Verify `docker pull ghcr.io/<owner>/workflow-engine:main` succeeds anonymously.

## 2. New `infrastructure/` project (flat layout)

- [x] 2.1 Create `infrastructure/main.tf` declaring `terraform { required_version = ">= 1.11.0" }`, the `s3` backend block targeting Scaleway Object Storage (with `endpoint`, `skip_credentials_validation = true`, `skip_region_validation = true`), the `encryption` block sourced from `var.state_passphrase`, and `provider "scaleway"` + `provider "dynu"`.
- [x] 2.2 Create `infrastructure/variables.tf` with: `state_passphrase`, `dynu_api_key`, `deploy_ssh_public_key`, `deploy_ssh_private_key`, `acme_email`, `prod_domain`, `staging_domain`, `instance_type` (default `VPS-START-2-S`), `ssh_port` (default `2222`).
- [x] 2.3 Create `infrastructure/cloud-init.yaml` templated with `templatefile()`. Bake in: deploy user creation, podman + fail2ban + unattended-upgrades install, subuid range allocation, sysctl `net.ipv4.ip_unprivileged_port_start=80`, sshd hardening (port `${ssh_port}`, no root, key-only, `AllowUsers deploy`, `MaxAuthTries 3`, `LoginGraceTime 20s`), firewall (default-deny, allow 80/443/`${ssh_port}`), enable `fail2ban` + `unattended-upgrades`, enable `podman-auto-update.timer` with a `/etc/systemd/system/podman-auto-update.timer.d/override.conf` setting `OnUnitActiveSec=1min`, create `/etc/wfe/` (0700 deploy:deploy), `/srv/wfe/{prod,staging}` (0700 deploy:deploy), `/srv/caddy/data` (per Caddy needs).
- [x] 2.4 Create `infrastructure/main.tf` (continued): `scaleway_instance_ip` + `scaleway_instance_server` resource referencing the rendered cloud-init.
- [x] 2.5 Create `infrastructure/files/Caddyfile.tmpl` rendering one site block per env with `tls ${acme_email}` and `reverse_proxy 127.0.0.1:${port}`.
- [x] 2.6 Create `infrastructure/files/wfe.container.tmpl` for app Quadlet units (parameters: `env_name`, `image_ref`, `host_port`, `data_dir`). Includes `Label=io.containers.autoupdate=registry`, `PublishPort=127.0.0.1:${host_port}:8080`, `Volume=${data_dir}:/data:Z`, `EnvironmentFile=/etc/wfe/${env_name}.env`, `Environment=PERSISTENCE_PATH=/data`, `Restart=always`, `[Install] WantedBy=default.target`.
- [x] 2.7 Create `infrastructure/files/caddy.container.tmpl` for the Caddy unit. Mount Caddyfile + ACME data volume, expose 80 + 443.
- [x] 2.8 Create `infrastructure/caddy.tf`: `null_resource` that depends on the VPS, copies the rendered Caddyfile and `caddy.container` over SSH via `file` + `remote-exec` provisioners, then starts the unit.
- [x] 2.9 Create `infrastructure/apps.tf`: two `null_resource`s (one per env) for the Quadlet `.container` files, each with `triggers = { content_hash = sha256(<rendered template>) }` so a Quadlet edit triggers `systemctl daemon-reload && systemctl restart`.
- [x] 2.10 Create `infrastructure/apps.tf` (continued): two more `null_resource`s for the env-file delivery — `triggers = { content_hash = filemd5("/tmp/wfe-secrets/<env>.env") }`, `provisioner "file"` with `source = "/tmp/wfe-secrets/<env>.env"`, `provisioner "remote-exec"` running `chmod 600`, `chown deploy:deploy`, `sudo systemctl restart wfe-<env>`.
- [x] 2.11 Create `infrastructure/main.tf` (continued): two `dynu_dns_record` resources for `prod_domain` and `staging_domain` CNAME-targeted at the VPS IP, TTL ≤ 300.
- [x] 2.12 Create `infrastructure/outputs.tf`: `vps_ip`, `prod_url`, `staging_url`.
- [x] 2.13 Run `tofu -chdir=infrastructure init` against a personal Scaleway Object Storage bucket and a personal Scaleway project; commit the resulting `infrastructure/.terraform.lock.hcl`.
- [x] 2.14 Add `infrastructure/.terraform/`, `infrastructure/*.tfstate*` (defensive — state lives in S3, but covers accidental local apply) and `infrastructure/terraform.tfvars` (if any operator-local vars) to `.gitignore`.

## 3. Pre-merge end-to-end smoke (operator, throwaway VPS)

- [x] 3.1 Provision a personal Scaleway Object Storage bucket for tofu state. Set `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` to its scoped credentials.
- [x] 3.2 Render `/tmp/wfe-secrets/{prod,staging}.env` locally with throwaway OAuth credentials pointing at temporary subdomain redirects.
- [x] 3.3 Run `tofu -chdir=infrastructure apply` from the feature branch; observe cloud-init complete, Quadlet units come up.
- [x] 3.4 Verify Caddy obtains LE certs against the temporary subdomains; `curl -I https://<temp>.example` returns `200` with a publicly-trusted cert.
- [x] 3.5 Verify `/readyz` on both subdomains returns `version.gitSha === <expected>`.
- [x] 3.6 Verify `wfe upload` succeeds against the staging subdomain.
- [x] 3.7 Verify `journalctl -u podman-auto-update.timer` shows ticks every 1 min; verify a deliberate ghcr push of `:main` triggers a pull within 60 s.
- [x] 3.8 Run `tofu destroy`; verify Scaleway resources are torn down cleanly.

## 4. New GitHub Actions workflows

- [x] 4.1 Rewrite `.github/workflows/deploy-staging.yml`: run on `push` to `main`, build + push `ghcr.io/<owner>/workflow-engine:main` with `GIT_SHA=${{ github.sha }}`. After push, poll `https://staging.workflow-engine.webredirect.org/readyz` until `version.gitSha === ${{ github.sha }}` (5-min budget). Then run `wfe upload` step (preserved from current workflow). No tofu, no SSH.
- [x] 4.2 Rewrite `.github/workflows/deploy-prod.yml`: run on `push` to `release`, declare `environment: production`, after approval build + push `ghcr.io/<owner>/workflow-engine:release` with `GIT_SHA=${{ github.sha }}`. No tofu, no SSH, no upload.
- [x] 4.3 Rewrite `.github/workflows/plan-infra.yml`: single job (no matrix), on `pull_request` to `main`, render dummy `/tmp/wfe-secrets/{prod,staging}.env`, `tofu init && tofu plan -detailed-exitcode -lock=false -no-color` in `infrastructure/`. Pipe plan to `$GITHUB_STEP_SUMMARY`. Exit 0 → pass; 1 or 2 → fail. Status check name: `plan (vps)`.
- [x] 4.4 ~~Create `apply-infra.yml`~~ — superseded: the `apply-infra` GHA workflow was deleted. `tofu apply` is operator-local only. The `null_resource.wfe_env_file` `source =` pattern still applies; the operator renders `/tmp/wfe-secrets/<env>.env` locally before running apply.
- [x] 4.4b Extract shared `.github/actions/deploy-image/` composite action — encapsulates ghcr login + `docker-build` + `/readyz` SHA-convergence poll. Both `deploy-prod.yml` and `deploy-staging.yml` consume it.
- [x] 4.5 Updated the `main` ruleset via `gh api`: required check renamed from old `plan (cluster|persistence|staging|prod)` matrix to single `plan-infra`. Persisted to `.github/rulesets/main.json` so `sync-rulesets.yml` keeps it after merge.
- [x] 4.6a `SCW_ACCESS_KEY`, `SCW_SECRET_KEY`, `TF_VAR_dynu_api_key`, `TF_VAR_state_passphrase`, `GH_UPLOAD_TOKEN`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (now Scaleway state bucket creds) all present. `SCW_DEFAULT_PROJECT_ID` / `SCW_DEFAULT_ORGANIZATION_ID` / `TF_VAR_acme_email` no longer needed (committed to `infrastructure/terraform.tfvars`). `GH_OAUTH_CLIENT_*_{PROD,STAGING}` no longer GHA secrets — they're consumed only at operator-local apply time and live in the operator's local secret store.
- [x] 4.6b Add the SSH keypair for `deploy`: `ssh-keygen -t ed25519 -f ~/.ssh/wfe-deploy -C wfe-deploy@github-actions -N ''` then `gh secret set TF_VAR_DEPLOY_SSH_PRIVATE_KEY < ~/.ssh/wfe-deploy` + `gh secret set TF_VAR_DEPLOY_SSH_PUBLIC_KEY < ~/.ssh/wfe-deploy.pub`.
- [x] 4.7 Removed obsolete: `GH_APP_CLIENT_ID_PROD`, `GH_APP_CLIENT_ID_STAGING`, `GH_APP_CLIENT_SECRET_PROD`, `GH_APP_CLIENT_SECRET_STAGING`. `TF_VAR_UPCLOUD_TOKEN` was already not in GHA.

## 5. Delete K8s-shaped code, modules, and envs

- [x] 5.1 Delete `infrastructure/envs/cluster/`.
- [x] 5.2 Delete `infrastructure/envs/prod/`.
- [x] 5.3 Delete `infrastructure/envs/staging/`.
- [x] 5.4 Delete `infrastructure/envs/persistence/`.
- [x] 5.5 Delete `infrastructure/envs/local/` (the kind-based local cluster).
- [x] 5.6 Delete `infrastructure/modules/kubernetes/`, `modules/object-storage/`, `modules/app-instance/`, `modules/baseline/`, `modules/caddy/`, `modules/dns/` (if it has no remaining consumers), `modules/image/` (if K8s-specific).
- [x] 5.7 Delete `scripts/prune-legacy-storage.ts` and any other K8s/S3-era one-shot scripts referenced from `docs/upgrades.md` or CLAUDE.md.
- [x] 5.8 Remove `pnpm local:up`, `pnpm local:up:build`, `pnpm local:destroy` script entries from the root `package.json`.
- [x] 5.9 Verify `grep -r "kind\|upcloud\|envs/cluster\|envs/persistence\|infrastructure/modules/kubernetes" .` returns no matches outside historical openspec archives.

## 6. Documentation

- [x] 6.1 Rewrite `docs/infrastructure.md` from scratch for the new VPS shape. Structure: Production setup (one-time), Steady-state operations (deploys, secret rotation, Caddy upgrades, log inspection), Operator runbook (apply-infra workflow, SSH access, sudo scope), Failure modes (auto-update stuck, OOM, cert renewal failed). Remove all K8s/Caddy-as-manifest content.
- [x] 6.2 Update `CLAUDE.md`: replace "Infrastructure (OpenTofu + kind)" section with VPS-shaped equivalent. Drop `pnpm local:up*` references. Drop "Cluster smoke (human)" pattern from the `tasks.md` section. Add a brief note that `pnpm dev` is now the only local mode.
- [x] 6.3 Rewrite `SECURITY.md §5`: new isolation posture (rootless Podman + per-Quadlet subuid + host firewall + scoped sudo + sshd hardening + fail2ban + secret-file modes). Cross-reference `host-security-baseline` capability. Remove K8s-specific items (PSA, NetworkPolicy, K8s Secrets, ServiceAccount tokens). Update §3 references to point at `infrastructure` (Caddy section) instead of removed `reverse-proxy` capability.
- [x] 6.4 Update `openspec/project.md` Infrastructure line: replace "OpenTofu (HCL), kind (local K8s), Traefik (Helm + IngressRoute CRDs), oauth2-proxy, S2 (local S3)" with "OpenTofu (HCL), Scaleway VPS, Podman + Quadlet, Caddy (rootless), local-disk persistence". Update any other stale references.
- [x] 6.5 Update `docs/upgrades.md`: remove the `prune-legacy-storage.ts` step (script is deleted); add a "Migrating from K8s shape" historical note pointing readers at the migration commit.
- [x] 6.6 Update `packages/tests/README.md` and any other docs referencing kind / `pnpm local:up*`.

## 7. Validate locally

- [x] 7.1 `pnpm validate` (lint + check + test + tofu fmt + tofu validate).
- [x] 7.2 `tofu -chdir=infrastructure fmt -check` and `tofu -chdir=infrastructure validate`.
- [x] 7.3 `pnpm exec openspec validate migrate-to-vps --strict`.
- [x] 7.4 Manually simulate the `plan-infra` workflow locally: render dummy `/tmp/wfe-secrets/`, run `tofu plan -detailed-exitcode` against the Scaleway backend, confirm exit 0 (clean plan after operator-applied state).

## 8. Cutover (single PR merge to `main`; one-way; no rollback)

> **Note:** The UpCloud K8s stack was destroyed out-of-band before this migration began. Both prod and staging URLs are currently returning DNS NXDOMAIN / connection refused. The "validation gates" below are first-deploy success criteria, not side-by-side comparisons. Until step 8.2 completes successfully, the service is offline.


- [ ] 8.1 Open the PR. Reviewer reads the proposal + design + spec deltas. Address review comments by force-pushing the feature branch (note: `release` branch protection is unchanged; this PR is against `main`).
- [x] 8.2 With the PR open, operator runs `tofu -chdir=infrastructure apply` **locally** (apply-infra GHA workflow was removed). Render `/tmp/wfe-secrets/{prod,staging}.env` first via the operator's local secret store; then apply provisions the production Scaleway VPS, writes Quadlet units, copies env files, and creates the Dynu A records pointing at the VPS IP.
- [ ] 8.3 Verify cutover validation gates (deploy success criteria — these are NOT rollback triggers):
  - [ ] 8.3.1 `curl -I https://workflow-engine.webredirect.org` → `200` with publicly-trusted LE cert.
  - [ ] 8.3.2 `curl -I https://staging.workflow-engine.webredirect.org` → `200` with publicly-trusted LE cert.
  - [ ] 8.3.3 `GET /readyz` on both URLs → `200` with `version.gitSha` matching the latest pushed image SHA.
  - [ ] 8.3.4 GitHub OAuth login flow works end-to-end on both envs (manual click-through).
  - [ ] 8.3.5 `wfe upload` succeeds against staging (run manually pre-merge or wait for the next `main` push).
  - [ ] 8.3.6 A canonical `demo.ts` trigger fires and produces an event visible in the dashboard.
  - [ ] 8.3.7 `dig workflow-engine.webredirect.org` and `dig staging.workflow-engine.webredirect.org` from at least one external resolver show the new IP.
- [ ] 8.4 If any validation gate fails: fix forward (edit code → re-run local `tofu apply`). Do NOT attempt to revert; there is no rollback strategy.
- [ ] 8.5 Once gates pass, merge the PR to `main`. Cherry-pick the merge commit to `release` and push (triggers `deploy-prod`, requires reviewer approval).
- [x] 8.6 ~~Destroy old UpCloud K8s stack~~ — already done out-of-band before the migration PR landed (operator ran `tofu destroy` on `staging`, `prod`, `cluster`, `persistence` envs; UpCloud resources fully torn down).
- [x] 8.7 Tear down the now-empty UpCloud project itself; rotate/revoke `TF_VAR_UPCLOUD_TOKEN`.
- [x] 8.8 Delete the obsolete repo secrets enumerated in 4.7 from GitHub Actions.
- [ ] 8.9 Update the operator's password manager: VPS root password, `deploy` SSH private key location, Scaleway API tokens.

## 9. Post-cutover smoke (within 24 h)

- [ ] 9.1 Confirm a real `main`-branch push triggers `deploy-staging`, the readiness gate sees the new gitSha within 5 min, and `wfe upload` succeeds.
- [ ] 9.2 Confirm a real `release`-branch push triggers `deploy-prod`, awaits approval, and the auto-update timer rotates the prod unit within ~1 min of the push completing.
- [ ] 9.3 Inspect `journalctl -u wfe-prod -u wfe-staging --since "1 hour ago"` for OOM kills, restart loops, or unexpected errors.
- [ ] 9.4 Confirm `fail2ban-client status sshd` is active. Confirm `unattended-upgrades` ran at least once (`/var/log/unattended-upgrades/`).
- [ ] 9.5 Open follow-up issue(s): "add backups for /srv/wfe/* and /srv/caddy/data" (top-priority), "consider GH OIDC → short-lived SSH cert", "consider AppArmor / seccomp profiles for the apps".
