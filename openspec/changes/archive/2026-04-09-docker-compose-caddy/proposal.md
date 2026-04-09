## Why

The workflow-engine can be built as a Docker image and run directly, but there's no way to run it behind a reverse proxy locally — the setup needed for production (TLS, path-based routing, auth in future steps). A docker-compose stack with Caddy provides a local environment that mirrors the production topology.

## What Changes

- Add `infrastructure/docker-compose.yml` with two services: `app` (workflow-engine) and `proxy` (Caddy)
- Add `infrastructure/Caddyfile` with localhost HTTPS, routing `/dashboard/*` and `/webhooks/*` to the app, 404 for everything else
- Move `Dockerfile` from repo root to `infrastructure/Dockerfile`
- Modify the Dockerfile to include compiled workflow bundles at `/workflows`
- Update the release CI workflow to reference the new Dockerfile location
- Change `pnpm start` to bring up the docker-compose stack

## Capabilities

### New Capabilities

- `compose-stack`: Docker Compose service definitions, networking, and volume configuration for local and production-like environments
- `reverse-proxy`: Caddy configuration for TLS termination, path-based routing, and request filtering

### Modified Capabilities

- `docker`: Dockerfile moves to `infrastructure/`, gains workflow compilation and `/workflows` output directory
- `release-workflow`: Build step references `infrastructure/Dockerfile` instead of root `Dockerfile`
- `runtime-config`: `WORKFLOW_DIR` default becomes `/workflows` inside the container image (set via `ENV` in Dockerfile)

## Impact

- **Files moved**: `Dockerfile` → `infrastructure/Dockerfile`
- **Files created**: `infrastructure/docker-compose.yml`, `infrastructure/Caddyfile`
- **Files modified**: `.github/workflows/release.yml` (Dockerfile path), `package.json` (start script)
- **Developer workflow**: `pnpm start` now requires Docker; bare-metal local run available via `pnpm dev`
- **No runtime code changes**: The application itself is unchanged
