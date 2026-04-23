## 1. Provider abstraction scaffolding

- [x] 1.1 Create `packages/runtime/src/auth/providers/types.ts` exporting `AuthProvider`, `AuthProviderFactory`, `ParsedEntry` (marker), and `ProviderRouteDeps` interfaces per design.md Decision 1
- [x] 1.2 Create `packages/runtime/src/auth/providers/registry.ts` with `buildRegistry(rawAuthAllow, factories, deps)` that splits on `,`, splits each entry on first `:`, buckets by id, calls `factory.create(rawList, deps)`, throws `unknown provider "<id>"` for unknown ids, and returns `Map<id, AuthProvider>`
- [x] 1.3 Create `packages/runtime/src/auth/providers/index.ts` exporting the assembled `PROVIDER_FACTORIES` array (github always; local conditionally on `process.env.LOCAL_DEPLOYMENT === "1"`) and re-exporting types
- [x] 1.4 Add unit tests `providers/registry.test.ts` covering empty `AUTH_ALLOW`, mixed providers, unknown provider error, whitespace trimming, empty-segment skipping, and the LOCAL_DEPLOYMENT gate

## 2. GitHub provider extraction

- [x] 2.1 Create `packages/runtime/src/auth/providers/github.ts` exporting `githubProviderFactory: AuthProviderFactory` (single public symbol; everything else module-private)
- [x] 2.2 Move `parseAuthAllow`'s github-entry parsing into a private `parseGithubRest` inside `github.ts`; produce internal `GithubEntry = { kind: "user"|"org", id: string }` records
- [x] 2.3 Implement `githubProvider.renderLoginSection(returnTo)` returning the existing "Sign in with GitHub" anchor markup (extracted verbatim from `ui/auth/login-page.ts`)
- [x] 2.4 Implement `githubProvider.mountAuthRoutes(subApp)` registering `GET /signin` and `GET /callback` handlers (move from `auth/routes.ts::authMiddleware`); paths become relative because the dispatcher mounts the sub-app at `/auth/github/`
- [x] 2.5 Implement `githubProvider.resolveApiIdentity(req)` that parses `Authorization: Bearer <token>`, calls `resolveUser`, applies the github allowlist (closure-captured users/orgs sets), returns `UserContext` or `undefined`
- [x] 2.6 Implement `githubProvider.refreshSession(payload)` that re-fetches `/user` and `/user/orgs` with `payload.accessToken`, applies the allowlist, returns `UserContext` or `undefined`
- [x] 2.7 Add unit tests `providers/github.test.ts` exercising only `githubProviderFactory.create()` and the public methods of the returned instance (no imports of internal helpers)

## 3. Local provider implementation

- [x] 3.1 Create `packages/runtime/src/auth/providers/local.ts` exporting `localProviderFactory: AuthProviderFactory` (single public symbol)
- [x] 3.2 Implement private `parseLocalRest(rest)` that splits on `:`, returns `LocalEntry = { name, orgs }`, validates name + orgs against `[A-Za-z0-9][-A-Za-z0-9]*`, splits orgs on `|`, throws targeted error `local entry "<entry>": orgs use '|' separator (e.g. acme|foo)` when orgs segment contains `,`
- [x] 3.3 Implement `localProvider.renderLoginSection(returnTo)` returning a CSP-safe `<form method="POST" action="/auth/local/signin">` with hidden `returnTo` input and `<select name="user">` populated from entries
- [x] 3.4 Implement `localProvider.mountAuthRoutes(subApp)` registering `POST /signin` only: parse form body, look up entry by name (400 on miss), seal session payload with `provider: "local"`, `accessToken: ""`, `mail: <name>@dev.local`, `orgs: entry.orgs`, sanitize `returnTo`, 302 to it
- [x] 3.5 Implement `localProvider.resolveApiIdentity(req)` parsing `Authorization: User <name>`, returning `{ name, mail: <name>@dev.local, orgs: entry.orgs }` only when `<name>` matches an entry
- [x] 3.6 Implement `localProvider.refreshSession(payload)` that returns `{ name, mail, orgs }` from the payload synchronously (no external call)
- [x] 3.7 Add unit tests `providers/local.test.ts` mirroring the github test file structure: `describe("create")`, `describe("renderLoginSection")`, `describe("mountAuthRoutes")`, `describe("resolveApiIdentity")`, `describe("refreshSession")`. Cover comma-in-orgs error path, unknown user 400 on signin, `returnTo` sanitization, signin sealing the cookie with all required payload fields

## 4. SessionPayload schema migration

- [x] 4.1 Add required `provider: "github" | "local"` field to `SessionPayload` in `auth/session-cookie.ts`
- [x] 4.2 Update `userFromPayload` to omit `provider` (UserContext shape unchanged)
- [x] 4.3 Verify `unsealSession` rejects pre-migration payloads (Zod parse fails on missing `provider`); add a test asserting that rejection
- [x] 4.4 Update every call site that constructs a `SessionPayload` to set `provider` explicitly (github callback, local signin)

## 5. Empty `Auth` union removal

- [x] 5.1 Delete the `Auth` discriminated union and `parseAuth` from `auth/allowlist.ts`; the file becomes module-private helpers only (or is deleted entirely if nothing else uses it)
- [x] 5.2 Delete the `__DISABLE_AUTH__` sentinel constant and its export
- [x] 5.3 Delete the `allow()` predicate and all its imports — providers own their own allowance check internally
- [x] 5.4 Delete the `authOpen` field from `auth/user-context.ts`'s `ContextVariableMap`

## 6. Config changes

- [x] 6.1 Update `config.ts` to no longer compute an `Auth` union; instead expose `auth: { providers: Map<id, AuthProvider> }` (or pass the registry through directly)
- [x] 6.2 In `config.ts`, build `PROVIDER_FACTORIES` conditionally on `process.env.LOCAL_DEPLOYMENT === "1"` and call `buildRegistry(env.AUTH_ALLOW, factories, deps)` to produce the registry
- [x] 6.3 Drop the existing `createConfig` refinement requiring `GITHUB_OAUTH_CLIENT_ID/SECRET/BASE_URL` when `mode === "restricted"`; replace with: those vars are required only when the github factory ends up registering at least one provider (i.e., AUTH_ALLOW contains `github:*` entries)
- [x] 6.4 Update `config.test.ts`: delete sentinel-related tests (3 occurrences); add tests for empty AUTH_ALLOW → empty registry, local entry without LOCAL_DEPLOYMENT → throws, local entry with LOCAL_DEPLOYMENT → registry contains local provider

## 7. Middleware refactor

- [x] 7.1 Rewrite `auth/session-mw.ts` per the new spec: read session cookie → unseal → branch on `payload.provider` to look up provider → call `refreshSession` when stale → set `UserContext` and `next()`. Delete the `disabled`/`open`/`restricted` switch and the `authOpen` set
- [x] 7.2 Rewrite `auth/tenant-mw.ts`: drop the `authOpen` bypass branch; require `c.get("user")` to be set (no fall-through); identifier-validation runs first
- [x] 7.3 Rewrite `api/auth.ts::bearerUserMiddleware` (or its successor) into a registry dispatcher: read `X-Auth-Provider`, look up provider, call `resolveApiIdentity(req)`, set user or 401
- [x] 7.4 Rewrite `api/index.ts`: delete the `switch(auth.mode)` block; install the dispatcher unconditionally; `requireTenantMember()` mounting is unchanged
- [x] 7.5 Update `auth/routes.ts`: keep `loginPageMiddleware` and `/auth/logout`; delete the github-specific `authMiddleware` (its routes move into `githubProvider.mountAuthRoutes`); add a new `mountProviderRoutes(app, registry)` that creates `/auth/<id>/` sub-apps and calls each provider's `mountAuthRoutes`
- [x] 7.6 Update `auth/routes.ts::loginPageMiddleware` to iterate the registry and concatenate each provider's `renderLoginSection(returnTo)` result; pass `sections: HtmlEscapedString[]` to `renderLoginPage`

## 8. Login page UI

- [x] 8.1 Update `ui/auth/login-page.ts::renderLoginPage` signature to accept `sections: readonly HtmlEscapedString[]` (instead of inlining the github button); render each section in registration order; flash banner logic unchanged
- [x] 8.2 Verify (and add a test for) the empty-sections case rendering brand + flash only, no provider controls

## 9. main.ts wiring

- [x] 9.1 Update `main.ts` to build the registry via `config.auth.providers`, pass it to the auth-routes mounter, the session middleware, the API dispatcher, and the login page middleware
- [x] 9.2 Remove any remaining references to `config.auth.mode`

## 10. Startup logging

- [x] 10.1 Update `main.ts` (or wherever the auth-mode log lives) to emit a single log record listing each registered provider with its entry count; warn-level if registry is empty, info-level otherwise; never include entry contents

## 11. SDK CLI changes

- [x] 11.1 Add `user?: string` field to `UploadOptions` in `packages/sdk/src/cli/upload.ts`
- [x] 11.2 Validate `user` and `token` are mutually exclusive at the top of `upload()` — throw if both supplied
- [x] 11.3 In `uploadBundle`, set `X-Auth-Provider: local` + `Authorization: User <name>` when `user` is set; `X-Auth-Provider: github` + `Authorization: Bearer <token>` when `token` is set; otherwise omit both
- [x] 11.4 Wire the CLI argument parser to accept `--user <name>` and pass it through to `upload()`
- [x] 11.5 Update `sdk/src/cli/upload.test.ts` with cases: `--user` happy path sends both headers; `--token` happy path sends both headers; both supplied throws; neither supplied omits both

## 12. dev.ts seed update

- [x] 12.1 Update `scripts/dev.ts::runtimeEnv` to set `AUTH_ALLOW = "local:dev,local:alice:acme,local:bob"` and `LOCAL_DEPLOYMENT = "1"`
- [x] 12.2 Update `scripts/dev.ts::runUpload` to pass `user: "dev"` to the `upload()` call

## 13. Local terraform tfvars

- [x] 13.1 Update `infrastructure/envs/local/terraform.tfvars` to use the new AUTH_ALLOW format (`local:dev,local:alice:acme,local:bob`); ensure `LOCAL_DEPLOYMENT=1` is set in the local env wiring

## 14. Test migration

- [x] 14.1 Create `packages/runtime/src/auth/test-helpers.ts` exporting `withTestUser(app, user)` that wraps a Hono app with a stub middleware setting `c.set("user", user)`
- [x] 14.2 Migrate `packages/runtime/src/api/upload.test.ts`: replace `__DISABLE_AUTH__` setup with `withTestUser`
- [x] 14.3 Migrate `packages/runtime/src/api/index.test.ts`: replace `__DISABLE_AUTH__` setup with `withTestUser`
- [x] 14.4 Update `packages/runtime/src/auth/tenant-mw.test.ts`: drop the local `authOpen` parameter from `mkApp`; delete the two `authOpen`-bypass tests; keep the rest
- [x] 14.5 Update `packages/runtime/src/auth/session-mw.test.ts`: delete the open-mode pass-through tests; delete the disabled-mode 401 test; cover the new branches (provider not in registry → clear cookie + 302; local provider stale refresh = no external call)
- [x] 14.6 Delete `packages/runtime/src/auth/allowlist.test.ts` — its content moves into per-provider tests
- [x] 14.7 Update `auth/integration.test.ts` to add a local-login round-trip test (POST `/auth/local/signin` → session cookie → `/dashboard` returns 200 with right user)
- [x] 14.8 Run `pnpm test` and verify zero failures across runtime + sdk

## 15. SECURITY.md updates

- [x] 15.1 Remove the `authOpen` / `mode === "open"` invariants in §4 (they no longer apply)
- [x] 15.2 Add new §4 invariant: NEVER register the LocalProvider unless `process.env.LOCAL_DEPLOYMENT === "1"`. Gate lives in the registry-builder; do not bypass for tests
- [x] 15.3 Add new §4 invariant: NEVER persist a `SessionPayload` without a `provider` field
- [x] 15.4 Add new §4 invariant: NEVER trust `X-Auth-Provider` as identity — it only selects a provider; the provider's own `resolveApiIdentity` must validate the actual credential
- [x] 15.5 Update §4 narrative section describing the auth surface to reflect the provider registry (no more `disabled | open | restricted` modes)

## 16. CLAUDE.md upgrade-notes

- [x] 16.1 Add `dev-local-auth-provider` upgrade-notes entry per the draft in design.md "Migration Plan", documenting BREAKING SDK + env-var format changes, the SessionPayload migration, the new `X-Auth-Provider` header on `/api/*`, the `LOCAL_DEPLOYMENT=1` gate, the operator step list, and the rollback procedure

## 17. Validation

- [x] 17.1 Run `pnpm validate` (lint + format check + type check + tests) and resolve any issues
- [x] 17.2 Run `pnpm local:up:build` end-to-end; visit `https://localhost:8443/login`; verify the local-user dropdown renders with three users; sign in as `dev`; navigate to `/dashboard`; verify the user/email show `dev` / `dev@dev.local`; sign out; verify the dropdown re-appears
- [x] 17.3 Repeat 17.2 signing in as `alice`; verify access to `acme` tenant works and access to `bob` tenant returns 404 (tenant isolation demo)
- [x] 17.4 Run `wfe upload --tenant dev --user dev --url http://localhost:8443` (insecure flag if needed locally) and verify the bundle uploads with both new headers
- [x] 17.5 Confirm `pnpm exec openspec validate dev-local-auth-provider --strict` passes
