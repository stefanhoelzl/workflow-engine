# Dashboard Middleware Specification

## Purpose

Provide the middleware factory and route handlers for serving the dashboard UI, including the HTML page shell and integration with the existing Hono server.

## Requirements

### Requirement: Dashboard middleware factory
The system SHALL provide a `dashboardMiddleware` factory function that accepts an `EventStore` and returns a standard `Middleware` object (`{ match, handler }`).

#### Scenario: Middleware creation
- **WHEN** `dashboardMiddleware(eventStore)` is called
- **THEN** a `Middleware` is returned with `match` set to `"/dashboard/*"`

#### Scenario: Middleware integrates with existing server
- **WHEN** the dashboard middleware is passed to `createServer` alongside the HTTP trigger middleware
- **THEN** both `/webhooks/*` and `/dashboard/*` routes are served from the same Hono server

### Requirement: Dashboard page route
The system SHALL serve a complete HTML page at `GET /dashboard` using the shared layout function with `user` and `email` from authentication headers.

#### Scenario: Page load with authenticated user
- **WHEN** a browser requests `GET /dashboard` with `X-Auth-Request-User: stefan` and `X-Auth-Request-Email: stefan@example.com` headers
- **THEN** the response is an HTML document produced by `renderLayout({ title: "Dashboard", activePath: "/dashboard", user: "stefan", email: "stefan@example.com" }, dashboardContent)`
- **THEN** the top bar displays the username and email

#### Scenario: Page load without auth headers
- **WHEN** a browser requests `GET /dashboard` without authentication headers
- **THEN** the layout is rendered with empty user and email
- **THEN** the top bar user section is hidden

### Requirement: Security context

The implementation SHALL conform to the threat model documented at
`/SECURITY.md §4 Authentication`, which enumerates the trust level,
entry points, threats, current mitigations, residual risks, and rules
governing this capability. This capability reads `X-Auth-Request-User`
and `X-Auth-Request-Email` forwarded headers from oauth2-proxy; the
threat model treats forwarded-header trust as contingent on network
controls documented in `/SECURITY.md §5`.

Changes to this capability that introduce new threats, weaken or remove
a documented mitigation, add reliance on additional forwarded headers,
alter the identity signal consumed by downstream UI code, or conflict
with the rules listed in `/SECURITY.md §4` MUST update `/SECURITY.md §4`
in the same change proposal.

#### Scenario: Change alters behaviors covered by the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change affects a threat, mitigation, residual risk, or
  rule enumerated in `/SECURITY.md §4`
- **THEN** the proposal SHALL include the corresponding updates to
  `/SECURITY.md §4`
- **AND** the updates SHALL be reviewed before the change is archived

#### Scenario: Change is orthogonal to the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change does not affect any item enumerated in
  `/SECURITY.md §4`
- **THEN** no update to `/SECURITY.md §4` is required
- **AND** the proposal SHALL note that threat-model alignment was
  checked
