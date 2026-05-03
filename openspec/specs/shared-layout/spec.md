# Shared Layout Specification

## Purpose

Provide a shared HTML layout with navigation sidebar reused across dashboard and trigger UI pages.
## Requirements
### Requirement: Shared layout API

Every authenticated UI surface (`/dashboard/*`, `/trigger/*`) SHALL render with four regions: a topbar (delegated to the universal topbar contract in `ui-foundation`), a navigation sidebar, an in-page tab strip that switches between Dashboard and Trigger surfaces, and a content area for the page-specific body. The runtime SHALL expose a single shared mechanism that authenticated route handlers use to compose these regions; surface-specific handlers SHALL NOT reimplement the shell layout.

The layout SHALL emit `<!DOCTYPE html>` ahead of `<html>` so browsers render the page in standards mode.

The shared mechanism SHALL accept the tab strip as an opaque slot (a child node), in the same way it accepts the sidebar tree as an opaque slot. The layout SHALL render the tab strip in a fixed location between the sidebar and the content area, so CSS can anchor the tabs to that region without inspecting their content. The layout SHALL NOT itself decide which surface is active — that is the caller's responsibility (the caller passes a pre-rendered tab strip with the active surface marked).

#### Scenario: Layout includes topbar, sidebar, tabs, and content area

- **WHEN** an authenticated UI surface is rendered (e.g. `/dashboard`, `/trigger`)
- **THEN** the response body SHALL contain a topbar element matching the `ui-foundation` universal topbar contract
- **AND** a sidebar element with the navigation tree
- **AND** an in-page tab strip switching between Dashboard and Trigger surfaces
- **AND** a content area carrying the page-specific body

#### Scenario: Layout emits DOCTYPE

- **WHEN** any authenticated UI surface is rendered
- **THEN** the response body SHALL begin with `<!DOCTYPE html>` followed by `<html lang="en">`

#### Scenario: Sidebar tree present on authenticated surfaces

- **WHEN** an authenticated UI surface is rendered for a user with at least one accessible owner
- **THEN** the sidebar SHALL contain a single owner→repo→workflow→trigger tree
- **AND** the layout SHALL NOT render any flat top-level nav-link list (no separate Dashboard/Trigger entry points in the sidebar or topbar)

### Requirement: Navigation sidebar

The layout SHALL include a sidebar that contains a single persistent `owner → repo → workflow → trigger` tree, shared by both the dashboard and trigger surfaces. The tree SHALL NOT be split into per-surface sections; the same tree markup is reused on every authenticated UI surface.

Every tree node — owner, repo, workflow, and trigger — SHALL be a real anchor link to that node's scope page. Expansion state SHALL be derived purely from the active URL: ancestors of the active route SHALL render with their children visible; siblings SHALL render collapsed. The current node SHALL render with a visible "active" state. There SHALL NOT be a client-side toggle for tree expansion.

Tree links SHALL preserve the surface segment of the active URL: when rendered under `/dashboard/*`, every tree link SHALL target `/dashboard/<scope>`; when rendered under `/trigger/*`, every tree link SHALL target `/trigger/<scope>`. Lateral navigation between tree nodes therefore keeps the user on their current surface; switching surface is the responsibility of the in-page tab strip, not the sidebar.

Trigger leaves SHALL display the trigger-kind indicator next to the trigger name; the hover tooltip SHALL include the owning workflow name plus the kind, per the `ui-foundation` cross-surface trigger-kind contract.

The sidebar SHALL NOT render any top-level Dashboard/Trigger section header, nav-link list, or surface-selector control. Surface choice is made via the in-page tab strip (see "In-page surface tabs"), not via sidebar navigation.

#### Scenario: Sidebar contains a single unified tree

- **WHEN** the layout is rendered on either `/dashboard/*` or `/trigger/*`
- **THEN** the sidebar contains exactly one `owner → repo → workflow → trigger` tree
- **AND** the sidebar contains no "Dashboard" or "Trigger" section header
- **AND** the sidebar contains no separate top-level nav-link list above or below the tree

#### Scenario: Tree links preserve current surface

- **GIVEN** a user on `/dashboard/acme/foo/deploy/run`
- **WHEN** the sidebar is rendered
- **THEN** every owner / repo / workflow / trigger link in the tree SHALL begin with `/dashboard/`
- **AND** clicking the `bar` repo under `acme` navigates to `/dashboard/acme/bar`, not `/trigger/acme/bar`

#### Scenario: Workflow row is a real link to its scope

- **GIVEN** repo `(acme, foo)` declares workflow `deploy` with triggers `run` and `rollback`
- **WHEN** the sidebar is rendered on `/dashboard/acme/foo`
- **THEN** the sidebar SHALL contain a `deploy` workflow row under the `foo` repo
- **AND** the `deploy` row SHALL be an anchor whose `href` is `/dashboard/acme/foo/deploy`

#### Scenario: Active ancestors unfold; siblings stay collapsed

- **GIVEN** the user is on `/dashboard/acme/foo/deploy/run`
- **WHEN** the sidebar is rendered
- **THEN** the `acme` owner node SHALL render with its children visible
- **AND** the `foo` repo node under it SHALL render with its workflow children visible
- **AND** the `deploy` workflow node under `foo` SHALL render with its trigger children visible
- **AND** sibling owners (e.g. `alice`) SHALL render collapsed
- **AND** sibling repos under `acme` (e.g. `bar`) SHALL render collapsed
- **AND** sibling workflows under `foo` (e.g. `build`) SHALL render collapsed

### Requirement: Application top bar

Authenticated UI surfaces SHALL render a topbar above the sidebar and main content area. The topbar's appearance and content (brand wordmark, conditional user identity, sign-out control) SHALL conform to the `ui-foundation` universal topbar contract. The topbar SHALL NOT contain Dashboard/Trigger surface-selector links — surface choice lives in the in-page tab strip rendered between the sidebar and main content.

#### Scenario: Authenticated topbar shows user identity

- **WHEN** an authenticated UI surface is rendered for a user with a valid session
- **THEN** the topbar matches the `ui-foundation` "Universal topbar" requirement (brand wordmark + username + email + sign-out control)
- **AND** the topbar SHALL NOT contain any link or button labelled "Dashboard" or "Trigger"

#### Scenario: Sign out link

- **WHEN** the user clicks the "Sign out" link in the topbar
- **THEN** the browser submits a POST to `/auth/logout`

### Requirement: In-page surface tabs

Every authenticated UI surface SHALL render an in-page tab strip between the sidebar and the main content area. The strip SHALL contain exactly two tabs — `Dashboard` and `Trigger` — corresponding to the `/dashboard/*` and `/trigger/*` URL prefixes. The tab matching the current URL prefix SHALL render in an "active" visual state; the other tab SHALL render in an inactive state.

Each tab SHALL be a real anchor whose `href` swaps the URL prefix while preserving the rest of the path. Given the current URL `/<surface>/<rest>` (where `<rest>` is everything after the surface segment, possibly empty), the Dashboard tab's `href` SHALL be `/dashboard/<rest>` and the Trigger tab's `href` SHALL be `/trigger/<rest>`. A tab click is therefore a pure surface swap that keeps the user's selected scope (owner / repo / workflow / trigger) intact.

The tab strip SHALL be a shared component used by both surfaces; surface-specific handlers SHALL NOT inline tab markup in their page content. The tab strip's visual treatment is implementation-defined (e.g. underline-style, segmented-control), with the constraint that the active tab is visually distinguishable from the inactive tab in a way that matches the `ui-foundation` reduced-motion and dark-mode contracts.

#### Scenario: Tabs render on every authenticated surface

- **WHEN** any authenticated UI surface is rendered (`/dashboard`, `/dashboard/<owner>`, `/dashboard/<owner>/<repo>`, `/dashboard/<owner>/<repo>/<workflow>`, `/dashboard/<owner>/<repo>/<workflow>/<trigger>`, and the symmetric `/trigger/*` paths)
- **THEN** the response body SHALL contain a tab strip with exactly two tabs labelled `Dashboard` and `Trigger`
- **AND** exactly one tab SHALL render in the active state

#### Scenario: Active tab matches URL prefix

- **GIVEN** the user is on `/trigger/acme/foo/deploy/run`
- **WHEN** the tab strip is rendered
- **THEN** the `Trigger` tab SHALL render in the active state
- **AND** the `Dashboard` tab SHALL render in the inactive state

#### Scenario: Tab click preserves scope, swaps prefix

- **GIVEN** the user is on `/dashboard/acme/foo/deploy/run`
- **WHEN** the tab strip is rendered
- **THEN** the `Trigger` tab's `href` SHALL be `/trigger/acme/foo/deploy/run`
- **AND** the `Dashboard` tab's `href` SHALL be `/dashboard/acme/foo/deploy/run`

#### Scenario: Tabs at surface root preserve empty scope

- **GIVEN** the user is on `/dashboard` (no scope segments)
- **WHEN** the tab strip is rendered
- **THEN** the `Dashboard` tab's `href` SHALL be `/dashboard`
- **AND** the `Trigger` tab's `href` SHALL be `/trigger`

