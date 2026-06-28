## 1. Provider

- [x] 1.1 `infrastructure/main.tf`: add the restful provider to `required_providers` — source `magodo/restful` (the OpenTofu-registry namespace for Mastercard/restful; `registry.opentofu.org` has no `mastercard/restful`), pinned `~> 0.25.2`. Configure a `restful` provider block in `bunny-staging.tf` with `base_url = "https://api.bunny.net/database"` and the `AccessKey = var.bunnynet_api_key` header.
- [x] 1.2 `infrastructure/.terraform.lock.hcl`: refresh with multi-platform hashes for the new provider (`tofu providers lock -platform=linux_amd64 -platform=darwin_amd64 -platform=darwin_arm64 -platform=windows_amd64`, matching the existing platform set).

## 2. Bunny Database resource

- [x] 2.1 `infrastructure/bunny-staging.tf`: add `resource "bunnynet_database" "staging"` with `name` (e.g. `wfe-staging`), `regions_primary = ["DE"]`, no `regions_replica`.
- [x] 2.2 Add a short comment documenting accept-loss (preview: 1 GB/DB, no automatic backups/replication) and that this DB backs the event-store + queues for the Bunny MC staging app only.

## 3. In-tofu token mint

- [x] 3.1 `infrastructure/bunny-staging.tf`: add a `restful_operation` resource that on create issues `PUT /v2/databases/${bunnynet_database.staging.id}/auth/generate` with body `{ authorization = "full-access", expires_at = null }`; capture the response `token`.
- [x] 3.2 Key the mint on `bunnynet_database.staging.id` (e.g. via the resource id / a `terraform_data` trigger) so a plan refresh never re-mints the non-idempotent token; ensure the operation does NOT reconcile/re-read (use the action primitive, not a CRUD `restful_resource`).
- [x] 3.3 Mark the token-bearing attribute `sensitive` (locals/output) so it never reaches the `plan-infra` `$GITHUB_STEP_SUMMARY`.
- [x] 3.4 Add the destroy-time `POST /v2/databases/${id}/auth/revoke`; comment that revoke invalidates ALL tokens for that database (safe now — single consumer — but a future-prod hazard).

## 4. Staging env flip

- [x] 4.1 `infrastructure/bunny-staging.tf`: repoint the `DATABASE_URL` env value to `bunnynet_database.staging.url`.
- [x] 4.2 Add a `DATABASE_AUTH_TOKEN` env block (value = the minted token attribute), placed alphabetically BEFORE `DATABASE_URL` (env blocks MUST stay alphabetized).
- [x] 4.3 Remove the `DATABASE_WAL` env block entirely (token present ⇒ the boot `superRefine` rejects `DATABASE_WAL=true`; default is `false`).
- [x] 4.4 Remove the `volume {}` block and the container `volumemount {}` — staging is fully stateless (DB on Bunny Database, bundles already on Bunny Edge Storage). Keep `PERSISTENCE_PATH=/data` set (config-required, never touched at runtime); update the inline comments accordingly. Confirm `var.app_data_volume_size_gb` is still used elsewhere (prod block volume) so it isn't orphaned.

## 5. Docs

- [x] 5.1 `docs/infrastructure.md`: replace the "future flip" runbook with the live staging cutover — one `tofu apply` provisions `bunnynet_database` + mints the token + rolls the env; no manual token step; rollback = revert env to `DATABASE_URL=file:/data/events.db` + `DATABASE_WAL=true`, drop `DATABASE_AUTH_TOKEN`.
- [x] 5.2 Document caveats: preview limits (1 GB/DB, no backups), `…/auth/revoke` is account-/DB-wide, cold-start latency (D7 read-retry deferred), token-in-state rationale (mirrors `secrets_key`), and the `url`-scheme/Hrana unknown resolved by smoke.
- [x] 5.3 `docs/upgrades.md`: dated BREAKING (operator) entry — staging now requires the Bunny Database + minted token; existing staging embedded event history is dropped (accept-loss).

## 6. Validation

- [x] 6.1 `pnpm validate` (lint + check + test + `tofu fmt -check -recursive infrastructure/` + `tofu -chdir=infrastructure validate`) passes. (No runtime/SDK code changes expected — `demo.ts` untouched.)
- [x] 6.2 `openspec validate cutover-staging-bunny-database --strict` passes.
- [x] 6.3 `tofu -chdir=infrastructure plan` parses and references resolve (provider installed, `restful_operation` schema valid). Plan will be NON-empty (new resources + env diff) — that is expected; agents do NOT run `apply`.

## Cluster smoke (human + agent)

- [x] H.1 `tofu -chdir=infrastructure plan` shows ONLY: new `bunnynet_database.staging`, the `restful_operation` token mint, the staging container env diff (`DATABASE_URL`→remote, `+DATABASE_AUTH_TOKEN`, `-DATABASE_WAL`), and the `/data` volume + volumemount removal. No unrelated resource replacement or destroy (in particular: `bunnynet_storage_zone.staging_bundles` and `random_bytes.staging_secrets_key` MUST be untouched — their presence in a destroy plan means the branch is behind `main`). Surface the apply need in the PR summary.
- [x] H.2 Operator ran `tofu apply --auto-approve`: `bunnynet_database.staging` created (`db_01KW83G5BVZBSH9V8G0FK7V35Q`), token minted via `restful_operation`, staging env rolled, `/data` volume removed — `2 added, 1 changed, 0 destroyed`. Remote connectivity confirmed: `@libsql/client` negotiated Bunny's `url` cleanly (`/readyz` eventstore `SELECT 1` pass at ~35ms = real remote round-trip).
- [x] H.3 Smoke against live staging: `/livez` + `/readyz` green after the container rolled; demo webhook invocations fired and recorded in `/invocations` (read+write against the remote Bunny Database confirmed by the authorized operator). NOTE: `runDemo` itself returns 500 on staging because its `sendDemo`/`querySql` actions have no SMTP/Postgres backing — pre-existing demo behavior on `e722e772`, independent of the database (`event-store` is a best-effort consumer, so a write failure would not surface as that 500).
- [x] H.4 Rollback documented (not executed): `git revert` restores the `/data` volume + `DATABASE_URL=file:` + `DATABASE_WAL=true` and drops the token; or a hot env-only rollback to `file:/tmp/events.db` (ephemeral). See `docs/infrastructure.md` "Staging on a managed Bunny Database".
