## Why

A security review found a latent cross-tenant escalation path on `/api/*`: an allow-listed Bearer caller can forge `X-Auth-Request-User` + `X-Auth-Request-Groups: <victim-tenant>`, and the current `userMiddleware` (packages/runtime/src/auth/user.ts) prefers those forwarded-auth headers over the Bearer path — so `isMember(user, tenant)` is evaluated against attacker-controlled orgs. The Traefik edge does not strip these headers on non-UI routes either. The single-user allow-list masks the attack today; it becomes exploitable on day two.

## What Changes

- **App-layer fix (correctness)**: Split `userMiddleware` into two trust-domain-specific middlewares. `bearerUserMiddleware` (Bearer → GitHub, used only on `/api/*`) MUST NOT consult `X-Auth-Request-*` headers; `headerUserMiddleware` (oauth2-proxy forward-auth headers, used only on `/dashboard` and `/trigger`) MUST NOT consult Bearer tokens. Enforcement is structural — the two middlewares live in separate modules and share only the `UserContext` data type.
- **Edge-layer fix (containment)**: Add a Traefik `Middleware` CR named `strip-auth-headers` that clears the oauth2-proxy `X-Auth-Request-*` set on every route in the IngressRoute except `/dashboard` and `/trigger` (the only routes where oauth2-proxy is authoritative). Strips `User`, `Email`, `Preferred-Username`, `Groups`, `Access-Token`, `Redirect`.
- **SECURITY.md §4**: Split residual risk R-A4 ("Forwarded-header trust is implicit") into R-A4a (app-side, closed by correctness fix) and R-A4b (edge-side, closed by containment fix). Note that the NetworkPolicy from R-A3 is no longer load-bearing for *this specific* cross-tenant threat.
- **Tests**: Add regression coverage — Bearer + forged `X-Auth-Request-Groups` on `/api/workflows/<victim>` returns `404 Not Found` (tenant-enum-safe); Bearer + forged headers on the `bearer-user` middleware yield orgs from the GitHub response, never from the headers; symmetric test for `header-user` ignoring Bearer.
- **Not changed**: `/webhooks/*` remains public; `open`/`disabled` API auth modes remain untouched; `UserContext` data shape and tenant-membership semantics (`isMember`, `tenantSet`) remain unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `github-auth`: `/api/*` user-context population is Bearer-only. Forward-auth headers (`X-Auth-Request-*`) SHALL NOT be consulted on the API trust chain. The existing `userMiddleware` export is replaced by two trust-domain-specific middlewares (`bearerUserMiddleware`, `headerUserMiddleware`). Threat-model alignment: SECURITY.md §4 is updated in the same change.
- `infrastructure`: The routes-chart adds a `strip-auth-headers` `Middleware` CR and attaches it to every route in the `workflow-engine` `IngressRoute` except `PathPrefix('/dashboard')` and `PathPrefix('/trigger')`.

## Impact

- **Code**: `packages/runtime/src/auth/user.ts` is removed; replaced by `auth/user-context.ts` (type + `ContextVariableMap` augmentation), `auth/bearer-user.ts`, `auth/header-user.ts`, plus a split test file per middleware. Call sites updated: `packages/runtime/src/api/index.ts`, `packages/runtime/src/ui/dashboard/middleware.ts`, `packages/runtime/src/ui/trigger/middleware.ts`.
- **Infrastructure**: `infrastructure/modules/app-instance/routes-chart/templates/routes.yaml` adds one `Middleware` CR and updates seven route entries to reference it.
- **Docs**: `SECURITY.md` §4 R-A4 split, R-A3 annotated, mitigations list mentions both the app-side split and the edge-layer strip.
- **No config, manifest, dependency, or public-API changes.**
- **No migration**: the refactor is internal; API behavior for legitimate callers is unchanged.
