## Context

The workflow-engine runs as a single Docker container exposing port 8080. Production requires a reverse proxy for TLS termination, path-based routing, and (in a future step) authentication via oauth2-proxy. No local multi-container setup exists today — `pnpm dev` runs the app directly on the host.

The Dockerfile currently lives at the repo root. It builds the runtime and SDK but does not include workflow bundles — workflows must be supplied externally via `WORKFLOW_DIR`.

## Goals / Non-Goals

**Goals:**
- Provide a docker-compose stack that runs the workflow-engine behind Caddy with local HTTPS
- Bake compiled workflow bundles into the Docker image so it's self-contained
- Establish `infrastructure/` as the home for all deployment configuration
- Make `pnpm start` bring up the full stack

**Non-Goals:**
- Authentication (Step 2: oauth2-proxy)
- Network isolation / SSRF protection (Step 3: squid proxy)
- Watchtower / dynamic DNS (Step 4)
- Pulumi IaC (Step 5)
- Production VPS provisioning (Step 6)
- CI/CD promotion workflow (Step 7)

## Decisions

### Dockerfile location: `infrastructure/Dockerfile`

Co-locate all deployment config in `infrastructure/`. The Dockerfile, docker-compose.yml, and Caddyfile all live together. The release CI workflow adds `file: infrastructure/Dockerfile` — a one-line change.

**Alternative considered**: Keep Dockerfile at repo root. Avoids the CI change but splits deployment config across two locations. Rejected because `infrastructure/` will grow with Pulumi in Step 5.

### Build context for docker-compose: parent directory

The compose file at `infrastructure/docker-compose.yml` uses `context: ..` (repo root) so the Dockerfile can COPY source from `packages/`, `workflows/`, etc. The `dockerfile` field is `infrastructure/Dockerfile`, resolved relative to context.

### Workflow bundles baked into image at `/workflows`

The Dockerfile gains `COPY workflows/` and runs the full `pnpm build` which includes `pnpm --filter workflows build`. The output at `workflows/dist/` is copied to `/workflows` in the final image. `ENV WORKFLOW_DIR=/workflows` is set in the Dockerfile.

**Alternative considered**: Bind-mount workflows from the host. Rejected because it requires a separate host-side build step and doesn't match production behavior.

### Caddy with local HTTPS on `localhost`

Caddy's built-in local CA auto-provisions a certificate for `localhost`. Only port 443 is exposed. The user must trust Caddy's root CA once (`caddy trust`).

### Caddy TLS data at `/caddy` via `XDG_DATA_HOME`

The `caddy_data` named volume mounts at `/caddy`. The `XDG_DATA_HOME=/caddy` environment variable tells Caddy to store its data directory there instead of the default `/data`.

### Persistence via bind-mount to `.persistence`

The repo's `.persistence/` directory (already gitignored) is bind-mounted to `/events` in the container. `PERSISTENCE_PATH=/events` is set. This shares persistence data between `pnpm dev` (host) and `pnpm start` (container).

**Alternative considered**: Named Docker volume. Rejected because `.persistence/` is already used by `pnpm dev` and inspecting data on the host is useful for development.

### Path-based routing with explicit allow-list

Caddy routes only `/dashboard/` + `/dashboard/*` and `/webhooks/*` to the app. All other paths return a plain-text 404. This matches the app's own route registration and prevents accidental exposure of unintended endpoints.

### `pnpm start` replaces direct-run with docker-compose

`pnpm start` becomes `docker compose -f infrastructure/docker-compose.yml up --build`. The previous direct-run behavior is covered by `pnpm dev` (Vite watch mode with hot reload).

## Risks / Trade-offs

- **`pnpm start` now requires Docker** → Acceptable since `pnpm dev` remains for bare-metal development. Docker is already required for the Dockerfile.
- **Caddy local CA trust** → One-time setup per machine. If not trusted, browsers show a certificate warning but the stack still works.
- **Shared `.persistence/` between dev and compose** → Data format is identical. Risk of concurrent access if both run simultaneously, but that's a developer error not worth guarding against.
