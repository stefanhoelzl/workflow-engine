## 1. Tofu: generalize into an env-keyed Bunny module

- [x] 1.1 Refactor `bunny-staging.tf` into an env-keyed Bunny config (`for_each`/locals over `{ staging, prod }`) producing per-env app, CDN endpoint, `bunnynet_pullzone_hostname`, `bunnynet_database`, `restful_operation` token mint, `bunnynet_storage_zone`, and sealing key. Staging values unchanged (`:main`, `staging.workflow-engine.stho.net`); prod values `:release`, `workflow-engine.stho.net`, memory budget carried from the old VPS `local.envs.prod` (350m), `AUTH_ALLOW` and `retention_days=90` carried over.
- [x] 1.2 Add `moved {}` blocks for EVERY existing staging Bunny resource (app, CDN, hostname, database, token mint, storage zone, `random_bytes.staging_secrets_key`) to their new env-keyed addresses so staging shows moves, not destroy/create.
- [x] 1.3 Add a `moved {}` block carrying `random_bytes.secrets_key["prod"]` to the prod env's sealing-key address. **Highest-blast-radius line** — verify in 6.2 that the plan shows a move and the rendered prod `SECRETS_PRIVATE_KEYS` is byte-identical.
- [x] 1.4 Wire the prod app env: `DATABASE_URL` from the prod `bunnynet_database.url`, `DATABASE_AUTH_TOKEN` from the prod token mint, NO `DATABASE_WAL`; `STORAGE_BACKEND=bunny` + `STORAGE_BUNNY_ENDPOINT=storage.bunnycdn.com` + prod `STORAGE_BUNNY_STORAGE_ZONE` + `STORAGE_BUNNY_ACCESS_KEY` from the prod zone `password`; `GITHUB_OAUTH_CLIENT_ID/SECRET` from the existing `*_PROD` TF_VARs; `BASE_URL=https://workflow-engine.stho.net`; readiness probe `/livez`; `lifecycle { ignore_changes = [container[0].image_tag, image_digest, image_pull_policy] }`. Keep the env block alphabetized by `name`.
- [x] 1.5 Update `dns.tf`: prod `workflow-engine` record flips from an A record (`scaleway_instance_ip`) to a CNAME at the prod Bunny CDN host; staging CNAME unchanged. No `scaleway_instance_ip` reference remains in DNS.
- [x] 1.6 Update `outputs.tf` so both env URLs source from the Bunny config; drop `vps_ip`, `ssh_port`, and `deploy_ssh_private_key` outputs.

## 2. Tofu: retire the VPS completely

- [x] 2.1 Lift `prevent_destroy` on the prod block volume so teardown can proceed.
- [x] 2.2 Delete `apps.tf`, `host.tf`, `caddy.tf`, `cloud-init.yaml`, `files/` (Quadlet + Caddyfile templates), and the `terraform.tfvars`/variables entries that only fed the VPS.
- [x] 2.3 Remove from `main.tf` the VPS **resources**: `scaleway_instance_server`, `scaleway_instance_ip`, the security group, `scaleway_block_volume.prod`, `local.envs`, `tls_private_key.deploy`, `terraform_data.cloud_init_bootstrap`, and the `null_resource.*` convergence. **Keep the `scaleway`/`null`/`tls` providers declared** (with the `provider "scaleway"` block + its vars/creds) — OpenTofu requires a resource's provider be present to *destroy* it, and these resources stay in state until the teardown apply. A fast-follow drops the three providers once the VPS is gone (step 6.9). Keep the `s3` backend + `encryption {}` block and the `bunnynet`/`random`/`magodo/restful` providers.
- [x] 2.4 Prune now-unused variables (`instance_type`, `instance_image`, `ssh_port`, `acme_email`, etc.) from `variables.tf`; keep `base_domain`, `bunnynet_api_key`, `state_passphrase`, the `gh_oauth_*` vars, and `auth_allow` inputs both envs need.
- [x] 2.5 Run `tofu init -upgrade` and refresh `.terraform.lock.hcl` with multi-platform hashes (all six providers remain for now: `bunnynet`, `random`, `magodo/restful` for the live config + `scaleway`, `null`, `tls` retained for the teardown).

## 3. CI workflows

- [x] 3.1 `deploy-prod.yml`: after build+push of `:release`, capture the digest and roll the **prod** Bunny app (SHA-pinned `BunnyWay/actions/container-update-image` or inline `curl` PATCH, app id resolved by name), then poll the prod `/readyz` for `gitSha`. Keep `environment: production`. Add the `BUNNYNET_API_KEY` secret; ensure no `TF_VAR_*`/`AWS_*`/`SCW_*`/SSH secret is referenced.
- [x] 3.2 `plan-infra.yml`: rename the job/status check `plan (vps)` → `plan (infra)`. Remove the `/tmp/wfe-secrets` host-env-file dummy-secrets step (the VPS `null_resource` env-file `filemd5` triggers are gone); keep passing the `TF_VAR_*` secrets so per-env Bunny env content-hashes render.
- [x] 3.3 Audit all workflows + `docs/` for stale `plan (vps)` references and update to `plan (infra)`.

## 4. Docs + spec hygiene

- [x] 4.1 Rewrite `docs/infrastructure.md` from the VPS+Bunny split to an all-Bunny topology: drop the VPS runbook (SSH, cloud-init ritual, Caddy upgrades, host convergence, block-volume/swap), generalize the Bunny sections to both envs, document the prod deploy roll, and keep the Bunny Database preview caveats. Move the cutover runbook reference to this change.
- [x] 4.2 Update `SECURITY.md` cross-references that pointed at Caddy / `host-security-baseline` for the edge-no-auth posture to point at the Bunny CDN (`bunny-deployment`); confirm §2 host-call boundary now references `sandbox-plugin`.
- [x] 4.3 Check `openspec/project.md` for VPS/Scaleway/Caddy staleness introduced by this change and update.

## 5. Validation (agent, against the source tree — no apply)

- [x] 5.1 `tofu fmt -check -recursive infrastructure/` and `tofu -chdir=infrastructure validate` pass.
- [x] 5.2 `pnpm validate` passes (lint, check, test). No runtime/SDK/`demo.ts` change is expected — confirm the diff is infra/CI/docs/specs only.
- [x] 5.3 `pnpm exec openspec validate migrate-prod-to-bunny` passes.

## 6. Cluster smoke (human) — operator cutover runbook

> Agents do NOT run `tofu apply` or touch prod data. The operator runs the choreographed three-apply cutover (design D2) plus the one-shot data migration (design D6/D12). Rehearse the migration commands against staging first.

- [ ] 6.1 **Rehearse migration on staging.** Copy staging's `events.db` (≤90d) into a throwaway Bunny DB via `@libsql/client` and `PUT` a sample bundle to a throwaway zone; confirm row counts and a `recover()`. Discard the throwaway resources.
- [x] 6.2 **Pre-flight plan.** On the feature branch run `tofu -chdir=infrastructure plan`. Confirm: the ONLY destroys are VPS resources; NO `random_bytes` is destroyed/created (prod + staging keys show `moved`); the rendered prod `SECRETS_PRIVATE_KEYS` is byte-identical to today. Do not proceed if any sealing key would regenerate.
- [x] 6.3 **apply #1 — stand up prod Bunny, VPS untouched.** Apply the module refactor + new prod resources (app, CDN, database+token, storage zone). `curl` the raw prod Bunny CDN host `/livez` → 200; confirm the prod Database + token + zone exist.
- [x] 6.4 **Maintenance window — consistent data migration.** `systemctl --user stop wfe-prod` on the VPS (quiesce writes). Pull `events.db` + the `workflows/` bundle tree off the VPS (subuid-owned — escalate as needed). `PUT` each `workflows/<owner>/<repo>.tar.gz` to the prod Edge Storage origin (`storage.bunnycdn.com`, prod zone access key). Dump `events.db` rows within the 90d window and replay into the prod Bunny Database via `@libsql/client`. Verify reads/writes + a `recover()` against the prod Bunny CDN host directly.
- [x] 6.5 **apply #2 — flip DNS (two-step).** Targeted-apply the prod `workflow-engine` A→CNAME first; wait for propagation + Bunny managed-TLS issuance; then confirm prod live on Bunny over `https://workflow-engine.stho.net` (valid TLS, OAuth round-trip, an authenticated route, a trigger). The cert MUST be live before apply #3.
- [x] 6.6 **apply #3 — destroy the VPS.** Run a full `tofu apply` (no `-target`). It destroys all VPS resources still in state (instance, IP, SG, prod block volume, `tls_private_key.deploy`, and the `null_resource.*` convergence — whose destroy-time provisioners SSH in and clean up, `on_failure=continue`). The `scaleway`/`null`/`tls` providers are still declared (required to perform these destroys). Confirm an empty `plan (infra)` afterward.
- [ ] 6.7 **Ruleset.** Rename the `main` branch ruleset required check `plan (vps)` → `plan (infra)` in lockstep with 3.2 (admin `gh api` action) so the renamed check doesn't block merges.
- [x] 6.8 **Post-cutover checks.** A push to `release` rolls the prod Bunny app and `/readyz` converges on the new `gitSha`; CDN does not cache dynamic/authenticated routes (`cdn-cache: MISS`); existing tenant workflows with sealed secrets still run with NO author re-upload (sealing key preserved).
- [x] 6.9 **Drop the teardown-only providers (folded into this change once the VPS was destroyed).** Removed the `scaleway`/`null`/`tls` entries from `required_providers`, the `provider "scaleway"` block, the `scaleway_*` vars + `terraform.tfvars`, and `SCW_*` from `plan-infra.yml` / `.proton.yaml`; re-init dropped the three from the lock. Plan stays empty. Keeps the Scaleway Object Storage **state backend** + its `AWS_*` creds — that is not the VPS. **Operator: delete the now-unused GitHub Actions secrets `SCW_ACCESS_KEY`, `SCW_SECRET_KEY` (and any `SCW_DEFAULT_*`).**

> **Rollback reality (design D2):** before apply #3, rollback is "flip the prod DNS back to the VPS IP" (the VPS still exists with its data). After apply #3 there is no rollback — fix-forward only.
