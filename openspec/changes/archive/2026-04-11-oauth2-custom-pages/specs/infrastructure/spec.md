## ADDED Requirements

### Requirement: Unauthenticated static asset route

The Traefik IngressRoute SHALL include a route for `/static*` that proxies to the app service without authentication middleware, allowing the sign-in page to load CSS before the user is logged in.

#### Scenario: Static assets accessible without auth
- **WHEN** a browser requests `/static/workflow-engine.css` without a session cookie
- **THEN** Traefik routes the request to the app service
- **THEN** the response contains the CSS file (no auth redirect)

#### Scenario: Route has no auth middleware
- **WHEN** the IngressRoute is defined
- **THEN** the `/static*` route has no `oauth2-errors` or `oauth2-forward-auth` middleware
