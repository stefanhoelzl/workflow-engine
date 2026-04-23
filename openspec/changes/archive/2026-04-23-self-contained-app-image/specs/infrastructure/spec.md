## MODIFIED Requirements

### Requirement: Traefik Helm release

The routing module SHALL create a `helm_release` installing the `traefik/traefik` chart version `39.0.7`. The Helm release SHALL use `traefik_helm_sets` for environment-specific Helm `set` values, `traefik_extra_objects` for CRD objects deployed via the chart's `extraObjects` feature, and an optional `wait` variable (bool, default `false`) controlling whether Helm waits for all resources to be ready.

The Helm release SHALL NOT declare any `experimental.plugins` or `experimental.localPlugins` entry, SHALL NOT mount any init container for plugin extraction, SHALL NOT create a ConfigMap carrying a plugin tarball as `binary_data`, and SHALL NOT mount a `plugins-local` or `plugin-src` volume. The module's `error_page_5xx_html` input variable SHALL be removed. Rendering of 5xx HTML bodies is performed inside the app, not inside Traefik.

#### Scenario: Traefik installed via Helm with parameterized config
- **WHEN** `tofu apply` completes
- **THEN** Traefik SHALL be running in the cluster
- **AND** the Helm `set` values SHALL match the provided `traefik_helm_sets`
- **AND** the Helm `extraObjects` SHALL contain the provided `traefik_extra_objects`

#### Scenario: Wait disabled (default)
- **WHEN** `tofu apply` is run with `wait` not set
- **THEN** Helm SHALL not wait for resources to be ready before marking the release as successful

#### Scenario: Wait enabled
- **WHEN** `tofu apply` is run with `wait = true`
- **THEN** Helm SHALL wait for all pods to be ready and LoadBalancer services to receive an external IP before marking the release as successful

#### Scenario: Web entrypoint enabled internally
- **WHEN** the Traefik pod is running
- **THEN** the web entrypoint SHALL listen on port 80 inside the pod
- **AND** the Traefik K8s Service SHALL include port 80
- **AND** no NodePort SHALL be mapped to port 80

#### Scenario: No plugin scaffolding on the Traefik pod
- **WHEN** the Traefik pod is inspected
- **THEN** it SHALL have no init container
- **AND** it SHALL have no `plugins-local` `emptyDir` volume mount
- **AND** it SHALL have no `plugin-src` ConfigMap volume mount
- **AND** the rendered Helm values SHALL contain no `experimental.plugins` or `experimental.localPlugins` entries

#### Scenario: Module input contract
- **WHEN** the `modules/traefik/` module's input variables are inspected
- **THEN** there SHALL be no variable named `error_page_5xx_html`

### Requirement: IngressRoute for routing

The routes-chart Helm release's `extraObjects` SHALL include exactly one `IngressRoute` CRD on the `websecure` entrypoint: a single catch-all rule matching `Host(var.domain) && PathPrefix('/')` that routes to the app service on the app port, with no attached Middleware references, and carrying TLS via `tls.secretName = var.tlsSecretName`. All URL dispatch — `/dashboard`, `/trigger`, `/auth`, `/login`, `/static`, `/webhooks`, `/api`, `/livez`, `/`, and the unknown-path fallback — is performed by the app's Hono router. The routes-chart SHALL NOT define any `Middleware` CRD named `not-found`, `server-error`, `inline-error`, or `redirect-root`, and SHALL NOT define any IngressRoute that references those middlewares or the `traefik_inline_response` plugin. The routes-chart SHALL continue to define the `redirect-to-https` `Middleware` and the `web`-entrypoint IngressRoute that applies it — HTTP→HTTPS redirection remains at Traefik because TLS terminates there.

#### Scenario: Single catch-all routes all prefixes to the app
- **WHEN** a request arrives at `https://<domain>/dashboard` with any trailing path
- **THEN** the catch-all IngressRoute SHALL match
- **AND** the request SHALL be routed to `app_service:app_port`
- **AND** no Middleware SHALL be applied

#### Scenario: Webhook prefix routes through the catch-all
- **WHEN** a POST to `https://<domain>/webhooks/<tenant>/<workflow>/<trigger>` arrives
- **THEN** the catch-all IngressRoute SHALL match
- **AND** the request SHALL reach the app on `:8080`

#### Scenario: API prefix routes through the catch-all
- **WHEN** a request to `https://<domain>/api/workflows/<tenant>` arrives
- **THEN** the catch-all IngressRoute SHALL match
- **AND** the request SHALL reach the app on `:8080` with no Traefik-level auth middleware interposed

#### Scenario: Unknown path reaches the app
- **WHEN** a request to `https://<domain>/absolutely-nothing` arrives
- **THEN** the catch-all IngressRoute SHALL match
- **AND** the app's global `notFound` handler SHALL produce the response (content-negotiated per `http-server` spec)

#### Scenario: HTTP-to-HTTPS redirect preserved on web entrypoint
- **WHEN** a request arrives at `http://<domain>/anything` on the `web` entrypoint
- **THEN** the `redirect-to-https` Middleware SHALL fire
- **AND** the client SHALL receive a `301` redirect to the `https://` equivalent

#### Scenario: No deleted middlewares remain in the rendered chart
- **WHEN** the rendered `routes-chart` Kubernetes manifests are inspected
- **THEN** no resource of kind `Middleware` SHALL be named `not-found`, `server-error`, `inline-error`, or `redirect-root`
- **AND** no resource of kind `IngressRoute` SHALL be named `error-pages`

## REMOVED Requirements

### Requirement: Root redirect
**Reason**: The root redirect `GET / → 302 /trigger` moves into the app. A Traefik `redirectRegex` Middleware is no longer used.
**Migration**: The same redirect is now implemented as `app.get("/", c => c.redirect("/trigger", 302))` in the Hono app. See `http-server` spec §"Root redirect" for the new requirement.

### Requirement: Not-found errors middleware
**Reason**: 404 handling moves into the app. Traefik no longer intercepts 404 responses from the app.
**Migration**: Styled 404 bodies are now served by the app's global `notFound` handler, content-negotiated per the `Accept` header. See `http-server` spec §"Unmatched routes return 404" and `static-assets` spec §"404 HTML page" for the new requirements.

### Requirement: Server-error errors middleware
**Reason**: 5xx handling moves into the app. Traefik no longer intercepts 5xx responses from the app.
**Migration**: Styled 5xx bodies for thrown exceptions are now served by the app's global `onError` handler, content-negotiated per the `Accept` header. See `http-server` spec §"Global error handler for unhandled exceptions" and `static-assets` spec §"5xx error page" for the new requirements. Handlers that explicitly return a 5xx body keep their own body and status (documented gap — no behavioural parity maintained for that code path).

### Requirement: Inline error page route on web entrypoint
**Reason**: The `traefik_inline_response` plugin is removed. There is no longer a loopback `Path('/error')` route, no `noop@internal` backend for it, and no inline HTML response served by Traefik.
**Migration**: None required at the infra layer — the route simply disappears along with the plugin. The equivalent HTML is served by the app as documented in `static-assets` spec §"5xx error page".
