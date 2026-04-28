# Shared Layout Specification

## Purpose

Provide a shared HTML layout with navigation sidebar reused across dashboard and trigger UI pages.

## Requirements

### Requirement: Shared layout API

The system SHALL provide a `<Layout>` JSX component (in `packages/runtime/src/ui/layout.tsx`) that returns a complete HTML document with a top bar, navigation sidebar, and content area. The component SHALL accept the following props: `title`, `activePath`, `user`, `email`, an optional `sidebarTree` slot carrying a pre-rendered sidebar JSX subtree for the current request, and `children` carrying the page-specific content.

When `sidebarTree` is supplied, the sidebar SHALL render that subtree verbatim inside the sidebar container. When it is absent (e.g. the login page), the sidebar SHALL render only the top-level nav-link list (Dashboard / Trigger).

The component SHALL be a synchronous function. Async data fetches required to build the sidebar or page content SHALL be performed in route handlers before invoking `c.html(<Layout/>...)`; the component itself SHALL NOT receive `Promise`-typed props.

The `<Layout>` component SHALL emit `<!DOCTYPE html>` ahead of `<html>` so browsers render the page in standards mode.

#### Scenario: Layout accepts the sidebarTree slot

- **GIVEN** `<Layout title="..." activePath="..." user="..." email="..." sidebarTree={tree}>...</Layout>` is rendered with a non-empty `sidebarTree`
- **THEN** the output SHALL embed the supplied subtree inside the sidebar container
- **AND** the output SHALL NOT include a separate nav-link list above the tree

#### Scenario: Layout emits DOCTYPE

- **WHEN** any `<Layout/>` is rendered
- **THEN** the response body SHALL begin with `<!DOCTYPE html>` followed by `<html lang="en">`
### Requirement: Navigation sidebar

The layout SHALL include a sidebar (~240 px) that contains a persistent `owner → repo → trigger` tree split into two sections — Dashboard and Trigger — rendered by a shared helper (`ui/sidebar-tree.ts:renderSidebarBoth`) that each surface's middleware calls from every request handler.

Every tree node SHALL be a real link (no client-side `<details>` toggle), and expansion state SHALL be derived purely from the active URL:

- Clicking an owner navigates to `/:surface/:owner`.
- Clicking a repo navigates to `/:surface/:owner/:repo`.
- Clicking a trigger navigates to `/:surface/:owner/:repo/:workflow/:trigger`.
  - On `/dashboard`, this filters the flat invocation list to that trigger.
  - On `/trigger`, this renders the pre-expanded single-trigger card.
- The owner and repo ancestors of the current route SHALL render `open` (children visible); siblings SHALL render collapsed.
- The current node SHALL carry an `active` class for accent-color highlighting.

Trigger leaves SHALL display the trigger-kind icon (`triggerKindIcon` from `ui/triggers.ts`) next to the trigger name; the hover tooltip SHALL include the owning workflow name plus the kind.

Section headers (`Dashboard`, `Trigger`) SHALL be links to that surface's root (`/dashboard`, `/trigger`). The active section SHALL be highlighted. The sidebar SHALL NOT render a separate top-level nav-link list — the section headers fill that role.

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
### Requirement: Shared CSS variables
The layout SHALL reference an external CSS file at `/static/workflow-engine.css` via a `<link>` tag instead of inline `<style>`.

#### Scenario: External CSS referenced
- **WHEN** the layout is rendered
- **THEN** the HTML contains `<link href="/static/workflow-engine.css">` in the `<head>`
- **THEN** no inline `<style>` block with CSS variables is present

#### Scenario: Light mode variables
- **WHEN** the page is rendered in light mode
- **THEN** CSS variables `--bg`, `--bg-surface`, `--bg-elevated`, `--border`, `--text`, `--text-secondary`, `--text-muted`, `--green`, `--red`, `--yellow`, and `--accent` are defined on `:root` in the external CSS file

#### Scenario: Dark mode variables
- **WHEN** the user's system preference is dark mode
- **THEN** the CSS variables are overridden via `@media (prefers-color-scheme: dark)` with dark theme values in the external CSS file

### Requirement: Shared script tags

The layout SHALL include `<script>` tags referencing client-side JavaScript files served from the static middleware at `/static/` paths. The full script set is emitted unconditionally on every page rendered by `<Layout>`; there is no per-surface `head` slot for surface-specific script injection.

The emitted scripts SHALL include at minimum: `/static/alpine.js` (deferred), `/static/htmx.js`, `/static/result-dialog.js` (deferred), `/static/local-time.js` (deferred), `/static/flamegraph.js` (deferred), and `/static/trigger-forms.js` (deferred).

#### Scenario: Scripts included on every page

- **WHEN** any `<Layout/>` is rendered
- **THEN** the HTML SHALL include `<script defer src="/static/alpine.js">` and `<script src="/static/htmx.js">`
- **AND** the HTML SHALL include `<script defer src="/static/flamegraph.js">` and `<script defer src="/static/trigger-forms.js">` regardless of which surface is rendering

#### Scenario: No per-surface head injection

- **GIVEN** the dashboard surface and the trigger surface render via the same `<Layout/>` component
- **THEN** both surfaces SHALL emit the identical `<script>` tag set
- **AND** there SHALL NOT be a `head` prop on `<Layout/>` for surface-specific tag injection

### Requirement: Application top bar
The layout SHALL render a full-width top bar above the sidebar and main content area, displaying application branding and authenticated user identity.

#### Scenario: Top bar with authenticated user
- **WHEN** the layout is rendered with `user` and `email` values
- **THEN** the top bar displays "Workflow Engine" branding on the left and the username with a "Sign out" link on the first line and the email as a muted caption below on the right

#### Scenario: Top bar without authenticated user
- **WHEN** the layout is rendered with empty `user` and `email` values
- **THEN** the top bar displays "Workflow Engine" branding on the left and the user section on the right is hidden

#### Scenario: Sign out link
- **WHEN** the user clicks the "Sign out" link in the top bar
- **THEN** the browser submits a POST to `/auth/logout`
