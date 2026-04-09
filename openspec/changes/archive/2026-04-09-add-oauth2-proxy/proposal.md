## Why

The dashboard is publicly accessible to anyone who can reach the host. Before deploying to a VPS (Step 2 of the deployment plan), we need authentication gating on the dashboard routes. oauth2-proxy with GitHub OAuth provides this without any application code changes — authentication is handled entirely at the infrastructure layer.

## What Changes

- Add an `oauth2-proxy` container to the docker-compose stack, configured via environment variables
- Update the Caddyfile to use `forward_auth` for `/dashboard/*` routes, routing through oauth2-proxy before reaching the app
- Expose `/oauth2/*` routes through Caddy so the browser can complete the OAuth flow (login, callback)
- Add `--watch` flag to Caddy's command so Caddyfile edits are picked up automatically
- Pass authenticated user identity (`X-Forwarded-User`, `X-Forwarded-Email`) to the app via headers
- Webhook routes (`/webhooks/*`) remain unauthenticated

## Capabilities

### New Capabilities
- `oauth2-proxy`: oauth2-proxy container configuration, GitHub provider setup, and secret management via shell environment variables
- `dashboard-auth`: Caddy forward_auth integration gating dashboard routes through oauth2-proxy, with unauthenticated webhook bypass

### Modified Capabilities
- `reverse-proxy`: Caddyfile gains forward_auth directive, oauth2 route block, user identity header forwarding, and --watch auto-reload
- `compose-stack`: docker-compose.yml gains oauth2-proxy service definition and Caddy command override

## Impact

- **Infrastructure files**: `infrastructure/docker-compose.yml`, `infrastructure/Caddyfile`
- **Dependencies**: New container image `quay.io/oauth2-proxy/oauth2-proxy:latest`
- **External setup required**: GitHub OAuth App must be created manually with callback URL `https://localhost:8443/oauth2/callback`
- **Environment variables required at runtime**: `OAUTH2_PROXY_CLIENT_ID`, `OAUTH2_PROXY_CLIENT_SECRET`, `OAUTH2_PROXY_COOKIE_SECRET`
- **No application code changes** — auth is entirely at the infrastructure layer
