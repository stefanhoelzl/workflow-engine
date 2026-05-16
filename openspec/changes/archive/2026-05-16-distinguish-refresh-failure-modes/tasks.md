## 1. Provider contract

- [x] 1.1 Define `RefreshResult` discriminated union in `packages/runtime/src/auth/providers/types.ts` and update `AuthProvider.refreshSession` signature to `Promise<RefreshResult>`.
- [x] 1.2 Update `packages/runtime/src/auth/providers/github.tsx::refreshSession` to return `{ ok: true, user }`, `{ ok: false, reason: 'session-expired' }` (on `!userRes.ok`), or `{ ok: false, reason: 'access-denied' }` (on `!isAllowed`).
- [x] 1.3 Update `packages/runtime/src/auth/providers/local.tsx::refreshSession` to look up `payload.login` in the in-memory `byName` map; return `{ ok: true, user }` on hit or `{ ok: false, reason: 'access-denied' }` on miss.
- [x] 1.4 Update `packages/runtime/src/auth/providers/test-fakes.ts` and any in-test provider stubs to the new return type. (no changes needed in test-fakes.ts; stubs updated in `api/auth.test.ts` and `providers/registry.test.ts`)

## 2. Shared redirect helper

- [x] 2.1 Create `packages/runtime/src/auth/redirect-to-login.ts` exporting `redirectToLoginWithFlash(c, flash, secureCookies)`.
- [x] 2.2 Add `packages/runtime/src/auth/redirect-to-login.test.ts` covering both flash kinds, assert exact `Set-Cookie` headers and 302 status.

## 3. Session middleware rewiring

- [x] 3.1 No-cookie path routes through a plain `c.redirect(loginRedirectUrl(c))` — no flash set.
- [x] 3.2 Unseal-failure, isExpired, and unregistered-provider paths use `redirectToLoginWithFlash(c, { kind: 'logged-out' }, secureCookies)`.
- [x] 3.3 Stale-refresh branch switches on `RefreshResult`: `ok` re-seals; `session-expired` sets logged-out flash; `access-denied` sets denied flash with `payload.login`.
- [x] 3.4 Removed the now-unused `setFlash` and `clearSession` private helpers in `session-mw.ts`.

## 4. OAuth callback rewiring

- [x] 4.1 In `github.tsx::buildCallback`, replaced the inline flash+clear+redirect block with `redirectToLoginWithFlash(c, { kind: 'denied', login: user.login }, deps.secureCookies)`. Cleaned up the now-unused `sealFlash`, `FLASH_COOKIE`, `LOGIN_PATH`, `SIXTY_SECONDS` imports.

## 5. Tests — middleware

- [x] 5.1 Added `session-mw.test.ts` scenarios for each transition (no cookie, unsealable, unknown provider, expired, stale ok, stale session-expired, stale access-denied).
- [x] 5.2 Updated stale-5xx assertion to expect `logged-out` flash. Added new 401-token-revoked scenario.
- [x] 5.3 Flipped expired-session assertion to expect `logged-out` flash.

## 6. Tests — providers

- [x] 6.1 Replaced `undefined` assertions in `github.test.ts::refreshSession` with `{ ok: false, reason: ... }` assertions; added 401 → session-expired scenario; allowlist miss → access-denied; happy path → `{ ok: true, user }`.
- [x] 6.2 Replaced `local.test.ts::refreshSession` assertions: catalog hit → `{ ok: true, user }`; catalog miss → `{ ok: false, reason: 'access-denied' }`. Kept the "no fetch" assertion.

## 7. Tests — callback

- [x] 7.1 Existing `github.test.ts` callback section unchanged — the wire shape (auth_flash cookie + `Location: /login`) is preserved by the helper. Verified by `pnpm test` passing (allowlist-rejection callback test still green).

## 8. Tests — integration

- [x] 8.1 `integration.test.ts::"denied user: callback → flash + 302 /login → deny banner"` still passes — the callback path's deny flash is unchanged. The logout-flow test also still passes. No edits required.

## 9. Validation

- [x] 9.1 `pnpm exec openspec validate distinguish-refresh-failure-modes --strict` passes.
- [x] 9.2 `pnpm lint`, `pnpm check`, `pnpm test` all pass (1514 tests, including auth + integration).

## 10. Dev verification

- [x] 10.1 `pnpm dev --random-port --kill` in background; ready marker emitted on port 38379.
- [x] 10.2 `curl /invocations/` with no cookie → `302 Location: /login?returnTo=%2Finvocations%2F`, no `auth_flash` Set-Cookie. ✓
- [x] 10.3 Covered by unit tests (`session-mw.test.ts::clears local session with denied flash when catalog entry was removed` and `local.test.ts::returns access-denied when login was removed from the catalog`). Live verification would require restarting `pnpm dev` with a reduced AUTH_ALLOW (the dev script hardcodes `local:local-user,local:alice:acme,local:bob`); the unit tests cover the exact transition.
- [x] 10.4 `curl /invocations/` with tampered cookie → `302 Location: /login`, `auth_flash` Set-Cookie sealing `{ kind: 'logged-out' }`, session cookie cleared. Following the redirect renders `<title>Signed out</title>` and the "Signed out." banner. ✓
- [x] 10.5 Dev process tree killed.
