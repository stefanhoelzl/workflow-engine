## Why

The dashboard was simplified to a plain HTML table during the recent UI CSP / refactor series. It lost the visual language of the previous design (status-colored rows, scannable layout, async-load shape) without gaining anything in exchange. The next dashboard features on the roadmap — inline flamegraph expand (soon), filters (after), live updates (later) — all assume a shell + async-loaded list. Restoring that shape now pays off immediately (better scan feel, consistent with the trigger UI aesthetic) and leaves the seams each phase-2+ feature needs.

## What Changes

- Split the dashboard into a page shell (`GET /dashboard`) and an invocation list fragment (`GET /dashboard/invocations`). The shell renders a non-blank loading state; the fragment replaces it.
- Render each invocation as a card (state indicator + workflow + trigger + colored status label on the top row; started-at + duration on the meta row) instead of a flat table row.
- Each rendered invocation has a stable DOM identity keyed to its invocation id (enables phase-2 inline expand to target it without a re-render).
- Rename the shared `.done` status CSS classes to `.succeeded` to match the status-string vocabulary already used by the middleware. Drop the now-dead `.invocations-table` / `.status-*` table-era CSS.
- Loading state honors `prefers-reduced-motion: reduce`.
- No new data surface: the fragment reads the same EventStore queries the current `/dashboard` handler already issues.
- Phase-1 scope explicitly excludes filters, detail routes, expand interaction, polling, and live updates (those are later phases).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `dashboard-list-view`: the current spec assumes a single synchronous page that "contains rows". This change re-requires the list to be delivered via a distinct endpoint behind a loading state, adds scenarios for status-as-colored-label, stable DOM identity, empty state, and reduced-motion behavior.

## Impact

- **Code**
  - `packages/runtime/src/ui/dashboard/page.ts` — split renderer: `renderDashboardPage(user, email)` (shell + skeleton) and new `renderInvocationList(invocations)` (fragment body).
  - `packages/runtime/src/ui/dashboard/middleware.ts` — add a second route for the fragment; the shell route becomes data-free.
  - `packages/runtime/src/ui/static/workflow-engine.css` — add `.entry` / `.entry-header` / `.entry-meta` / `.entry.skeleton` rules; rename `.done` → `.succeeded`; remove unused `.invocations-table` / `.status-*`.
  - `packages/runtime/src/ui/dashboard/middleware.test.ts` — retarget data-presence assertions to `/dashboard/invocations`; add a shell test that only asserts loading state.
  - `packages/runtime/src/ui/html-invariants.test.ts` — update the CSP-invariant call site for the new signature and cover both the shell and the list renderer.
- **APIs**: new public route `GET /dashboard/invocations` (behind the same `githubAuthMiddleware` as `/dashboard`). No event-bus, sandbox, or manifest changes.
- **Dependencies**: none added. HTMX and Alpine are already served by `static/middleware.ts`; no new libraries.
- **Security**: no change to the CSP, auth, or sandbox boundary. The new route is under `/dashboard/*` so existing oauth2-proxy forward-auth + `githubAuthMiddleware` already cover it. Markup remains CSP-strict (no inline `<script>`, `on*=`, `style=`) — verified by `html-invariants.test.ts`.
