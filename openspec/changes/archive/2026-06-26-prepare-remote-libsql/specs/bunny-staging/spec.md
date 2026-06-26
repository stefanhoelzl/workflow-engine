## MODIFIED Requirements

### Requirement: Magic Containers staging app via the bunnynet provider

The `infrastructure/` project SHALL declare the `bunnynet` provider and exactly one `bunnynet_compute_container_app` resource for staging. The app SHALL reference image `ghcr.io/stefanhoelzl/workflow-engine:main` (a `linux/amd64` image), SHALL set `autoscaling_min` and `autoscaling_max` both to `1`, and SHALL pin a single EU region (Frankfurt) via `regions_required`. The container SHALL expose the app's listen port (8080) and SHALL set `PERSISTENCE_PATH=/data`.

The container SHALL also set `DATABASE_URL=file:/data/events.db` and `DATABASE_WAL=true`, keeping staging on the embedded on-disk libSQL database. The change SHALL NOT set `DATABASE_AUTH_TOKEN` and SHALL NOT provision a remote (Bunny Database) libSQL resource — staging remains embedded; the remote env vars are wired-ready but unset. Prod SHALL NOT be deployed to Magic Containers by this change — it remains entirely on the Scaleway VPS.

#### Scenario: Single always-on staging app in Frankfurt

- **WHEN** the operator inspects the planned `bunnynet_compute_container_app.staging`
- **THEN** it SHALL declare `autoscaling_min = autoscaling_max = 1` and a single Frankfurt region
- **AND** the container env SHALL set `PERSISTENCE_PATH=/data`, `DATABASE_URL=file:/data/events.db`, and `DATABASE_WAL=true`
- **AND** the container env SHALL NOT set `DATABASE_AUTH_TOKEN`

#### Scenario: No remote libSQL resource provisioned

- **WHEN** the operator inspects the staging Terraform
- **THEN** there SHALL NOT be a Bunny Database / remote libSQL resource declared
