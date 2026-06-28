## 1. Relocate staging config out of `local.envs`

- [x] 1.1 In `infrastructure/main.tf`, remove the `staging = { … }` entry from `local.envs` so `local.envs` enumerates only the `prod` VPS env (keep it a map keyed by env name — do not collapse to a scalar).
- [x] 1.2 In `infrastructure/bunny-staging.tf`, replace `local.bunny_staging = local.envs["staging"]` with an inlined `local` carrying the staging config Bunny needs: `domain = "staging.workflow-engine.${var.base_domain}"`, `dns_node = "staging.workflow-engine"`, `auth_allow = "github:user:stefanhoelzl"`, `retention_days = 1`, and the OAuth client id/secret var references. Keep all downstream `local.bunny_staging.*` reads working.
- [x] 1.3 In `infrastructure/dns.tf`, change `bunnynet_dns_record.staging_cname`'s `name` to source the staging `dns_node` from the relocated Bunny local instead of `local.envs["staging"]`. The record `type`, `value` (Bunny CDN host), and `ttl` are UNCHANGED — this must produce no plan diff on the record itself.
- [x] 1.4 In `infrastructure/outputs.tf`, keep a `staging` entry in the `urls` output, sourced from the relocated Bunny local (so `tofu output urls` still lists prod + staging). The `prod` entry continues to derive from `local.envs`.

## 2. Standalone Bunny sealing key (D2)

- [x] 2.1 In `infrastructure/bunny-staging.tf`, declare a standalone `random_bytes` resource (32 bytes, e.g. `random_bytes.staging_secrets_key`) for the Bunny app's sealing key.
- [x] 2.2 Point the Bunny app's `SECRETS_PRIVATE_KEYS` env at `v1:${random_bytes.staging_secrets_key.base64}` instead of `random_bytes.secrets_key["staging"]`. (The old keyed instance is destroyed when `local.envs` loses `staging` — accepted; new key, one-time unseal gap closed by the next deploy's re-upload.)

## 3. Remove VPS staging resources

- [x] 3.1 In `infrastructure/main.tf`, delete `resource "scaleway_block_volume" "staging"` and remove `scaleway_block_volume.staging.id` from the instance's `additional_volume_ids` list.
- [x] 3.2 In `infrastructure/host.tf`: drop the `"wfe-staging"` entry from `local.managed_users`; drop `"wfe-staging"` from `local.tenants`; drop the `staging = scaleway_block_volume.staging.id` line from `local.data_volume_ids`; and drop the hardcoded `"/srv/wfe/staging"` entry from `local.managed_dirs`. (The per-tenant dir loops, subuid content, `srv-wfe-<env>.mount`, `enable_data_mounts_script`, and `disk-cleanup.sh` tenants param all derive from those locals and `local.envs`, so they shed staging automatically.)
- [x] 3.3 Confirm `infrastructure/apps.tf` (Quadlet + env file, iterates `local.envs`) and `infrastructure/caddy.tf` (Caddyfile sites, iterates `local.envs`) now render prod-only with no manual edits — the `wfe-staging` Quadlet, `/etc/wfe/staging.env`, and the `staging.*` Caddy site block are gone.

## 4. Reframe comments + docs (full reframe)

- [x] 4.1 Rewrite the `infrastructure/bunny-staging.tf` header comment: drop "spike / in parallel with the VPS / warm fallback" framing; state Bunny is the sole staging backend.
- [x] 4.2 Update the `main.tf` `bunnynet` provider comment (and `required_providers` note) if it frames Bunny staging as a spike running alongside a VPS fallback.
- [x] 4.3 `docs/infrastructure.md`: host topology (three Quadlets → two: `wfe-prod` + `caddy`); the persistence/volume table (drop the staging Block Storage row); the tenant-user list (`wfe-prod`, `wfe-caddy`); journalctl/troubleshooting commands that reference `wfe-staging`; and the "Staging on bunny.net Magic Containers" section reframed to "sole backend". **Delete the "Switching staging back to the VPS" section** and any warm-fallback language.
- [x] 4.4 Optional cleanup: `infrastructure/variables.tf` descriptions that imply staging is an `apps.tf`/VPS env (e.g. `app_image` "chosen per-env in apps.tf") — adjust to reflect that `:main` is consumed by `bunny-staging.tf`.

## 5. Verification (agent — static)

- [x] 5.1 `tofu fmt -check -recursive infrastructure/` passes.
- [x] 5.2 `tofu -chdir=infrastructure init -backend=false` (or operator-credentialed `init`) then `tofu -chdir=infrastructure validate` passes.
- [x] 5.3 `pnpm exec openspec validate remove-vps-staging` passes.
- [x] 5.4 Grep `infrastructure/` and `docs/infrastructure.md` for residual `wfe-staging`, `/srv/wfe/staging`, `staging.env`, "warm fallback", "Switching staging back to the VPS" — only intended references remain (the Bunny staging hostname/CNAME and the relocated Bunny config).
- [x] 5.5 PR summary: surface that this is a destroy-heavy, non-empty plan and that the operator must run `apply-infra` from the branch **before** merge (agents do NOT run `tofu apply`); note the brief prod stop/start.

> No `pnpm dev` probe: this change touches only `infrastructure/` + docs, with no runtime, SDK, or sandbox-stdlib surface change. Behavioral verification is the cluster smoke below.

## 6. Apply procedure (operator — two-step, load-bearing)

A single `tofu apply` does NOT reliably detach the staging volume before deleting it (the config no longer references it from the instance, so OpenTofu drops the detach-before-delete edge → the provider deletes an attached volume → `waiting for Volume failed: timeout after 5m0s`). Apply in two steps:

- [x] 6.1 **Detach first:** `tofu apply -target=scaleway_instance_server.vps` — updates `additional_volume_ids` to prod-only, detaching the staging volume. (Observed as a ~2 s *live* hot-detach, not a stop/start; prod downtime effectively nil.)
- [x] 6.2 **Delete + reconcile:** `tofu apply` — the now-detached `scaleway_block_volume.staging` deletes cleanly, and the host-convergence files recreate. Result: `8 added, 0 changed, 1 destroyed`.
- [x] 6.3 **Clean up the orphaned `wfe-staging` OS user** (tofu can't — `userdel` failed closed on the running container/`systemd --user`, but `on_failure=continue` removed the user from state). SSH in as `deploy` and: `loginctl disable-linger wfe-staging` → `systemctl stop user@$(id -u wfe-staging).service` → `pkill -KILL -u wfe-staging` → `userdel --remove wfe-staging`. Verify `id wfe-staging` fails and `free -m` shows the ~350 MB reclaimed.

## Cluster smoke (human)

This change retires the VPS staging stack and detaches its block volume; verify on the VPS after the two-step apply (§6):

- [x] The applies show: `scaleway_block_volume.staging` destroyed, the `wfe-staging` managed-user/dir/mount/quadlet/env-file `null_resource`s destroyed, the instance `additional_volume_ids` updated to prod-only (live hot-detach), `random_bytes.secrets_key["staging"]` destroyed + `random_bytes.staging_secrets_key` created, the Bunny app's `SECRETS_PRIVATE_KEYS` updated — with **no diff on `bunnynet_dns_record.staging_cname`** and **no destroy/replace of any prod resource**.
- [x] After apply, prod recovers: `curl -sf https://workflow-engine.stho.net/readyz` returns `status: pass` and `findmnt /srv/wfe/prod` shows the prod volume still mounted.
- [x] Staging is unaffected throughout: `curl -sf https://staging.workflow-engine.stho.net/readyz` (served by Bunny) stays healthy; `dig staging.workflow-engine.stho.net` still CNAMEs to the Bunny CDN host.
- [x] VPS staging is gone: `id wfe-staging` fails (no such user); `systemctl --user -M wfe-staging@ status wfe-staging.service` / `srv-wfe-staging.mount` are absent; `/srv/wfe/staging` is gone; the Scaleway console shows the `wfe-staging-data` volume deleted.
- [x] A follow-up `plan (vps)` on the PR branch is **empty** (gate green) so the PR can merge.
