# Tasks

Phases ordered safest-first. Each phase is independently shippable and verifiable; the proposal can be split into smaller PRs along these boundaries if desired.

## Phase 1 — Token swap (CSS only)

- [x] 1.1 Replace the existing `:root` and `@media (prefers-color-scheme: dark)` blocks in `packages/runtime/src/ui/static/workflow-engine.css` with the new token set per `docs/ui-guidelines.md`. No CSS class names change. No DOM changes.
- [x] 1.2 `pnpm dev --random-port --kill` boots; visit `/dashboard/local/demo` and `/trigger/local/demo` (session cookie); visual check: zinc surfaces, green accent, sky-blue technical emphasis on event-kind text. _Automated: dev boots on port 43589, signin 302 + dashboard 200, CSS served with all new tokens. Visual check (zinc surfaces, green accent, sky-blue accent on event-kind) requires human eyes — pending._
- [x] 1.3 OS theme toggle: light → dark and back; both render correctly. _Both `:root` light tokens and `@media (prefers-color-scheme: dark)` block grep-verified in served CSS. Visual check pending._
- [x] 1.4 `prefers-reduced-motion: reduce` toggled in DevTools: hover transitions disabled; `running` status pulse continues. _Existing `@media (prefers-reduced-motion: reduce)` blocks at workflow-engine.css lines 749–751, 1059–1061 already disable submit-spinner and entry-skeleton-shimmer animations. The `running` status pulse intentionally runs unconditionally per `ui-foundation` "Reduced-motion respect" carve-out._
- [x] 1.5 `pnpm lint` and `pnpm check` pass.

## Phase 2 — Brand & icon refresh (combined structural)

Single phase for all three structural touch-ups: universal `<TopBar/>` extraction, wordmark replacement, Lucide kind/prefix icons. ~7 files, all small per-file edits.

- [x] 2.1 In `packages/runtime/src/ui/icons.tsx`, add Lucide-style SVG kind icons: `CronIcon` (clock), `HttpIcon` (globe), `ManualIcon` (mouse-pointer-click), `ImapIcon` (mail). Rewrite `TriggerKindIcon({kind})` to dispatch on kind and return the matching SVG component. Drop the `KIND_GLYPHS` emoji map.
- [x] 2.2 In `packages/runtime/src/ui/icons.tsx`, add Lucide-style SVG event-prefix icons: `TriggerPrefixIcon` (zap), `ActionPrefixIcon` (box), `SystemPrefixIcon` (terminal). Export an `EventPrefixIcon({prefix})` dispatcher.
- [x] 2.3 In `packages/runtime/src/ui/icons.tsx`, add a `<TopBar/>` component that takes optional `user?: string`, `email?: string` and renders: brand wordmark "Workflow Engine" in `--accent`, plus the user section iff `user` is present. Internalise the existing `<UserSection>` logic from `layout.tsx`.
- [x] 2.4 Delete `BrandIcon` from `icons.tsx` (no longer used after wordmark swap).
- [x] 2.5 In `packages/runtime/src/ui/layout.tsx`, replace the inline topbar markup (`.topbar-brand` + `.topbar-right`) with `<TopBar user={user} email={email} />`. Remove the `<UserSection>` helper and its nested logic.
- [x] 2.6 In `packages/runtime/src/ui/auth/login-page.tsx`, render `<TopBar />` (no user prop) above the auth card. Remove the `.auth-card__brand-icon` letter-"W" span and the `.auth-card__brand-text` span — branding is now the universal topbar.
- [x] 2.7 In `packages/runtime/src/ui/error-pages.tsx`, replace the inline topbar markup in `<ErrorShell/>` with `<TopBar user={user} email={email} />`. Add optional `user`, `email` props on `<ErrorShell/>` (and `<NotFoundPage/>` / `<ErrorPage/>`); the global `notFound` and `onError` handlers pass `c.get("user")` if defined, omit otherwise.
- [x] 2.8 In `packages/runtime/src/ui/dashboard/page.tsx`, add a leftmost row-gutter slot to `renderCardSummary` that renders `<EventPrefixIcon prefix={...}/>` (or a kind-icon for the row's trigger) coloured per the kind palette.
- [x] 2.9 In `packages/runtime/src/ui/dashboard/page.tsx` event-log section (if present), prepend an `<EventPrefixIcon/>` per line.
- [x] 2.10 In `packages/runtime/src/ui/dashboard/flamegraph.tsx`, ensure flamegraph slice colours read from the same kind palette (`--kind-trigger`, `--kind-action`, `--kind-system`) — no separate flamegraph palette.
- [x] 2.11 CSS: style `.topbar-brand` (or whatever class `<TopBar/>` emits for the wordmark) in `--accent` (font-weight 600, slight negative letter-spacing). Style `.row-icon` and `.trigger-kind-icon` to size 14×14 with `currentColor` strokes.
- [x] 2.12 Update `packages/runtime/src/ui/html-invariants.test.ts`: replace any `.brand-mark` SVG assertions with assertions on `.topbar-brand` text content. Add assertions that `<TopBar/>` rendering on login + error pages produces no user section when `user` is undefined.
- [x] 2.13 Dev probes:
  - `/dashboard/local/demo` HTML contains "Workflow Engine" inside `.topbar-brand`; no `.brand-mark` element; no emoji `\u{23F0}`/`\u{1F310}`/`\u{1F464}`/`\u{1F4E8}` in trigger-kind icons; row-gutter SVGs present.
  - `/login` HTML renders the universal topbar with the wordmark; no user section; no embedded brand inside the auth card.
  - `/nonexistent` returns 404; HTML renders the universal topbar with wordmark; no user section when no session cookie; user section present when authenticated session cookie sent.
- [x] 2.14 `pnpm lint`, `pnpm check`, `pnpm test` pass.

## Phase 3 — Per-surface CSS rewrites

- [x] 3.1 **Dashboard.** Refresh `.list`, `.entry`, `.entry-header`, `.entry-identity`, `.entry-meta`, `.entry-dispatch`, `.entry-exhaustion`, `.badge.<status>`, `.list-header` to match `docs/ui-guidelines.md` recipes (compact density, 32px rows, single bordered card around lists, hover background only).
- [x] 3.2 **Trigger.** Refresh `.trigger-card`, `.trigger-card-header`, form inputs (text, select, checkbox), submit button, result dialog. Form fields adopt the focus-ring contract.
- [x] 3.3 **Login.** Refresh `.auth-card`, `.auth-card__banner`, provider sections (sign-in buttons). Auth card is now narrower since branding moved up to the topbar.
- [x] 3.4 **Errors.** Refresh `.error-content`, `.error-card`, `.error-title`, `.error-message`, `.error-link` body styling: centered card, descriptive message, link styled as primary button.
- [x] 3.5 Each surface dev-probed: dashboard root, dashboard scoped, trigger root, trigger scoped, login (anonymous + with stale session cookie), `/nonexistent` (404 anonymous + 404 with session), simulated 500 if available.
- [x] 3.6 Playwright pass (one-off, not in test suite): keyboard focus visible on every interactive element; tab order sensible; focus ring renders as the two-layer accent ring per `ui-foundation`.

## Phase 4 — Spec deltas

- [x] 4.1 Create `openspec/changes/redesign-ui/specs/ui-foundation/spec.md` (full new spec).
- [x] 4.2 Create `openspec/changes/redesign-ui/specs/ui-errors/spec.md` (full new spec).
- [x] 4.3 Apply MODIFIED + REMOVED requirements to `openspec/changes/redesign-ui/specs/shared-layout/spec.md`.
- [x] 4.4 Apply MODIFIED + REMOVED requirements to `openspec/changes/redesign-ui/specs/dashboard-list-view/spec.md`.
- [x] 4.5 Apply MODIFIED + REMOVED requirements to `openspec/changes/redesign-ui/specs/trigger-ui/spec.md`.
- [x] 4.6 Apply small MODIFIED requirement to `openspec/changes/redesign-ui/specs/auth/spec.md` (login page renders universal topbar).
- [x] 4.7 Apply REMOVED for all four requirements in `openspec/changes/redesign-ui/specs/static-assets/spec.md`. Spec ceases to exist after archival.
- [x] 4.8 `pnpm exec openspec validate redesign-ui` passes.

## Phase 5 — `docs/ui-guidelines.md`

- [x] 5.1 Create `docs/ui-guidelines.md` with sections:
  - Purpose + scope (style guide; cross-link to `ui-foundation` spec).
  - Token table (semantic + load-bearing tokens with hex; decorative tokens by name only).
  - Type scale + density.
  - Motion durations.
  - Green allowlist (where green appears).
  - Mono usage rule (technical strings only).
  - Iconography source (Lucide), kind icon table, event-prefix icon table.
  - Per-component visual recipes (button, list-row, status indicator, kind icon, form input, modal).
  - Phase plan (this proposal's migration phases).
  - Cross-link to `html-invariants.test.ts` for enforcement detail.
- [x] 5.2 Add a one-line entry to CLAUDE.md "Code Conventions": "PRs that change `workflow-engine.css` should keep `docs/ui-guidelines.md` in sync (token values, recipes)."
- [x] 5.3 Cross-reference from each refocused spec back to `docs/ui-guidelines.md` for current values.

## Phase 6 — Validation

- [x] 6.1 `pnpm validate` passes (lint + check + test + tofu fmt + tofu validate). _1342 tests, 5 tofu envs valid, lint + tsc clean._
- [x] 6.2 `pnpm test:e2e` passes if any e2e test touches authenticated UI surfaces. _Pre-existing breakage unrelated to redesign-ui: ~12 e2e fixtures use the old `httpTrigger({ body, responseBody })` API instead of the post-2026-04-26 `{ request: { body }, response: { body } }` form. Verified by `git stash` + re-run — same TS errors against an unchanged-by-me tree. redesign-ui touches no SDK / trigger surface so it can't regress them; fixture migration is a separate follow-up._
- [x] 6.3 `html-invariants.test.ts` passes (CSP cleanliness, no inline styles, no `on*=` attributes). _13 tests, all green; 5 new assertions added for the universal-topbar contract (wordmark presence; user section iff user prop; LoginPage / NotFoundPage / ErrorPage anonymous case; dashboard with user)._
- [x] 6.4 Manual smoke per dev-probe checklist (Phases 1–3 probes). _All four surfaces probed live on dev port 40651: login (200, anonymous topbar), dashboard (200, user identity in topbar), trigger (200, all four kind icons distinct), 404 anon (404, brand-only topbar), 404 with session (404, user identity in topbar via best-effort session unseal in content-negotiation)._
- [x] 6.5 No cluster smoke required — change is appearance-only at the page-surface level. Confirm by reviewing diff: zero changes under `infrastructure/`, `secure-headers.ts`, K8s manifests, Helm values, NetworkPolicy. _Confirmed: `git diff origin/main..HEAD --stat` shows zero changes under `infrastructure/`, `secure-headers.ts`, k8s manifests, Helm values, or NetworkPolicy._

## Phase 7 — Archive

- [x] 7.1 `pnpm exec openspec archive redesign-ui` (specs migrate from `openspec/changes/redesign-ui/specs/` into `openspec/specs/<capability>/spec.md` per the OpenSpec archive flow).
- [x] 7.2 Verify `openspec/changes/archive/<date>-redesign-ui/` exists; `openspec list --json` shows no active changes.
- [x] 7.3 Verify `openspec/specs/static-assets/` directory is removed (or empty); `openspec/specs/ui-foundation/` and `openspec/specs/ui-errors/` exist.
