## 1. Config schema

- [x] 1.1 In `packages/runtime/src/config.ts`, keep `GITHUB_USER: z.string().optional()` at the raw schema level and add a `.refine()` that rejects values where `__DISABLE_AUTH__` appears as a comma-separated segment alongside other values
- [x] 1.2 Extend the `.transform()` to produce `githubAuth` as a discriminated union `{ mode: 'disabled' } | { mode: 'open' } | { mode: 'restricted'; users: string[] }`, replacing the old `githubUser` field
- [x] 1.3 Implement the list parser inside the transform: `env.GITHUB_USER.split(",")` with no trimming and no empty-filtering (matches oauth2-proxy pflag `StringSlice`)
- [x] 1.4 Export the `GitHubAuth` TypeScript type so consumers can pattern-match on `mode`

## 2. Config tests

- [x] 2.1 Update `packages/runtime/src/config.test.ts`: existing "GITHUB_USER is set" case asserts `githubAuth.mode === 'restricted'` with `users: ["stefanhoelzl"]`
- [x] 2.2 Update the "GITHUB_USER is not set" case to assert `githubAuth.mode === 'disabled'`
- [x] 2.3 Add a case for a comma-separated value producing `mode: 'restricted'` with a multi-element `users` array
- [x] 2.4 Add a case verifying whitespace and empty segments are preserved (pflag parity)
- [x] 2.5 Add a case asserting the sentinel `__DISABLE_AUTH__` produces `mode: 'open'`
- [x] 2.6 Add a case asserting mixed sentinel + usernames throws a Zod validation error

## 3. Middleware

- [x] 3.1 In `packages/runtime/src/api/auth.ts`, rename `GitHubAuthOptions.githubUser: string` to `githubUsers: string[]` and replace the equality check with `githubUsers.includes(login)`
- [x] 3.2 Replace the 403 Forbidden response with a 401 Unauthorized response that is byte-identical to the other 401 responses in this middleware (same body, same headers); remove the `HTTP_FORBIDDEN` constant
- [x] 3.3 Standardize all 401 responses on the body `{ error: "Unauthorized" }` so attackers cannot distinguish failure causes from the response

## 4. API middleware wiring

- [x] 4.1 In `packages/runtime/src/api/index.ts`, change the `ApiOptions` shape to accept `githubAuth: GitHubAuth` (instead of the optional `githubUser`)
- [x] 4.2 Branch on `githubAuth.mode`: `'restricted'` → install `githubAuthMiddleware({ githubUsers: githubAuth.users })`; `'disabled'` → install a small always-401 middleware (same body/headers as the auth-failure response); `'open'` → install no middleware
- [x] 4.3 Update the `main.ts` call site to pass `config.githubAuth` to `apiMiddleware`

## 5. Startup logging

- [x] 5.1 In `packages/runtime/src/main.ts`, after `createConfig` returns, emit `runtimeLogger.warn("api-auth.disabled")` when `config.githubAuth.mode === 'disabled'` and `runtimeLogger.warn("api-auth.open")` when `mode === 'open'`
- [x] 5.2 Ensure each warn is a one-shot, emitted before the server starts listening

## 6. Middleware tests

- [x] 6.1 Update `packages/runtime/src/api/auth.test.ts` for the `githubUsers: string[]` signature
- [x] 6.2 Add a test asserting a valid token whose login is in a multi-entry allow-list is accepted
- [x] 6.3 Replace the existing "valid token, wrong user returns 403" test with one asserting the same scenario returns 401 with body `{ error: "Unauthorized" }`
- [x] 6.4 Add a test asserting the 401 body/headers for "wrong user" are byte-identical to the 401 body/headers for "missing Authorization header"
- [x] 6.5 Add a new test file (e.g., `packages/runtime/src/api/index.test.ts`) that covers the three modes via `apiMiddleware`: `disabled` returns 401 without calling GitHub; `open` passes through to the handler without auth; `restricted` routes through the auth middleware

## 7. Infrastructure (app module)

- [x] 7.1 In `infrastructure/modules/workflow-engine/modules/app/app.tf`, declare a new input `variable "github_users" { type = string }`
- [x] 7.2 Inside the `container` block of `kubernetes_deployment_v1.app`, add a plain `env { name = "GITHUB_USER" value = var.github_users }` entry (no secret reference; the allow-list is not a secret)

## 8. Infrastructure (workflow-engine module)

- [x] 8.1 In `infrastructure/modules/workflow-engine/workflow-engine.tf`, pass `github_users = var.oauth2.github_users` into the `module "app"` block

## 9. Verification

- [x] 9.1 Run `pnpm validate` (lint, format check, typecheck, tests) and ensure it passes
- [x] 9.2 Run `pnpm infra:up` against a fresh dev cluster; confirm pod spec contains `GITHUB_USER` env var with the value from `terraform.tfvars`
- [x] 9.3 From the dev cluster, verify `curl -X POST https://localhost:8443/api/workflows` without Authorization returns `401 Unauthorized`
- [x] 9.4 From the dev cluster, verify an upload with a valid PAT belonging to an allow-listed user succeeds
- [x] 9.5 From the dev cluster, verify an upload with a valid PAT belonging to a non-allow-listed user returns 401 (not 403)
- [x] 9.6 Confirm `runtimeLogger` emits `api-auth.restricted` (or equivalent info/warn) at startup with the expected user list
