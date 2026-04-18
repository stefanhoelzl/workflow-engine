## 1. App-layer: split userMiddleware

- [x] 1.1 Create `packages/runtime/src/auth/user-context.ts` containing the `UserContext` interface and the `declare module "hono"` `ContextVariableMap` augmentation (both `user: UserContext` and `authOpen: boolean` keys).
- [x] 1.2 Create `packages/runtime/src/auth/bearer-user.ts` exporting `bearerUserMiddleware` and the internal `fetchBearerUser` / `fetchJson` helpers. The file MUST NOT reference any `X-Auth-Request-*` string.
- [x] 1.3 Create `packages/runtime/src/auth/header-user.ts` exporting `headerUserMiddleware` and the internal `parseHeaderUser` helper. The file MUST NOT reference `api.github.com` or read the `Authorization` header. Include a short comment near `parseHeaderUser` naming the Traefik `strip-auth-headers` middleware and instructing maintainers to add any new `X-Auth-Request-*` reader to that middleware's list.
- [x] 1.4 Delete `packages/runtime/src/auth/user.ts`.
- [x] 1.5 Update `packages/runtime/src/api/index.ts` to import and use `bearerUserMiddleware()` in the `restricted` branch (replacing `userMiddleware()`).
- [x] 1.6 Update `packages/runtime/src/ui/dashboard/middleware.ts` to use `headerUserMiddleware()`.
- [x] 1.7 Update `packages/runtime/src/ui/trigger/middleware.ts` to use `headerUserMiddleware()`.
- [x] 1.8 Update `packages/runtime/src/api/upload.ts` (and any other consumer) to import `UserContext` from `auth/user-context.js`.

## 2. App-layer: tests

- [x] 2.1 Split `packages/runtime/src/auth/user.test.ts` into `bearer-user.test.ts` and `header-user.test.ts`; remove the original file.
- [x] 2.2 In `bearer-user.test.ts`, keep the existing Bearer-path tests. Add a regression test: with `Authorization: Bearer <valid>` + forged `X-Auth-Request-User: attacker` + `X-Auth-Request-Groups: victim-tenant`, the stubbed GitHub response (e.g., `orgs: [{ login: "acme" }]`) SHALL be the sole source of `UserContext.orgs`; assert `user.orgs === ["acme"]` and `user.name` is the GitHub login (not the header).
- [x] 2.3 In `bearer-user.test.ts`, add a test that a request with only `X-Auth-Request-User` set (no Bearer) leaves `user` unset and does NOT call the stubbed `fetchFn`.
- [x] 2.4 In `header-user.test.ts`, keep the existing forward-auth-header tests. Add a test that `Authorization: Bearer <any>` alone (no `X-Auth-Request-*`) leaves `user` unset and does NOT call the stubbed `fetchFn`.
- [x] 2.5 In `packages/runtime/src/api/index.test.ts`, extend `ApiOptions` / `apiMiddleware` with an optional `fetchFn` plumbed through to both `githubAuthMiddleware` and `bearerUserMiddleware` (test-only seam). Add an integration test under `mode: restricted`: stub GitHub so `login: "stefan"` is allow-listed but `orgs: []`, POST `/api/workflows/victim-tenant` with a valid Bearer AND forged `X-Auth-Request-User: stefan` + `X-Auth-Request-Groups: victim-tenant`, expect `404 Not Found` with `{ error: "Not Found" }`.
- [x] 2.6 Run `pnpm test` and confirm all tests pass.

## 3. Edge-layer: Traefik middleware

- [x] 3.1 In `infrastructure/modules/app-instance/routes-chart/templates/routes.yaml`, add a `Middleware` CR named `strip-auth-headers` with `spec.headers.customRequestHeaders` setting each of the six oauth2-proxy `X-Auth-Request-*` headers to `""`. Include a comment above the CR pointing at `packages/runtime/src/auth/header-user.ts` as the code that consumes these headers on UI routes.
- [x] 3.2 Attach `strip-auth-headers` as the first middleware in the chain for the following routes in the `workflow-engine` IngressRoute: `Path('/')` (redirect-root), `PathPrefix('/oauth2')`, `PathPrefix('/static')`, `PathPrefix('/webhooks')`, `Path('/livez')`, `PathPrefix('/api')`, and the priority-1 `PathPrefix('/')` catch-all. Do NOT attach it to `/dashboard` or `/trigger`.
- [x] 3.3 Run `tofu fmt` + `tofu validate` in `infrastructure/envs/local/` to confirm the chart renders and reconciles.

## 4. Edge-layer: integration verification

- [x] 4.1 `pnpm local:up` and wait for kind + Helm reconciliation. Confirm `kubectl get middleware strip-auth-headers -A` returns the CR in the app namespace.
- [x] 4.2 Cross-tenant forgery via edge: forged `X-Auth-Request-*` through Traefik → 404 (headers stripped at edge, logs show zero `X-Auth-Request-*` on Traefik-routed requests).
- [x] 4.3 Cross-tenant forgery bypassing Traefik via `kubectl port-forward` → 404 (headers visible in app logs but `bearerUserMiddleware` ignores them; `isMember` evaluates against real GitHub orgs).
- [x] 4.4 Legitimate upload to own tenant with valid Bearer → 415 "Not a valid gzip/tar archive" (past auth + membership; NOT 404).
- [x] 4.5 UI regression: `/trigger` unauthenticated → 401 with oauth2-proxy sign-in page (forward-auth chain intact).
- [x] 4.6 Pod logs clean — no warnings/errors from new middlewares. (Noted: pre-existing R-A6 residual risk confirmed — full Bearer token logged in access log; follow-up change, not F1 scope.)

## 5. Documentation

- [x] 5.1 Update `SECURITY.md` §4: split R-A4 into R-A4a (app-side, closed by §1-2) and R-A4b (edge-side, closed by §3). Annotate R-A3 (NetworkPolicy) noting that it is no longer load-bearing for the cross-tenant threat vector.
- [x] 5.2 Add two bullets to the SECURITY.md §4 "Mitigations (current)" list: one naming `bearer-user.ts` / `header-user.ts` as the app-side trust-domain split, one naming the Traefik `strip-auth-headers` middleware as the edge-side strip.
- [x] 5.3 Run `pnpm validate` and confirm lint, format, typecheck, and tests all pass.

## 6. Finalization

- [ ] 6.1 Create a PR titled "feat(auth): prevent X-Auth-Request-* header spoofing on non-UI routes". Link the F1 security-review finding in the PR description.
- [ ] 6.2 After merge, archive the OpenSpec change via `/opsx:archive prevent-auth-header-spoofing`.
