## Why

The `/api` routes (currently only `POST /api/workflows`) are unauthenticated in production: the app conditionally installs the GitHub auth middleware only when `GITHUB_USER` is set, but `GITHUB_USER` is never injected into the production pod and the Traefik `/api` route intentionally delegates auth to the app. Result: any internet user can upload and execute arbitrary workflow code. This proposal makes API auth **fail-closed** and wires the allow-list through to the pod.

## What Changes

- **BREAKING** (spec behavior, observable): `/api` requests with a valid PAT for a user who is not on the allow-list now return **401 Unauthorized** instead of **403 Forbidden**. The 401 is identical to the "missing/invalid token" response so the allow-list cannot be enumerated by PAT holders.
- **BREAKING** (runtime config shape, internal): `config.githubUser?: string` is replaced by a discriminated union `config.githubAuth: {mode:'disabled'} | {mode:'open'} | {mode:'restricted', users: string[]}`.
- `GITHUB_USER` becomes a comma-separated list of allowed GitHub logins (matching `OAUTH2_PROXY_GITHUB_USERS` semantics). Parsing mirrors oauth2-proxy's pflag `StringSlice`: split on `,`, no whitespace trimming, empty segments preserved.
- Unset `GITHUB_USER` → `mode: 'disabled'`: all `/api` requests respond 401. The middleware is always installed.
- Sentinel `GITHUB_USER=__DISABLE_AUTH__` → `mode: 'open'`: middleware is skipped; auth is disabled (intended for local dev). The sentinel must be the only value; mixing with real usernames fails config parsing.
- `githubAuthMiddleware` accepts `githubUsers: string[]` instead of `githubUser: string` and checks `login ∈ githubUsers`.
- Runtime logs a one-shot `WARN` at startup when `mode` is `disabled` or `open`.
- Infrastructure: app module gains a `github_users` input, wired from `var.oauth2.github_users` by the workflow-engine module. Dev reuses the existing `oauth2_github_users` tfvar; no new dev inputs.
- Traefik `/api` route is **unchanged** (no oauth2-forward-auth); the existing "App-auth (app validates tokens)" comment now matches reality.
- Incidental spec-drift fix: `infrastructure` spec references to `oauth2_github_user` (singular) are corrected to `oauth2_github_users` (plural), matching the actual tfvar.

## Capabilities

### New Capabilities

*(none)*

### Modified Capabilities

- `github-auth`: multi-user allow-list; 401 for "wrong user" (no 403); three middleware modes (disabled/open/restricted).
- `runtime-config`: `GITHUB_USER` is a comma-separated list; sentinel `__DISABLE_AUTH__` disables auth; config exposes discriminated union `githubAuth` instead of `githubUser`.
- `infrastructure`: app module accepts `github_users`; workflow-engine module wires `var.oauth2.github_users` to the app; dev tfvars key is `oauth2_github_users` (plural), correcting stale spec wording.

## Impact

- **Code**: `packages/runtime/src/config.ts`, `packages/runtime/src/api/index.ts`, `packages/runtime/src/api/auth.ts`, `packages/runtime/src/main.ts`; tests in `packages/runtime/src/config.test.ts`, `packages/runtime/src/api/auth.test.ts`, and new coverage for `apiMiddleware` mode branching.
- **Infra**: `infrastructure/modules/workflow-engine/modules/app/app.tf` (new variable + env var on container), `infrastructure/modules/workflow-engine/workflow-engine.tf` (pass-through).
- **Deployment**: no change to dev tfvars or secrets files. In production the existing allow-list surfaces via the same `oauth2.github_users` value used by oauth2-proxy.
- **Security**: closes S01. `/api` is fail-closed when `GITHUB_USER` is missing; allow-list enumeration via 401/403 split is removed.
- **Observability**: startup logs surface the auth mode; an accidentally left `__DISABLE_AUTH__` in production is visible in logs on boot.
