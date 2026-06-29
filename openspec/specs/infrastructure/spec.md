<!-- ═══════════════════════════════════════════════════════ -->
<!-- Local Stack (infrastructure/local/)                    -->
<!-- ═══════════════════════════════════════════════════════ -->

## Purpose

Reusable Terraform modules for the local (kind) and production (UpCloud) stacks.
## Requirements
### Requirement: Single flat tofu project at infrastructure/

The repository SHALL contain exactly one OpenTofu project at `infrastructure/` with no `envs/<name>/` subdirectories. The project owns the env-keyed bunny.net deployment for both `staging` and `prod` (see the `bunny-deployment` capability), the Bunny DNS records (both CNAMEs to Bunny), and the Scaleway Object Storage bucket reference for state. There is NO Scaleway VPS, no app Quadlet unit, no Caddy unit, no Caddyfile, and no cloud-init. All operations run as `tofu -chdir=infrastructure {init|plan|apply}`.

#### Scenario: Single project layout

- **WHEN** the repository is inspected after the migration
- **THEN** `infrastructure/main.tf` and `infrastructure/variables.tf` SHALL exist
- **AND** `infrastructure/envs/` SHALL NOT exist
- **AND** `infrastructure/cloud-init.yaml`, `infrastructure/host.tf`, `infrastructure/apps.tf`, and `infrastructure/caddy.tf` SHALL NOT exist
- **AND** `infrastructure/modules/{kubernetes,object-storage,app-instance,baseline,caddy}/` SHALL NOT exist

### Requirement: Pinned OpenTofu version

The `infrastructure/` project SHALL declare an exact-patch `required_version` (e.g. `"1.11.6"`, not a range) so all clients — operator local + every CI job invoking `tofu` — resolve the same version. The pin is required because `tofu init` writes version-specific `h1:` hashes into `.terraform.lock.hcl`, and the repo's lockfile-drift gate (`git diff --exit-code infrastructure/.terraform.lock.hcl` in `ci.yml`) fails when CI's `tofu init` produces a different set of hashes than the operator's last commit.

The CI jobs that invoke `tofu` (`ci.yml`, `plan-infra.yml`) SHALL set `opentofu/setup-opentofu`'s `tofu_version` input to the same exact value declared in `required_version`. Bumping the pinned version SHALL update both `infrastructure/main.tf` and every `setup-opentofu` invocation in the same PR.

#### Scenario: Wrong-version tofu refuses to init

- **GIVEN** an operator runs `tofu version` returning a version that does not exactly match `required_version` (e.g. `1.10.0` or `1.12.0` against a pin of `1.11.6`)
- **WHEN** they run `tofu -chdir=infrastructure init`
- **THEN** tofu SHALL refuse with a version-constraint error

#### Scenario: CI tofu matches the pin

- **WHEN** the rendered `.github/workflows/ci.yml` and `.github/workflows/plan-infra.yml` are inspected
- **THEN** every `opentofu/setup-opentofu@v*` step SHALL set `with.tofu_version` to a literal version string
- **AND** that string SHALL equal `infrastructure/main.tf#required_version`

### Requirement: Tofu state on Scaleway Object Storage

The project SHALL configure the `s3` backend pointing at a Scaleway Object Storage bucket, with a custom `endpoint` (e.g. `https://s3.fr-par.scw.cloud`), `region` set to a Scaleway region, and `skip_credentials_validation = true` and `skip_region_validation = true` (Scaleway is S3-compatible but not AWS). Client-side state encryption SHALL be configured via the `encryption` block using a passphrase from `TF_VAR_state_passphrase` so state at rest never contains unencrypted secrets.

#### Scenario: State backend is reachable

- **GIVEN** valid `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for Scaleway Object Storage
- **WHEN** the operator runs `tofu -chdir=infrastructure init`
- **THEN** init SHALL succeed and acquire a lock against the Scaleway bucket

### Requirement: Lock file committed and gitignore boundaries

`infrastructure/.terraform.lock.hcl` SHALL be committed. `infrastructure/.terraform/` SHALL be gitignored. The runner-local `/tmp/wfe-secrets/` directory SHALL never be in the repository (created and removed by the GHA workflow).

#### Scenario: Lock file is tracked

- **WHEN** the operator runs `git ls-files infrastructure/`
- **THEN** `.terraform.lock.hcl` SHALL appear

### Requirement: kind-based local env removed

The `infrastructure/envs/local/` directory, the `kind` provider usage, the `pnpm local:up*` scripts, the `local.secrets.auto.tfvars(.example)?` files, and any "Cluster smoke (human)" pattern in CLAUDE.md SHALL all be removed. `pnpm dev` SHALL be the only documented local mode.

#### Scenario: kind is gone from the repo

- **WHEN** the repo is grep'd for `kind` provider, `pnpm local:up`, or `infrastructure/envs/local`
- **THEN** no occurrence SHALL remain

### Requirement: Bunny DNS records owned by tofu

The project SHALL manage exactly two DNS records under the `stho.net` zone via the `bunnynet` provider. The zone SHALL be referenced through a `data "bunnynet_dns_zone"` lookup (read-only); the project SHALL NOT own or create the `stho.net` zone, its apex, or any record other than the two below.

- `workflow-engine.stho.net` → **CNAME** to the prod Bunny Magic Containers CDN endpoint host (`*.b-cdn.net`).
- `staging.workflow-engine.stho.net` → **CNAME** to the staging Bunny Magic Containers CDN endpoint host (`*.b-cdn.net`).

Both records SHALL set `ttl = 300`. Each env's `BASE_URL` and its `bunnynet_pullzone_hostname` SHALL use the same `base_domain`-composed hostname. The project SHALL NOT reference the Scaleway VPS IP, the Dynu API, the `restapi` provider, `var.dynu_api_key`, or any `staging_backend`/VPS toggle variable. Because Bunny issues each managed cert only once its CNAME resolves to Bunny, the record for an env SHALL be created and propagated before the apply that validates that env's custom hostname (two-step targeted apply).

#### Scenario: Prod hostname resolves to the Bunny CDN endpoint

- **GIVEN** tofu apply has completed and Bunny DNS propagation has occurred
- **WHEN** `dig workflow-engine.stho.net` is run from an external resolver
- **THEN** it SHALL resolve (via CNAME) to the prod Bunny Magic Containers CDN endpoint host

#### Scenario: Staging hostname resolves to the Bunny CDN endpoint

- **GIVEN** tofu apply has completed and Bunny DNS propagation has occurred
- **WHEN** `dig staging.workflow-engine.stho.net` is run from an external resolver
- **THEN** it SHALL resolve (via CNAME) to the staging Bunny Magic Containers CDN endpoint host

#### Scenario: No VPS / Dynu / restapi reference remains

- **WHEN** the rendered `infrastructure/` project and its `.terraform.lock.hcl` are inspected
- **THEN** there SHALL be no `scaleway_instance_ip` reference in the DNS records, no `restapi` provider, no `Mastercard/restapi` lockfile entry, and no `var.dynu_api_key` reference

#### Scenario: tofu does not own the stho.net zone

- **WHEN** the DNS configuration is inspected
- **THEN** the `stho.net` zone SHALL be referenced via a `data "bunnynet_dns_zone"` source (not a `resource`)
- **AND** only the two `workflow-engine` subdomain records SHALL be managed; the apex and any sibling records SHALL NOT appear in the plan

### Requirement: Bunny Edge Storage zones for bundle storage

The `infrastructure/` project SHALL declare one `bunnynet_storage_zone` resource **per env** (`staging`, `prod`) for workflow bundle storage, each with its main storage region set to Frankfurt (DE) to match that env's Magic Containers region. Both envs run on the Bunny Edge Storage (`bunny`) backend; there is no local-disk (`fs`) backend in use anywhere, the VPS having been retired. Each env's zone SHALL be dedicated to that env's bundles; staging and prod SHALL NOT share a zone.

Each zone's read-write access key SHALL be sourced from the resource's own `password` attribute and threaded directly into that env's Magic Containers app env (see the `bunny-deployment` capability) — no new `TF_VAR_*` input or GHA secret SHALL be introduced for it. Because the `bunnynet` provider marks the zone `password` attribute sensitive, it SHALL NOT appear in the `plan-infra` step summary.

Provisioning the zones is operator-driven via the `apply-infra` workflow; agents SHALL NOT run `tofu apply`. The `plan-infra` empty-plan gate SHALL hold once the operator has applied.

#### Scenario: One Frankfurt storage zone per env

- **WHEN** the operator inspects the planned infrastructure
- **THEN** there SHALL be exactly one `bunnynet_storage_zone` per env (`staging`, `prod`), each with its main region set to Frankfurt (DE)

#### Scenario: Access key flows from the zone resource, not a new secret input

- **WHEN** the repository and tofu variables are inspected
- **THEN** each env app's Bunny access key SHALL be wired from that env's `bunnynet_storage_zone.password`
- **AND** there SHALL NOT be a new `TF_VAR_*` input or GHA secret declared for any storage-zone access key

#### Scenario: Access key does not leak into the plan-infra step summary

- **WHEN** `plan-infra` renders the plan into `$GITHUB_STEP_SUMMARY`
- **THEN** every storage-zone access key SHALL appear as a sensitive/redacted value, not in cleartext

