## Context

The docker-compose stack currently runs two containers: workflow-engine (`app`) and Caddy (`proxy`). All routes are publicly accessible. Before deploying to a VPS, dashboard routes need authentication gating. oauth2-proxy handles this at the infrastructure layer using GitHub OAuth, requiring zero application code changes.

This is Step 2 of the 7-step deployment plan. Step 1 (Caddy + app) is complete. Step 3 (network isolation) comes next.

## Goals / Non-Goals

**Goals:**
- Gate `/dashboard/*` routes behind GitHub OAuth authentication
- Keep `/webhooks/*` routes unauthenticated for external integrations
- Pass authenticated user identity to the app via headers
- Auto-reload Caddy config on Caddyfile changes
- Keep secrets out of version control

**Non-Goals:**
- Network isolation (Step 3)
- Application-level authorization or user management
- Production domain or TLS certificate configuration
- Role-based access control

## Decisions

### 1. Authentication pattern: Caddy forward_auth

Caddy's `forward_auth` directive checks authentication with oauth2-proxy before proxying to the app. This keeps Caddy as the single reverse proxy with centralized routing.

**Alternative considered:** Proxy chain (Caddy → oauth2-proxy → app). Rejected because it adds an extra hop and moves routing logic into oauth2-proxy.

### 2. Access restriction: `--github-user`

Use `OAUTH2_PROXY_GITHUB_USER` to restrict access to a specific GitHub username. Switch to `--github-org` later for team access.

**Alternative considered:** Email-based restriction (`--email-domain`, `--authenticated-emails-file`). Rejected as more complex to manage for single-user access.

### 3. Secret management: shell environment variables

Secrets (`CLIENT_ID`, `CLIENT_SECRET`, `COOKIE_SECRET`) are passed as shell environment variables, referenced in docker-compose.yml with `${VAR}` syntax. No `.env` file.

**Alternative considered:** `.env` file (gitignored). Rejected by user preference — shell env vars avoid any risk of committing secrets.

### 4. Configuration method: environment variables

oauth2-proxy is configured entirely via `OAUTH2_PROXY_*` environment variables in docker-compose.yml. No config file.

**Alternative considered:** Mounted `oauth2-proxy.cfg` file. Rejected — env vars keep everything in one file and are easier to override per environment.

### 5. Caddy auto-reload: `--watch` flag

Override Caddy's command to `caddy run --config /etc/caddy/Caddyfile --watch`. This watches the volume-mounted Caddyfile and reloads automatically on changes.

**Alternative considered:** Manual reload via `docker compose exec`. Rejected — `--watch` is zero-effort and built into Caddy.

## Request flow

```
Browser → https://localhost:8443

             ┌─────────────────────────────────────┐
             │              Caddy :443              │
             │                                      │
             │  /oauth2/*  ──► oauth2-proxy:4180    │
             │                                      │
             │  /dashboard/* ──► forward_auth       │
             │                    oauth2-proxy:4180  │
             │                   then ──► app:8080  │
             │                                      │
             │  /webhooks/*  ──► app:8080 (no auth) │
             │                                      │
             │  /*           ──► 404                │
             └─────────────────────────────────────┘

forward_auth flow:
  1. Caddy sends subrequest to oauth2-proxy /oauth2/auth
  2. oauth2-proxy checks session cookie
  3. If valid → 202, Caddy copies X-Forwarded-User/Email headers, proxies to app
  4. If invalid → 401, Caddy follows oauth2-proxy's redirect to /oauth2/start
  5. Browser does GitHub OAuth dance → callback → redirect to original URL
```

## Risks / Trade-offs

**[Risk] GitHub OAuth App requires manual setup** → Document the setup steps. User creates the app at github.com/settings/developers with callback URL `https://localhost:8443/oauth2/callback`.

**[Risk] Shell env vars not set → compose fails to start** → docker-compose will interpolate missing vars as empty strings and oauth2-proxy will fail with a clear error. Document required vars.

**[Risk] Caddy `--watch` not available in older Caddy versions** → We use `caddy:2` which tracks latest Caddy 2.x. The `--watch` flag has been available since Caddy 2.7 (2023).

**[Trade-off] No dev bypass** → Auth is always enforced, even locally. Simpler configuration but requires GitHub OAuth App setup for any local development with the compose stack. Accepted because it ensures parity with production.
