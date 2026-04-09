## ADDED Requirements

### Requirement: Docker Compose file defines the local stack

The repository SHALL contain a `infrastructure/docker-compose.yml` file that defines two services: `app` (workflow-engine) and `proxy` (Caddy reverse proxy).

#### Scenario: Compose file exists and is valid

- **WHEN** `docker compose -f infrastructure/docker-compose.yml config` is run from the repo root
- **THEN** it SHALL exit successfully and list services `app` and `proxy`

### Requirement: app service builds from infrastructure/Dockerfile

The `app` service SHALL build from the repository's Dockerfile at `infrastructure/Dockerfile` with the repo root as build context.

#### Scenario: app service build configuration

- **WHEN** the compose file is parsed
- **THEN** the `app` service SHALL have `build.context` set to `..` (repo root)
- **AND** `build.dockerfile` set to `infrastructure/Dockerfile`

### Requirement: app service exposes port 8080 internally

The `app` service SHALL expose port 8080 to other compose services but SHALL NOT publish it to the host.

#### Scenario: app port is internal only

- **WHEN** the compose stack is running
- **THEN** the `proxy` service SHALL be able to reach `app:8080`
- **AND** port 8080 SHALL NOT be accessible from the host

### Requirement: app service configures persistence via bind-mount

The `app` service SHALL bind-mount the host's `.persistence/` directory to `/events` inside the container and set `PERSISTENCE_PATH=/events`.

#### Scenario: Persistence volume mapping

- **WHEN** the compose file is parsed
- **THEN** the `app` service SHALL have a volume mapping `../.persistence:/events`
- **AND** environment variable `PERSISTENCE_PATH` set to `/events`

### Requirement: proxy service uses stock Caddy image

The `proxy` service SHALL use the `caddy:2` image without modification.

#### Scenario: Proxy image

- **WHEN** the compose file is parsed
- **THEN** the `proxy` service SHALL use image `caddy:2`

### Requirement: proxy service publishes port 443

The `proxy` service SHALL publish port 443 to the host for HTTPS access. No other ports SHALL be published.

#### Scenario: Only HTTPS port exposed

- **WHEN** the compose stack is running
- **THEN** port 443 SHALL be accessible from the host
- **AND** no other ports SHALL be published by the `proxy` service

### Requirement: proxy service mounts Caddyfile and data volume

The `proxy` service SHALL mount the Caddyfile read-only and use a named volume for Caddy's data directory.

#### Scenario: Proxy volumes

- **WHEN** the compose file is parsed
- **THEN** the `proxy` service SHALL mount `./Caddyfile` to `/etc/caddy/Caddyfile` as read-only
- **AND** mount named volume `caddy_data` to `/caddy`
- **AND** set environment variable `XDG_DATA_HOME` to `/caddy`

### Requirement: Container restart and logging policies

All services SHALL use `unless-stopped` restart policy and json-file logging with size limits.

#### Scenario: Restart policy

- **WHEN** any service container stops unexpectedly
- **THEN** Docker SHALL restart it automatically

#### Scenario: Log rotation

- **WHEN** a service produces log output
- **THEN** logs SHALL be written with json-file driver, max-size 10MB, max-file 3

### Requirement: pnpm start runs docker-compose

The root `package.json` start script SHALL run `docker compose -f infrastructure/docker-compose.yml up --build`.

#### Scenario: pnpm start brings up the stack

- **WHEN** `pnpm start` is run from the repo root
- **THEN** Docker Compose SHALL build the app image and start both services
