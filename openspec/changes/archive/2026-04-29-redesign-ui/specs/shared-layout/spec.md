## MODIFIED Requirements

### Requirement: Shared layout API

Every authenticated UI surface (`/dashboard/*`, `/trigger/*`) SHALL render with three regions: a topbar (delegated to the universal topbar contract in `ui-foundation`), a navigation sidebar, and a content area for the page-specific body. The runtime SHALL expose a single shared mechanism that authenticated route handlers use to compose these regions; surface-specific handlers SHALL NOT reimplement the shell layout.

The layout SHALL emit `<!DOCTYPE html>` ahead of `<html>` so browsers render the page in standards mode.

#### Scenario: Layout includes topbar, sidebar, and content area

- **WHEN** an authenticated UI surface is rendered (e.g. `/dashboard`, `/trigger`)
- **THEN** the response body SHALL contain a topbar element matching the `ui-foundation` universal topbar contract
- **AND** a sidebar element with the navigation tree
- **AND** a content area carrying the page-specific body

#### Scenario: Layout emits DOCTYPE

- **WHEN** any authenticated UI surface is rendered
- **THEN** the response body SHALL begin with `<!DOCTYPE html>` followed by `<html lang="en">`

#### Scenario: Sidebar tree present on authenticated surfaces

- **WHEN** an authenticated UI surface is rendered for a user with at least one accessible owner
- **THEN** the sidebar SHALL contain the owner→repo→trigger tree
- **AND** the layout SHALL NOT render a separate flat nav-link list above the tree

### Requirement: Navigation sidebar

The layout SHALL include a sidebar that contains a persistent `owner → repo → trigger` tree split into two sections — Dashboard and Trigger. Every tree node SHALL be a real link (no client-side toggle); expansion state SHALL be derived purely from the active URL.

- Clicking an owner navigates to `/:surface/:owner`.
- Clicking a repo navigates to `/:surface/:owner/:repo`.
- Clicking a trigger navigates to `/:surface/:owner/:repo/:workflow/:trigger`.
  - On `/dashboard`, this filters the flat invocation list to that trigger.
  - On `/trigger`, this renders the pre-expanded single-trigger card.
- The owner and repo ancestors of the current route SHALL render with their children visible; siblings SHALL render collapsed.
- The current node SHALL render with a visible "active" state.

Trigger leaves SHALL display the trigger-kind indicator next to the trigger name; the hover tooltip SHALL include the owning workflow name plus the kind. The trigger-kind indicator SHALL be the same indicator used elsewhere for that kind, per the `ui-foundation` cross-surface trigger-kind contract.

Section headers (`Dashboard`, `Trigger`) SHALL be links to that surface's root (`/dashboard`, `/trigger`). The active section SHALL render with a visible "active" state. The sidebar SHALL NOT render a separate top-level nav-link list — the section headers fill that role.

#### Scenario: Sidebar contains both surface sections

- **WHEN** the layout is rendered
- **THEN** the sidebar contains a section titled "Dashboard" linking to `/dashboard`
- **AND** a section titled "Trigger" linking to `/trigger`
- **AND** each section contains the full `owner → repo → trigger` tree for the user's scope allow-list

#### Scenario: Trigger leaf points to the correct surface

- **GIVEN** a user on `/trigger/acme/foo/deploy/run`
- **WHEN** the sidebar is rendered
- **THEN** the trigger leaf for `deploy/run` under `(acme, foo)` in the Trigger section SHALL link to `/trigger/acme/foo/deploy/run`
- **AND** the corresponding leaf in the Dashboard section SHALL link to `/dashboard/acme/foo/deploy/run`

#### Scenario: Active ancestor unfolds; siblings stay collapsed

- **GIVEN** the user is on `/dashboard/acme/foo`
- **WHEN** the sidebar is rendered
- **THEN** the `acme` owner node in the Dashboard section SHALL render with its children visible
- **AND** the `foo` repo node under it SHALL render with its trigger children visible
- **AND** sibling owners (e.g. `alice`) SHALL render collapsed
- **AND** sibling repos under `acme` (e.g. `bar`) SHALL render collapsed

### Requirement: Application top bar

Authenticated UI surfaces SHALL render a topbar above the sidebar and main content area. The topbar's appearance and content (brand wordmark, conditional user identity, sign-out control) SHALL conform to the `ui-foundation` universal topbar contract — `shared-layout` does NOT independently specify topbar content; it inherits the cross-surface contract.

#### Scenario: Authenticated topbar shows user identity

- **WHEN** an authenticated UI surface is rendered for a user with a valid session
- **THEN** the topbar matches the `ui-foundation` "Universal topbar" requirement (brand wordmark + username + email + sign-out control)

#### Scenario: Sign out link

- **WHEN** the user clicks the "Sign out" link in the topbar
- **THEN** the browser submits a POST to `/auth/logout`

## REMOVED Requirements

### Requirement: Shared CSS variables

**Reason**: The CSS-variable list and external-CSS-file requirement bind specific implementation choices that are not externally observable. The CSP-clean rendering invariant (no inline `<style>`) is now owned by `ui-foundation`'s "CSP-clean rendering" requirement; the existence and values of design tokens are an implementation concern documented in `docs/ui-guidelines.md`.

**Migration**: Pages must continue to render without inline `<style>` elements (enforced by `ui-foundation` CSP-clean rendering). The set of CSS variables defined and their values are not part of any spec; refer to `packages/runtime/src/ui/static/workflow-engine.css` and `docs/ui-guidelines.md`.

### Requirement: Shared script tags

**Reason**: The "universal script set on every page" requirement and its enumerated list of specific script filenames bind implementation choices that are not externally observable. Whether a page loads alpine.js, htmx, or any specific script bundle is an internal performance/architecture decision; the user-observable contract is "page interactivity works" and "scripts come from same-origin `/static/*`" — both of which are owned by `ui-foundation` (asset delivery + CSP-clean rendering) and `http-security` (CSP).

**Migration**: All script references must continue to be served from same-origin `/static/*` paths (enforced by `ui-foundation` asset delivery + `http-security` CSP). The specific scripts emitted and how they are split per-surface are implementation choices documented in `docs/ui-guidelines.md` and the rendering code; they are not part of any spec.
