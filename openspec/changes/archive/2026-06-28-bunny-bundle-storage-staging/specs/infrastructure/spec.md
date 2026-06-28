## ADDED Requirements

### Requirement: Bunny Edge Storage zone for staging bundles

The `infrastructure/` project SHALL declare exactly one `bunnynet_storage_zone`
resource for staging bundle storage, with its main storage region set to
Frankfurt (DE) to match the staging Magic Containers region and the Scaleway
`fr-par` footprint. The zone is dedicated to staging bundles; prod (on the VPS)
is NOT migrated and remains on the local-disk (`fs`) backend. (Bunny is the sole
staging backend; the VPS staging stack was retired in a prior change.)

The zone's read-write access key SHALL be sourced from the resource's own
`password` attribute and threaded directly into the staging Magic Containers app
env (see the `bunny-staging` capability) — no new `TF_VAR_*` input or GHA secret
SHALL be introduced for it. Because the `bunnynet` provider marks the zone
`password` attribute sensitive, it SHALL NOT appear in the `plan-infra` step
summary.

Provisioning the zone is operator-driven via the `apply-infra` workflow; agents
SHALL NOT run `tofu apply`. The `plan-infra` empty-plan gate SHALL hold once the
operator has applied.

#### Scenario: Single Frankfurt storage zone declared

- **WHEN** the operator inspects the planned infrastructure
- **THEN** there SHALL be exactly one `bunnynet_storage_zone` resource with its main region set to Frankfurt (DE)

#### Scenario: Access key flows from the zone resource, not a new secret input

- **WHEN** the repository and tofu variables are inspected
- **THEN** the staging app's Bunny access key SHALL be wired from `bunnynet_storage_zone.<name>.password`
- **AND** there SHALL NOT be a new `TF_VAR_*` input or GHA secret declared for the storage-zone access key

#### Scenario: Access key does not leak into the plan-infra step summary

- **WHEN** `plan-infra` renders the plan into `$GITHUB_STEP_SUMMARY`
- **THEN** the storage-zone access key SHALL appear as a sensitive/redacted value, not in cleartext
