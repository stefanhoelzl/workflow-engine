## Why

Staging already runs entirely on bunny.net (Magic Containers app, Bunny
Database, Bunny Edge Storage, Bunny CDN for managed TLS), so the Scaleway VPS
now hosts only `wfe-prod` + `caddy` — a single-region, single-host failure
domain carrying real ops burden (cloud-init/sshd/fail2ban/swap convergence,
Caddy ACME, Block Storage formatting, podman-auto-update) for one app. Every
seam prod needs is already proven in production-shaped use on staging. Moving
prod onto Bunny and retiring the VPS removes that burden and collapses both envs
onto one managed platform.

## What Changes

- **Stand prod up on Bunny** as a second env in an env-keyed Bunny config:
  a `bunnynet_compute_container_app` (image `:release`, `autoscaling_min=max=1`,
  region DE, `/livez` readiness probe), a CDN endpoint for managed TLS, its own
  `bunnynet_database` + in-tofu-minted token, its own Bunny Edge Storage zone,
  and its own workflow-secrets sealing key — all **separate** from staging's
  (Bunny's token revoke is database-wide).
- **Preserve prod data and authors' workflows with zero author action:** copy
  the bundle tree to the prod Edge Storage zone and **preserve the existing prod
  sealing key value** (via `moved {}`) so sealed tenant secrets keep decrypting;
  migrate `events.db` (pruned to the 90-day retention window) into the prod
  Bunny Database.
- **BREAKING (operational):** retire the VPS **completely** in this same change
  — delete the Scaleway instance, IP, security group, prod Block Storage volume
  (lifting `prevent_destroy`), Caddy, all host convergence (`host.tf`,
  `apps.tf`, `caddy.tf`, `cloud-init.yaml`). The `scaleway`/`null`/`tls`
  providers stay declared through the teardown apply (OpenTofu needs a
  resource's provider present to destroy it) and are dropped in a fast-follow
  once state is clean. The tofu **state** stays on Scaleway Object Storage (it
  isn't the VPS). Cutover is one-way; there is no rollback after the VPS is
  destroyed.
- **Generalize the tofu and the spec:** refactor `bunny-staging.tf` into one
  env-keyed Bunny config covering staging (`:main`) + prod (`:release`), with
  `moved {}` blocks preserving **both** envs' existing state (no churn). The
  `bunny-staging` capability is **renamed to `bunny-deployment`** and its
  requirements re-parameterized over `{staging, prod}`.
- **Repoint the prod deploy path:** `deploy-prod.yml` (push to `release`, gated
  `environment: production`) stops pushing for the VPS to auto-pull and instead
  rolls the prod Bunny app by image digest + polls `/readyz`. Rename the
  pre-merge plan gate job `plan (vps)` → `plan (infra)` (and the `main` ruleset's
  required-check name in lockstep — operator/admin action).
- **No runtime/SDK/`demo.ts`/sandbox code changes** — the `STORAGE_BACKEND=bunny`
  and remote-libSQL (`DATABASE_URL` + `DATABASE_AUTH_TOKEN`) seams already exist
  and are proven on staging. The cutover is choreographed as three operator
  applies (create Bunny prod → verify → flip DNS → destroy VPS) with a short
  maintenance window for the consistent data migration; agents do not run
  `tofu apply` or touch prod data.

## Capabilities

### New Capabilities
- `bunny-deployment`: the env-keyed bunny.net Magic Containers deployment for
  **both** staging and prod — per-env app, CDN/managed-TLS custom hostname,
  managed Bunny Database + in-tofu token mint, Bunny Edge Storage bundle zone,
  workflow-secrets sealing key, `/livez` readiness probe, and the
  deploy-rolls-forward-by-digest contract. Generalizes the former
  `bunny-staging`.

### Modified Capabilities
- `infrastructure`: remove every VPS/Caddy/host requirement (single VPS, in-place
  host convergence, managed users, cloud-init, Quadlets, auto-update, Caddyfile,
  loopback binds, local-disk persistence, per-env secret env files, the
  `local.envs`-keyed sealing key, disk cleanup, block volumes, swap, lowered port
  floor); the tofu project now provisions both envs on Bunny; prod DNS flips from
  an A record to a CNAME; the Edge Storage zone and Bunny DNS requirements cover
  prod too; tofu state stays on Scaleway Object Storage; the `scaleway`/`null`/`tls`
  providers are retained through the teardown apply and dropped in a fast-follow.
  Correct the stale Purpose (drops the `kind`/`UpCloud` text).
- `ci-workflow`: the prod deploy workflow rolls the prod Bunny app by digest
  (`BunnyWay/actions/container-update-image` SHA-pinned, or inline `curl` PATCH)
  and polls `/readyz` for `gitSha`, instead of building/pushing `:release` for
  the VPS auto-update timer; the plan-gate job and `main`-ruleset required check
  rename from `plan (vps)` to `plan (infra)`.
- `sandbox-plugin`: gains the **Worker→main host-call trust boundary**
  requirement, **moved** out of the removed `host-security-baseline` (it is an
  app/sandbox security boundary, not VPS host posture).

### Removed Capabilities
- `bunny-staging`: renamed and generalized into `bunny-deployment`.
- `host-security-baseline`: the Scaleway VPS host posture (deploy/tenant users,
  rootless Podman + subuid, sshd hardening, fail2ban, host firewall, swapfile,
  per-Quadlet ceilings, unattended-upgrades, operator log access) retires with
  the VPS. Its one non-host requirement (the host-call trust boundary) is
  preserved by moving it to `sandbox-plugin`.

## Impact

- **Terraform (`infrastructure/`):** env-keyed Bunny module (generalized
  `bunny-staging.tf`) with `moved {}` blocks for both envs' resources (the prod
  sealing-key move is the single highest-blast-radius line); new prod
  `bunnynet_compute_container_app` + CDN + `bunnynet_database` + `restful_operation`
  token + `bunnynet_storage_zone` + `bunnynet_pullzone_hostname`; `dns.tf` prod
  A→CNAME; lift `prevent_destroy` on the prod volume; delete `apps.tf`,
  `host.tf`, `caddy.tf`, `cloud-init.yaml`, the VPS resources in `main.tf`
  (`scaleway`/`null`/`tls` providers retained for the teardown apply, dropped in
  a fast-follow). State backend unchanged.
- **CI:** `deploy-prod.yml` rolls the Bunny app + polls `/readyz`; `plan-infra.yml`
  job rename `plan (vps)` → `plan (infra)`; the `main` branch ruleset required
  check renamed in lockstep (operator/admin action, surfaced in the PR summary).
- **Data migration (operator, one-shot, documented in `tasks.md`, no committed
  script):** HTTP `PUT` each `workflows/<owner>/<repo>.tar.gz` to the prod Edge
  Storage origin; dump `events.db` (≤90d) and replay into the prod Bunny Database
  via `@libsql/client`. Measured prod footprint ~1.5 MB total (≈600× under
  Bunny's 1 GB/DB cap); rehearse on staging first.
- **Docs:** `docs/infrastructure.md` rewritten from the VPS+Bunny split to an
  all-Bunny topology; `openspec/project.md` checked for VPS-related staleness.
- **Risks accepted (documented, not mitigated):** one-way cutover with no
  rollback after VPS teardown; prod data on a single no-backup public-preview
  Bunny Database; cold-start failed-read after idle (no read-path retry); brief
  maintenance-window downtime; database-wide token revoke (safe while prod is the
  DB's sole consumer).
- **No** runtime/SDK/`demo.ts`/sandbox-boundary/manifest/EventBus-consumer change.
