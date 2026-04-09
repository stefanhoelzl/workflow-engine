## MODIFIED Requirements

### Requirement: Docker Compose file defines the local stack

The repository SHALL contain a `infrastructure/docker-compose.yml` file that defines three services: `app` (workflow-engine), `proxy` (Caddy reverse proxy), and `oauth2-proxy` (authentication proxy).

#### Scenario: Compose file exists and is valid

- **WHEN** `docker compose -f infrastructure/docker-compose.yml config` is run from the repo root
- **THEN** it SHALL exit successfully and list services `app`, `proxy`, and `oauth2-proxy`

## ADDED Requirements

### Requirement: Caddy command includes --watch flag

The `proxy` service SHALL override the default command to `caddy run --config /etc/caddy/Caddyfile --watch` for automatic configuration reloading.

#### Scenario: Caddy runs with watch flag

- **WHEN** the compose file is parsed
- **THEN** the `proxy` service SHALL have command `caddy run --config /etc/caddy/Caddyfile --watch`
