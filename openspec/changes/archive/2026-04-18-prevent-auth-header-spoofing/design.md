## Context

The runtime today has one Hono middleware, `userMiddleware` (packages/runtime/src/auth/user.ts), that populates `c.var.user: UserContext` for both the API and UI trust domains. It prefers forward-auth headers (`X-Auth-Request-User` etc.) when present, otherwise falls back to calling GitHub with a Bearer token. The same middleware is mounted on `/api/*` (after `githubAuthMiddleware`) and on `/dashboard` + `/trigger`.

Composed with the current Traefik config, this is unsafe. `infrastructure/modules/app-instance/routes-chart/templates/routes.yaml` only attaches `oauth2-forward-auth` to `/dashboard` and `/trigger`; every other route passes client-supplied request headers through untouched. An allow-listed Bearer caller on `/api/*` can therefore forge `X-Auth-Request-User` + `X-Auth-Request-Groups: victim-tenant`. `githubAuthMiddleware` accepts the Bearer, `userMiddleware` trusts the forged headers, and `checkTenantAccess` in `api/upload.ts` grants cross-tenant write. The single-entry `github_users = ["stefanhoelzl"]` allow-list masks the path today; the hole opens the moment a second user is added.

Two independent fixes are needed. App-layer — split the trust domains in code so that the API path structurally cannot read forward-auth headers, and the UI path cannot authenticate via Bearer tokens. Edge-layer — strip `X-Auth-Request-*` at Traefik on every route where oauth2-proxy is not authoritative, so forged values never reach the app in the first place.

## Goals / Non-Goals

**Goals:**
- Make forged `X-Auth-Request-*` on `/api/*` ineffective for cross-tenant access, even if an upstream (Traefik, NetworkPolicy) regresses.
- Prevent forged identity headers from reaching the app process on any route except `/dashboard` and `/trigger`.
- Keep the code shape such that the trust-domain invariant is obvious from a grep ("does `bearer-user.ts` reference any `X-Auth-Request` string?"), not from a reviewer remembering an invariant.
- Preserve legitimate behavior for callers: `/api/*` still works for allow-listed Bearer tokens; `/dashboard` and `/trigger` still read forward-auth headers exactly as before.
- Update SECURITY.md §4 to reflect the new control topology.

**Non-Goals:**
- `/webhooks/*` trust model (remains public per SECURITY.md §3).
- `open` / `disabled` API modes (unchanged).
- Caching of GitHub token validation (separate residual risk R-A2).
- Wildcard/regex-based header stripping at Traefik (no first-class support; see Decisions §3).

## Decisions

### 1. Split `userMiddleware` into two trust-domain middlewares

**Chosen**: Two separately-exported middlewares living in distinct modules, both under `packages/runtime/src/auth/`. The `UserContext` type and the `ContextVariableMap` augmentation move to a new type-only module (`auth/user-context.ts`); neither middleware depends on the other at runtime.

```
  packages/runtime/src/auth/
  ├── user-context.ts     type UserContext + ContextVariableMap augmentation
  ├── bearer-user.ts      bearerUserMiddleware (Bearer → GitHub)
  ├── bearer-user.test.ts
  ├── header-user.ts      headerUserMiddleware (X-Auth-Request-*)
  ├── header-user.test.ts
  ├── tenant.ts           unchanged (shared membership check)
  └── tenant.test.ts      unchanged

  Call sites:
    api/index.ts           → bearerUserMiddleware() on restricted-mode /api/*
    ui/dashboard/mw.ts     → headerUserMiddleware()
    ui/trigger/mw.ts       → headerUserMiddleware()
```

**Alternatives considered**:
- *Runtime flag* `userMiddleware({ mode: "api" | "ui" })`. Smallest diff, but string flag is a silent foot-gun: a wrong mode looks fine at review and the defence regresses without a test failure.
- *Two exports, one shared internal*. Materially safer than the flag, but still co-located; adds only naming, not topology.
- *Two modules, different directories* (e.g., `ui/header-user.ts` vs `auth/bearer-user.ts`). Stronger filesystem-level split, but offers no additional enforcement over same-directory in practice and scatters related auth logic. Revisited and rejected in favor of same-directory clarity.

The co-located two-module split gives a checkable invariant — grep `X-Auth-Request` in `bearer-user.ts`, grep `api.github.com` or `Authorization` header reads in `header-user.ts`; both MUST be empty — without adding new directories or lint rules.

### 2. API trust chain no longer touches forward-auth headers

`bearerUserMiddleware` reads only `Authorization: Bearer <token>` and resolves `UserContext` from GitHub's `/user`, `/user/orgs`, `/user/teams` endpoints (unchanged helper `fetchBearerUser`, moved over). No code path in the module reads `X-Auth-Request-*`. This is the primary correctness control; it closes the cross-tenant hole even if Traefik (decision 3) regresses.

`headerUserMiddleware` reads only the forward-auth headers (unchanged helper `parseHeaderUser`, moved over). It does NOT fall back to Bearer. Rationale: the UI trust domain is oauth2-proxy sessions; a UI mount accepting Bearer would blur the domains. The existing `userMiddleware` behavior "ignore Bearer when headers are present" is preserved for UI, but we also remove the Bearer fallback that would fire when headers are absent. In production, oauth2-proxy forward-auth guarantees headers on `/dashboard` and `/trigger`; absence means `open`/dev mode, which the app already tolerates with `user` unset.

### 3. Traefik edge strip: enumerate the oauth2-proxy header set

Add a `Middleware` CR (`strip-auth-headers`) to the routes-chart that sets every known `X-Auth-Request-*` header to `""` via `customRequestHeaders`. Per the Traefik docs, empty string = delete header (not "forward empty"). Attach the middleware first in the chain on every route except `/dashboard` and `/trigger`.

Header list (source: oauth2-proxy's emitted `X-Auth-Request-*` set):
- `X-Auth-Request-User`
- `X-Auth-Request-Email`
- `X-Auth-Request-Preferred-Username`
- `X-Auth-Request-Groups`
- `X-Auth-Request-Access-Token`
- `X-Auth-Request-Redirect`

**Alternatives considered**:
- *Wildcard/regex matching*. Traefik's built-in `customRequestHeaders` has no wildcard support; the one viable community plugin (`traefik-plugin-headers`) still requires exact names for `unset`. Not worth a plugin dependency for this.
- *Per-request forwardAuth with `authRequestHeaders` allowlist*. Wrong primitive (that field allowlists headers sent TO the auth service, not stripped from the backend request).
- *Skip the edge fix entirely, rely on decision 1+2*. Tempting, but loses containment value: forged headers still reach the app, pollute request logs, and could be read by a future handler that bypasses the middleware layer.

### 4. Maintenance invariant colocated with the reader

The Traefik list must stay in sync with the headers parsed by `header-user.ts`. Rather than a CI check or a PR template note, put a short comment inside `header-user.ts` near `parseHeaderUser`:

> "The Traefik strip-auth-headers middleware (infrastructure/.../routes.yaml) clears X-Auth-Request-* headers on non-UI routes. When adding a new X-Auth-Request-* reader here, also add the header to that middleware's customRequestHeaders list."

This inverts the forcing function: drift in Traefik is harmless until a reader appears; the reminder lives where a reader gets added. Thread 4 of the exploration concluded this is proportionate because Part A is containment, not correctness — upstream oauth2-proxy churn on this header set is historically rare, and decision 1+2 closes the only known high-severity path.

### 5. SECURITY.md §4 updates

- Split R-A4 (*"Forwarded-header trust is implicit — the application does not verify requests came via Traefik / oauth2-proxy"*) into:
  - **R-A4a (app-side)**: The API trust chain no longer consults forward-auth headers — closed by decision 1+2.
  - **R-A4b (edge-side)**: Traefik strips `X-Auth-Request-*` on non-UI routes — closed by decision 3.
- R-A3 (NetworkPolicy) is annotated: still valuable as defense-in-depth, but no longer load-bearing for the cross-tenant threat vector, because decision 1+2 closes it at the app layer.
- Mitigations list gains two bullets naming the app-side split and the edge-side strip.

## Risks / Trade-offs

- **[Drift in the Traefik strip list]** → Containment regression only, not correctness. Comment in `header-user.ts` surfaces the invariant at the point of change. Accepted given low oauth2-proxy churn.
- **[UI behavior change: Bearer fallback removed]** → In production, oauth2-proxy forward-auth sets headers on every UI request, so Bearer fallback was never exercised. In local dev `open` mode, the app already tolerates `user` absence. No known caller depends on Bearer auth for UI.
- **[Test duplication]** → The "no auth context" describe block exists once in `user.test.ts` today; after the split it appears in both test files (same assertion, different middleware). Minor. Alternative is a shared helper, which would re-couple the test files; the duplication is clearer.
- **[Refactor touches 3 call sites and 1 test file]** → Low mechanical risk; covered by the existing test suite plus the new regression tests named in the proposal.
- **[Review pressure: two near-identical-looking middlewares]** → Mitigated by the module separation — reviewers see two distinct files, not two cases in one function.

## Migration Plan

No runtime data migration. Deploy order:

1. Merge and deploy the refactor + routes.yaml change together. The two fixes are independent, but shipping them in one PR keeps the threat surface coherent.
2. After Helm release reconciles, verify the `strip-auth-headers` Middleware CR exists (`kubectl -n <ns> get middleware strip-auth-headers`).
3. Manual curl tests (documented in tasks.md): cross-tenant upload with forged headers MUST return 404; bypass via `kubectl port-forward` directly to the pod MUST also return 404 (decision 1+2 independent of Traefik).
4. Rollback: revert the PR. No data touched, no schema/manifest changes, no downgrade hazards.

## Open Questions

None at proposal time. Implementation-time questions, if any, are expected to be purely mechanical (import paths, test fixture layout) and resolved in the PR.
