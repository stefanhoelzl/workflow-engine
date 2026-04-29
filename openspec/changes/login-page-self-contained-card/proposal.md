## Why

The login page is the only UI surface where the user has nothing to act on except the auth providers themselves. The universal topbar — useful on `/dashboard` and `/trigger` because it carries identity and a sign-out control, useful on error pages because the user may already be authenticated and needs a way back — duplicates branding the auth card already needs to carry on its own. Two "Workflow Engine" wordmarks (one in the topbar, one as the heading of the auth card) compete for the eye on a surface whose only job is "pick a provider, click".

The redesigned login page makes the brand the focal point of the heading itself ("Sign in to **Workflow Engine**", with the brand portion in the accent green). Once the heading carries branding, the topbar wordmark becomes a redundant second wordmark stacked above the card — visual noise, not information.

The current `ui-foundation` "Universal topbar" requirement (added in `2026-04-29-redesign-ui`) makes "every UI surface, including the login page, renders the same topbar" a contract. That was the right call when the goal was cross-surface consistency between authenticated pages and error pages — both can carry user identity, both need a sign-out control reachable. The login page never carried either by definition (no session = no user info, no sign-out), so it was already the weakest case for the contract. With branding now living inside the auth heading, the login page no longer needs the topbar at all.

## What Changes

### Spec

- **MODIFIED `ui-foundation` "Universal topbar"** narrows the scope from *every UI surface* to *every authenticated UI surface and every error page*. The login page is explicitly exempted: it is a self-contained card whose heading carries the brand wordmark in `--accent`, replacing the topbar's role. The "Login page shows wordmark only" scenario is replaced with "Login page omits the topbar".
- No other `ui-foundation` requirement changes (theme detection, reduced-motion, CSP cleanliness, focus-visible, asset delivery, kind-colour mapping, status semantics, icon invariants, distinct-indicator-per-kind, distinct-indicator-per-prefix all stay as-is).
- No `auth` spec change. The login page is still the same route (`/login`), still composes provider sections, still reads the flash cookie. Only its chrome reshapes.

### Visual implementation

- `<TopBar/>` is removed from `LoginPage` (`packages/runtime/src/ui/auth/login-page.tsx`).
- `LoginPage` heading becomes `<h1>Sign in to <span class="auth-card__brand">Workflow Engine</span></h1>` with the brand span coloured `--accent`.
- `.auth-page` CSS drops the `padding-top: calc(--topbar-height + --sp-5)` (no topbar to reserve space for); the card becomes vertically centred on the viewport.
- `<TopBar/>` itself is unchanged — it still renders on `/dashboard`, `/trigger`, `/404`, `/5xx` exactly as before.
- `html-invariants.test.ts` `LoginPage` invariant flips from "renders `.topbar-brand`" to "renders `.auth-card__brand` and does NOT render `.topbar`".
- `auth/routes.test.ts` `GET /login` scenario flips its topbar assertions accordingly.

### Out of scope

- The visual refresh of the login page (provider buttons, dropdown overlay, brand-green title) lands in the same PR but is not part of this proposal — it is implementation detail covered by the existing `ui-foundation` contracts (CSP-clean, focus-visible, reduced-motion, kind/accent palette).

## Impact

- Affected specs: `ui-foundation` (one requirement modified).
- Affected code: `packages/runtime/src/ui/auth/login-page.tsx`, `packages/runtime/src/ui/static/workflow-engine.css` (auth-page padding + auth-card heading rules), `packages/runtime/src/ui/html-invariants.test.ts`, `packages/runtime/src/auth/routes.test.ts`.
- No state wipe, no rebuild required for tenants. Operator-visible only as a visual difference on `/login`.
