## MODIFIED Requirements

### Requirement: Local HTTPS on localhost

The Caddyfile SHALL configure the site address using the `{$DOMAIN}` environment variable with no default fallback. The `DOMAIN` env var SHALL be set on the Caddy container by the orchestration tool (Pulumi). If `DOMAIN` is not set, Caddy SHALL fail to start.

#### Scenario: HTTPS with configured domain

- **WHEN** a client connects to `https://{DOMAIN}`
- **THEN** Caddy SHALL present a valid TLS certificate for that domain

#### Scenario: Missing DOMAIN env var

- **WHEN** Caddy starts without the `DOMAIN` environment variable set
- **THEN** Caddy SHALL fail to parse the Caddyfile
