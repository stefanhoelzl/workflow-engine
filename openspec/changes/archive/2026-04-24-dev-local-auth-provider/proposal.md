## Why

The current `__DISABLE_AUTH__` sentinel turns auth fully off in dev: no `UserContext` is set, tenant-membership checks are bypassed, and the dashboard renders an empty user/email field. This is awkward to demo, doesn't exercise the real session/login/logout paths, and makes it impossible to test multi-user / multi-tenant separation locally without registering a GitHub OAuth App. The interview also surfaced that the existing `disabled | open | restricted` mode union is the wrong abstraction once a second auth source enters the picture.

This change replaces the sentinel with a first-class **local** auth provider that participates in the full login flow (login page section + POST signin + sealed session + logout), and refactors the auth surface around a small `AuthProvider` registry so adding any future provider (OIDC, SAML, …) is mechanical.

## What Changes

- **BREAKING** Remove the `__DISABLE_AUTH__` sentinel and the `Auth` discriminated union (`disabled | open | restricted`). Replace with a provider registry whose only state is "which providers are registered, with which entries."
- **BREAKING** Remove the `authOpen` `ContextVariableMap` flag and every code path that branches on it (open-mode session pass-through, tenant-membership bypass, `/api/*` no-Bearer pass-through).
- **BREAKING** `SessionPayload` gains a required `provider: "github" | "local"` field. Existing sealed sessions fail to unseal on first request after deploy and users re-authenticate.
- **BREAKING** `/api/*` dispatch reads a new `X-Auth-Provider: <id>` request header to pick the provider. Clients send both `X-Auth-Provider` and the provider-specific `Authorization` value. Missing or unknown provider id → 401.
- **BREAKING** SDK `upload()` gains a `user?: string` option (mutually exclusive with `token?: string`); `--user <name>` on the CLI sends `X-Auth-Provider: local` + `Authorization: User <name>`.
- Add `AuthProvider` + `AuthProviderFactory` interfaces in `packages/runtime/src/auth/providers/`, with `githubProvider` (refactor of today's behavior) and `localProvider` (new).
- Add `local:<name>` and `local:<name>:<org>|<org>` entries to the AUTH_ALLOW grammar. Top-level entry separator stays `,`. Local provider uses `|` as its org sub-separator. Mail is derived as `<name>@dev.local`.
- The `localProvider` factory is registered only when `process.env.LOCAL_DEPLOYMENT === "1"`. Outside dev, `local:` entries fail `createConfig` with `unknown provider "local"` (same error class as a typo).
- `/login` iterates the registry: each registered provider contributes one section (GitHub button, local-user dropdown form). Empty registry → empty card; nothing can authenticate.
- Logout (`POST /auth/logout`) stays provider-agnostic — clears the session cookie regardless of which provider minted it.
- `scripts/dev.ts` switches `AUTH_ALLOW` to `local:dev,local:alice:acme,local:bob`, sets `LOCAL_DEPLOYMENT=1`, and passes `--user dev` to the upload helper.
- Tests that previously relied on `__DISABLE_AUTH__` to skip auth either delete (open-mode-semantics tests are no longer reachable) or migrate to a new `withTestUser` helper.

## Capabilities

### New Capabilities
*(none — the change is a refactor + extension of the existing `auth` capability; no new top-level capability emerges)*

### Modified Capabilities
- `auth`: AUTH_ALLOW grammar widens with `local:` entries; `Auth` mode union and `__DISABLE_AUTH__` sentinel removed; provider registry abstraction introduced; `/api/*` dispatch reads `X-Auth-Provider`; session payload gains `provider` field.
- `cli`: `upload()` gains a `user` option (mutually exclusive with `token`) that sets the local-provider headers.
- `runtime-config`: `LOCAL_DEPLOYMENT=1` becomes a hard gate for registering the `localProvider` factory.

## Impact

- **Code**: `packages/runtime/src/auth/*` (rewritten around the provider abstraction), `packages/runtime/src/api/index.ts` + `auth.ts` (dispatcher), `packages/runtime/src/config.ts` (registry build, `LOCAL_DEPLOYMENT` gate), `packages/runtime/src/main.ts` (wiring), `packages/runtime/src/ui/auth/login-page.ts` (iterates registry sections), `packages/sdk/src/cli/upload.ts` (new `user` option), `scripts/dev.ts` (seed users + LOCAL_DEPLOYMENT), `infrastructure/envs/local/terraform.tfvars` (new AUTH_ALLOW value).
- **Tests**: ~12 deletions of open-mode-semantics tests; ~10 cosmetic edits dropping `authOpen`; ~5 genuine migrations to a new `withTestUser` helper; new per-provider test files mirroring the public interface.
- **Docs**: `SECURITY.md` §4 invariants (drop `authOpen` rules; add LocalProvider gate + `X-Auth-Provider` selection invariant), `CLAUDE.md` upgrade-notes (new `dev-local-auth-provider` entry).
- **Operators**: dev users update `AUTH_ALLOW` and add `LOCAL_DEPLOYMENT=1`; one-time forced re-login on deploy for any live session. No state wipe (`pending/`, `archive/`, storage state untouched). No tenant re-upload required. Prod/staging configs unchanged — no `local:` entries and no `LOCAL_DEPLOYMENT` set.
