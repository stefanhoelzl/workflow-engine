## MODIFIED Requirements

### Requirement: Single-replica invariant

The app runtime SHALL NOT be operated with more than one replica while the session cookie sealing password is generated in-memory. A second replica would sign cookies with a different password, causing deterministic decryption failures on every request that lands on a process other than the one that sealed the cookie.

This requirement SHALL be enforced structurally by the `infrastructure` capability, which provisions exactly one Quadlet `wfe-<env>.container` unit per env on a single VPS — there is no orchestrator that can scale the workload to >1. The requirement SHALL also be referenced in `SECURITY.md §5` as an invariant that must be resolved (by moving the password to a shared mechanism such as a host-side keyfile or an external KMS) before any change introduces a second concurrent app process.

#### Scenario: Exactly one Quadlet unit per env

- **WHEN** the infrastructure has been provisioned
- **THEN** exactly one `wfe-prod.service` and exactly one `wfe-staging.service` Quadlet unit SHALL exist on the VPS
- **AND** no orchestration mechanism (replica controller, HPA, second host) SHALL exist that could spawn an additional process for the same env

#### Scenario: Change adds a second concurrent process without shared sealing

- **GIVEN** a proposed change introduces a second concurrent app process for the same env
- **WHEN** the change is reviewed
- **THEN** the change SHALL be rejected unless it also migrates the session sealing password to a shared mechanism documented in `SECURITY.md §5`
