## ADDED Requirements

### Requirement: App module accepts auth_allow input

The `modules/app-instance/` module SHALL declare an `auth_allow` input variable (type `string`). The module SHALL inject the value as the `AUTH_ALLOW` environment variable on the app container using a plain `env { name = "AUTH_ALLOW" value = var.auth_allow }` block (i.e., not from a secret), so the allow-list is visible in pod specs and Kubernetes events for auditability.

#### Scenario: auth_allow threaded to pod env

- **WHEN** the `app-instance` module is instantiated with `auth_allow = "github:user:alice;github:org:acme"`
- **THEN** the rendered `kubernetes_deployment_v1.app` SHALL contain a container `env` entry with `name = "AUTH_ALLOW"` and `value = "github:user:alice;github:org:acme"`

#### Scenario: auth_allow empty string

- **WHEN** the `app-instance` module is instantiated with `auth_allow = ""`
- **THEN** the rendered deployment SHALL still include the `AUTH_ALLOW` env var with an empty string value
- **AND** the app SHALL resolve `auth.mode` to `disabled`, rejecting every request with `401 Unauthorized`

### Requirement: App module accepts GitHub OAuth App credentials

The `modules/app-instance/` module SHALL declare two input variables carrying the GitHub OAuth App credentials:

- `github_oauth_client_id` (type `string`) — the OAuth App's client id, injected as the `GITHUB_OAUTH_CLIENT_ID` environment variable via a plain `env {}` block.
- `github_oauth_client_secret` (type `string`, marked `sensitive`) — the OAuth App's client secret, stored in a Kubernetes Secret and injected as the `GITHUB_OAUTH_CLIENT_SECRET` environment variable via `value_from.secret_key_ref`.

The Kubernetes Secret holding the client secret SHALL be created by this module (not oauth2-proxy's module, which no longer exists) and SHALL follow the same naming convention as other app Secrets in the module.

#### Scenario: Client id injected as plain env var

- **WHEN** the `app-instance` module is instantiated with `github_oauth_client_id = "cid123"`
- **THEN** the rendered app Deployment SHALL contain a container `env` entry with `name = "GITHUB_OAUTH_CLIENT_ID"` and `value = "cid123"`

#### Scenario: Client secret injected from Kubernetes Secret

- **WHEN** the `app-instance` module is instantiated with a non-empty `github_oauth_client_secret`
- **THEN** the module SHALL create a `kubernetes_secret_v1` containing the client secret
- **AND** the app container SHALL receive `GITHUB_OAUTH_CLIENT_SECRET` via `value_from.secret_key_ref` referencing that Secret
- **AND** the Terraform plan SHALL NOT print the secret value in plaintext (variable is marked `sensitive`)

## MODIFIED Requirements

### Requirement: App Deployment

The module SHALL create a `kubernetes_deployment_v1` running the provided `image` with `spec.replicas = 1`. The container SHALL listen on port 8080.

The `replicas = 1` invariant is load-bearing for the `auth` capability: the session-cookie sealing password is generated in memory at app startup and is not shared across pods. Running more than one replica would cause deterministic cookie-decryption failures whenever a request lands on a pod other than the one that sealed the cookie. Raising `replicas` above 1 SHALL be blocked by the corresponding `auth` invariant recorded in `/SECURITY.md §5` until the sealing-password strategy is migrated to a shared mechanism (e.g., a K8s Secret or KMS-backed KEK).

#### Scenario: App pod running with a single replica

- **WHEN** `tofu apply` completes
- **THEN** exactly one app pod SHALL be running with the specified image
- **AND** the Deployment's `spec.replicas` SHALL equal 1

#### Scenario: Raising replicas beyond one is blocked by spec invariant

- **GIVEN** a change proposal that sets `spec.replicas > 1` on the app Deployment
- **WHEN** the proposal is reviewed
- **THEN** the proposal SHALL include a migration of the session-cookie sealing password out of in-memory state (recorded in the `auth` capability) before being accepted

### Requirement: IngressRoute for routing

The routes-chart Helm release's `extraObjects` SHALL include Traefik `IngressRoute` CRDs on the `websecure` entrypoint organized into three categories:

**UI routes** (session-authenticated by the app, no Traefik-level auth middleware):
- `PathPrefix('/dashboard')` routes to app service (with `not-found` and `server-error` middlewares). No forward-auth, no strip-auth-headers.
- `PathPrefix('/trigger')` routes to app service (with `not-found` and `server-error` middlewares). No forward-auth, no strip-auth-headers.
- `PathPrefix('/auth')` routes to app service (with `not-found` and `server-error` middlewares). Covers `/auth/github/login`, `/auth/github/callback`, and `/auth/logout`.

**No-auth whitelist** (public):
- `Path('/')` redirects to `/trigger` (with `redirect-root` middleware).
- `PathPrefix('/static')` routes to app service (no middleware).
- `PathPrefix('/webhooks')` routes to app service (with `server-error` middleware).
- `Path('/livez')` routes to app service (no middleware).

**App-auth** (app validates tokens internally):
- `PathPrefix('/api')` routes to app service (with `server-error` middleware).

**Catch-all** (deny by default):
- `PathPrefix('/')` with low priority routes to app service (with `not-found` middleware).

The `/oauth2/*` IngressRoute SHALL NOT be present. The `oauth2-forward-auth`, `oauth2-errors`, and `strip-auth-headers` Middleware CRDs SHALL NOT be defined or attached to any route.

#### Scenario: Dashboard route has no forward-auth

- **WHEN** a request matches `PathPrefix('/dashboard')`
- **THEN** it SHALL be routed to `app_service:app_port` with only the `not-found` and `server-error` middlewares
- **AND** no `forwardAuth` Middleware SHALL be applied
- **AND** no `X-Auth-Request-*` headers SHALL be set by any middleware

#### Scenario: /auth routes reach the app

- **WHEN** a request matches `PathPrefix('/auth')`
- **THEN** it SHALL be routed to `app_service:app_port`
- **AND** no auth middleware SHALL interpose

#### Scenario: /oauth2 path is not routed

- **WHEN** a request matches `PathPrefix('/oauth2')`
- **THEN** no IngressRoute SHALL match it
- **AND** the catch-all IngressRoute SHALL handle the request with a 404

#### Scenario: API routes without auth middleware

- **WHEN** a request matches `PathPrefix('/api')`
- **THEN** it SHALL be routed to `app_service:app_port` without any auth middleware applied
- **AND** the app's Bearer middleware SHALL perform authentication

#### Scenario: Webhook routes remain public

- **WHEN** a POST to `PathPrefix('/webhooks')` arrives
- **THEN** it SHALL be routed to `app_service:app_port` with only the `server-error` middleware

#### Scenario: Root redirect unchanged

- **WHEN** a request matches `Path('/')`
- **THEN** the user SHALL be redirected to `/trigger` with a 302 status

#### Scenario: Unknown path returns 404

- **WHEN** a request matches no specific route and falls through to the catch-all
- **THEN** the `not-found` middleware SHALL intercept the 404 from the app
- **AND** the response SHALL be the styled 404 page

## REMOVED Requirements

### Requirement: App module accepts github_users input
**Reason**: Replaced by the new `App module accepts auth_allow input` requirement, which threads the `AUTH_ALLOW` env var with provider-prefixed grammar instead of the simple `GITHUB_USER` comma-separated list.
**Migration**: See this capability's `App module accepts auth_allow input` requirement. Callers of the module SHALL rename the input from `github_users` to `auth_allow` and SHALL update the variable value to the new grammar. `github_users = "alice,bob"` becomes `auth_allow = "github:user:alice;github:user:bob"`.

### Requirement: OAuth2-proxy Deployment
**Reason**: The oauth2-proxy pod is removed entirely. Authentication is performed in the app process.
**Migration**: No replacement resource. See `auth/spec.md` for the in-app OAuth flow.

### Requirement: OAuth2-proxy environment variables
**Reason**: No `OAUTH2_PROXY_*` env vars exist anywhere in the infrastructure. The app reads `AUTH_ALLOW`, `GITHUB_OAUTH_CLIENT_ID`, and `GITHUB_OAUTH_CLIENT_SECRET`.
**Migration**: See this capability's `App module accepts auth_allow input` and `App module accepts GitHub OAuth App credentials` requirements.

### Requirement: Cookie secret generation
**Reason**: oauth2-proxy's 32-byte random cookie secret Kubernetes Secret is not needed. The app generates a 32-byte sealing password in memory at process start and never persists it (see `auth/spec.md` → "Session cookie sealing").
**Migration**: No replacement resource. The `random_password` resource and its corresponding Kubernetes Secret field SHALL be removed.

### Requirement: OAuth2-proxy Secret
**Reason**: No Kubernetes Secret is associated with oauth2-proxy because the sidecar is removed. A Secret containing `GITHUB_OAUTH_CLIENT_SECRET` is created on the app side instead (see the new `App module accepts GitHub OAuth App credentials` requirement).
**Migration**: See this capability's `App module accepts GitHub OAuth App credentials` requirement. The new Secret carries only the client secret; the client id is a plain env var; the cookie secret is replaced by the in-memory sealing password.

### Requirement: OAuth2-proxy health probe
**Reason**: No oauth2-proxy container exists. App health is probed via its existing liveness and readiness probes on port 8080.
**Migration**: No replacement.

### Requirement: OAuth2-proxy Service
**Reason**: No oauth2-proxy Service is needed because no pod exists. Traefik routes auth traffic to the app service directly via the `/auth/*` IngressRoute.
**Migration**: See the modified `IngressRoute for routing` requirement, which includes `PathPrefix('/auth')` routed to `app_service:app_port`.

### Requirement: oauth2-proxy workload network allow-rules
**Reason**: No oauth2-proxy pod exists, so no dedicated NetworkPolicy selects its pods. The app pod's existing NetworkPolicy (egress to public internet for GitHub API calls, DNS, ingress from Traefik) covers the app's new OAuth responsibilities; no change to the app NetworkPolicy is required.
**Migration**: No replacement. The app pod's existing `egress_internet = true` profile already permits outbound HTTPS to `github.com` (token exchange) and `api.github.com` (profile/orgs fetch).

### Requirement: ForwardAuth Middleware
**Reason**: No forward-auth chain exists. The app performs authentication in-process via its session middleware.
**Migration**: See `auth/spec.md` → "Session middleware on /dashboard/* and /trigger/*". The unauthenticated-user redirect that was previously handled by ForwardAuth returning 401 + errors-middleware intercepting is now handled by the app responding `302 /auth/github/login?returnTo=<original>` directly.

### Requirement: Errors Middleware for OAuth2 redirect
**Reason**: The Errors Middleware that redirected 401/403 to oauth2-proxy's sign-in page is obsolete because oauth2-proxy's sign-in page no longer exists and the sessionMw issues 302s directly.
**Migration**: No replacement. See `auth/spec.md` → "Session middleware on /dashboard/* and /trigger/*" for the redirect flow.

### Requirement: Strip forward-auth headers on non-UI routes
**Reason**: The `strip-auth-headers` Middleware existed to prevent forged `X-Auth-Request-*` headers from reaching the app on non-UI routes, as defence-in-depth against oauth2-proxy's own header path. With oauth2-proxy removed and `headerUserMiddleware` deleted, no code path in the runtime reads `X-Auth-Request-*` headers, and the Middleware has no threat to mitigate.
**Migration**: No replacement. The application-side invariant ("no code path reads `X-Auth-Request-*`") is stated in `auth/spec.md`'s `Bearer middleware on /api/*` and `Session middleware on /dashboard/* and /trigger/*` requirements (both explicitly SHALL NOT read those headers) and reinforced in `/SECURITY.md §4`.

### Requirement: oauth2-proxy env vars via dynamic maps
**Reason**: No oauth2-proxy container exists; the `dynamic "env"` blocks and their supporting local maps are deleted.
**Migration**: No replacement. The app container's env var set is defined by the existing `App S3 environment variables` requirement plus the new `App module accepts auth_allow input` and `App module accepts GitHub OAuth App credentials` requirements.
