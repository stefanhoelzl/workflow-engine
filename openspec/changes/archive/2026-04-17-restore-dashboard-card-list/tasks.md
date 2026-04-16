## 1. CSS — palette rename and card rules

- [x] 1.1 Rename `.badge.done` → `.badge.succeeded` and `.state-dot.done` → `.state-dot.succeeded` in `packages/runtime/src/ui/static/workflow-engine.css`.
- [x] 1.2 Grep the repo (`packages/`, `workflows/`, templates) for `.done` / `badge done` / `state-dot done` references and confirm no remaining usages.
- [x] 1.3 Remove the dead table-era rules: `.invocations-table`, `.invocation-row`, `.invocation-workflow`, `.invocation-trigger`, `.invocation-status`, `.invocation-started`, `.invocation-duration`, `.status-succeeded`, `.status-failed`, `.status-pending`. (No-op: these class names never had CSS rules; only appeared in the old table HTML, which is removed in §2.)
- [x] 1.4 Add `.entry`, `.entry-header`, `.entry-workflow`, `.entry-trigger`, `.entry-meta`, `.entry-started`, `.entry-duration`, `.entry-sep` rules that realize the card layout from `design.md` §D4. (`.entry`, `.entry-header`, `.entry-meta` reused from existing palette; `cursor: pointer` removed from `.entry-header` per D4.)
- [x] 1.5 Add `.entry.skeleton` rules with a shimmer animation on a pseudo-element.
- [x] 1.6 Add a `@media (prefers-reduced-motion: reduce)` block that disables the shimmer animation on `.entry.skeleton` while keeping the placeholder visible.

## 2. Renderer — split into shell and fragment

- [x] 2.1 In `packages/runtime/src/ui/dashboard/page.ts`, change `renderDashboardPage` to accept `(user, email)` only and return a shell whose `#invocation-list` container includes three `<div class="entry skeleton">` placeholders, with `hx-get="/dashboard/invocations"`, `hx-trigger="load"`, and `hx-swap="innerHTML"` on the container.
- [x] 2.2 Export a new `renderInvocationList(invocations)` function that returns the fragment body: a sequence of `.entry` cards (see §D4), or `<div class="empty-state">No invocations yet</div>` when the input is empty.
- [x] 2.3 Ensure each card's root element has `id="inv-{id}"` and `aria-expanded="false"` (no click handler, no `cursor: pointer`).
- [x] 2.4 Keep `formatTimestamp` and `formatDuration` helpers; the fragment renderer reuses them.
- [x] 2.5 Remove the `renderRow` table helper and the table markup entirely.
- [x] 2.6 Update the `InvocationRow` type export if needed (same fields; only the renderer changes).

## 3. Middleware — add the fragment route

- [x] 3.1 In `packages/runtime/src/ui/dashboard/middleware.ts`, add `app.get("/invocations", fragmentHandler)` alongside the existing `"/"` / `""` shell handlers.
- [x] 3.2 Move the EventStore query + `InvocationRow` mapping into `fragmentHandler`; the shell handler no longer touches the store.
- [x] 3.3 The shell handler calls `renderDashboardPage(user, email)` and returns HTML.
- [x] 3.4 The fragment handler calls `renderInvocationList(rows)` and returns HTML (no layout wrapper).
- [x] 3.5 Confirm both routes run under the existing `/dashboard/*` middleware match, so `githubAuthMiddleware` coverage is unchanged. (Unchanged `match: "/dashboard/*"` covers `/dashboard/invocations`.)

## 4. Tests

- [x] 4.1 Retarget the existing data-presence assertions in `packages/runtime/src/ui/dashboard/middleware.test.ts` from `app.request("/dashboard")` to `app.request("/dashboard/invocations")` (tests: pending, succeeded, failed, ordering).
- [x] 4.2 Update the "renders an empty state when there are no invocations" test to hit `/dashboard/invocations` and assert the empty-state markup.
- [x] 4.3 Add a new test: `GET /dashboard` returns the shell containing the loading-state placeholder, does NOT contain any invocation data, and triggers the fragment via `hx-get="/dashboard/invocations"`.
- [x] 4.4 Add a new test: the fragment response for a non-empty store includes a card with `id="inv-<id>"` and the colored status label markup (`class*="succeeded"`, `class*="pending"`, or `class*="failed"`).
- [x] 4.5 Update `packages/runtime/src/ui/html-invariants.test.ts`: change the `renderDashboardPage` call to the new `(user, email)` signature, and add a second case that calls `renderInvocationList([...])` and asserts the same four invariants (no inline script, no `on*=`, no `style=`, no `javascript:`).

## 5. Validate

- [x] 5.1 Run `pnpm lint` — clean.
- [x] 5.2 Run `pnpm check` — clean.
- [x] 5.3 Run `pnpm test` — all tests pass (29 files / 261 tests, including the dashboard middleware and html-invariants suites).
- [x] 5.4 Run `pnpm validate` — full gate passes (lint, tsc, test, tofu-fmt, tofu-val for all three envs).
- [ ] 5.5 Manual smoke via `pnpm dev`: load `/dashboard`, confirm three skeleton cards appear, then cards swap in; load with zero invocations to confirm the empty state path; toggle OS reduced-motion and confirm shimmer is disabled. **(Deferred to user — requires browser.)**

## 6. Archive prep

- [x] 6.1 Confirm `pnpm exec openspec validate restore-dashboard-card-list --strict` passes before handing off to `/openspec-archive-change`.
