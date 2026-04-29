# Tasks

## 1. Spec amendment

- [x] 1.1 `openspec/changes/login-page-self-contained-card/specs/ui-foundation/spec.md` modifies the "Universal topbar" requirement to exempt the login page and replaces the "Login page shows wordmark only" scenario with "Login page omits the topbar".

## 2. Implementation

- [x] 2.1 Remove `<TopBar />` from `LoginPage` in `packages/runtime/src/ui/auth/login-page.tsx`; remove the `TopBar` import.
- [x] 2.2 Wrap the brand portion of the heading in `<span class="auth-card__brand">` so CSS can colour it `--accent`.
- [x] 2.3 In `packages/runtime/src/ui/static/workflow-engine.css`, drop `padding-top: calc(--topbar-height + --sp-5)` from `.auth-page` (no topbar to reserve room for) and add `.auth-card__brand { color: var(--accent); }`.

## 3. Test alignment

- [x] 3.1 Update `packages/runtime/src/ui/html-invariants.test.ts` "LoginPage" scenario: assert `.auth-card__brand` is present and `.topbar` / `.topbar-brand` / `.topbar-user` are absent (was: assert `.topbar-brand` is present).
- [x] 3.2 Update `packages/runtime/src/auth/routes.test.ts` "GET /login renders the sign-in page" scenario: assert `.topbar` is absent and `.auth-card__brand` is present (was: assert `.topbar` and `.topbar-brand` are present).

## 4. Verification

- [x] 4.1 `pnpm validate` passes (lint, type check, unit tests, infra fmt/validate).
- [x] 4.2 `pnpm dev --random-port --kill` boots; `GET /login` HTML grep: contains `auth-card__brand`, does NOT contain `class="topbar"`.
- [x] 4.3 Sign-in still functional: `POST /auth/local/signin` (form: `user=local`) → 302 + session cookie; `/dashboard/local` with cookie → 200.
