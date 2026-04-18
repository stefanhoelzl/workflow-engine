## ADDED Requirements

### Requirement: Strip forward-auth headers on non-UI routes

The routes-chart SHALL include a Traefik `Middleware` CRD of type `headers` named `strip-auth-headers`. The middleware SHALL clear every `X-Auth-Request-*` header emitted by oauth2-proxy from the incoming request before it reaches the backend, by setting each header to `""` under `customRequestHeaders` (per Traefik semantics, empty string deletes the header).

The header list SHALL cover the oauth2-proxy v7 emitted set: `X-Auth-Request-User`, `X-Auth-Request-Email`, `X-Auth-Request-Preferred-Username`, `X-Auth-Request-Groups`, `X-Auth-Request-Access-Token`, `X-Auth-Request-Redirect`.

The middleware SHALL be attached to every route in the `workflow-engine` IngressRoute except `PathPrefix('/dashboard')` and `PathPrefix('/trigger')`, which are the only routes where oauth2-proxy is authoritative over these headers (via the `oauth2-forward-auth` middleware's `authResponseHeaders`).

#### Scenario: Middleware resource exists

- **WHEN** the routes-chart Helm release reconciles
- **THEN** a `Middleware` resource named `strip-auth-headers` SHALL exist in the release namespace
- **AND** its `customRequestHeaders` map SHALL include all six oauth2-proxy `X-Auth-Request-*` headers mapped to `""`

#### Scenario: Forged headers dropped on API route

- **GIVEN** a curl request to `https://<host>/api/workflows/<tenant>` with headers `X-Auth-Request-User: attacker` and `X-Auth-Request-Groups: victim-tenant`
- **WHEN** Traefik routes the request
- **THEN** the backend app SHALL receive the request with those headers absent
- **AND** no `X-Auth-Request-*` header forged by the client SHALL be visible to the app

#### Scenario: Forged headers dropped on webhook route

- **GIVEN** a public webhook POST to `https://<host>/webhooks/<tenant>/<workflow>/<path>` with `X-Auth-Request-User: attacker`
- **WHEN** Traefik routes the request
- **THEN** the backend SHALL receive the request with `X-Auth-Request-User` absent

#### Scenario: oauth2-proxy headers preserved on UI routes

- **GIVEN** an authenticated browser request to `/dashboard/` with a valid oauth2-proxy session cookie
- **WHEN** Traefik invokes `oauth2-forward-auth`, which populates `X-Auth-Request-User` et al. via `authResponseHeaders`
- **THEN** the backend SHALL receive the headers populated by oauth2-proxy
- **AND** the `strip-auth-headers` middleware SHALL NOT be applied to `/dashboard` or `/trigger`

## MODIFIED Requirements

### Requirement: IngressRoute for routing

The Helm release `extraObjects` SHALL include Traefik `IngressRoute` CRDs on the `websecure` entrypoint organized into four categories:

**Auth whitelist** (oauth2-proxy protected):
- `PathPrefix('/dashboard')` routes to app service (with oauth2-errors + oauth2-forward-auth + not-found + server-error middleware; `strip-auth-headers` NOT applied because oauth2-proxy is authoritative over `X-Auth-Request-*` here)
- `PathPrefix('/trigger')` routes to app service (with oauth2-errors + oauth2-forward-auth + not-found + server-error middleware; `strip-auth-headers` NOT applied for the same reason)

**No-auth whitelist** (public):
- `Path('/')` redirects to `/trigger` (with strip-auth-headers + redirect-root middleware)
- `PathPrefix('/oauth2')` routes to oauth2-proxy service (with strip-auth-headers middleware)
- `PathPrefix('/static')` routes to app service (with strip-auth-headers middleware)
- `PathPrefix('/webhooks')` routes to app service (with strip-auth-headers + server-error middleware)
- `Path('/livez')` routes to app service (with strip-auth-headers middleware)

**App-auth** (app validates tokens internally):
- `PathPrefix('/api')` routes to app service (with strip-auth-headers + server-error middleware)

**Catch-all** (deny by default):
- `PathPrefix('/')` with low priority routes to app service (with strip-auth-headers + not-found middleware)

The `strip-auth-headers` middleware SHALL be ordered first in every chain that includes it, so that `X-Auth-Request-*` headers are cleared before any downstream middleware or backend sees them.

#### Scenario: OAuth2 routes

- **WHEN** a request matches `PathPrefix('/oauth2')`
- **THEN** it SHALL be routed to `oauth2_service:oauth2_port` with the `strip-auth-headers` middleware applied (no authentication or error middleware)

#### Scenario: Webhook routes

- **WHEN** a request matches `PathPrefix('/webhooks')`
- **THEN** it SHALL be routed to `app_service:app_port` without authentication middleware
- **AND** with the `strip-auth-headers` and `server-error` middlewares

#### Scenario: Static asset routes

- **WHEN** a request matches `PathPrefix('/static')`
- **THEN** it SHALL be routed to `app_service:app_port` with the `strip-auth-headers` middleware applied (no error or authentication middleware)

#### Scenario: Livez route

- **WHEN** a request matches `Path('/livez')`
- **THEN** it SHALL be routed to `app_service:app_port` with the `strip-auth-headers` middleware applied

#### Scenario: API routes

- **WHEN** a request matches `PathPrefix('/api')`
- **THEN** it SHALL be routed to `app_service:app_port` without oauth2 middleware
- **AND** with the `strip-auth-headers` and `server-error` middlewares applied
- **AND** forged `X-Auth-Request-*` headers from the client SHALL NOT reach the app

#### Scenario: Dashboard routes with auth

- **WHEN** a request matches `PathPrefix('/dashboard')`
- **THEN** the ForwardAuth middleware SHALL verify the request via oauth2-proxy
- **AND** unauthenticated requests SHALL see the oauth2-proxy sign-in page
- **AND** authenticated requests SHALL be routed to `app_service:app_port`
- **AND** `X-Auth-Request-*` headers set by oauth2-proxy SHALL be forwarded to the app (the `strip-auth-headers` middleware is NOT applied on this route)
- **AND** 404 responses SHALL be replaced with the styled 404 page
- **AND** 5xx responses SHALL be replaced with the styled 5xx page

#### Scenario: Trigger routes with auth

- **WHEN** a request matches `PathPrefix('/trigger')`
- **THEN** the ForwardAuth middleware SHALL verify the request via oauth2-proxy
- **AND** unauthenticated requests SHALL see the oauth2-proxy sign-in page
- **AND** authenticated requests SHALL be routed to `app_service:app_port`
- **AND** `X-Auth-Request-*` headers set by oauth2-proxy SHALL be forwarded to the app (the `strip-auth-headers` middleware is NOT applied on this route)
- **AND** 404 responses SHALL be replaced with the styled 404 page
- **AND** 5xx responses SHALL be replaced with the styled 5xx page

#### Scenario: Unknown path returns 404

- **WHEN** a request matches no specific route and falls through to the catch-all
- **THEN** the `strip-auth-headers` middleware SHALL clear forged identity headers
- **AND** the not-found middleware SHALL intercept the 404 from the app
- **AND** the response SHALL be the styled 404 page

#### Scenario: Root path redirects to trigger

- **WHEN** a request matches `Path('/')`
- **THEN** the `strip-auth-headers` middleware SHALL clear forged identity headers
- **AND** the user SHALL be redirected to `/trigger` with a 302 status
