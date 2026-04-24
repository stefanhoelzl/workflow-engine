## MODIFIED Requirements

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

### Requirement: Shared layout API

The system SHALL provide a `renderLayout(options, content)` function that returns a complete HTML document with a top bar, navigation sidebar, and content area. The `options` object SHALL include `title`, `activePath`, `user`, `email`, an optional `head`, an optional `bodyAttrs`, and an optional `sidebarTree` slot carrying the pre-rendered sidebar HTML for the current request.

When `sidebarTree` is supplied, the sidebar SHALL render that markup verbatim inside the sidebar container. When it is absent (e.g. the login page), the sidebar SHALL render nothing.

#### Scenario: Layout accepts the sidebarTree slot

- **GIVEN** `renderLayout({title, activePath, user, email, sidebarTree})` is called with a non-empty `sidebarTree`
- **THEN** the output SHALL embed the supplied HTML inside the sidebar container
- **AND** the output SHALL NOT include a separate nav-link list above the tree
