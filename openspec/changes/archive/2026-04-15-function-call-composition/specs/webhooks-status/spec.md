## ADDED Requirements

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

## REMOVED Requirements

### Requirement: Status endpoint reads from EventSource

**Reason**: `EventSource` is removed. Liveness derives from the HTTP trigger registry directly.

**Migration**: The endpoint reads from the new HTTP trigger registry.
