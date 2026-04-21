## MODIFIED Requirements

### Requirement: Prod image identity via digest

The prod project SHALL declare `variable image_digest { type = string }` (no default — supplied at apply time by the prod deploy workflow). The image reference SHALL be constructed as `"ghcr.io/stefanhoelzl/workflow-engine@${var.image_digest}"`. It SHALL pass `image_hash = var.image_digest` to the `app-instance` module. The prod project SHALL NOT declare or use an `image_tag` variable; `prod/terraform.tfvars` SHALL NOT contain an `image_tag` entry.

#### Scenario: Prod image pinned by digest

- **WHEN** `tofu apply` is run in `envs/prod/` with `-var image_digest=sha256:abc...`
- **THEN** the prod Deployment's container image SHALL be `ghcr.io/stefanhoelzl/workflow-engine@sha256:abc...`

#### Scenario: Missing digest fails apply

- **WHEN** `tofu apply` is run in `envs/prod/` without providing `image_digest`
- **THEN** the apply SHALL fail with a missing-variable error

#### Scenario: Digest change triggers rollout

- **WHEN** `image_digest` changes between successive applies
- **THEN** the Deployment's pod template `sha256/image` annotation SHALL change
- **AND** Kubernetes SHALL perform a rolling update

### Requirement: Per-project variables and tfvars

Each project SHALL declare only the variables it uses. Non-secret values SHALL live in the project's `terraform.tfvars`; secrets SHALL be supplied via `TF_VAR_*` environment variables. Values injected at apply time by CI (such as image digests) SHALL NOT be committed to `terraform.tfvars`.

- cluster tfvars: `acme_email`
- prod tfvars: `domain`, `auth_allow`
- staging tfvars: `domain`, `auth_allow`, `service_uuid`, `service_endpoint`, `bucket_name`

#### Scenario: Prod tfvars does not reference cluster state passphrase

- **WHEN** `prod/terraform.tfvars` is read
- **THEN** it SHALL contain `domain` and `auth_allow`
- **AND** it SHALL NOT contain `state_passphrase`, `upcloud_token`, `dynu_api_key`, `github_oauth_client_id`, `github_oauth_client_secret`, `image_tag`, or `image_digest`

### Requirement: CLAUDE.md production documentation

CLAUDE.md SHALL include a production deployment section documenting prerequisites, per-project environment variables, one-time setup steps, the four-project apply order (persistence → cluster → prod → staging), and the distinction between operator-driven first-time setup and CI-driven ongoing deploys. The subsequent-deploy documentation SHALL describe: (1) staging auto-deploys on push to `main` via `deploy-staging.yml`; (2) prod auto-deploys on push to `release` via `deploy-prod.yml` behind a required-reviewer gate on the `production` GitHub Environment; (3) the `release` branch is the source of truth for what is deployed to prod; (4) rollback = `git revert` on `release` followed by push.

#### Scenario: Documentation complete

- **WHEN** a developer reads CLAUDE.md
- **THEN** they SHALL find the per-project env-var matrix
- **AND** they SHALL find the apply order
- **AND** they SHALL find the staging-via-CI deploy note
- **AND** they SHALL find the prod-via-CI deploy note describing the `release` branch trigger and approval gate
- **AND** they SHALL find the `git revert` rollback instruction
- **AND** they SHALL find an Upgrade Note describing the one-time migration (destroy + rebuild) required to adopt the four-project layout
