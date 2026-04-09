## MODIFIED Requirements

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

## ADDED Requirements

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
