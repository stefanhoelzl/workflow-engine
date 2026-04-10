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
