## Why

The list view that operators land on after login is named "Dashboard" everywhere — URL, tab label, h1, identifier — even though the page is purely a flat list of invocations. The naming overstates what the view does and conflicts with how operators talk about it ("the invocations list"). Several smaller inconsistencies accreted in the same view: a sticky page header that duplicates context already carried by the sidebar and list-header; upload rows that lack the leading kind-icon every other row carries, while sporting a redundant `UPLOADED` status badge alongside an `upload` dispatch chip; and a sort key (`completedTs`) that disagrees with the timestamp displayed on each row (`startedAt`), producing visually-disordered lists. This change cleans them up in one pass.

## What Changes

- **BREAKING** Rename URL prefix `/dashboard/*` → `/invocations/*` (no redirect — internal-only app, hard cutover). The flamegraph fragment endpoint moves with it: `/dashboard/:owner/:repo/invocations/:id/flamegraph` → `/invocations/:owner/:repo/:id/flamegraph` (collapses the redundant `invocations` segment).
- Rename identifiers and file paths: `DashboardPage` → `InvocationsPage`, `dashboardMiddleware` → `invocationsMiddleware`, `DashboardFilter` → `InvocationsFilter`, `ui/dashboard/` → `ui/invocations/`, `<Tabs surface="/dashboard">` → `<Tabs surface="/invocations">`, sidebar surface key likewise. Tab label `"Dashboard"` → `"Invocations"`. `<title>` tag and error-page links updated.
- Remove the sticky page-header (breadcrumb + `Dashboard` h1) entirely from this view. The sidebar tree carries scope navigation; the list-header subtitle carries view identity.
- Upload-row visual cleanup:
  - Synthetic `system.upload` rows SHALL render a leading kind-icon (upload arrow) in the accent colour, in the same slot every other row uses for its `TriggerKindIcon`.
  - The dispatch chip's visible label for `dispatch.source === "upload"` becomes `UPLOAD` (uppercase) and is positioned at the far right of the row (replacing the status badge slot).
  - Drop the `UPLOADED` status badge for upload rows entirely — the leading icon plus the right-side `UPLOAD` chip already convey the kind and outcome unambiguously.
  - Drop the right-side synthetic `<UploadIcon>` glyph (replaced by the leading kind-icon).
- Sort terminal invocations by `startedTs` descending (was `completedTs` descending) so the visible timestamp on each row matches the sort key. Update the list-header subtitle from `"pending first, then newest-completed"` to `"pending first, then newest-started"`.

## Capabilities

### New Capabilities

- `invocations-list-view`: Authoritative spec for the invocations list page (formerly `dashboard-list-view`). Carries the renamed requirements plus the new behaviour: sticky-bar removal, upload-row visual contract, terminal sort by `startedTs`.

### Modified Capabilities

- `ui-foundation`: The cross-surface kind-icon registry gains an `upload` kind whose colour token is the accent colour, distinct from the trigger-kind palette. Tab strip surface enum changes `/dashboard` → `/invocations`.
- `trigger-ui`, `ui-errors`, `auth`, `http-security`, `shared-layout`, `invocations`: Any requirement that names the `/dashboard/*` URL prefix updates to `/invocations/*`. Where the old prefix appears only in prose (not in a normative SHALL), the rename is editorial.

### Removed Capabilities

- `dashboard-list-view`: Replaced wholesale by `invocations-list-view`. The old spec file is deleted; its requirements are carried forward (with the changes above) into the new capability.

## Impact

- **Routing**: `main.ts` mount point changes; `dashboardMiddleware` is renamed and re-exported under the new name. `apiAuthMiddleware` and `sessionMiddleware` matchers that scope to `/dashboard/*` update to `/invocations/*`.
- **Authn / CSP**: `secure-headers` allowlists, `sessionMiddleware` `match` strings, and any `apiAuthMiddleware` route prefixes referencing `/dashboard` move to `/invocations`. No security posture change — the rename is a string substitution at the path level.
- **Sidebar + tabs**: `sidebar-tree.tsx` `Surface` union and route-construction helpers; `tabs.tsx` `SURFACES` table and `surface` prop callsites.
- **Tests**: Every test that hits `/dashboard/...` (unit + integration + e2e) is updated. `html-invariants`, `tabs.test`, `dashboard/middleware.test`, `dashboard/page.test` (renamed), `error-pages` test, `static/middleware.test`. The `pnpm test:e2e` suite is exercised because route paths are part of its surface.
- **Specs**: `dashboard-list-view/spec.md` is deleted; `invocations-list-view/spec.md` is created via `## ADDED Requirements` with the carried-forward content. Cross-references in other specs (`trigger-ui`, `invocations`, `auth`, `ui-errors`, `shared-layout`, `http-security`) are updated via `## MODIFIED Requirements`.
- **CSS**: `.page-header` rule (sticky positioning + backdrop-filter) is deleted from `workflow-engine.css`. A new `.trigger-kind-icon--upload { color: var(--accent); }` rule is added. The `.entry-dispatch` selector grows a variant or rule that pushes the chip to `margin-left: auto` on upload rows.
- **No security boundary changes**. No sandbox surface changes. No EventStore / EventBus / persistence changes.
- **No demo.ts changes** — SDK surface is unaffected.
