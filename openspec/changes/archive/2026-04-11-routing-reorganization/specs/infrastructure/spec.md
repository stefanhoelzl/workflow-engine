## MODIFIED Requirements

### Requirement: Traefik Helm release

The module SHALL create a `helm_release` installing the `traefik/traefik` chart version `39.0.7`. The Helm release SHALL configure Traefik with a `NodePort` service on port 30443 for the websecure entrypoint. The Helm release SHALL also enable the `web` entrypoint (HTTP port 80) without NodePort exposure — this entrypoint is used only for internal loopback error page serving. The Helm release SHALL install the `traefik_inline_response` plugin (`github.com/tuxgal/traefik_inline_response`). The IngressRoute, ForwardAuth Middleware, Errors Middleware, and Plugin Middleware SHALL be deployed via the Helm chart's `extraObjects` feature (not as separate `kubernetes_manifest` resources) to avoid CRD timing issues during first apply.

#### Scenario: Traefik installed via Helm

- **WHEN** `tofu apply` completes
- **THEN** Traefik SHALL be running in the cluster
- **AND** the Traefik CRDs (IngressRoute, Middleware, MiddlewarePlugin) SHALL be registered
- **AND** the IngressRoute and Middleware objects SHALL be deployed as part of the Helm release

#### Scenario: Web entrypoint enabled internally

- **WHEN** the Traefik pod is running
- **THEN** the web entrypoint SHALL listen on port 80 inside the pod
- **AND** the Traefik K8s Service SHALL include port 80
- **AND** no NodePort SHALL be mapped to port 80

#### Scenario: Plugin installed

- **WHEN** the Traefik pod starts
- **THEN** the `traefik_inline_response` plugin SHALL be loaded and available for middleware configuration

### Requirement: IngressRoute for routing

The Helm release `extraObjects` SHALL include Traefik `IngressRoute` CRDs on the `websecure` entrypoint organized into four categories:

**Auth whitelist** (oauth2-proxy protected):
- `PathPrefix('/dashboard')` routes to app service (with oauth2-errors + oauth2-forward-auth + not-found + server-error middleware)
- `PathPrefix('/trigger')` routes to app service (with oauth2-errors + oauth2-forward-auth + not-found + server-error middleware)

**No-auth whitelist** (public):
- `Path('/')` redirects to `/trigger` (via redirect-root middleware, no error middleware)
- `PathPrefix('/oauth2')` routes to oauth2-proxy service (no middleware)
- `PathPrefix('/static')` routes to app service (no error middleware)
- `PathPrefix('/webhooks')` routes to app service (with server-error middleware)
- `Path('/livez')` routes to app service (no middleware)

**App-auth** (app validates tokens internally):
- `PathPrefix('/api')` routes to app service (with server-error middleware)

**Catch-all** (deny by default):
- `PathPrefix('/')` with low priority routes to app service (with not-found middleware)

#### Scenario: OAuth2 routes

- **WHEN** a request matches `PathPrefix('/oauth2')`
- **THEN** it SHALL be routed to `oauth2_service:oauth2_port` without authentication or error middleware

#### Scenario: Webhook routes

- **WHEN** a request matches `PathPrefix('/webhooks')`
- **THEN** it SHALL be routed to `app_service:app_port` without authentication middleware
- **AND** with the server-error middleware

#### Scenario: Static asset routes

- **WHEN** a request matches `PathPrefix('/static')`
- **THEN** it SHALL be routed to `app_service:app_port` without any error or authentication middleware

#### Scenario: Livez route

- **WHEN** a request matches `Path('/livez')`
- **THEN** it SHALL be routed to `app_service:app_port` without any middleware

#### Scenario: API routes

- **WHEN** a request matches `PathPrefix('/api')`
- **THEN** it SHALL be routed to `app_service:app_port` without oauth2 middleware
- **AND** with the server-error middleware

#### Scenario: Dashboard routes with auth

- **WHEN** a request matches `PathPrefix('/dashboard')`
- **THEN** the ForwardAuth middleware SHALL verify the request via oauth2-proxy
- **AND** unauthenticated requests SHALL see the oauth2-proxy sign-in page
- **AND** authenticated requests SHALL be routed to `app_service:app_port`
- **AND** 404 responses SHALL be replaced with the styled 404 page
- **AND** 5xx responses SHALL be replaced with the styled 5xx page

#### Scenario: Trigger routes with auth

- **WHEN** a request matches `PathPrefix('/trigger')`
- **THEN** the ForwardAuth middleware SHALL verify the request via oauth2-proxy
- **AND** unauthenticated requests SHALL see the oauth2-proxy sign-in page
- **AND** authenticated requests SHALL be routed to `app_service:app_port`
- **AND** 404 responses SHALL be replaced with the styled 404 page
- **AND** 5xx responses SHALL be replaced with the styled 5xx page

#### Scenario: Unknown path returns 404

- **WHEN** a request matches no specific route and falls through to the catch-all
- **THEN** the not-found middleware SHALL intercept the 404 from the app
- **AND** the response SHALL be the styled 404 page

#### Scenario: Root path redirects to trigger

- **WHEN** a request matches `Path('/')`
- **THEN** the user SHALL be redirected to `/trigger` with a 302 status

### Requirement: Not-found errors middleware

The Helm release `extraObjects` SHALL include a Traefik `Middleware` CRD of type `errors` named `not-found`. The middleware SHALL intercept HTTP 404 responses and fetch the replacement content from the app service at `/static/404.html`.

#### Scenario: 404 intercepted and replaced

- **WHEN** the app returns HTTP 404 on a route with the `not-found` middleware
- **THEN** the middleware SHALL fetch `/static/404.html` from the app service
- **AND** the response body SHALL be replaced with the fetched content

### Requirement: Server-error errors middleware

The Helm release `extraObjects` SHALL include a Traefik `Middleware` CRD of type `errors` named `server-error`. The middleware SHALL intercept HTTP 500-599 responses and fetch the replacement content from the Traefik K8s Service on port 80 (web entrypoint) at the `/error` path.

#### Scenario: 5xx intercepted and replaced via loopback

- **WHEN** the app returns HTTP 500 on a route with the `server-error` middleware
- **THEN** the middleware SHALL fetch `/error` from the Traefik service on port 80
- **AND** the response body SHALL be replaced with the inline 5xx error page

### Requirement: Inline error page route on web entrypoint

The Helm release `extraObjects` SHALL include a Traefik `IngressRoute` CRD on the `web` entrypoint with a route matching `Path('/error')`. The route SHALL use the `traefik_inline_response` plugin middleware to serve self-contained 5xx HTML. The backend service SHALL be `noop@internal`.

#### Scenario: Loopback serves inline HTML

- **WHEN** an HTTP request is made to Traefik port 80 at `/error`
- **THEN** the `traefik_inline_response` middleware SHALL return the inline 5xx HTML page
- **AND** the response content type SHALL be detected as `text/html`
