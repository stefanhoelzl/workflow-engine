## MODIFIED Requirements

### Requirement: Webhooks subsystem readiness endpoint

The HTTP trigger middleware SHALL handle `GET /webhooks/` and return HTTP `204` when the trigger registry has at least one registered trigger across any `(owner, repo)`, or HTTP `503` when no triggers are registered. The response SHALL have no body.

The readiness check is scope-agnostic — a single registered trigger under any `(owner, repo)` is sufficient to return `204`. The endpoint SHALL NOT accept or require `(owner, repo)` path segments; it is a global subsystem health check.

#### Scenario: No triggers registered

- **GIVEN** the registry has no bundles registered
- **WHEN** `GET /webhooks/` is requested
- **THEN** the response SHALL be `503` with no body

#### Scenario: At least one trigger across any scope

- **GIVEN** `(acme, foo)` has a registered HTTP trigger
- **WHEN** `GET /webhooks/` is requested
- **THEN** the response SHALL be `204` with no body
