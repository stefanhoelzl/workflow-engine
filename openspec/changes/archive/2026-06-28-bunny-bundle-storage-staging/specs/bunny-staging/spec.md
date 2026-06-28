## MODIFIED Requirements

### Requirement: Magic Containers staging app via the bunnynet provider

The `infrastructure/` project SHALL declare the `bunnynet` provider and exactly one `bunnynet_compute_container_app` resource for staging. The app SHALL reference image `ghcr.io/stefanhoelzl/workflow-engine:main` (a `linux/amd64` image), SHALL set `autoscaling_min` and `autoscaling_max` both to `1`, and SHALL pin a single EU region (Frankfurt) via `regions_required`. The container SHALL expose the app's listen port (8080) and SHALL set `PERSISTENCE_PATH=/data`.

The container SHALL also set `DATABASE_URL=file:/data/events.db` and `DATABASE_WAL=true`, keeping staging on the embedded on-disk libSQL database. The change SHALL NOT set `DATABASE_AUTH_TOKEN` and SHALL NOT provision a remote (Bunny Database) libSQL resource — staging remains embedded; the remote env vars are wired-ready but unset. Prod SHALL NOT be deployed to Magic Containers by this change — it remains entirely on the Scaleway VPS.

The staging app SHALL select the Bunny Edge Storage bundle backend by setting `STORAGE_BACKEND=bunny` together with `STORAGE_BUNNY_ENDPOINT` (the storage origin host), `STORAGE_BUNNY_STORAGE_ZONE` (the staging zone name), and `STORAGE_BUNNY_ACCESS_KEY` (referenced from the `bunnynet_storage_zone` resource's `password` attribute — see the `infrastructure` capability). `PERSISTENCE_PATH=/data` SHALL remain set so `events.db` continues to live on the local volume; only the `workflows/` bundle tree moves to the zone. Env blocks remain alphabetized by `name`.

#### Scenario: Single always-on staging app in Frankfurt

- **WHEN** the operator inspects the planned `bunnynet_compute_container_app.staging`
- **THEN** it SHALL declare `autoscaling_min = autoscaling_max = 1` and a single Frankfurt region
- **AND** the container env SHALL set `PERSISTENCE_PATH=/data`, `DATABASE_URL=file:/data/events.db`, and `DATABASE_WAL=true`
- **AND** the container env SHALL NOT set `DATABASE_AUTH_TOKEN`

#### Scenario: No remote libSQL resource provisioned

- **WHEN** the operator inspects the staging Terraform
- **THEN** there SHALL NOT be a Bunny Database / remote libSQL resource declared

#### Scenario: Staging selects the Bunny bundle backend

- **WHEN** the rendered `bunnynet_compute_container_app.staging` env is inspected
- **THEN** it SHALL set `STORAGE_BACKEND=bunny`, `STORAGE_BUNNY_ENDPOINT`, and `STORAGE_BUNNY_STORAGE_ZONE`
- **AND** `STORAGE_BUNNY_ACCESS_KEY` SHALL be wired from the `bunnynet_storage_zone` resource's `password` attribute
- **AND** `PERSISTENCE_PATH` SHALL still be `/data`

### Requirement: Staging secrets as plaintext env on the platform

The staging app's `bunnynet` `env` block SHALL carry the staging configuration and secrets (`GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `AUTH_ALLOW`, `BASE_URL`, `PORT`, `PERSISTENCE_PATH`, the workflow-secrets sealing key, and `STORAGE_BUNNY_ACCESS_KEY`). Configuration and OAuth/sealing secrets are sourced from `TF_VAR_*` values; the `STORAGE_BUNNY_ACCESS_KEY` is the one exception — it is sourced from the `bunnynet_storage_zone` resource's `password` attribute rather than a `TF_VAR` input. Because Magic Containers has no secret store, env values are plaintext at the platform. Secret values SHALL NOT appear in committed `*.tfvars`; they SHALL be encrypted at rest only in tofu state (the existing `encryption {}` block).

Because the `bunnynet` provider does NOT mark `env.value` as sensitive (it renders unredacted in plan output, which `plan-infra.yml` pipes into `$GITHUB_STEP_SUMMARY`), every secret-bearing `TF_VAR_*` input SHALL be declared `sensitive = true` so Terraform redacts it in plan output. The `bunnynet_storage_zone` `password` attribute is provider-marked sensitive, so the access-key env value is likewise redacted in plan output without an explicit `TF_VAR`.

#### Scenario: Secrets reach the app without entering committed source

- **WHEN** the repository is inspected
- **THEN** no staging secret value SHALL appear in any committed `*.tfvars` file
- **AND** the secret values SHALL be supplied via `TF_VAR_*` (or, for the storage access key, the zone resource attribute) and rendered into the `bunnynet` `env` block

#### Scenario: Secrets do not leak into the plan-infra step summary

- **GIVEN** secret-bearing `TF_VAR_*` inputs are declared `sensitive = true` and the storage-zone `password` is provider-marked sensitive
- **WHEN** `plan-infra` renders the plan into `$GITHUB_STEP_SUMMARY`
- **THEN** the staging OAuth client secret, the sealing key, and the storage access key SHALL appear as `(sensitive value)`, not in cleartext
