## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: Static JS asset routes
**Reason**: Static assets (Alpine.js, HTMX) are now served by the static middleware at `/static/*` instead of by the dashboard middleware at `/dashboard/*`.
**Migration**: Update references from `/dashboard/alpine.js` to `/static/alpine.js` and `/dashboard/htmx.js` to `/static/htmx.js`.
