## 1. Runtime config

- [x] 1.1 Replace `GITHUB_USER` field in `packages/runtime/src/config.ts` with `AUTH_ALLOW` parsed per the grammar in `auth/spec.md`; expose as `config.auth` discriminated union.
- [x] 1.2 Add `GITHUB_OAUTH_CLIENT_ID` (plain) and `GITHUB_OAUTH_CLIENT_SECRET` (wrapped via `createSecret()`) to the config schema.
- [x] 1.3 Wire startup validation: `auth.mode === "restricted"` MUST have both client id and secret set; otherwise throw with an error identifying the missing field.
- [x] 1.4 Rewrite startup log record to report `auth.mode` with counts only (no allowlist contents); `warn` for disabled/open, `info` for restricted.
- [x] 1.5 Delete the old `GITHUB_USER` config tests; add unit tests for `AUTH_ALLOW` (happy path, unknown provider, unknown kind, invalid identifier, sentinel alone, sentinel mixed, empty, unset) and for OAuth credentials validation.

## 2. Auth: allowlist and user context

- [x] 2.1 Create `packages/runtime/src/auth/allowlist.ts` exporting `parseAuthAllow(value: string)` returning `{ users: Set<string>, orgs: Set<string> }` and `allow(user, auth)` predicate. Unit tests cover every grammar edge case + predicate matrix (login match, org match, miss, open, disabled).
- [x] 2.2 Remove `teams` from `UserContext` type in `packages/runtime/src/auth/user-context.ts`; update every consumer. Verify no references to `UserContext.teams` remain (`grep`).
- [x] 2.3 Delete `packages/runtime/src/auth/header-user.ts` and its tests; remove all references to `X-Auth-Request-*` in the runtime source (`grep` must come up empty outside of tests that assert they are ignored).
- [x] 2.4 Keep `packages/runtime/src/auth/tenant.ts` (`isMember`) unchanged; add/extend tests to cover the invalid-tenant-identifier scenario.

## 3. Auth: cookie sealing

- [x] 3.1 Add `iron-webcrypto` to `packages/runtime/package.json`; run `pnpm install`.
- [x] 3.2 Create `packages/runtime/src/auth/key.ts` — a module-level singleton holding a 32-byte password generated via `crypto.getRandomValues` at first access. Password SHALL NOT be exported outside this module; expose only sealer/unsealer wrappers that close over it.
- [x] 3.3 Create `packages/runtime/src/auth/session-cookie.ts` — `seal(payload)` and `unseal(raw)` for the session cookie with 7d TTL; throws on tamper/expiry. Unit tests for round-trip, tamper, expiry.
- [x] 3.4 Create `packages/runtime/src/auth/state-cookie.ts` — same pattern, 5min TTL, `{ state, returnTo }` payload. Include same-origin validator for `returnTo`. Unit tests for round-trip, tamper, expiry, malformed returnTo.
- [x] 3.5 Create `packages/runtime/src/auth/flash-cookie.ts` — 60s TTL, string payload (rejected login). Unit tests for round-trip, tamper, expiry.

## 4. Auth: GitHub API client

- [x] 4.1 Create `packages/runtime/src/auth/github-api.ts` with typed wrappers: `exchangeCode(code, redirectUri)`, `fetchUser(accessToken)`, `fetchOrgs(accessToken)`. Each returns a typed envelope `{ ok: true, data } | { ok: false, status, error }`. No `fetchTeams`.
- [x] 4.2 Unit tests using Vitest's fetch mock: success paths for all three, and failure modes (4xx, 5xx, network error, malformed JSON).
- [x] 4.3 Expose a small helper that builds the authorize URL with scopes `user:email read:org` and the state + redirect_uri; unit-test URL shape.

## 5. Auth: middleware (Bearer)

- [x] 5.1 Refactor `packages/runtime/src/auth/bearer-user.ts` to remove `/user/teams` fetch; parallelise only `/user` and `/user/orgs`.
- [x] 5.2 Rewrite `packages/runtime/src/api/auth.ts` (`githubAuthMiddleware`, rename to `bearerMw` or keep the name — either is fine, choose to minimise churn) so the allowlist check calls `allow()` from 2.1 instead of an exact-login check.
- [x] 5.3 Update existing `api/auth.test.ts` to cover: login match, org match (new), login-and-org miss (401), GitHub error, open mode, disabled mode, forward-auth header immunity (add a test that sends forged `X-Auth-Request-User` + `X-Auth-Request-Groups` and asserts `UserContext.orgs` is GitHub-derived).

## 6. Auth: middleware (session)

- [x] 6.1 Create `packages/runtime/src/auth/session-mw.ts` — the full state machine from `auth/spec.md` (no cookie → 302; fresh → next; stale + GitHub OK + allow → refresh + next; stale + GitHub fail → 302; stale + allow fail → flash + 302; expired → 302; disabled → 401; open → synthetic user + next).
- [x] 6.2 Unit tests cover every branch; use a fake GitHub API function passed in via DI (no global fetch mocking).
- [x] 6.3 Wire `session-mw` onto `/dashboard/*` and `/trigger/*` in `packages/runtime/src/main.ts`.

## 7. Auth: OAuth handshake routes

- [x] 7.1 Create `packages/runtime/src/auth/oauth-login.ts` — dual-mode handler. Mode A: seals state cookie and 302s to authorize URL. Mode B: unseal flash, clear, render deny page via `ui/auth/login-page.ts`.
- [x] 7.2 Create `packages/runtime/src/ui/auth/login-page.ts` — HTML template with the deny banner. Must render through `ui/layout.ts` and stay CSP-clean (no inline script/style, no `on*=`). Link to `https://github.com/logout` with `rel="noopener noreferrer" target="_blank"`.
- [x] 7.3 Create `packages/runtime/src/auth/oauth-callback.ts` — state validation, code exchange, profile fetch, allowlist evaluation, cookie set/clear, redirect to validated `returnTo`.
- [x] 7.4 Create `packages/runtime/src/auth/logout.ts` — POST-only, clear session cookie, 302 `/`. GET → 405.
- [x] 7.5 Wire all four handlers under `/auth/*` in `main.ts`. No middleware other than the global ones (logging, CORS, security-headers) on this prefix.
- [x] 7.6 Unit tests for each handler; integration test (section 9) covers the happy path end-to-end.

## 8. SECURITY.md

- [x] 8.1 §4: rewrite to describe the in-app auth model. Remove invariants mentioning `strip-auth-headers`, `X-Auth-Request-*`, and `headerUserMiddleware`. Add invariants: no reader of `X-Auth-Request-*` anywhere; `allow()` re-evaluated on refresh; fail-closed refresh; in-memory password never persisted; unknown provider prefix in `AUTH_ALLOW` fails startup.
- [x] 8.2 §5: add the `replicas=1` auth invariant pointing back to the `auth` capability and `App Deployment` infrastructure requirement.
- [x] 8.3 Re-score A10 (stale allowlist) to ≤10min exposure window. Remove A13 from active threats (eliminated — add a brief historical note).
- [x] 8.4 Grep-verify: no surviving references to `oauth2-proxy`, `OAUTH2_PROXY_`, `X-Auth-Request-`, `headerUserMiddleware`, `strip-auth-headers`, `forward-auth` outside of archive notes.

## 9. Integration tests

- [x] 9.1 Add a fake GitHub OAuth server as a Hono app in `packages/runtime/test/fixtures/fake-github.ts` serving: `/login/oauth/authorize` (auto-approves and 302s back with a code), `/login/oauth/access_token` (returns a canned token), `api.github.com/user`, `api.github.com/user/orgs`. Allow per-test overrides for response shape and status codes.
- [x] 9.2 Full-flow integration test: unauthenticated `/dashboard` → 302 `/auth/github/login` → 302 fake-GitHub → 302 `/auth/github/callback?code=X&state=Y` → 302 `/dashboard` → 200 with rendered UserContext.
- [x] 9.3 Failure-mode integration tests: state mismatch, fake GitHub token exchange 500, allowlist rejects at callback (expect flash cookie + deny banner on next `/auth/github/login` hit), session refresh with fake GitHub 500 (expect clear session + 302 login).
- [x] 9.4 Logout integration test: POST `/auth/logout` clears cookie, subsequent `/dashboard` bounces to login.

## 10. Infrastructure: app-instance module

- [x] 10.1 Delete `infrastructure/modules/app-instance/oauth2-locals.tf`.
- [x] 10.2 In `infrastructure/modules/app-instance/workloads.tf`: remove the oauth2-proxy Deployment, Service, cookie Secret, `random_password` resource, and any oauth2-proxy-specific locals.
- [x] 10.3 Rename module input variable `github_users` → `auth_allow`; update `variables.tf`.
- [x] 10.4 Add module input variables `github_oauth_client_id` (string) and `github_oauth_client_secret` (string, `sensitive = true`).
- [x] 10.5 Create a Kubernetes Secret in the app-instance module holding only `github_oauth_client_secret`; inject `GITHUB_OAUTH_CLIENT_SECRET` into the app container via `value_from.secret_key_ref`.
- [x] 10.6 Inject `AUTH_ALLOW` and `GITHUB_OAUTH_CLIENT_ID` into the app container as plain `env {}` blocks.
- [x] 10.7 Explicitly set `spec.replicas = 1` on the app Deployment (already the effective value; make it explicit and add a code comment referencing SECURITY.md §5).

## 11. Infrastructure: routes-chart

- [x] 11.1 In `infrastructure/modules/app-instance/routes-chart/templates/routes.yaml`: remove the `oauth2-forward-auth`, `oauth2-errors`, and `strip-auth-headers` Middleware CRDs.
- [x] 11.2 Remove the `/oauth2/*` IngressRoute.
- [x] 11.3 On the `/dashboard` and `/trigger` IngressRoutes: remove the forward-auth and errors-middleware attachments; keep only `not-found` and `server-error`.
- [x] 11.4 Remove `strip-auth-headers` middleware from every IngressRoute chain (`/api`, `/webhooks`, `/static`, `/livez`, root, catch-all).
- [x] 11.5 Add a new IngressRoute for `PathPrefix('/auth')` → `app_service:app_port` with `not-found` + `server-error` middlewares.

## 12. Infrastructure: reverse-proxy

- [x] 12.1 In `infrastructure/modules/traefik/`: remove the oauth2-proxy egress rule from the Traefik NetworkPolicy (the `pods` selector match for `app.kubernetes.io/name = oauth2-proxy`).

## 13. Infrastructure: environment config

- [x] 13.1 `infrastructure/envs/upcloud/cluster/variables.tf`: rename `oauth2_github_users` → `auth_allow`; add `github_oauth_client_id` and `github_oauth_client_secret` variable declarations.
- [x] 13.2 `infrastructure/envs/upcloud/cluster/terraform.tfvars`: rename the non-secret var.
- [x] 13.3 Update `TF_VAR_*` env var names in `CLAUDE.md`: `TF_VAR_oauth2_client_id` → `TF_VAR_github_oauth_client_id`, `TF_VAR_oauth2_client_secret` → `TF_VAR_github_oauth_client_secret`.
- [x] 13.4 `infrastructure/envs/local/local.secrets.auto.tfvars.example`: rename the vars, add a comment pointing developers at creating a local GitHub OAuth App with callback URL `https://localhost:8443/auth/github/callback`.
- [x] 13.5 Thread the new variables through the `app_instance` module instantiation in both local and upcloud cluster compositions.

## 14. GitHub OAuth App reconfiguration (manual steps, documented)

- [x] 14.1 Document in `CLAUDE.md` (prod deploy section): before `tofu apply`, **add** `https://workflow-engine.webredirect.org/auth/github/callback` to the prod GitHub OAuth App's authorized callback URLs alongside the existing `.../oauth2/callback`. Do not remove the old URL yet.
- [x] 14.2 Document in `CLAUDE.md` (local dev section): each developer adds `https://localhost:8443/auth/github/callback` to their local GitHub OAuth App's authorized callback URLs alongside the existing `.../oauth2/callback`.
- [x] 14.3 Document post-verification step: after confirming the new flow works, remove the old `.../oauth2/callback` URL from the prod GitHub OAuth App authorized callback URLs.

## 15. OpenSpec + project docs

- [x] 15.1 Run `openspec validate replace-oauth2-proxy` after every artifact edit; ensure it stays green.
- [x] 15.2 After merge + prod verification, run `openspec archive replace-oauth2-proxy` to move the change into the archive and apply the spec deltas to `openspec/specs/`.
- [x] 15.3 Update `CLAUDE.md` "Upgrade notes" with a `replace-oauth2-proxy` entry covering: the `AUTH_ALLOW` grammar change, the GitHub OAuth App callback URL rotation, the one-time consent re-prompt, and the `replicas=1` invariant.
- [x] 15.4 Remove the `openspec/project.md` / current context fields referring to `oauth2-proxy` as part of the infra stack; replace with "in-app GitHub OAuth".

## 16. Verification gates

- [x] 16.1 `pnpm lint` passes.
- [x] 16.2 `pnpm check` passes.
- [x] 16.3 `pnpm test` passes (unit + integration).
- [x] 16.4 `pnpm test:wpt` still passes (should be unaffected; run to confirm).
- [x] 16.5 `pnpm local:up:build` brings up the local stack; manual smoke test: hit `https://localhost:8443/dashboard`, complete OAuth, reach dashboard. Log out via POST `/auth/logout`. Hit `/dashboard` again with a login not in `AUTH_ALLOW`; confirm deny banner renders.
- [x] 16.6 `openspec validate replace-oauth2-proxy --strict` passes.
