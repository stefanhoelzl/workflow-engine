## ADDED Requirements

### Requirement: Pulumi project in infrastructure/

The `infrastructure/` directory SHALL contain a Pulumi project with `Pulumi.yaml`, `index.ts`, `package.json`, and `tsconfig.json`. It SHALL be registered as a pnpm workspace package in `pnpm-workspace.yaml`.

#### Scenario: Pulumi project is valid

- **WHEN** `pulumi preview` is run from `infrastructure/`
- **THEN** it SHALL parse the project successfully without errors

#### Scenario: pnpm workspace includes infrastructure

- **WHEN** `pnpm install` is run from the repo root
- **THEN** `infrastructure/` SHALL be resolved as a workspace package
- **AND** its dependencies (`@pulumi/pulumi`, `@pulumi/docker`, `@pulumi/docker-build`) SHALL be installed

### Requirement: ESM TypeScript configuration

The infrastructure package SHALL use `"type": "module"` in `package.json` and `tsconfig.json` SHALL set `module` and `moduleResolution` to `nodenext`.

#### Scenario: ESM module format

- **WHEN** Pulumi runs the program
- **THEN** it SHALL execute `index.ts` as an ES module

### Requirement: Dev stack targets local Docker

The `dev` stack SHALL target the local Docker daemon. All containers, volumes, and images SHALL be created on the local machine.

#### Scenario: Dev stack uses local Docker

- **WHEN** `pulumi up -s dev` is run
- **THEN** all Docker resources SHALL be created on the local Docker daemon

### Requirement: Stack config is the single source of truth

All configuration values (domain, ports, credentials) SHALL be defined in `Pulumi.<stack>.yaml`. No other file (Caddyfile, Dockerfile, etc.) SHALL contain default values for stack-configurable settings.

#### Scenario: Dev stack defaults

- **WHEN** the dev stack config is read
- **THEN** `domain` SHALL be `localhost`
- **AND** `httpsPort` SHALL be `8443`

#### Scenario: Missing config fails loudly

- **WHEN** a required config value is missing from the stack
- **THEN** `pulumi up` SHALL fail with an error identifying the missing config key

### Requirement: Secrets stored as Pulumi encrypted secrets

OAuth2-proxy credentials (`oauth2ClientId`, `oauth2ClientSecret`, `oauth2CookieSecret`, `oauth2GithubUser`) SHALL be stored as Pulumi encrypted secrets in the stack config file. They SHALL NOT be readable in plaintext from the config file.

#### Scenario: Secrets are encrypted at rest

- **WHEN** `Pulumi.dev.yaml` is inspected
- **THEN** secret values SHALL be stored in Pulumi's encrypted format

#### Scenario: Secrets are injected into containers

- **WHEN** `pulumi up` is run
- **THEN** the oauth2-proxy container SHALL receive the decrypted secret values as environment variables

### Requirement: Pulumi Cloud state backend

The Pulumi project SHALL use Pulumi Cloud (free tier) as its state backend. State SHALL NOT be stored locally or committed to version control.

#### Scenario: State is remote

- **WHEN** `pulumi up` is run
- **THEN** state SHALL be read from and written to Pulumi Cloud

### Requirement: Image build uses docker-build provider

The app image SHALL be built using `@pulumi/docker-build` (`docker_build.Image`) with BuildKit. The image SHALL be loaded into the local Docker daemon via tar export and SHALL NOT be pushed to any registry.

#### Scenario: Local image build

- **WHEN** `pulumi up` is run
- **THEN** the app image SHALL be built from `infrastructure/Dockerfile` with context at the repo root
- **AND** the built image SHALL be available in the local Docker daemon
- **AND** no image SHALL be pushed to a remote registry

### Requirement: Containers managed by docker provider

The three containers (app, proxy, oauth2-proxy) SHALL be managed by `@pulumi/docker` (`docker.Container`). Each SHALL have `unless-stopped` restart policy and json-file logging with max-size 10MB, max-file 3.

#### Scenario: All containers running

- **WHEN** `pulumi up` completes successfully
- **THEN** three containers SHALL be running: app, proxy, oauth2-proxy
- **AND** each SHALL have restart policy `unless-stopped`
- **AND** each SHALL use json-file logging with max-size `10m` and max-file `3`

### Requirement: App container configuration

The app container SHALL use the locally built image, mount a `persistence` volume to `/events`, and set `PERSISTENCE_PATH=/events`.

#### Scenario: App container environment and volumes

- **WHEN** the app container is inspected
- **THEN** `PERSISTENCE_PATH` SHALL be set to `/events`
- **AND** a Docker volume SHALL be mounted at `/events`

### Requirement: Proxy container configuration

The proxy container SHALL use the `caddy:2.11.2` image, mount the Caddyfile read-only, mount `caddy-data` volume, set `DOMAIN` and `XDG_DATA_HOME` env vars, publish the configured HTTPS port, and run with `--watch`.

#### Scenario: Proxy container

- **WHEN** the proxy container is inspected
- **THEN** `DOMAIN` SHALL be set to the stack's `domain` config value
- **AND** `XDG_DATA_HOME` SHALL be set to `/caddy`
- **AND** port 443 SHALL be published to the host on the configured `httpsPort`
- **AND** the Caddyfile SHALL be mounted read-only at `/etc/caddy/Caddyfile`
- **AND** the `caddy-data` volume SHALL be mounted at `/caddy`

### Requirement: OAuth2-proxy container configuration

The oauth2-proxy container SHALL use `quay.io/oauth2-proxy/oauth2-proxy:v7.15.1`, receive all `OAUTH2_PROXY_*` env vars from Pulumi config/secrets, and derive `REDIRECT_URL` from the stack's `domain` and `httpsPort` values.

#### Scenario: OAuth2-proxy environment

- **WHEN** the oauth2-proxy container is inspected
- **THEN** `OAUTH2_PROXY_REDIRECT_URL` SHALL be `https://{domain}:{httpsPort}/oauth2/callback` using values from stack config

#### Scenario: OAuth2-proxy static env vars

- **WHEN** the oauth2-proxy container is inspected
- **THEN** `OAUTH2_PROXY_PROVIDER` SHALL be `github`
- **AND** `OAUTH2_PROXY_HTTP_ADDRESS` SHALL be `0.0.0.0:4180`
- **AND** `OAUTH2_PROXY_REVERSE_PROXY` SHALL be `true`
- **AND** `OAUTH2_PROXY_EMAIL_DOMAINS` SHALL be `*`
- **AND** `OAUTH2_PROXY_COOKIE_SECURE` SHALL be `true`
- **AND** `OAUTH2_PROXY_SET_XAUTHREQUEST` SHALL be `true`
- **AND** `OAUTH2_PROXY_UPSTREAMS` SHALL be `static://202`

### Requirement: Deploy and destroy npm scripts

The root `package.json` SHALL define `deploy` as `pulumi -C infrastructure up --yes` and `deploy:destroy` as `pulumi -C infrastructure destroy --yes`.

#### Scenario: pnpm deploy starts the stack

- **WHEN** `pnpm deploy` is run from the repo root
- **THEN** Pulumi SHALL build the image and create/update all containers

#### Scenario: pnpm deploy:destroy tears down the stack

- **WHEN** `pnpm deploy:destroy` is run from the repo root
- **THEN** Pulumi SHALL destroy all containers, volumes, and images it manages
