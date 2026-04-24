## Why

The post-signout `/login` page currently renders a second, GitHub-specific affordance — a body sentence ("GitHub may still consider this browser signed in…") plus a "Sign out of GitHub" button linking to `github.com/logout` — immediately after the user clicks our own "Sign out". The bundling reads as if signing out of our app *did* or *should have* signed the user out of GitHub, which it cannot (GitHub's session is first-party on github.com and our origin has no mechanism to end it). The net effect is confusion about what "Signed out" means. The same nudge appears on the `denied` flash, where it *is* load-bearing (it's the only escape hatch out of the silent re-auth loop when the browser has a GitHub session for a rejected user), but the heavy styled-button treatment is still more than that case needs.

## What Changes

- **BREAKING (login page HTML):** The `logged-out` flash banner no longer contains the "GitHub may still be signed in…" body sentence nor the "Sign out of GitHub" action button. It renders as a plain "Signed out" banner.
- **BREAKING (login page HTML):** The `denied` flash banner no longer contains a styled action-area button. Instead, the banner body gains a single inline `<a href="https://github.com/logout" target="_blank" rel="noopener noreferrer">sign out of GitHub</a>` link embedded in a sentence framed as account-switching guidance ("To try a different account, sign out of GitHub first"). No action-area affordance.
- **BREAKING (AuthProvider interface):** Remove the optional `renderFlashBody()` and `renderFlashAction()` hooks from `AuthProvider`. The GitHub provider's implementations of both are deleted. No provider uses these hooks after this change.
- **BREAKING (FlashPayload):** Remove the `provider` field from both the `denied` and `logged-out` variants of `FlashPayload`. The field is no longer read by any caller.
- Simplify `/auth/logout`: it no longer needs to unseal the session cookie to read the provider before sealing the flash.
- Simplify the GitHub `/auth/github/callback` denied path: it no longer stamps `provider: "github"` on the flash cookie.
- Simplify `GET /login`: it no longer looks up a provider by `flash.provider` nor invokes `renderFlashBody`/`renderFlashAction`; it passes only `{ flash, returnTo, sections }` to `renderLoginPage`.
- Simplify `renderLoginPage` props: drop `flashBody` and `flashAction`; the denied-banner account-switch sentence lives directly in `bannerFor()` in `login-page.ts`.
- Mental model the UI now communicates: our app's session and GitHub's session are two independent logouts. Account switching is done by signing out of github.com (any tab) and then signing in again — the standard pattern for any GitHub-authenticated service.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `auth`: Flash banner rendering on `GET /login` is simplified. The `logged-out` banner drops the GitHub sign-out link entirely. The `denied` banner replaces the styled action-area link with an inline prose link inside the banner body. `AuthProvider` no longer exposes `renderFlashBody` / `renderFlashAction`. `FlashPayload.provider` is removed.

## Impact

- **Code (runtime):**
  - `packages/runtime/src/auth/providers/types.ts` — remove `renderFlashBody?` and `renderFlashAction?` from `AuthProvider`.
  - `packages/runtime/src/auth/providers/github.ts` — delete the two `renderFlash*` method implementations (≈10 lines).
  - `packages/runtime/src/auth/flash-cookie.ts` — drop `provider` from both `FlashPayload` variants.
  - `packages/runtime/src/auth/routes.ts` — `/auth/logout` stops unsealing the session; `GET /login` stops resolving a `flashProvider` and stops calling `renderFlashBody`/`renderFlashAction`.
  - `packages/runtime/src/auth/providers/github.ts` (callback path) — stop stamping `provider: "github"` on denied flashes.
  - `packages/runtime/src/ui/auth/login-page.ts` — drop `flashBody`/`flashAction` from `LoginPageProps`; add inline account-switch link to the `denied` branch of `bannerFor()`.
- **Tests:** `packages/runtime/src/auth/routes.test.ts`, `packages/runtime/src/auth/integration.test.ts`, and any snapshot/HTML assertions that reference the old body/action strings must be updated.
- **Spec:** `openspec/specs/auth/spec.md` — update the `GET /login` route requirement covering the two flash variants (lines ~640–641), update or remove the `AuthProvider.renderFlashBody/Action` requirement if one exists there, update the `FlashPayload` schema requirement to drop `provider`, update the `/auth/logout` requirement to reflect that it no longer reads session provider.
- **No infrastructure impact.** No Traefik, NetworkPolicy, CSP, or K8s manifest change. The new inline `<a>` on the denied banner is a plain anchor, not an inline script/style — the existing strict CSP (§6 in CLAUDE.md) is unchanged.
- **No breaking change for external consumers.** `AuthProvider` is an internal-only type, not exported from any published package.
- **Behavioural impact for users:** Users who currently rely on the convenience button to end their GitHub session after signout will need to open github.com themselves (same as any other GitHub-authenticated service). Users hitting the `denied` flash retain an in-app link to do the same — it moves from the action area into the banner prose.
