# bunny-staging Specification (delta)

## MODIFIED Requirements

### Requirement: Magic Containers staging app via the bunnynet provider

The `infrastructure/` project SHALL declare the `bunnynet` provider and exactly one `bunnynet_compute_container_app` resource for staging. The app SHALL reference image `ghcr.io/stefanhoelzl/workflow-engine:main` (a `linux/amd64` image), SHALL set `autoscaling_min` and `autoscaling_max` both to `1`, and SHALL pin a single EU region (Frankfurt) via `regions_required`. The container SHALL expose the app's listen port (8080) and SHALL set `PERSISTENCE_PATH=/data`.

The container SHALL set `DATABASE_URL` to the connection URL of the provisioned managed Bunny Database — the `bunnynet_database.staging` resource's `url` output — and SHALL set `DATABASE_AUTH_TOKEN` to the access token minted in-tofu (see the "Staging Bunny Database provisioning and in-tofu token mint" requirement). The container SHALL NOT set `DATABASE_WAL`: it is an embedded-only pragma, and the runtime config fails closed at boot when `DATABASE_AUTH_TOKEN` is set together with `DATABASE_WAL=true`. Staging's event-store and per-workflow queues therefore run on the remote Bunny Database, not an on-disk `events.db`. Prod SHALL NOT be deployed to Magic Containers by this change — it remains entirely on the Scaleway VPS.

The staging app SHALL select the Bunny Edge Storage bundle backend by setting `STORAGE_BACKEND=bunny` together with `STORAGE_BUNNY_ENDPOINT` (the storage origin host), `STORAGE_BUNNY_STORAGE_ZONE` (the staging zone name), and `STORAGE_BUNNY_ACCESS_KEY` (referenced from the `bunnynet_storage_zone` resource's `password` attribute — see the `infrastructure` capability). With both the database and the bundle store remote, the staging container holds NO local state: `PERSISTENCE_PATH=/data` SHALL remain set (the runtime config requires it) but is never touched at runtime under `STORAGE_BACKEND=bunny` + a remote `DATABASE_URL`. Env blocks remain alphabetized by `name`.

#### Scenario: Single always-on staging app in Frankfurt

- **WHEN** the operator inspects the planned `bunnynet_compute_container_app.staging`
- **THEN** it SHALL declare `autoscaling_min = autoscaling_max = 1` and a single Frankfurt region
- **AND** the container env SHALL set `PERSISTENCE_PATH=/data`
- **AND** the container env SHALL set `DATABASE_URL` to the `bunnynet_database.staging` `url` output
- **AND** the container env SHALL set `DATABASE_AUTH_TOKEN`
- **AND** the container env SHALL NOT set `DATABASE_WAL`

#### Scenario: Remote Bunny Database backs staging

- **WHEN** the operator inspects the staging Terraform
- **THEN** a managed Bunny Database (`bunnynet_database`) resource SHALL be declared
- **AND** the container's `DATABASE_URL` SHALL reference that resource's `url` (not a `file:` URL)

#### Scenario: Staging selects the Bunny bundle backend

- **WHEN** the rendered `bunnynet_compute_container_app.staging` env is inspected
- **THEN** it SHALL set `STORAGE_BACKEND=bunny`, `STORAGE_BUNNY_ENDPOINT`, and `STORAGE_BUNNY_STORAGE_ZONE`
- **AND** `STORAGE_BUNNY_ACCESS_KEY` SHALL be wired from the `bunnynet_storage_zone` resource's `password` attribute
- **AND** `PERSISTENCE_PATH` SHALL still be `/data`

### Requirement: Staging secrets as plaintext env on the platform

The staging app's `bunnynet` `env` block SHALL carry the staging configuration and secrets (`GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `AUTH_ALLOW`, `BASE_URL`, `PORT`, `PERSISTENCE_PATH`, the workflow-secrets sealing key, `STORAGE_BUNNY_ACCESS_KEY`, and the Bunny Database access token `DATABASE_AUTH_TOKEN`). Configuration and OAuth/sealing secrets are sourced from `TF_VAR_*` values; two exceptions are sourced from resource attributes rather than `TF_VAR` inputs — `STORAGE_BUNNY_ACCESS_KEY` from the `bunnynet_storage_zone` resource's `password` attribute, and `DATABASE_AUTH_TOKEN` from the in-tofu token mint (the `restful_operation` resource's response output). Because Magic Containers has no secret store, env values are plaintext at the platform. Secret values SHALL NOT appear in committed `*.tfvars`; they SHALL be encrypted at rest only in tofu state (the existing `encryption {}` block).

Because the `bunnynet` provider does NOT mark `env.value` as sensitive (it renders unredacted in plan output, which `plan-infra.yml` pipes into `$GITHUB_STEP_SUMMARY`), every secret-bearing input SHALL be redacted in plan output: secret-bearing `TF_VAR_*` inputs SHALL be declared `sensitive = true`; the `bunnynet_storage_zone` `password` attribute is provider-marked sensitive; and the token-mint response attribute that feeds `DATABASE_AUTH_TOKEN` SHALL be marked `sensitive` (via the `restful_operation` `use_sensitive_output`).

#### Scenario: Secrets reach the app without entering committed source

- **WHEN** the repository is inspected
- **THEN** no staging secret value SHALL appear in any committed `*.tfvars` file
- **AND** the secret values SHALL be supplied via `TF_VAR_*` (or, for the storage access key and the database token, the respective resource attribute) and rendered into the `bunnynet` `env` block

#### Scenario: Secrets do not leak into the plan-infra step summary

- **GIVEN** secret-bearing `TF_VAR_*` inputs are declared `sensitive = true`, the storage-zone `password` is provider-marked sensitive, and the token-mint output uses `use_sensitive_output`
- **WHEN** `plan-infra` renders the plan into `$GITHUB_STEP_SUMMARY`
- **THEN** the staging OAuth client secret, the sealing key, the storage access key, and `DATABASE_AUTH_TOKEN` SHALL appear as `(sensitive value)`, not in cleartext

## REMOVED Requirements

### Requirement: Staging persistent volume mounted at /data

**Reason**: Staging is now fully stateless. With the event-store/queue database on the managed Bunny Database and workflow bundles on the Bunny Edge Storage zone, nothing is written to local disk — the `/data` volume and its `volumemount` are removed. The runtime never touches `PERSISTENCE_PATH` under `STORAGE_BACKEND=bunny` + a remote `DATABASE_URL` (`createFsStorage` is not constructed; the libSQL client is HTTP-only).

**Migration**: Remove the `volume {}` block and the container `volumemount {}` from `bunnynet_compute_container_app.staging`. Keep `PERSISTENCE_PATH=/data` in the env (the config field is still required) — it needs no backing volume. The prior embedded `events.db` on the volume is discarded (accept-loss).

## ADDED Requirements

### Requirement: Staging Bunny Database provisioning and in-tofu token mint

The `infrastructure/` project SHALL provision a managed Bunny Database for staging and mint its access token within the same `tofu apply`, so standing up the staging stack requires no out-of-band token step.

A `bunnynet_database` resource SHALL be declared for staging with `regions_primary = ["DE"]` (matching the Frankfurt-pinned container) and no `regions_replica`. Its `url` output SHALL be the source of the container's `DATABASE_URL`.

The access token SHALL be minted in-tofu via the `magodo/restful` provider's `restful_operation` resource, which on create SHALL issue `PUT https://api.bunny.net/database/v2/databases/{db_id}/auth/generate` with body `{ "authorization": "full-access", "expires_at": null }` and header `AccessKey = var.bunnynet_api_key`, capturing the response `token` into a `sensitive` output (`use_sensitive_output = true`) that feeds `DATABASE_AUTH_TOKEN`. The `{db_id}` SHALL be `bunnynet_database.staging.id`, interpolated into `path` so the operation is create-only and is not re-minted on plan refresh (a database replacement re-mints for the new id). The mint resource SHALL invoke `POST https://api.bunny.net/database/v2/databases/{db_id}/auth/revoke` on destroy. No `DATABASE_AUTH_TOKEN` value SHALL be required as a `TF_VAR_*` input — the provider's account API key (`var.bunnynet_api_key`) is the only credential needed to mint it.

`magodo/restful` SHALL be added to `required_providers` and `.terraform.lock.hcl` SHALL be refreshed with multi-platform hashes per the repo convention.

#### Scenario: Bunny Database provisioned in Frankfurt with no replicas

- **WHEN** the operator inspects the planned staging Terraform
- **THEN** a `bunnynet_database.staging` resource SHALL be declared with `regions_primary = ["DE"]` and no `regions_replica`
- **AND** the container's `DATABASE_URL` env SHALL reference `bunnynet_database.staging.url`

#### Scenario: Token minted once via an authenticated HTTP action, not the CLI

- **WHEN** the operator inspects the token-mint resource
- **THEN** it SHALL be a `magodo/restful` `restful_operation` issuing `PUT …/v2/databases/{db_id}/auth/generate` with `authorization = "full-access"` and the `AccessKey` header set to `var.bunnynet_api_key`
- **AND** it SHALL interpolate `bunnynet_database.staging.id` into `path` so a plan refresh does not re-mint the (non-idempotent) token
- **AND** the captured token attribute SHALL be `sensitive` and feed the `DATABASE_AUTH_TOKEN` env

#### Scenario: Destroy revokes the database tokens

- **WHEN** the token-mint resource is destroyed
- **THEN** it SHALL issue `POST …/v2/databases/{db_id}/auth/revoke` for the staging database

#### Scenario: No external token secret is required

- **WHEN** the repository and CI secrets are inspected
- **THEN** there SHALL be no `TF_VAR_*`/GHA secret carrying a pre-minted `DATABASE_AUTH_TOKEN`
- **AND** the only Bunny credential consumed SHALL be the existing account API key `var.bunnynet_api_key`
