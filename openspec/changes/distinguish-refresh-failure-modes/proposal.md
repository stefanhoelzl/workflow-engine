## Why

When a session goes stale (>10min idle, still inside its 7-day exp), `sessionMiddleware` calls `provider.refreshSession(payload)`. Today the provider returns `undefined` for **two unrelated reasons** — the upstream token is no longer valid (revoked, expired, GitHub 5xx, network error) OR the user is no longer on the allowlist — and the middleware always renders the same "Not authorized — contact administrator" banner. Users whose GitHub session simply expired in the background see a banner accusing them of being denied access, when in fact a fresh sign-in works immediately. The misleading message has been reported by users in the wild.

## What Changes

- **BREAKING (provider contract):** `AuthProvider.refreshSession` returns a discriminated `RefreshResult` (`{ ok: true; user }` | `{ ok: false; reason: 'session-expired' | 'access-denied' }`) instead of `UserContext | undefined`. Both shipped providers (github, local) are updated; any out-of-tree provider must follow suit.
- `sessionMiddleware` maps `reason: 'session-expired'` to the existing `logged-out` flash, and `reason: 'access-denied'` to the existing `denied` flash. Only the genuine allowlist-rejection case shows "Not authorized."
- `sessionMiddleware` sets the `logged-out` flash on **every clear-and-redirect path** — expired session, malformed/unsealable cookie, unknown provider in payload — so the user always sees a coherent "Signed out" banner when a cookie they had was cleared. **No flash on first-time visits** (no cookie to clear).
- The local provider's `refreshSession` now re-checks `AUTH_ALLOW`; a user removed from the catalog after their session was minted returns `access-denied` (currently always returns `ok` — silent stale data).
- New shared helper `redirectToLoginWithFlash(c, flash, secure)` consolidates the seal-flash + clear-session + redirect-to-`/login` sequence used by the GitHub OAuth callback's allowlist-rejection branch and by all `sessionMiddleware` clear-and-redirect paths.
- **Behavior change visible in tests:** the existing spec scenarios "Stale github session with GitHub 5xx fails closed" and "Expired session redirects to login" change their asserted flash payload (5xx case: `denied` → `logged-out`; expiry case: no flash → `logged-out`).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `auth`: Provider `refreshSession` contract switches to a typed `RefreshResult`; session-middleware flash semantics expand to cover every clear-and-redirect path with the correct kind; local provider re-validates the catalog on refresh.

## Impact

- **Code:** `packages/runtime/src/auth/providers/types.ts`, `providers/github.tsx`, `providers/local.tsx`, `session-mw.ts`, plus a new `redirect-to-login.ts` module. Callback path in `github.tsx:191` switches to the shared helper but otherwise unchanged.
- **Tests:** `session-mw.test.ts` gains scenarios for each clear-and-redirect transition; `github.test.ts` and `local.test.ts` cover the new discriminated returns; new `redirect-to-login.test.ts` unit-tests the helper.
- **APIs / wire format:** None — session payload, cookie names, TTLs, sealing, and flash kinds (`denied` | `logged-out`) are unchanged.
- **UX side effect:** post-deploy (sealing key regenerates per process), users now see "Signed out." on next visit instead of a silent redirect. Accepted as accurate, not a regression.
- **Out-of-tree providers:** any third-party `AuthProvider` implementation must migrate to the new `refreshSession` return type. None known.
- **Security:** no change to the threat model — no new globals, no new public routes, no relaxation of allowlist enforcement; the allowlist check still fails closed.
