# Infrastructure

Operator runbook for the all-Bunny deployment. Both `staging` and `prod` run on bunny.net Magic Containers; there is no VPS and no Caddy. Local-dev instructions live in `CLAUDE.md` (`pnpm dev` is the only local mode).

## Topology

Two near-identical bunny.net Magic Containers apps, one per env, declared through a single env-keyed shape (`for_each` over `local.bunny_envs` in `bunny.tf`):

| Env | App | Image | Host |
| --- | --- | --- | --- |
| `staging` | `bunnynet_compute_container_app.app["staging"]` | `ghcr.io/stefanhoelzl/workflow-engine:main` | <https://staging.workflow-engine.stho.net> |
| `prod` | `bunnynet_compute_container_app.app["prod"]` | `ghcr.io/stefanhoelzl/workflow-engine:release` | <https://workflow-engine.stho.net> |

Both run as **single always-on replicas** in Frankfurt (`regions_required = regions_allowed = ["DE"]`, `regions_max_allowed = 1`, `autoscaling_min = autoscaling_max = 1`) fronted by a per-env Bunny **CDN endpoint** (`origin_ssl = false`) that terminates managed HTTPS — the replacement for Caddy. The public image is resolved via the `bunnynet_compute_container_imageregistry` data source (`username = ""`, no token). There is no VPS, no Caddy, no rootless Podman, no host convergence, no SSH/cloud-init/fail2ban/swap/block-volumes.

DNS: one Bunny DNS CNAME per env (`dns.tf`, `bunnynet_dns_record.cname["<env>"]`) pointing the env hostname at that env's CDN pull-zone `*.b-cdn.net` host. The `stho.net` zone is owned out-of-band (registered at Scaleway, delegated to Bunny nameservers) and referenced read-only via `data "bunnynet_dns_zone" "stho"`.

Authentication is owned entirely in-process by the app (`sessionMiddleware`, `apiAuthMiddleware`); the CDN does no auth, no forward-auth, no header injection. See `SECURITY.md §4`.

## Tofu layout

Single flat project at `infrastructure/`:

```
infrastructure/
  main.tf        # terraform block: providers (random / bunnynet / restful),
                 #   s3 backend on Scaleway Object Storage (key = "vps"),
                 #   AES-GCM state encryption (encryption {} + pbkdf2)
  bunny.tf       # the env-keyed Bunny deployment (apps, CDN, Database + token,
                 #   Edge Storage zones, sealing keys, pullzone hostnames)
  dns.tf         # two Bunny DNS CNAMEs (one per env)
  moves.tf       # state-preserving moved {} blocks (staging→env-keyed)
  variables.tf
  outputs.tf
  Dockerfile     # app image (built by GHA, not by tofu)
```

Run from the repo root:

```
tofu -chdir=infrastructure init
tofu -chdir=infrastructure plan
tofu -chdir=infrastructure apply
```

**Providers** (`main.tf`): `hashicorp/random` (`~> 3.6`, sealing keys), `BunnyWay/bunnynet` (`~> 0.15`, apps/CDN/Database/storage/DNS — 0.x with breaking minors, bump deliberately), `magodo/restful` (`~> 0.25.2`, the one-shot Bunny Database token mint/revoke). OpenTofu is pinned exactly (`required_version = 1.11.6`) to keep the lockfile gate stable; CI pins the same value. (The `scaleway`/`null`/`tls` providers were retained through the VPS-teardown apply and dropped once state was clean — see the cutover note below.)

**State backend:** Scaleway Object Storage (S3-compatible), `key = "vps"`. The key is kept as `vps` to preserve state continuity across the migration — renaming it would orphan existing state. State is client-side AES-GCM encrypted via the `encryption {}` block (pbkdf2 from `TF_VAR_state_passphrase`). After teardown this bucket is the **only remaining Scaleway dependency** — the VPS compute, IP, security group, and block volume are destroyed; the bucket is not the VPS, so it stays.

## Per-env state isolation

Each env has its **own** Bunny Database + minted token, Edge Storage bundle zone, and workflow-secrets sealing key; staging and prod share nothing. This is load-bearing: Bunny's token revoke (`…/auth/revoke`) is **database-wide**, so a shared token would couple the two envs' availability, and a shared storage zone or sealing key would cross-wire prod and staging data.

Both envs are **fully stateless** — the app declares **no `/data` volume**. The event-store and per-workflow queues live on the managed Bunny Database (remote libSQL); the workflow bundle tree lives on Bunny Edge Storage. Nothing is written to local disk. `PERSISTENCE_PATH=/data` stays set (the runtime config requires it) but is never touched when `STORAGE_BACKEND=bunny` + a remote `DATABASE_URL` are in effect.

## Storage & Database

### Bundles on Bunny Edge Storage

One durable Edge Storage zone per env: `bunnynet_storage_zone.bundles["<env>"]`, named `wfe-<env>-bundles`, region `DE`/Frankfurt, `Standard` tier. Holds the `workflows/<owner>/<repo>.tar.gz` tree. The app selects it with `STORAGE_BACKEND=bunny` plus:

- `STORAGE_BUNNY_ENDPOINT=storage.bunnycdn.com` — the DE main-region storage **origin** host. The backend reads/writes the origin directly, **never a CDN pull zone**, so a re-uploaded bundle is never served stale to `recover()`.
- `STORAGE_BUNNY_STORAGE_ZONE` — the zone name (`bunnynet_storage_zone.bundles["<env>"].name`).
- `STORAGE_BUNNY_ACCESS_KEY` — the zone resource's `password` attribute (provider-marked sensitive), wired straight into the env. **No new `TF_VAR` / GHA secret** is introduced, and it is redacted in the `plan-infra` step summary.

The runtime's Bunny backend does a status-keyed boot probe (401/403 = bad key → crash; 200/empty zone = healthy) and does **not** retry; a transient blip at boot crashes the container, which Bunny restarts.

### Event-store + queues on a managed Bunny Database

One managed Bunny Database (libSQL) per env: `bunnynet_database.db["<env>"]`, named `wfe-<env>`, single primary in `DE`, no read replicas (single writer, lowest latency). The provider outputs only `id` + `url`. The access token is minted separately in the same apply by `restful_operation.db_token["<env>"]` — a one-shot `PUT https://api.bunny.net/database/v2/databases/{id}/auth/generate` (`authorization=full-access`), authenticated with the existing account API key (`AccessKey` header = `var.bunnynet_api_key`, no new secret). `use_sensitive_output = true` keeps the JWT in `sensitive_output` so it never reaches the plan-infra summary. On destroy it POSTs `…/auth/revoke`.

The libSQL connection is named by three env vars (parsed in `packages/runtime/src/config.ts`):

- `DATABASE_URL` — the database's `url` output. `libsql://…`/`https://…` selects the remote client variant. Scheme is resolved by Bunny at apply.
- `DATABASE_AUTH_TOKEN` — the minted JWT. Its presence selects the remote client variant.
- `DATABASE_WAL` — **must be absent.** `DATABASE_AUTH_TOKEN` present together with `DATABASE_WAL=true` fails closed at config parse (WAL is an embedded-only toggle).

`main.ts` builds one `@libsql/client` from these and injects it into both Kysely stores; the remote variant is the same dialect over the network.

`EVENT_STORE_RETENTION_DAYS` bounds future growth (prod `90`, staging `1`); the runtime self-prunes whole invocations older than the window on a derived cadence (prunes 100× per window) and logs `event-store.prune-ok` / `event-store.prune-failed`. Unset or `0` disables retention.

### Bunny Database is public preview — caveats

- **Accept-loss.** 1 GB/DB cap; **no automatic backups or replication**. (Prod's measured footprint is ~1.5 MB total — ~600× headroom.)
- **Cold-start, no read-path retry.** A Bunny Database spins down when idle; the first read after an idle period can surface as a failed query the user/browser must retry. There is no read-path retry in the runtime today (tracked follow-up).
- **Token mint is non-idempotent and lives in state.** `restful_operation` is create-only (no read-back), so it never re-mints on plan; a database *replacement* re-mints for the new id. The JWT is in tofu state (AES-GCM encrypted) and redacted from the plan summary.
- ⚠️ **Revoke is database-wide.** The destroy-time revoke invalidates **all** tokens for that database. Safe because each DB is its env's sole consumer (per-env isolation above).
- **`url` scheme resolved at apply.** Transport follows the scheme: `libsql://` uses a long-lived WebSocket (an idle spin-down may kill it), `https://` is stateless per request. Confirm `@libsql/client` (pinned `^0.8.0`, `@libsql/kysely-libsql ^0.4.1`) negotiates Bunny's Hrana server cleanly and survives an idle cycle.

### SQL engine memory

libSQL (SQLite) does **not** auto-size a buffer pool to host RAM — its page cache is small and bounded (a few MiB), so the old DuckDB "sized to 80% of host RAM and got OOM-killed" failure mode does not apply and no `memory_limit` knob is needed. The runtime as a whole (notably V8's heap) is still memory-bounded by the container.

## Deploys

No tofu in the deploy path. Each env's workflow builds + pushes its image, then rolls **that env's** Bunny app forward by image **digest** (Bunny Magic Containers does NOT auto-pull — updating the container image is the only documented rolling-update trigger, so a changing digest per deploy is required).

- **`deploy-staging.yml`** — push to `main`: build + push `ghcr.io/…:main`, resolve the `wfe-staging` app id by name, roll via the SHA-pinned `BunnyWay/actions/container-update-image` action (`…@671d620…` = `0.2.2`; SHA-pinned because it receives `BUNNYNET_API_KEY`) with `image_tag: main` + `image_digest: <digest>`, poll `/readyz` until `version.gitSha === github.sha`, then `wfe upload` the demo workflows.
- **`deploy-prod.yml`** — push to `release`, gated `environment: production` (required reviewer): the `deploy` job uses the shared **`.github/actions/deploy-image`** composite action (`tag: release`, `url: https://workflow-engine.stho.net`, `app_name: wfe-prod`). The composite does the same build+push → resolve-id-by-name → SHA-pinned digest roll → poll `/readyz` sequence. No `wfe upload` (prod bundles are author-uploaded). A parallel `publish-npm` job handles the SDK release (below).

Both apps declare `lifecycle { ignore_changes = [container[0].image_tag, container[0].image_digest, container[0].image_pull_policy] }`: CI owns the digest, and Bunny resets `image_pull_policy` to `IfNotPresent` out-of-band (harmless under digest-pinning). TF stops managing all three so neither a deploy nor a `tofu apply` fights the other — keeping the `plan-infra` empty-plan gate green after every deploy.

The `release` branch is protected (no force-push, no delete). Promote to prod with `git cherry-pick <sha> && git push origin release`.

**Rollback (app bugs).** `git revert <bad-sha>` on the affected branch → CI rebuilds, re-pushes the same tag, rolls the digest forward within minutes. There is no rollback for *infra* changes (cutover is one-way).

## Readiness probe MUST be /livez, not /readyz

Each app's `readiness_probe` targets **`/livez`** (pure process-liveness), NOT `/readyz`. `/readyz` runs deep checks that self-reach the app's own public `BASE_URL` (`domain` → `…/healthz`, `webhooks` → `…/webhooks/`). During a deploy Bunny serves a "We're deploying" **503** on that hostname *until* readiness passes — so gating readiness on `/readyz` **deadlocks**: the pod boots and listens fine but can never satisfy its own self-check, and Bunny retries forever. `/livez` returns 200 the moment the process listens → the pod goes ready → Bunny routes → and then `/readyz`'s self-checks pass. The deploy pipeline still polls `/readyz` (the full-health + gitSha gate); only Bunny's traffic-gating probe uses `/livez`. Note `min=max=1` deploys have a brief 503 window (Bunny can't run the new replica alongside the old).

## Pre-merge plan gate

`.github/workflows/plan-infra.yml` runs on every PR to `main`. Single job, status-check context **`plan-infra`**:

- `tofu init && tofu plan -detailed-exitcode -lock=false -no-color`, with all `TF_VAR_*` secrets piped from GHA secrets so the plan renders every env's secret-bearing attributes.
- Pipes the plan into `$GITHUB_STEP_SUMMARY`.
- Exit 0 = pass (empty plan); 1 (error) or 2 (changes pending) = fail.

The `main` branch ruleset requires `plan-infra`. Infra changes are operator-driven: the operator runs `apply-infra` from the feature branch *before* requesting review so the gate is empty at merge. If the gate is broken, an admin temporarily disables the ruleset, merges the fix, and re-enables.

> The `main` ruleset requires the `plan-infra` status check (unchanged by this migration — the check was already named for the infra project, not the retired VPS).

### Required GitHub Actions secrets and variables

Secrets:

- `TF_VAR_state_passphrase` — client-side state encryption.
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` — Scaleway Object Storage credentials for the S3 state backend.
- `BUNNYNET_API_KEY` — bunny.net **account** API key ("team member API keys are not supported"). Used by the `bunnynet` + `restful` providers (mapped to `TF_VAR_bunnynet_api_key` in `plan-infra`/apply) AND by both deploy workflows' rolling-update step (resolve app id, roll the digest).
- `GH_OAUTH_CLIENT_ID_PROD`, `GH_OAUTH_CLIENT_SECRET_PROD` — prod GitHub OAuth App.
- `GH_OAUTH_CLIENT_ID_STAGING`, `GH_OAUTH_CLIENT_SECRET_STAGING` — staging GitHub OAuth App.
- `GH_UPLOAD_TOKEN` — fine-grained PAT for `wfe upload` (staging deploy only).

Variables:

- `AUTH_ALLOW_PROD`, `AUTH_ALLOW_STAGING` — `AUTH_ALLOW` value per env (carried in `local.bunny_envs`).

(Dropped with the VPS: `SCW_*`, the deploy SSH key, `TF_VAR_acme_email`.)

## Prod cutover runbook

The change `migrate-prod-to-bunny` retired the VPS and moved prod onto Bunny. It is a **one-way** move executed as **three applies in one operator session** (verify-then-destroy), not one atomic apply. Full design: `openspec/changes/migrate-prod-to-bunny/` (D1–D12 + the operator runbook).

Agents wrote the env-keyed module, the `moved {}` blocks, the `prevent_destroy` lift, the CI changes, and this doc. Agents do **not** run `tofu apply` or touch prod data. The operator runs:

**Pre-flight.** On the feature branch, `tofu plan` and confirm: the only destroys are VPS resources; **no `random_bytes` is destroyed/created** (prod + staging keys both show as preserved/move); the rendered prod `SECRETS_PRIVATE_KEYS=v1:<base64>` is byte-identical to today.

**apply #1 — create the prod Bunny stack (TARGETED).** The VPS is already gone from config but preserved in state until the full apply, so apply #1 is **targeted at the new prod resources** (`bunnynet_compute_container_app.app["prod"]` + its CDN, `bunnynet_database.db["prod"]`, `restful_operation.db_token["prod"]`, `bunnynet_storage_zone.bundles["prod"]`). The VPS stays up serving prod on its A record. Curl the raw Bunny CDN host → `/livez` green; confirm the prod Database + token + storage zone exist.

> **Sealing-key preservation (the one line to get right).** `random_bytes.secrets_key["prod"]` keeps its value **by address identity** — it was already at that address (declared in the deleted `apps.tf` with `for_each = local.envs = {prod}`); `bunny.tf` re-declares the same address, so tofu preserves the value with no move and no regeneration. The plan MUST show **no `random_bytes` destroy/create**. If it regenerates, every sealed prod tenant secret (`stefanhoelzl`, `mrh1997`, `baltech-ag`, `sharepad-de`) becomes undecryptable until that author re-uploads. (Staging's key + DB + token + zone + hostname carry to their env-keyed addresses via the `moved {}` blocks in `moves.tf` — no staging churn.)

> **CDN host placeholder.** `local.bunny_envs["prod"].cdn_host` in `bunny.tf` ships as `REPLACE-AFTER-APPLY-1.b-cdn.net`. The prod pull zone doesn't exist until apply #1 creates it. After apply #1 the operator reads the real `*.b-cdn.net` host (`tofu state show 'bunnynet_compute_container_app.app["prod"]' | grep pullzone_id`, then the pullzone API) and fills it in **before** the DNS targeted apply (#2) and before the change merges (the `plan-infra` gate needs the real value).

**Maintenance window (non-tofu).** `systemctl --user stop wfe-prod` on the VPS (quiesce writes → consistent dump point). Then, per the documented commands in the change's `tasks.md` (rehearse on staging first):

- **Bundles:** for each `/srv/wfe/prod/workflows/<owner>/<repo>.tar.gz`, an authenticated HTTP `PUT` to the prod Edge Storage **origin** (`storage.bunnycdn.com`, the zone's access key) — a `curl` loop, not rsync (Edge Storage is an HTTP API). Byte-identical copy; the preserved sealing key keeps sealed secrets inside decryptable.
- **Event DB:** dump `events.db` rows within the 90-day window and replay into the prod Bunny Database via `@libsql/client` (run ad hoc from the monorepo).

Verify reads/writes and a `recover()` against the Bunny CDN host directly.

**apply #2 — flip DNS (TARGETED, two-step).** Flip `workflow-engine.stho.net` from the VPS A record to a CNAME at the prod CDN host. Per the load-bearing ordering in `bunny.tf`/`dns.tf`: step 1 applies **only** `bunnynet_dns_record.cname["prod"]` so the CNAME propagates; after `dig` confirms it is live (~5 min), step 2 (full apply) lets Bunny validate the `bunnynet_pullzone_hostname.host["prod"]` Let's Encrypt cert against the already-resolving CNAME. **Do not** run step 2 before `dig` confirms propagation — a premature validation can trigger an LE lockout (~1 week). Confirm prod live on Bunny over its real hostname (OAuth round-trip, an authenticated route, a trigger).

**apply #3 — destroy the VPS (full apply).** The full apply destroys everything the VPS config left in state (instance, IP, security group, prod block volume after the `prevent_destroy` lift, `tls_private_key.deploy`, and the `null_resource.*` convergence — whose destroy-time provisioners SSH in and clean up, `on_failure=continue`). The `scaleway`/`null`/`tls` providers stay declared (required to perform these destroys). Confirm an empty `plan-infra`.

**Ruleset.** No change needed — the `main` ruleset already requires `plan-infra`, which the renamed-free workflow still produces.

**Drop the teardown-only providers.** Once `tofu state list` shows no `scaleway_*`, `tls_private_key.*`, or `null_resource.*` (i.e. the teardown apply completed), remove the `scaleway`/`null`/`tls` entries from `required_providers`, the `provider "scaleway"` block, the `scaleway_*` vars + `terraform.tfvars`, and `SCW_*` from `plan-infra.yml` / `.proton.yaml`; re-init drops them from the lock. Plan must stay empty. (Done in this change once the VPS was destroyed.) The Scaleway Object Storage **state backend** + its `AWS_*` credentials stay — that is not the VPS.

**Rollback reality:** before apply #3, rollback is "flip DNS back to the VPS IP" (the VPS still exists with its data). After apply #3 there is no rollback — fix-forward only.

## Risks (carry these in your head)

- **One-way cutover, no rollback after teardown.** The choreography adds a verify-before-destroy point so a failed bring-up is caught before the VPS dies; once apply #3 runs it is fix-forward only.
- **Prod data on a single no-backup preview Bunny Database.** 1 GB/DB cap, no backups or replication, database-wide token revoke (safe while prod is the DB's sole consumer). The VPS block volume also had no backups, so this is not a regression.
- **No off-box backups / snapshots** for the Database or bundle zones — a tracked follow-up, not built.
- **Cold-start failed-read after idle** — no read-path retry; user/browser retry. Tracked follow-up.

## SDK publishing to npm

`@workflow-engine/sdk` and `@workflow-engine/core` publish to npm on every push to `release` whose diff touches `packages/sdk` or `packages/core`. Auth is via npm trusted publishing (OIDC) — there is no long-lived `NPM_AUTOMATION_TOKEN` in repo secrets. Workflow: `.github/workflows/deploy-prod.yml` job `publish-npm` (runs in parallel with the `deploy` job).

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

`AUTH_ALLOW` is a comma-separated string of provider-prefixed identifiers (e.g. `github:org:acme,github:user:alice`) read at runtime boot. It is materialized from the `AUTH_ALLOW_PROD` and `AUTH_ALLOW_STAGING` GitHub Actions repository variables (carried into the app env via `local.bunny_envs`). To onboard a new external author:

1. Confirm the author's GitHub identity. Their owner namespace must be either their own GitHub login (`github:user:<login>`) OR a GitHub org they're a member of (`github:org:<org>`).
2. Append the entry to the relevant `AUTH_ALLOW_*` GitHub Actions variable. Example: `github:org:acme` → add `,github:user:bob` to onboard `bob`.
3. Re-deploy by pushing to `main` (staging) or `release` (prod). The runtime reads the variable at boot, so the value lands when the Bunny app rolls forward.
4. Tell the author to install the SDK (`npm install @workflow-engine/sdk`), mint a GitHub PAT with the **`read:org`** scope (fine-grained tokens: "Members: read" on the org), and run `npx wfe upload --owner <their-namespace> --token <PAT>`. The runtime calls `/user` and `/user/orgs` to populate `user.orgs` and enforces `isMember(user, owner)`. A token without `read:org` returns an empty `orgs` array → membership check fails → 404 (deliberately indistinguishable from "owner does not exist", to prevent enumeration).

## References

- `openspec/changes/migrate-prod-to-bunny/` — the cutover design + runbook.
- `openspec/specs/bunny-deployment/spec.md`
- `openspec/specs/infrastructure/spec.md`
- `openspec/specs/ci-workflow/spec.md`
- `SECURITY.md §4`, `§5`
