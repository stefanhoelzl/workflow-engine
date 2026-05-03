## Context

Two authenticated UI surfaces — `/dashboard/*` and `/trigger/*` — render the same `owner → repo → trigger` hierarchy. Today the sidebar shows that hierarchy twice (once per surface) and the trigger surface re-renders the same hierarchy a third time as inline-expandable HTMX rows in the main view. Surface choice is a view concern but is currently expressed as navigation: users pick the surface in the topbar / sidebar before they pick the resource.

The hierarchy also has a hidden level: triggers are addressed by `/<owner>/<repo>/<workflow>/<trigger>` but the workflow segment has no row in the tree and no scope page. Two triggers from different workflows under the same repo appear as flat siblings.

This change collapses the duplication and surfaces the workflow level. It is a pure UI/routing rework — no sandbox boundary, no event pipeline, no manifest format change.

Constraints in scope:
- `/dashboard/*` and `/trigger/*` URL prefixes stay (alternative root layouts collide with reserved top-level mounts: `/webhooks`, `/auth`, `/api`, `/static`, `/login`, `/logout`).
- Owner-name regex and `isMember(user, owner)` enumeration-safe 404 contract (`SECURITY.md` §4) is preserved across the new workflow-scoped routes.
- CSP/HSTS/Permissions-Policy contracts (`ui-foundation`) — the new tab markup must bind via `data-*` hooks, no inline `<script>`/`<style>`/`on*=`.

## Goals / Non-Goals

**Goals:**

- One sidebar tree, shared by both surfaces, deriving expansion state purely from the active URL.
- Workflow appears as an intermediate tree level and gains a navigable scope page on both surfaces.
- Surface choice (Dashboard vs Trigger) becomes an in-page tab control sitting between the sidebar and main content.
- Tab click is a pure URL-prefix swap that preserves the rest of the path, so lateral switching between Dashboard ↔ Trigger never loses the user's selected scope.
- Removing the trigger main-view inline tree eliminates the third duplicated navigator and the HTMX fragments that backed it.

**Non-Goals:**

- No URL migration path / redirect layer for the removed HTMX fragments. They were internal endpoints, not documented user URLs.
- No sticky "remember last surface" cookie. A bare URL always defaults to `/dashboard/*` (the user picked `Dashboard` as the canonical default; tabs preserve the choice on lateral navigation but not across cold-start visits).
- No design for workflow-with-zero-triggers empty state. That invariant is fixed in a separate change; this proposal assumes every registered workflow has ≥1 trigger.
- No pagination / virtualization for the new "all trigger cards in scope" main view at owner level. If card count grows large in practice, that is a follow-up.
- No change to the `POST /trigger/:owner/:repo/:workflow/:trigger` fire endpoint or its auth posture.

## Decisions

### D1. Keep `/dashboard/*` and `/trigger/*` URL prefixes; do not move owner to root

Considered:
- **Path-segment tab** (`/<owner>/<repo>/dashboard`): collides with reserved repo / workflow / trigger names; needs a per-level denylist.
- **GitLab-style `/-/` sentinel** (`/<owner>/-/dashboard`): collision-free under a known prefix, but does nothing for the *root-level* collision between an owner segment and `/webhooks`, `/auth`, `/api`, `/static`, `/login`, `/logout` mounts.
- **Query param** (`?tab=dashboard`): demotes tab to view state; bookmarks point at the bare URL whose tab is determined by client logic — fragile.
- **Keep `/dashboard/*` and `/trigger/*` (chosen)**: zero name reservations, zero migration, smallest blast radius. Tab click is a literal prefix swap.

The sentinel pattern would only become attractive if owner content moved under `/r/<owner>` or similar — a significantly larger change with no benefit for this rework's goal.

### D2. Tabs are an optional `tabs?: Child` slot on `<Layout>`, filled by middleware render helpers

Considered:
- **Inline `<nav class="page-tabs">` per page.tsx**: duplicates the markup we are trying to deduplicate; drift risk identical to today's two-tree problem.
- **Tabs inside `children`**: middleware does `<Layout …><><Tabs/>{body}</></Layout>`. Works but couples body composition to chrome and gives tabs no stable CSS anchor between sidebar and main-content (they'd live inside the scrolling region).
- **Tabs as a Layout slot (chosen)**: mirrors the existing `sidebarTree?: Child` slot. Layout stays surface-agnostic — it sees only an opaque `Child` and renders it in a fixed location. Surfaces own composition; CSS anchors `.page-tabs` between `.sidebar` and `.main-content`. Pages stay tab-unaware.

### D3. `<Tabs>` is a new shared module under `packages/runtime/src/ui/tabs.tsx`

Mirrors `sidebar-tree.tsx`: small JSX module exporting one component, consumed by both surface middlewares. Signature:

```
<Tabs surface="/dashboard" | "/trigger" path={pathAfterPrefix} />
```

The `path` argument is the URL minus the surface prefix (e.g. `/acme/foo/deploy`); the component emits two `<a>` elements with `href` = `${otherSurface}${path}` and `${currentSurface}${path}` respectively, marking the current surface active. Lateral tab swap therefore preserves owner/repo/workflow/trigger context byconstruction — there is no lookup table or fallback logic.

Edge cases:
- At the surface root (`/dashboard`, `/trigger`), `path === ""` and both tab hrefs are bare prefixes. Same logic, no special case.
- Tab links to `/dashboard/<owner>/<repo>/<workflow>/<trigger>` work because the new dashboard middleware route handles that depth (already does today).

### D4. Sidebar tree is a single 4-level tree; expansion derives from active URL

The tree component reads the active URL and unfolds ancestors. With 4 levels (owner → repo → workflow → trigger), three ancestors of a leaf URL must mark `.active`/`.open`. No new mechanism — the existing `ActiveState` shape gains a `workflow?` field; the existing `pairKey` triple-nested traversal extends to a quadruple-nested one.

Workflow row UX matches repo row: chevron + link, expands children when active. Skipping the workflow row when a repo has only one workflow was rejected: tree shape would become data-dependent and URL depth would no longer match tree depth.

### D5. Drop the trigger main-view inline-expandable tree; HTMX fragments deleted

`/trigger/:owner` today renders an inline-expandable owner→repo→cards tree with HTMX fragments at `/trigger/:owner/repos` and `/trigger/:owner/:repo/cards`. With the sidebar as the sole navigator, the inline tree is redundant and reintroduces the duplication this change removes.

The trigger main view becomes "all trigger cards under the current scope, flat" at every level:
- `/trigger` → all cards across all owners the user belongs to
- `/trigger/:owner` → all cards across owner's repos
- `/trigger/:owner/:repo` → all cards across repo's workflows
- `/trigger/:owner/:repo/:workflow` → all cards in workflow
- `/trigger/:owner/:repo/:workflow/:trigger` → single card (unchanged)

HTMX fragment routes are removed. No deprecation window: they are internal endpoints, never linked to from outside the trigger main view.

### D6. Default surface is `/dashboard`; lateral navigation preserves current tab; cold-start does not

Cold-start (e.g. user types `/` or hits the root) lands on `/dashboard`. There is no `lastTab` cookie. Lateral navigation (clicking a tree node while on `/dashboard/...`) keeps the user on `/dashboard/...` because the sidebar tree is rendered with surface-aware hrefs (the surface segment is just templated in). Tab clicks switch surface explicitly and preserve the rest of the path (D3).

This was a deliberate simplification over a sticky-cookie design. The cost is small (a returning user who last used `/trigger` lands back on `/dashboard` after closing the tab) and the benefit is no client-state surface and no Set-Cookie on every page render.

### D7. Nonexistent workflow → 404, identical to existing repo-level 404

The new `:workflow` routes resolve via `WorkflowRegistry.list(owner, repo)` filtered to the workflow name. Empty result yields 404, consistent with the owner/repo enumeration-safety contract. The membership check (`requireOwnerMember`) is unchanged — it gates on owner regardless of segment depth. Explicit scenarios in `dashboard-list-view` and `trigger-ui` make the workflow 404 contract impossible to miss in review (chosen over relying on the umbrella enumeration-safety requirement).

### D8. Topbar `Dashboard` / `Trigger` nav items removed; brand wordmark + user identity remain

Today `layout.tsx` renders a `<Nav>` block in the sidebar (Dashboard/Trigger entries) when `sidebarTree` is unset, and `ui-foundation`'s topbar contract owns brand + user identity + sign-out. With unified sidebar rendered on every authenticated surface, the conditional nav block is dead code on authenticated paths. Login and error pages don't render the nav today either, so removing `<Nav>` is a strict deletion — no replacement.

The topbar contract in `ui-foundation` is unchanged: it never owned the Dashboard/Trigger links (they lived in `shared-layout`'s sidebar nav block). No `ui-foundation` delta is required.

## Risks / Trade-offs

- **Risk**: Existing cross-references to the trigger inline-expansion UX (e.g. screenshots in `docs/ui-guidelines.md`, dev-probe recipes, or third-party documentation) silently rot. → **Mitigation**: Touch `docs/ui-guidelines.md` and `docs/dev-probes.md` as part of this change; surface in the PR summary that `/trigger/:owner/repos` and `/trigger/:owner/:repo/cards` are gone.
- **Risk**: The new "all cards in scope" main view at `/trigger/:owner` could render hundreds of cards eagerly for organisations with many workflows, degrading first-paint. → **Mitigation**: Acceptable for the current size of deployments (single-digit workflows per owner in known tenants); acknowledged as out of scope; pagination/grouping is a follow-up if it becomes a problem.
- **Risk**: Sidebar 4-level indent is cramped at the current ~240px width; deep names truncate. → **Mitigation**: CSS pass during implementation. If truncation becomes severe, sidebar width is a tunable in `workflow-engine.css` (separate change if needed); does not block this rework.
- **Risk**: The 3 stacked `.active`/`.open` indicators (owner, repo, workflow ancestors of a trigger leaf) could look noisy. → **Mitigation**: Use existing `.active`/`.open` styling unchanged at first; visual polish during implementation if it reads poorly. Spec doesn't constrain visual treatment — implementation detail.
- **Trade-off**: No sticky "last surface" memory means tab choice is not preserved across browser sessions. Accepted for state-surface simplicity (D6). Easy to add later as a cookie if user feedback demands it.
- **Trade-off**: Removing HTMX fragments without a deprecation window. Accepted because they were internal endpoints; no documented or external consumers.
