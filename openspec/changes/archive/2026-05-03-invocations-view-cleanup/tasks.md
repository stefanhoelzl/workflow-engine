## 1. Capability rename — directory + identifier moves

- [x] 1.1 Move `packages/runtime/src/ui/dashboard/` → `packages/runtime/src/ui/invocations/` (preserve git history via `git mv`); rename `page.tsx`, `middleware.tsx`, `flamegraph.tsx`, `flamegraph.test.ts`, `middleware.test.ts` in place.
- [x] 1.2 Rename identifiers across the moved files: `DashboardPage` → `InvocationsPage`, `DashboardPageOptions` → `InvocationsPageOptions`, `DashboardFilter` → `InvocationsFilter`, `DashboardMiddlewareDeps` → `InvocationsMiddlewareDeps`, `dashboardMiddleware` → `invocationsMiddleware`, `renderDashboardPage` → `renderInvocationsPage`. Update the type re-exports.
- [x] 1.3 Update the Hono basePath in `invocationsMiddleware`: `new Hono().basePath("/dashboard")` → `new Hono().basePath("/invocations")`. Update the `match` string in the returned `Middleware`: `/dashboard/*` → `/invocations/*`.
- [x] 1.4 Update the flamegraph URL template in `invocations/page.tsx` (`Card`): `/dashboard/${row.owner}/${row.repo}/invocations/${row.id}/flamegraph` → `/invocations/${row.owner}/${row.repo}/${row.id}/flamegraph`. Update the matching server route in `invocations/middleware.tsx` to `/:owner/:repo/:id/flamegraph` (relative to the `/invocations` basePath).
- [x] 1.5 Update `packages/runtime/src/main.ts` — rename the import from `./ui/dashboard/middleware.js` → `./ui/invocations/middleware.js`, update the call from `dashboardMiddleware(...)` → `invocationsMiddleware(...)`, and update any comment referring to `/dashboard/*`.
- [x] 1.6 Update `packages/runtime/src/ui/sidebar-tree.tsx` — `Surface` union member `"/dashboard"` → `"/invocations"`; every URL constructor that targets the dashboard surface.
- [x] 1.7 Update `packages/runtime/src/ui/tabs.tsx` — `Surface` union and `SURFACES` table entry `{ surface: "/dashboard", label: "Dashboard" }` → `{ surface: "/invocations", label: "Invocations" }`. Update every callsite passing `surface="/dashboard"` to pass `surface="/invocations"`.
- [x] 1.8 Update `packages/runtime/src/ui/error-pages.tsx` — replace `linkHref="/dashboard/"` with `linkHref="/invocations/"` and the link label `"Go to dashboard"` → `"Go to invocations"`.
- [x] 1.9 Update `<title>` and any `activePath` strings: `Layout` instantiation in `invocations/page.tsx` uses `title="Invocations"` and `activePath="/invocations"`.
- [x] 1.10 Run `grep -rn '/dashboard\|dashboardMiddleware\|DashboardPage\|DashboardFilter\|DashboardMiddlewareDeps\|renderDashboardPage' packages/ workflows/ infrastructure/ docs/` and address every hit. Document any intentional remaining hits in `tasks.md` cleanup notes.

## 2. Visual cleanup — sticky bar removal

- [x] 2.1 Delete the `<div class="page-header">…</div>` block (breadcrumb + h1) from `InvocationsPage` in `invocations/page.tsx`.
- [x] 2.2 Delete the `ScopeLabel` component if it has no remaining callers after task 2.1.
- [x] 2.3 Delete the `.page-header`, `.page-header h1`, `.breadcrumb`, `.breadcrumb-sep`, `.breadcrumb-current` CSS rules from `packages/runtime/src/ui/static/workflow-engine.css` (and any matching dark-mode overrides). Verify no other surface uses these classes.
- [x] 2.4 Delete the `.page-tabs-slot ~ .main-content { margin-top: calc(...) }` adjustment if it depends on `.page-header` height; re-verify the `.main-content { margin-top: var(--topbar-height) }` computation accounts for the fixed tabbar alone.

## 3. Visual cleanup — upload row contract

- [x] 3.1 In `packages/runtime/src/ui/icons.tsx`: add `"upload"` to `kindGlyph` returning the existing upload-arrow shape (the same SVG path currently in `UploadIcon` in `dashboard/page.tsx`). Export the new kind.
- [x] 3.2 In `packages/runtime/src/ui/static/workflow-engine.css`: add a rule `.trigger-kind-icon--upload { color: var(--accent); }` near the existing `.trigger-kind-icon--*` rules.
- [x] 3.3 In `invocations/middleware.tsx` `buildUploadRow`: set `triggerKind: "upload"` on the returned `InvocationRow`.
- [x] 3.4 In `invocations/page.tsx` `CardSummary`: remove the `<SyntheticGlyph>` rendering for `system.upload` rows (the leading kind-icon now covers it). Keep `SyntheticGlyph` for `trigger.exception` and `trigger.rejection`. Delete the `UploadIcon` component from the file (now unused) and the `entry-upload` span branch in `SyntheticGlyph`.
- [x] 3.5 In `invocations/page.tsx` `CardSummary`: skip rendering the status `<span class={badge ${row.status}}>` for `system.upload` rows (no `UPLOADED` text). Other statuses unchanged.
- [x] 3.6 In `invocations/page.tsx` `DispatchChip`: render uppercase `UPLOAD` (not `upload`) when `dispatch.source === "upload"`. The chip's `<title>` continues to carry `login <mail>`.
- [x] 3.7 In `workflow-engine.css`: add a rule that pushes the dispatch chip to the far right on upload rows (e.g. `.entry-header .entry-dispatch-upload { margin-left: auto; }`) — apply by giving the dispatch chip an extra class on upload rows in `DispatchChip`. Verify that on non-upload rows the chip still sits between the identity block and the status badge.
- [x] 3.8 Update the `entry-upload-shaShort` `<title>` placement: now attached to the leading `TriggerKindIcon` for upload rows (carrier was the right-side glyph). Wire `triggerKind="upload"` paired with the existing `uploadShaShort` field through to the icon's `<title>`.

## 4. Sort fix

- [x] 4.1 In `invocations/page.tsx` `sortInvocationRows`: change the terminal-row comparator from `(b.completedTs ?? 0) - (a.completedTs ?? 0)` to `b.startedTs - a.startedTs`. Pending-row branch is unchanged.
- [x] 4.2 In `InvocationList` list-header: change the subtitle text `"pending first, then newest-completed"` → `"pending first, then newest-started"`.

## 5. Tests + spec validation

- [x] 5.1 Rename `packages/runtime/src/ui/dashboard/middleware.test.ts` → `packages/runtime/src/ui/invocations/middleware.test.ts`. Update every URL literal `/dashboard/...` → `/invocations/...`. Update fixture imports / route mounts.
- [x] 5.2 Rename / update `dashboard/flamegraph.test.ts` → `invocations/flamegraph.test.ts`; update any URL literals.
- [x] 5.3 Update `packages/runtime/src/ui/tabs.test.tsx`: every `surface="/dashboard"` → `surface="/invocations"`, every `Dashboard` label expectation → `Invocations`.
- [x] 5.4 Update `packages/runtime/src/ui/html-invariants.test.ts`: replace `/dashboard` route fixtures with `/invocations`.
- [x] 5.5 Update `packages/runtime/src/ui/static/middleware.test.ts` referer/route fixtures.
- [x] 5.6 Sweep all package `*.test.ts(x)` files for `/dashboard` and update.
- [x] 5.7 Add a unit test for `sortInvocationRows`: terminal rows `A(startedTs=100, completedTs=200)` and `B(startedTs=150, completedTs=160)` SHALL produce `[B, A]` (B first because newer started).
- [x] 5.8 Add a unit test for the upload row contract: a synthetic `system.upload` row renders with (a) leading icon class `trigger-kind-icon--upload`, (b) right-side `<span class="entry-dispatch …">UPLOAD</span>`, (c) NO `<span class="badge uploaded">`, (d) NO right-side `<span class="entry-upload">`.
- [x] 5.9 Add a unit test asserting the invocations page does NOT render any element with class `page-header` or any `<h1>` with text `Dashboard`/`Invocations`.

## 6. Spec sync (other capabilities)

- [x] 6.1 Update `openspec/specs/auth/spec.md` illustrative `returnTo=/dashboard` and `Location: /dashboard` examples in the local-provider and github-signin scenarios to use `/invocations`. Authorial cleanup, not behavioral change.
- [x] 6.2 Update `openspec/specs/sandbox-stdlib/spec.md` cross-reference `(see dashboard-list-view)` → `(see invocations-list-view)`.
- [x] 6.3 Verify no other spec references `dashboard-list-view` or `/dashboard/` after the change is archived. `grep -rn 'dashboard-list-view\|/dashboard' openspec/specs/` SHALL return zero hits (post-archive).

## 7. Validation gates

- [x] 7.1 `pnpm lint` passes.
- [x] 7.2 `pnpm check` passes (TypeScript strict).
- [x] 7.3 `pnpm test` passes (unit + integration).
- [x] 7.4 `pnpm test:e2e` passes — required because the URL prefix change is exactly the surface e2e covers.
- [x] 7.5 `pnpm exec openspec validate invocations-view-cleanup --strict` passes.
- [x] 7.6 Dev probe: `pnpm dev --random-port --kill` boots; grep stdout for `[READY] Dev server listening on http://localhost:<port>`; `curl -sI http://localhost:<port>/dashboard` returns `404` (route gone); `curl -sI http://localhost:<port>/invocations` returns 302 to `/login` (sessionMw kicks in); after auth-fixture login, `curl -s http://localhost:<port>/invocations` returns the page shell with no `class="page-header"` hit and the `Invocations` tab in the active state.
- [x] 7.7 Dev probe (visual): expand the demo upload row in the browser; confirm the leading icon is the upload-arrow in accent colour, the right-side chip reads `UPLOAD` and is at the far right, no `UPLOADED` status badge is present. Confirm cron rows now sort with the most-recently-started row on top.
