## MODIFIED Requirements

### Requirement: Root redirect

The server SHALL redirect `GET /` to `/invocations` with a `302` status. The redirect SHALL match the exact root path only; requests to any other path SHALL NOT be redirected by this handler.

#### Scenario: Root redirects to /invocations
- **WHEN** a `GET /` request is received
- **THEN** the response status SHALL be `302`
- **AND** the `Location` header SHALL be `/invocations`

#### Scenario: Non-root paths are not redirected
- **WHEN** a `GET /trigger` request is received
- **THEN** the response SHALL NOT be a redirect produced by the root-redirect handler

#### Scenario: Redirect precedes the static middleware
- **GIVEN** the static middleware is mounted at `/static/*`
- **WHEN** a `GET /` request is received
- **THEN** the root-redirect handler SHALL fire
- **AND** the static middleware SHALL NOT be invoked
