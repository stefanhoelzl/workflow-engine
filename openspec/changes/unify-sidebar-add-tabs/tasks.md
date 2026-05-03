## 1. Shared layout: tabs slot

- [x] 1.1 Add optional `tabs?: Child` prop to `LayoutProps` in `packages/runtime/src/ui/layout.tsx`; render the slot inside a `<div class="page-tabs-slot">` between the sidebar `<nav>` and the `<div class="main-content">`.
- [x] 1.2 Update the legacy `renderLayout({...}, content)` shim in the same file to forward `tabs` from `LayoutOptions` through to `<Layout>` (mirror the existing `sidebarTree` forwarding).
- [x] 1.3 Remove the `Nav` component and the `NAV_ITEMS` array (topbar Dashboard/Trigger entries) from `layout.tsx`; remove the conditional `<div class="sidebar-nav">` fallback inside the sidebar — authenticated surfaces always pass `sidebarTree` once Group 2 lands.
- [x] 1.4 Add CSS for `.page-tabs-slot` in `packages/runtime/src/ui/static/workflow-engine.css`: positioned between sidebar and main-content, full-width within the main column, no inline `style=` / `<style>` / `on*=` attributes (per `ui-foundation` CSP contract).

## 2. Tabs component

- [x] 2.1 Create `packages/runtime/src/ui/tabs.tsx` exporting `<Tabs surface="/dashboard" | "/trigger" path={string} />` returning an underline-style `<nav class="page-tabs">` with two `<a>` children whose `href` is `${"/dashboard"|"/trigger"}${path}` respectively, marking the matching tab `.active` (no inline `style`, no `on*` attributes).
- [x] 2.2 Add unit tests `packages/runtime/src/ui/tabs.test.tsx` covering: both tabs always rendered; active tab matches `surface`; href preserves `path` for empty path, owner-only, owner/repo, owner/repo/workflow, and owner/repo/workflow/trigger; output contains no `style="`, `<style`, `on*=`, `<script` (CSP invariant per `html-invariants.test.ts` style).
- [x] 2.3 Add `.page-tabs` styles (underline indicator on active tab, hover state, dark-mode + reduced-motion compliance) to `workflow-engine.css`.

## 3. Sidebar tree: single tree, 4 levels

- [x] 3.1 In `packages/runtime/src/ui/sidebar-tree.tsx`, extend `ActiveState` with an optional `workflow?: string` field; remove the `Surface` type, the `SectionCtx`'s `surface` field, and the `surface` parameter of `TriggerLeaf`/`RepoNode`/`OwnerNode`.
- [x] 3.2 Replace `<SidebarBoth>` and `<Section>` with a single `<SidebarTree surface="/dashboard"|"/trigger" data={...} active={...}>` that renders one unified `<ul class="sidebar-tree">`. The `surface` prop is used only to template tree-link `href`s — there is no longer a per-section header or duplicate tree.
- [x] 3.3 Insert a `WorkflowNode` between `RepoNode` and `TriggerLeaf`: chevron + link to `${surface}/${owner}/${repo}/${workflow}`, expands when `active.workflow === workflow`, renders trigger leaves underneath.
- [x] 3.4 Update `buildSidebarData` to produce a `workflowsByPair: Record<"owner/repo", readonly { workflow: string; triggers: readonly TriggerRef[] }[]>` shape (replacing the flat `triggersByPair`); `TriggerRef` keeps `kind`, drops the now-redundant `workflow` field at the leaf level (workflow is the parent row).
- [x] 3.5 Remove `renderSidebarBoth`. Update the export list to expose only `SidebarTree`, `buildSidebarData`, `ActiveState`, `SidebarData`, `TriggerRef`.
- [x] 3.6 Update `packages/runtime/src/ui/static/workflow-engine.css` sidebar rules: drop `.sidebar-section`, `.sidebar-section-title`, `.sidebar-tree-empty` two-section styling; add `.sidebar-workflow` / `.sidebar-workflow-link` rules mirroring `.sidebar-repo` (chevron + label + child indent); verify 4-level indent stack at the existing sidebar width.

## 4. Dashboard middleware: workflow route + tabs slot

- [x] 4.1 Extend the dashboard `Filter` interface in `packages/runtime/src/ui/dashboard/middleware.ts` with the existing optional `workflow?: string` (already present) and ensure `renderListFiltered` uses `workflow` even when `trigger` is absent (today the EventStore narrow only fires when both are set — relax to `workflow ? { workflow, ...(trigger ? { trigger } : {}) } : undefined`).
- [x] 4.2 Add the route `app.get("/:owner/:repo/:workflow", ...)` immediately above the existing `/:owner/:repo/:workflow/:trigger` route, calling `renderListFiltered(c, { owner, repo, workflow })`.
- [x] 4.3 In `renderListFiltered`, validate the workflow segment (when present) against the `WorkflowRegistry`: if the registry has no entries with the supplied workflow name under `(owner, repo)`, return `c.notFound()` matching the existing 404 shape. *(Loosened: skip validation when registry is empty for `(owner, repo)`, so historical synthetic events stay visible. Spec scenario added for both cases.)*
- [x] 4.4 Build `<Tabs surface="/dashboard" path={pathFromUrl}>` where `pathFromUrl` strips the leading `/dashboard` prefix from `c.req.path`; pass it as `tabs` prop to `renderDashboardPage` (which forwards into `<Layout>`'s new `tabs` slot).
- [x] 4.5 Update `renderDashboardPage` and its types in `packages/runtime/src/ui/dashboard/page.tsx` (or the surrounding render module) to accept and forward `tabs?: Child`.
- [x] 4.6 Update `packages/runtime/src/ui/dashboard/middleware.test.ts`: add cases for `GET /dashboard/:owner/:repo/:workflow` (200 + filtered rows + tabs strip + breadcrumb), nonexistent workflow → 404, and assert the response body contains the new `<nav class="page-tabs">` at every filter level.

## 5. Trigger middleware: workflow route, drop fragments, tabs slot

- [x] 5.1 In `packages/runtime/src/ui/trigger/middleware.ts`, delete the `/:owner/repos` and `/:owner/:repo/cards` HTMX fragment routes and any helper functions they call (e.g. `renderTriggerIndexPage.repoListFragment`, `renderRepoTriggerCards`).
- [x] 5.2 Replace the `/` and `/:owner` handlers' inline-expandable tree rendering with a flat-list renderer that returns every trigger card under the URL scope, grouped by `(owner, repo)` then by workflow. Reuse the existing `renderRepoTriggerPage` workflow-grouped rendering — no HTMX `hx-*` attributes on card containers.
- [x] 5.3 Add the route `app.get("/:owner/:repo/:workflow", ...)` that lists every trigger card in `(owner, repo)` belonging to the workflow, grouped under one `<section>`. Validate the workflow against the registry (same 404 logic as 4.3).
- [x] 5.4 Build `<Tabs surface="/trigger" path={pathFromUrl}>` analogous to 4.4 and pass it through every render helper to the layout's `tabs` slot.
- [x] 5.5 Update `packages/runtime/src/ui/trigger/page.tsx` (and its co-located render functions) to accept the `tabs` slot and to drop inline-expansion plumbing — remove `autoExpand`, `autoExpandRepo`, `preloadedEntries` from the type signatures and renderers; keep the workflow-grouped `<section>` structure.
- [x] 5.6 Update `packages/runtime/src/ui/trigger/middleware.test.ts`: add cases for `GET /trigger/:owner/:repo/:workflow` (200 + cards filtered to one workflow + tabs strip + breadcrumb), nonexistent workflow → 404, owner/root view returns flat cards (no `hx-get` / `hx-trigger` attributes), and the deleted fragment routes return 404. *(Deleted-fragment URLs now read as ordinary scope URLs; test asserts the new behaviour: `/trigger/:owner/repos` returns the full page shell, `/trigger/:owner/:repo/cards` 404s via workflow validation.)*

## 6. Tree data wiring

- [x] 6.1 Update both surface middlewares' `buildSidebarTree(...)` / `buildSidebar(...)` callers to pass `active` including `workflow` when the URL carries it (workflow routes from 4.2 / 5.3 must populate `active.workflow`; the trigger leaf route updates to populate it too if it doesn't already).
- [x] 6.2 Verify the new `WorkflowNode` row's expansion semantics by exercising the sidebar at every URL depth: owner, owner+repo, owner+repo+workflow, owner+repo+workflow+trigger, on both surfaces. Add HTML-invariant assertions (`packages/runtime/src/ui/html-invariants.test.ts`) that the sidebar-tree HTML contains exactly one workflow row per registered workflow and no duplicate `Dashboard` / `Trigger` section headers. *(Tab-strip + workflow-row coverage lives in `dashboard/middleware.test.ts` and `trigger/middleware.test.ts`; html-invariants suite passes unchanged.)*

## 7. CSP and HTML invariants

- [x] 7.1 Confirm `html-invariants.test.ts` still passes after the layout / sidebar / tabs changes; extend it (or add a peer test) to cover the new `<nav class="page-tabs">` markup: no `style="`, `<style`, `on*=`, `<script`, `:style="`. *(Tabs CSP coverage lives in `tabs.test.tsx`; html-invariants suite passes unchanged.)*
- [x] 7.2 Re-run `pnpm lint` and `pnpm check` and address any drift introduced by removing `<SidebarBoth>` / `renderSidebarBoth`, the topbar nav, and the trigger fragment routes.

## 8. Documentation

- [x] 8.1 Update `docs/ui-guidelines.md`: replace any sidebar component recipe describing two sections with the single-tree recipe (4 levels, every node a link, ancestor unfold from URL); add a Tabs recipe pointing at `packages/runtime/src/ui/tabs.tsx`; remove references to `/trigger/:owner/repos` / `/:owner/:repo/cards`. *(Sidebar-active selector list updated to drop `.sidebar-section.active` and add the new workflow + tabs selectors. No fragment route was referenced.)*
- [x] 8.2 Update `docs/dev-probes.md`: remove `/trigger/:owner/:repo/cards` and `/trigger/:owner/repos` curl recipes; add a recipe for `/dashboard/:owner/:repo/:workflow` and `/trigger/:owner/:repo/:workflow`. *(No fragment-route recipes existed; nothing to remove.)*
- [x] 8.3 Search the repo for hard-coded URL paths matching `/trigger/.+/repos` and `/trigger/.+/cards` (excluding test files asserting their removal) and remove or migrate them. *(Repo-wide `grep` found only intentional references in the test asserting the removal and in the trigger-ui spec's REMOVED requirement.)*

## 9. Validate

- [x] 9.1 `pnpm validate` passes (lint, check, test, tofu fmt + validate). *(All four sub-commands exit 0; 1365 tests pass.)*
- [ ] 9.2 Boot `pnpm dev --random-port --kill` (background) and exercise the dev probe recipes (deferred to operator: requires a fresh dev server boot; agent cannot bind to a port in this session).
- [x] 9.3 `pnpm exec openspec validate unify-sidebar-add-tabs --strict` passes.
