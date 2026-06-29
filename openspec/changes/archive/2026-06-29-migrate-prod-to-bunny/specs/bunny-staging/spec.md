## ADDED Requirements

### Requirement: Capability removed

This capability SHALL NOT carry any standalone `bunny-staging` requirements; it has been renamed and generalized into the `bunny-deployment` capability. The Bunny Magic Containers app, CDN endpoint, plaintext-env secrets, `/livez` readiness probe, deploy roll-forward, Bunny Database provisioning + in-tofu token mint, and Edge Storage bundle backend are no longer staging-only: they MUST live in `bunny-deployment`, whose requirements are parameterized over both deployment envs `{staging, prod}`.

#### Scenario: Replacement capability exists

- **WHEN** an operator looks up the Bunny Magic Containers / CDN / Bunny Database / Edge Storage deployment requirements
- **THEN** the canonical source SHALL be `openspec/specs/bunny-deployment/spec.md` (the env-keyed `{staging, prod}` requirements introduced in this change)

## REMOVED Requirements

### Requirement: Magic Containers staging app via the bunnynet provider

**Reason**: The Magic Containers app requirement is generalized from staging-only to an env-keyed `{staging, prod}` requirement under the new `bunny-deployment` capability. Prod is now provisioned through the same `bunnynet_compute_container_app` shape rather than remaining on the Scaleway VPS, so a single env-parameterized requirement covers both.

**Migration**: See the env-keyed "Magic Containers app via the bunnynet provider" requirement in `openspec/specs/bunny-deployment/spec.md`.

### Requirement: CDN endpoint provides managed HTTPS for staging

**Reason**: The CDN managed-HTTPS requirement is generalized from staging-only to env-keyed `{staging, prod}` under the `bunny-deployment` capability, since prod now exposes the same CDN endpoint shape and custom-hostname/TLS flow on its own public host.

**Migration**: See the env-keyed "CDN endpoint provides managed HTTPS" requirement in `openspec/specs/bunny-deployment/spec.md`.

### Requirement: CDN SHALL NOT cache dynamic routes (gating observation)

**Reason**: The "before prod" gating observation is resolved now that prod is covered by the same `bunny-deployment` capability — the dynamic-route cache constraint is restated as an env-keyed `{staging, prod}` invariant rather than a one-time staging-only check that gates prod promotion.

**Migration**: See the env-keyed "CDN SHALL NOT cache dynamic routes" requirement in `openspec/specs/bunny-deployment/spec.md`.

### Requirement: Staging secrets as plaintext env on the platform

**Reason**: The plaintext-env secrets requirement is generalized from staging-only to env-keyed `{staging, prod}` under `bunny-deployment`, since prod's Magic Containers app carries its secrets the same way (no platform secret store) and faces the same plan-output redaction constraint.

**Migration**: See the env-keyed "Secrets as plaintext env on the platform" requirement in `openspec/specs/bunny-deployment/spec.md`.

### Requirement: Staging readiness probe on /livez (not /readyz)

**Reason**: The `/livez` readiness-probe requirement is generalized from staging-only to env-keyed `{staging, prod}` under `bunny-deployment`, because prod's container hits the identical self-reach deadlock on `/readyz` and MUST gate Bunny traffic on `/livez` too.

**Migration**: See the env-keyed "Readiness probe on /livez (not /readyz)" requirement in `openspec/specs/bunny-deployment/spec.md`.

### Requirement: Staging deploy rolls Bunny forward without Terraform image drift

**Reason**: The deploy roll-forward requirement is generalized from staging-only to env-keyed `{staging, prod}` under `bunny-deployment`, since prod is now rolled forward by the same digest-update + `/readyz` gitSha-poll mechanism with the same `lifecycle { ignore_changes }` drift suppression.

**Migration**: See the env-keyed "Deploy rolls Bunny forward without Terraform image drift" requirement in `openspec/specs/bunny-deployment/spec.md`.

### Requirement: Staging Bunny Database provisioning and in-tofu token mint

**Reason**: The Bunny Database provisioning + in-tofu token mint requirement is generalized from staging-only to env-keyed `{staging, prod}` under `bunny-deployment`, since prod provisions its own `bunnynet_database` and mints its access token in the same `tofu apply` via the same `magodo/restful` operation.

**Migration**: See the env-keyed "Bunny Database provisioning and in-tofu token mint" requirement in `openspec/specs/bunny-deployment/spec.md`.
