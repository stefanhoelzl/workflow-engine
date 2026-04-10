## Why

The current deployment stack uses docker-compose, which requires manually exporting environment variables for secrets and has no path to managing multiple environments (dev vs prod) from a single source of truth. Replacing it with Pulumi IaC enables encrypted secrets, stack-based environment configuration, and a foundation for future VPS provisioning — all in TypeScript consistent with the rest of the codebase.

## What Changes

- Add Pulumi project in `infrastructure/` as a pnpm workspace package with `@pulumi/pulumi`, `@pulumi/docker`, and `@pulumi/docker-build`
- Replace `docker-compose.yml` with a Pulumi program (`index.ts`) that manages the same three containers (app, caddy, oauth2-proxy), volumes, and port mappings
- Use `@pulumi/docker-build` (BuildKit) for image builds, `@pulumi/docker` for containers/volumes
- Migrate all configuration (domain, ports, oauth2 credentials) into Pulumi stack config as the single source of truth — no defaults in Caddyfile or other config files
- Template `Caddyfile` with `{$DOMAIN}` (no fallback), injected by Pulumi via container env
- Store oauth2-proxy credentials as Pulumi encrypted secrets
- Use Pulumi Cloud (free tier) for state backend
- Replace `pnpm compose:*` scripts with `pnpm deploy` and `pnpm deploy:destroy`
- **BREAKING**: Removes `docker-compose.yml` and all `compose:*` npm scripts

## Capabilities

### New Capabilities
- `pulumi-stack`: Pulumi project setup, stack configuration, secret management, and dev stack targeting local Docker

### Modified Capabilities
- `compose-stack`: Replaced entirely by Pulumi — docker-compose.yml is removed
- `reverse-proxy`: Caddyfile changes from hardcoded `localhost` to `{$DOMAIN}` env var (no default)
- `oauth2-proxy`: Credentials move from manual env vars to Pulumi encrypted secrets
- `docker`: Image build moves from docker-compose `build:` to `@pulumi/docker-build` provider

## Impact

- **infrastructure/**: New `package.json`, `tsconfig.json`, `Pulumi.yaml`, `Pulumi.dev.yaml`, `index.ts`; deleted `docker-compose.yml`; modified `Caddyfile`
- **pnpm-workspace.yaml**: Add `infrastructure` workspace
- **root package.json**: Replace `compose`/`compose:up`/`compose:up:force`/`compose:down` with `deploy`/`deploy:destroy`
- **Dependencies**: `@pulumi/pulumi`, `@pulumi/docker`, `@pulumi/docker-build` added
- **Developer workflow**: `pnpm dev` unchanged; `pnpm compose:up` becomes `pnpm deploy`; one-time `pulumi login` + secret setup required
- **CI/CD workflows**: Unchanged (still build/push to ghcr.io independently)
