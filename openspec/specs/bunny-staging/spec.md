# bunny-staging Specification

## Purpose
TBD - created by archiving change staging-bunny-magic-containers. Update Purpose after archive.
## Requirements
### Requirement: Capability removed

This capability SHALL NOT carry any standalone `bunny-staging` requirements; it has been renamed and generalized into the `bunny-deployment` capability. The Bunny Magic Containers app, CDN endpoint, plaintext-env secrets, `/livez` readiness probe, deploy roll-forward, Bunny Database provisioning + in-tofu token mint, and Edge Storage bundle backend are no longer staging-only: they MUST live in `bunny-deployment`, whose requirements are parameterized over both deployment envs `{staging, prod}`.

#### Scenario: Replacement capability exists

- **WHEN** an operator looks up the Bunny Magic Containers / CDN / Bunny Database / Edge Storage deployment requirements
- **THEN** the canonical source SHALL be `openspec/specs/bunny-deployment/spec.md` (the env-keyed `{staging, prod}` requirements introduced in this change)

