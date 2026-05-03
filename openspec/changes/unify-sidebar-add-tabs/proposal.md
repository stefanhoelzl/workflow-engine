## Why

The sidebar currently renders the `owner → repo → trigger` tree twice — once under a "Dashboard" section and once under a "Trigger" section — so users navigate the same hierarchy twice for the same scope. Picking the surface (Dashboard vs Trigger) is a view choice, not a navigation choice, and it belongs in the main view next to the content it switches.

The trigger surface compounds the duplication: its main view re-implements the tree as inline-expandable HTMX rows, so the same hierarchy exists in **three** places (sidebar Dashboard section, sidebar Trigger section, trigger main view). Consolidating to one navigator with in-page tabs removes that drift surface and makes room for a missing intermediate level — workflow — which today is folded into the trigger leaf URL but has no row of its own.

## What Changes

- **BREAKING (UI surface)**: Sidebar renders one unified tree, not two. The `Dashboard` and `Trigger` section headers and their separate per-surface trees are removed.
- **BREAKING (UI surface)**: Topbar `Dashboard` / `Trigger` nav items are removed. Surface choice is made via in-page tabs, not the topbar.
- **BREAKING (UI surface)**: The trigger main view no longer renders an inline-expandable tree of repos/cards. The sidebar tree is the sole navigator; the main view shows flat content for the current scope.
- Sidebar tree gains a workflow level: `owner → repo → workflow → trigger` (was 3 levels). Every node — owner, repo, workflow, trigger — is a real link to its scope page.
- Add Dashboard | Trigger tabs at the top of every authenticated main view (top-level, owner, repo, workflow, trigger leaf). Tab click swaps URL prefix (`/dashboard ↔ /trigger`) preserving the rest of the path.
- Add new routes `GET /dashboard/:owner/:repo/:workflow` and `GET /trigger/:owner/:repo/:workflow` rendering scope-filtered content for a single workflow.
- Nonexistent workflow segment returns 404, consistent with existing owner/repo enumeration-safe 404 behaviour.
- **REMOVED**: HTMX fragment endpoints `GET /trigger/:owner/repos` and `GET /trigger/:owner/:repo/cards` (the inline-expansion UX they backed is gone).
- `Layout` gains an optional `tabs?: Child` slot rendered between the sidebar and main content, mirroring the existing `sidebarTree?` slot pattern. The shared `<Tabs>` component lives in `packages/runtime/src/ui/tabs.tsx` and is filled by each surface middleware's render helper.

## Capabilities

### New Capabilities

(none — this change reshapes existing surfaces rather than introducing a new capability)

### Modified Capabilities

- `shared-layout`: sidebar requirement is rewritten — single unified tree (no Dashboard/Trigger split), 4 levels deep (owner → repo → workflow → trigger), every node a real link, ancestor-unfold from active URL regardless of surface. Layout API gains `tabs?` slot.
- `dashboard-list-view`: adds workflow-scoped route `/dashboard/:owner/:repo/:workflow`, adds in-page Dashboard|Trigger tab requirement, adds nonexistent-workflow 404 scenario.
- `trigger-ui`: adds workflow-scoped route `/trigger/:owner/:repo/:workflow`, adds in-page tab requirement, adds nonexistent-workflow 404 scenario, removes inline-expansion + HTMX-fragment requirements (`/:owner/repos`, `/:owner/:repo/cards`) since the sidebar tree replaces that navigator.

## Impact

- **Code**:
  - `packages/runtime/src/ui/sidebar-tree.tsx` — drop the two-section `<SidebarBoth>`, render single `<SidebarTree>` with workflow rows.
  - `packages/runtime/src/ui/layout.tsx` — add `tabs?: Child` prop and slot markup; remove `Nav` (topbar Dashboard/Trigger items).
  - `packages/runtime/src/ui/tabs.tsx` — **new** shared component (`<Tabs surface="/dashboard"|"/trigger" path={…} />`).
  - `packages/runtime/src/ui/dashboard/middleware.ts` — add `:workflow` route, build `<Tabs>` in `renderListFiltered`, pass to layout.
  - `packages/runtime/src/ui/dashboard/page.tsx` — accept `tabs` slot from middleware.
  - `packages/runtime/src/ui/trigger/middleware.ts` — add `:workflow` route, remove `/:owner/repos` + `/:owner/:repo/cards` fragment routes, build `<Tabs>` and pass to layout, remove inline-expansion data plumbing from `renderTriggerIndexPage` callers.
  - `packages/runtime/src/ui/trigger/page.tsx` — drop inline-expandable tree markup; render flat scope content + `<Tabs>` slot.
  - `packages/runtime/src/ui/static/workflow-engine.css` — tab styles, sidebar 4-level indent, drop two-section rules and inline-expansion rules.
  - Tests: `dashboard/middleware.test.ts`, `trigger/middleware.test.ts`, `html-invariants.test.ts` updated; new `tabs.test.tsx` (or co-located).
- **Routes**: `GET /dashboard/:owner/:repo/:workflow` and `GET /trigger/:owner/:repo/:workflow` are new. `GET /trigger/:owner/repos` and `GET /trigger/:owner/:repo/cards` are deleted.
- **Security**: New `:workflow` routes inherit `requireOwnerMember` middleware and the existing isMember-fail-closed 404 contract (`SECURITY.md` §4). No new auth surface.
- **Docs**: `docs/ui-guidelines.md` — refresh sidebar component recipe (single tree, 4 levels) and tabs recipe; `docs/dev-probes.md` — replace any `/trigger/:owner/:repo/cards` curl recipes.
- **Demos / external linkers**: `workflows/src/demo.ts` is unaffected (no URL coupling). External bookmarks under `/trigger/:owner/:repo/cards` will 404 — acceptable per "hard cut" decision; this is an internal HTMX endpoint, not a documented user URL.
- **`openspec/project.md`**: no changes (architecture text remains accurate; sidebar shape is spec-level, not project-level).
