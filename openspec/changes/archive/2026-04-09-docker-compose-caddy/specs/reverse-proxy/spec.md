## ADDED Requirements

### Requirement: Caddyfile exists at infrastructure/Caddyfile

The repository SHALL contain a `infrastructure/Caddyfile` that configures Caddy as a reverse proxy for the workflow-engine.

#### Scenario: Caddyfile is valid

- **WHEN** Caddy loads the Caddyfile
- **THEN** it SHALL parse without errors

### Requirement: Local HTTPS on localhost

The Caddyfile SHALL configure the site address as `localhost`, causing Caddy to auto-provision a TLS certificate via its built-in local CA.

#### Scenario: HTTPS on localhost

- **WHEN** a client connects to `https://localhost`
- **THEN** Caddy SHALL present a valid TLS certificate for `localhost`

### Requirement: Dashboard routes proxied to app

Requests matching `/dashboard/` or `/dashboard/*` SHALL be reverse-proxied to `app:8080` with the full path preserved.

#### Scenario: Dashboard page request

- **WHEN** a GET request is made to `https://localhost/dashboard/`
- **THEN** Caddy SHALL proxy the request to `app:8080` with path `/dashboard/`

#### Scenario: Dashboard sub-path request

- **WHEN** a GET request is made to `https://localhost/dashboard/list?state=pending`
- **THEN** Caddy SHALL proxy the request to `app:8080` with path `/dashboard/list?state=pending`

### Requirement: Webhook routes proxied to app

Requests matching `/webhooks/*` SHALL be reverse-proxied to `app:8080` with the full path preserved.

#### Scenario: Webhook request

- **WHEN** a POST request is made to `https://localhost/webhooks/order`
- **THEN** Caddy SHALL proxy the request to `app:8080` with path `/webhooks/order`

### Requirement: Unmatched paths return 404

Any request that does not match the dashboard or webhook path matchers SHALL receive a plain-text `404` response directly from Caddy.

#### Scenario: Root path

- **WHEN** a GET request is made to `https://localhost/`
- **THEN** Caddy SHALL respond with status 404 and body `Not Found`

#### Scenario: Random path

- **WHEN** a GET request is made to `https://localhost/admin`
- **THEN** Caddy SHALL respond with status 404 and body `Not Found`
