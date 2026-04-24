## ADDED Requirements

### Requirement: GET /webhooks/ readiness endpoint

The HTTP trigger middleware SHALL handle `GET /webhooks/` and return HTTP `204 No Content` when the trigger registry has at least one registered HTTP trigger across all tenants, or HTTP `503 Service Unavailable` when no HTTP triggers are registered. The response body SHALL be empty in both cases. `POST /webhooks/*` traffic (the actual trigger invocation path) SHALL NOT be affected by this endpoint — individual trigger routes continue to resolve independently.

The readiness endpoint exists so liveness/readiness probes can distinguish "runtime is up but has not yet loaded any workflows" (503) from "runtime is up with workflows loaded" (204). The endpoint SHALL NOT be authenticated (it is part of the public `/webhooks/*` prefix).

#### Scenario: 204 when at least one HTTP trigger is registered

- **GIVEN** the HTTP trigger registry has one or more registered HTTP triggers
- **WHEN** `GET /webhooks/` is requested
- **THEN** the response status SHALL be `204 No Content`
- **AND** the response body SHALL be empty

#### Scenario: 503 when no HTTP triggers are registered

- **GIVEN** the HTTP trigger registry has no registered HTTP triggers
- **WHEN** `GET /webhooks/` is requested
- **THEN** the response status SHALL be `503 Service Unavailable`
- **AND** the response body SHALL be empty

#### Scenario: POST traffic unaffected by readiness semantics

- **GIVEN** an HTTP trigger registered at `/webhooks/<tenant>/<workflow>/myHook`
- **WHEN** `POST /webhooks/<tenant>/<workflow>/myHook` is requested
- **THEN** the trigger SHALL fire as normal
- **AND** the 204/503 semantics of `GET /webhooks/` SHALL NOT apply to POST
