## 1. oauth2-proxy service

- [x] 1.1 Add oauth2-proxy service to `infrastructure/docker-compose.yml` with image `quay.io/oauth2-proxy/oauth2-proxy:latest`, port 4180 exposed internally, restart and logging policies matching existing services
- [x] 1.2 Configure oauth2-proxy environment variables: GitHub provider, redirect URL, cookie settings, `--github-user` restriction, and secrets interpolated from shell env vars (`${OAUTH2_PROXY_CLIENT_ID}`, `${OAUTH2_PROXY_CLIENT_SECRET}`, `${OAUTH2_PROXY_COOKIE_SECRET}`, `${OAUTH2_PROXY_GITHUB_USER}`)

## 2. Caddyfile updates

- [x] 2.1 Add `/oauth2/*` route that reverse-proxies to `oauth2-proxy:4180`
- [x] 2.2 Add `forward_auth` directive on `/dashboard/*` routes to authenticate via `oauth2-proxy:4180`, copying `X-Forwarded-User` and `X-Forwarded-Email` headers to the upstream request
- [x] 2.3 Ensure `/webhooks/*` routes remain unauthenticated (no forward_auth)

## 3. Caddy auto-reload

- [x] 3.1 Override proxy service command in docker-compose.yml to `caddy run --config /etc/caddy/Caddyfile --watch`

## 4. Verification

- [x] 4.1 Verify `docker compose -f infrastructure/docker-compose.yml config` parses successfully and lists all three services
- [ ] 4.2 Verify the stack starts with `pnpm up` (with required env vars set) and oauth2-proxy is healthy
