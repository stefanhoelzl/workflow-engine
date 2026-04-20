## Why

The dashboard session path currently runs through a separate oauth2-proxy pod wired into Traefik via forward-auth, while the `/api/*` Bearer path lives in the app. The split forces two auth models, two sets of env vars (`GITHUB_USER` vs `OAUTH2_PROXY_GITHUB_USERS`), and two spec capabilities (`dashboard-auth` + `oauth2-proxy`) that have already drifted from reality (both still reference Caddy/Pulumi, neither reflects the Traefik/Tofu world). The architecture also carries latent gaps: the oauth2-proxy session cookie is trusted for up to 7d with no re-evaluation of the allowlist, and the forward-auth header path requires the `strip-auth-headers` middleware as defence-in-depth against forged `X-Auth-Request-*` injection.

Pulling the OAuth flow in-process collapses two auth paths into one identity model, eliminates the `X-Auth-Request-*` forging threat class entirely (no code path reads those headers), cuts stale-allowlist exposure from 7d to ~10min via a soft-TTL refresh that re-evaluates `AUTH_ALLOW` on every tick, and drops an entire subsystem (pod, Service, Secret, three Traefik middlewares, one IngressRoute).

## What Changes

- **BREAKING** Remove the oauth2-proxy Deployment, Service, cookie Secret, the `oauth2-forward-auth`, `oauth2-errors`, and `strip-auth-headers` Traefik Middlewares, and the `/oauth2/*` IngressRoute.
- **BREAKING** Replace `GITHUB_USER` and `OAUTH2_PROXY_GITHUB_USERS` env inputs with a single `AUTH_ALLOW` env using a provider-prefixed grammar: `AUTH_ALLOW=github:user:<login>;github:org:<org>` (semicolon-separated). Grants access if the caller's login matches a `user:` entry OR any of their GitHub orgs matches an `org:` entry. Empty/unset → disabled mode (401 everywhere). Sentinel `__DISABLE_AUTH__` → open mode (fake user, warn-logged at startup).
- **BREAKING** The app requests GitHub OAuth scope `user:email read:org` (was oauth2-proxy's default of `user:email`). Enables private-org membership to count toward `AUTH_ALLOW=github:org:<private>` and toward tenant visibility. Forces one-time re-consent per user at first login.
- Add in-app auth routes: `GET /login` (provider-agnostic sign-in page — always renders, never auto-redirects), `GET /auth/github/signin` (starts the OAuth flow on explicit user click), `GET /auth/github/callback`, and `POST /auth/logout`. Unauthenticated `/dashboard` and `/trigger` requests 302 to `/login?returnTo=<path>`. The login page's "Sign in with GitHub" button links to `/auth/github/signin`, which 302s to GitHub's authorize endpoint. Callback exchanges code for token, fetches `/user` and `/user/orgs`, evaluates `AUTH_ALLOW`, and seals a session cookie on success.
- Add three sealed cookies using `iron-webcrypto`, all sharing a single 32-byte password generated in-memory at process start and never persisted:
  - `session` (`Path=/`, 7d hard TTL, carries `UserContext + accessToken + resolvedAt + exp`)
  - `auth_state` (`Path=/auth`, 5min TTL, carries `{state, returnTo}` for CSRF + post-login redirect)
  - `auth_flash` (`Path=/auth`, 60s TTL, carries the rejected login so the login page can render a red banner)
- Add soft-TTL refresh: past 10min since last resolve, the session middleware re-fetches `/user` + `/user/orgs` with the cookie's `accessToken`, re-evaluates `AUTH_ALLOW`, and re-seals. Any non-OK response from GitHub (401/403/5xx/timeout) or a now-failing `AUTH_ALLOW` clears the cookie and redirects to login; no grace period (fail closed).
- Unify the `/api/*` Bearer path to use the same `AUTH_ALLOW` predicate (previously exact-login match only). Org-based entries now grant `/api/*` access to org members, consistent with the UI path. `/api/*` stays Bearer-only — no cookie auth added.
- Drop `UserContext.teams`. Nothing consumes teams today; removing the field cuts one GitHub API roundtrip per login and per refresh, and shrinks the session cookie.
- Retire the `X-Auth-Request-*` header path entirely: delete `headerUserMiddleware`, remove all `strip-auth-headers` references. No code path reads those headers anywhere in the runtime.
- Deploy changes: `replicas=1` on the app Deployment becomes a documented load-bearing invariant for auth (in-memory JWE password cannot be shared across pods). SECURITY.md §5 gains an explicit invariant: never raise replicas without first migrating the password to a shared mechanism.
- GitHub OAuth App reconfiguration (manual, one-time): Authorization callback URL moves from `/oauth2/callback` to `/auth/github/callback`. Applies to both the prod OAuth App and each developer's local dev OAuth App.

## Capabilities

### New Capabilities

- `auth`: Unified authentication + authorization for the app. Owns the identity provider contract (pluggable, `github` as v1), the `AUTH_ALLOW` grammar + evaluation, `UserContext`, the per-tenant `isMember` predicate, session-cookie transport (JWE seal/verify, state + flash cookies, soft-TTL refresh, fail-closed behaviour), the Bearer transport for `/api/*`, the OAuth handshake routes, and the deny UX.

### Modified Capabilities

- `runtime-config`: Replaces `GITHUB_USER` env + auth-mode resolver with `AUTH_ALLOW` grammar + mode resolver. Adds `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET` (the latter wrapped in `createSecret()`). Removes all `OAUTH2_PROXY_*` env inputs.
- `infrastructure`: Removes the oauth2-proxy Deployment/Service/Secret, the three Traefik Middlewares (`oauth2-forward-auth`, `oauth2-errors`, `strip-auth-headers`), and the `/oauth2/*` IngressRoute. Drops forward-auth + error middleware from the `/dashboard` and `/trigger` IngressRoutes. Adds the new app env vars (`AUTH_ALLOW`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`). Documents the `replicas=1` invariant.
- `reverse-proxy`: Removes the requirement to define and attach the three auth-related Middlewares. Traefik now terminates TLS and routes; it performs no auth.

### Removed Capabilities

- `dashboard-auth`: Folded into the new `auth` capability. Forward-auth via oauth2-proxy is gone; dashboard session handling moves in-process.
- `oauth2-proxy`: Subsystem removed entirely. The pod, its Deployment, Service, Secret, and env config all go away.
- `github-auth`: Folded into `auth`. The Bearer flow survives but is now one transport inside the unified capability rather than a standalone spec.

## Impact

- **Runtime code**: adds `packages/runtime/src/auth/{allowlist,github-api,session-cookie,state-cookie,flash-cookie,session-mw,oauth-login,oauth-callback,logout,key}.ts`; modifies `auth/bearer-user.ts`, `auth/user-context.ts` (drops `teams`), `config.ts`, `main.ts`; deletes `auth/header-user.ts` and the new-obsolete tests. Adds one UI template `ui/auth/login-page.ts` for the deny banner.
- **Dependencies**: adds `iron-webcrypto` to `packages/runtime/package.json`.
- **Infrastructure (Tofu)**: edits `infrastructure/modules/app-instance/` (deletes `oauth2-locals.tf`, prunes `workloads.tf`, edits `routes-chart/templates/routes.yaml`). Renames env inputs in `infrastructure/envs/upcloud/cluster/variables.tf` and `infrastructure/envs/local/local.secrets.auto.tfvars.example`.
- **GitHub OAuth Apps**: one-time manual reconfig of the authorization callback URL in both the prod OAuth App and each developer's local dev OAuth App (move from `/oauth2/callback` to `/auth/github/callback`). GitHub supports multiple authorized callback URLs during the cutover window.
- **Behaviour changes visible to users**:
  - One-time GitHub consent screen re-prompt on first post-deploy login (new scope set).
  - All existing oauth2-proxy sessions invalidated at cutover; one-click re-auth via GitHub SSO.
  - Every pod restart (deploy, eviction, OOM) forces a re-login (in-memory password).
- **SECURITY.md**: §4 rewritten — removes `strip-auth-headers` and `X-Auth-Request-*` invariants, adds in-app-auth invariants (AUTH_ALLOW re-evaluation on refresh, fail-closed refresh semantics, in-memory password never persisted). §5 gains the `replicas=1` invariant for the auth subsystem.
- **Tests**: removes `auth/header-user.test.ts` and any teams-parsing assertions; adds unit coverage for the new modules and an integration test that runs the full dashboard flow against a fake GitHub OAuth server stood up in-process.
- **Cutover downtime**: ~60–120s of 5xx during the Tofu-driven rollout. Rollback is `git revert` + `tofu apply`; users re-auth either direction.
