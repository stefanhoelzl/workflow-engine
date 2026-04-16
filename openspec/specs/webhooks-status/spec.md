### Requirement: Webhooks subsystem readiness endpoint
The HTTP trigger middleware SHALL handle `GET /webhooks/` and return HTTP `204` when the trigger registry has at least one registered trigger, or HTTP `503` when no triggers are registered. The response SHALL have no body.

#### Scenario: Triggers are registered
- **GIVEN** the HttpTriggerRegistry has one or more registered triggers
- **WHEN** `GET /webhooks/` is requested
- **THEN** the response status SHALL be `204`
- **AND** the response body SHALL be empty

#### Scenario: No triggers registered
- **GIVEN** the HttpTriggerRegistry has no registered triggers
- **WHEN** `GET /webhooks/` is requested
- **THEN** the response status SHALL be `503`
- **AND** the response body SHALL be empty

#### Scenario: POST requests are unaffected
- **GIVEN** a trigger registered at `/webhooks/my-hook`
- **WHEN** `POST /webhooks/my-hook` is requested
- **THEN** the trigger SHALL fire as before (no change to existing behavior)

### Requirement: GET /webhooks/ returns liveness status

A `GET /webhooks/` request SHALL return `204 No Content` if at least one HTTP trigger is registered, or `503 Service Unavailable` if none are registered. The endpoint SHALL be served by the HTTP trigger middleware reading from the new HTTP trigger registry.

#### Scenario: 204 when triggers registered

- **GIVEN** at least one HTTP trigger is registered
- **WHEN** `GET /webhooks/` is requested
- **THEN** the response SHALL be `204 No Content`

#### Scenario: 503 when no triggers

- **GIVEN** no HTTP triggers are registered
- **WHEN** `GET /webhooks/` is requested
- **THEN** the response SHALL be `503 Service Unavailable`
