### Requirement: Caddyfile exists at infrastructure/Caddyfile

The repository SHALL contain a `infrastructure/Caddyfile` that configures Caddy as a reverse proxy for the workflow-engine.

#### Scenario: Caddyfile is valid

- **WHEN** Caddy loads the Caddyfile
- **THEN** it SHALL parse without errors

### Requirement: Local HTTPS on localhost

The Caddyfile SHALL configure the site address using the `{$DOMAIN}` environment variable with no default fallback. The `DOMAIN` env var SHALL be set on the Caddy container by the orchestration tool (Pulumi). If `DOMAIN` is not set, Caddy SHALL fail to start.

#### Scenario: HTTPS with configured domain

- **WHEN** a client connects to `https://{DOMAIN}`
- **THEN** Caddy SHALL present a valid TLS certificate for that domain

#### Scenario: Missing DOMAIN env var

- **WHEN** Caddy starts without the `DOMAIN` environment variable set
- **THEN** Caddy SHALL fail to parse the Caddyfile

### Requirement: Dashboard routes proxied to app

Requests matching `/dashboard` or `/dashboard/*` SHALL first pass through forward_auth to `oauth2-proxy:4180` and, upon success, be reverse-proxied to `app:8080` with the full path preserved. The `X-Forwarded-User` and `X-Forwarded-Email` headers from the auth response SHALL be copied to the upstream request.

#### Scenario: Authenticated dashboard page request

- **WHEN** a GET request is made to `https://localhost/dashboard/` with a valid session
- **THEN** Caddy SHALL verify auth via forward_auth to `oauth2-proxy:4180`
- **AND** proxy the request to `app:8080` with path `/dashboard/`
- **AND** include `X-Forwarded-User` and `X-Forwarded-Email` headers

#### Scenario: Unauthenticated dashboard request

- **WHEN** a GET request is made to `https://localhost/dashboard/` without a valid session
- **THEN** Caddy SHALL redirect the user to the OAuth login flow

### Requirement: Webhook routes proxied to app

Requests matching `/webhooks/*` SHALL be reverse-proxied to `app:8080` with the full path preserved.

#### Scenario: Webhook request

- **WHEN** a POST request is made to `https://localhost/webhooks/order`
- **THEN** Caddy SHALL proxy the request to `app:8080` with path `/webhooks/order`

### Requirement: OAuth2 routes proxied to oauth2-proxy

Requests matching `/oauth2/*` SHALL be reverse-proxied to `oauth2-proxy:4180`.

#### Scenario: OAuth callback request

- **WHEN** a GET request is made to `https://localhost/oauth2/callback`
- **THEN** Caddy SHALL proxy the request to `oauth2-proxy:4180`

#### Scenario: OAuth start request

- **WHEN** a GET request is made to `https://localhost/oauth2/start`
- **THEN** Caddy SHALL proxy the request to `oauth2-proxy:4180`

### Requirement: Caddy auto-reloads on Caddyfile changes

The Caddy container SHALL run with the `--watch` flag so that changes to the volume-mounted Caddyfile are picked up automatically without restarting the container.

#### Scenario: Caddyfile modification triggers reload

- **WHEN** the Caddyfile is modified on the host
- **THEN** Caddy SHALL reload its configuration automatically
- **AND** the new configuration SHALL take effect without downtime

### Requirement: Unmatched paths return 404

Any request that does not match the dashboard or webhook path matchers SHALL receive a plain-text `404` response directly from Caddy.

#### Scenario: Root path

- **WHEN** a GET request is made to `https://localhost/`
- **THEN** Caddy SHALL respond with status 404 and body `Not Found`

#### Scenario: Random path

- **WHEN** a GET request is made to `https://localhost/admin`
- **THEN** Caddy SHALL respond with status 404 and body `Not Found`
