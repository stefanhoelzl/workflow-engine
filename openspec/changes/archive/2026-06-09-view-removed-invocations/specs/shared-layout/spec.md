## MODIFIED Requirements

### Requirement: Navigation sidebar

The layout SHALL include a sidebar that contains a single persistent `owner → repo → workflow → trigger` tree, shared by both the invocations and trigger surfaces. The tree SHALL NOT be split into per-surface sections; the same tree markup is reused on every authenticated UI surface.

Every tree node — owner, repo, workflow, and trigger — SHALL be a real anchor link to that node's scope page. Expansion state SHALL be derived purely from the active URL: ancestors of the active route SHALL render with their children visible; siblings SHALL render collapsed. The current node SHALL render with a visible "active" state. There SHALL NOT be a client-side toggle for tree expansion.

Tree links SHALL preserve the surface segment of the active URL: when rendered under `/invocations/*`, every tree link SHALL target `/invocations/<scope>`; when rendered under `/trigger/*`, every tree link SHALL target `/trigger/<scope>`. Lateral navigation between tree nodes therefore keeps the user on their current surface; switching surface is the responsibility of the in-page tab strip, not the sidebar.

Trigger leaves SHALL display the trigger-kind indicator next to the trigger name; the hover tooltip SHALL include the owning workflow name plus the kind, per the `ui-foundation` cross-surface trigger-kind contract.

On the invocations surface only, the tree SHALL additionally reconstruct **removed** workflows and triggers — those whose `(workflow, name)` pair exists in the EventStore for the authorised `(owner, repo)` but is absent from the current `WorkflowRegistry` (a removed or renamed entity). Removed nodes SHALL be real anchor links to their `/invocations/<scope>` history. The union SHALL apply at the repo, workflow, and trigger levels: a repo whose every workflow has been removed SHALL still render a repo node carrying its removed workflows. Removed trigger leaves SHALL render with the `removed` trigger-kind indicator (archive, muted); removed workflow rows SHALL render muted. Within each level, removed nodes SHALL sort after all live siblings; no separator element is required between the live and removed groups. The `/trigger` and `/queue` surfaces SHALL NOT reconstruct removed nodes — their trees remain registry-only.

A renamed trigger SHALL appear as two leaves under the same workflow on the invocations surface: the old name (removed, muted) and the new name (live). There is no identity continuity between them.

The sidebar SHALL NOT render any top-level Invocations/Trigger section header, nav-link list, or surface-selector control. Surface choice is made via the in-page tab strip (see "In-page surface tabs"), not via sidebar navigation.

#### Scenario: Sidebar contains a single unified tree

- **WHEN** the layout is rendered on either `/invocations/*` or `/trigger/*`
- **THEN** the sidebar contains exactly one `owner → repo → workflow → trigger` tree
- **AND** the sidebar contains no "Invocations" or "Trigger" section header
- **AND** the sidebar contains no separate top-level nav-link list above or below the tree

#### Scenario: Tree links preserve current surface

- **GIVEN** a user on `/invocations/acme/foo/deploy/run`
- **WHEN** the sidebar is rendered
- **THEN** every owner / repo / workflow / trigger link in the tree SHALL begin with `/invocations/`
- **AND** clicking the `bar` repo under `acme` navigates to `/invocations/acme/bar`, not `/trigger/acme/bar`

#### Scenario: Workflow row is a real link to its scope

- **GIVEN** repo `(acme, foo)` declares workflow `deploy` with triggers `run` and `rollback`
- **WHEN** the sidebar is rendered on `/invocations/acme/foo`
- **THEN** the sidebar SHALL contain a `deploy` workflow row under the `foo` repo
- **AND** the `deploy` row SHALL be an anchor whose `href` is `/invocations/acme/foo/deploy`

#### Scenario: Active ancestors unfold; siblings stay collapsed

- **GIVEN** the user is on `/invocations/acme/foo/deploy/run`
- **WHEN** the sidebar is rendered
- **THEN** the `acme` owner node SHALL render with its children visible
- **AND** the `foo` repo node under it SHALL render with its workflow children visible
- **AND** the `deploy` workflow node under `foo` SHALL render with its trigger children visible
- **AND** sibling owners (e.g. `alice`) SHALL render collapsed
- **AND** sibling repos under `acme` (e.g. `bar`) SHALL render collapsed
- **AND** sibling workflows under `foo` (e.g. `build`) SHALL render collapsed

#### Scenario: Removed trigger appears as an removed leaf on the invocations surface

- **GIVEN** repo `(acme, foo)` has live workflow `deploy` with trigger `run`, and the EventStore holds invocations for a trigger `deploy/legacy-run` that is no longer in the registry
- **WHEN** the sidebar is rendered on `/invocations/acme/foo`
- **THEN** the `deploy` workflow SHALL list a live `run` leaf and an removed `legacy-run` leaf
- **AND** the `legacy-run` leaf SHALL render with the `removed` (archive, muted) trigger-kind indicator
- **AND** the `legacy-run` leaf SHALL sort after the live `run` leaf
- **AND** the `legacy-run` leaf SHALL be an anchor whose `href` is `/invocations/acme/foo/deploy/legacy-run`

#### Scenario: Fully-removed workflow appears as an removed repo child

- **GIVEN** repo `(acme, foo)` has no live workflows but the EventStore holds invocations for workflow `imap-poll`
- **WHEN** the sidebar is rendered on `/invocations/acme/foo`
- **THEN** the `foo` repo SHALL render a node (not the "no triggers" empty state)
- **AND** that repo SHALL list an removed `imap-poll` workflow rendered muted
- **AND** the `imap-poll` workflow SHALL sort after any live workflows

#### Scenario: Renamed trigger shows both old and new leaves

- **GIVEN** workflow `deploy` once had trigger `main-push` (with historical invocations) and now declares trigger `on-push`
- **WHEN** the sidebar is rendered on `/invocations/acme/foo`
- **THEN** the `deploy` workflow SHALL list a live `on-push` leaf and an removed `main-push` leaf
- **AND** the `on-push` leaf SHALL render with its declared kind and the `main-push` leaf SHALL render with the `removed` indicator

#### Scenario: Removed nodes do not appear on the trigger or queue surfaces

- **GIVEN** the same removed `deploy/legacy-run` history exists
- **WHEN** the sidebar is rendered on `/trigger/acme/foo` or `/queue/acme/foo`
- **THEN** the tree SHALL contain only registry-derived nodes
- **AND** no `legacy-run` leaf SHALL appear

### Requirement: In-page surface tabs

Every authenticated UI surface SHALL render an in-page tab strip between the sidebar and the main content area. The strip SHALL contain three tabs — `Invocations`, `Trigger`, and `Queues` — corresponding to the `/invocations/*`, `/trigger/*`, and `/queue/*` URL prefixes, with two exceptions: (a) at trigger-leaf scope (the URL has a trailing `:trigger` segment, e.g. `/trigger/:owner/:repo/:workflow/:trigger`), the `Queues` tab SHALL be omitted because `/queue` has no trigger-keyed counterpart and following the tab would 404; and (b) when the current invocations scope is **removed** — its workflow is absent from the `WorkflowRegistry`, or its trigger is absent from the registry entry for an otherwise-live workflow — the `Trigger` and `Queues` tabs SHALL both be omitted, because those surfaces are registry-only and following either tab would 404. An removed scope therefore renders only the current `Invocations` tab. The tab matching the current URL prefix SHALL render in an "active" visual state; the other tabs SHALL render in an inactive state.

Each tab SHALL be a real anchor whose `href` swaps the URL prefix while preserving the rest of the path. Given the current URL `/<surface>/<rest>` (where `<rest>` is everything after the surface segment, possibly empty), the Invocations tab's `href` SHALL be `/invocations/<rest>`, the Trigger tab's `href` SHALL be `/trigger/<rest>`, and the Queues tab's `href` SHALL be `/queue/<rest>`. A tab click is therefore a pure surface swap that keeps the user's selected scope (owner / repo / workflow) intact.

The tab strip SHALL be a shared component used by all surfaces; surface-specific handlers SHALL NOT inline tab markup in their page content. The tab strip's visual treatment is implementation-defined (e.g. underline-style, segmented-control), with the constraint that the active tab is visually distinguishable from the inactive tabs in a way that matches the `ui-foundation` reduced-motion and dark-mode contracts.

The asymmetry between the singular `Trigger` tab label and the plural `Invocations` and `Queues` labels is deliberate; existing tab labels SHALL NOT be renamed as part of introducing the `Queues` tab.

#### Scenario: Tabs render on every authenticated surface

- **WHEN** any authenticated UI surface is rendered at root, owner, repo, or workflow scope (`/invocations`, `/invocations/<owner>/...` up to `/<surface>/<owner>/<repo>/<workflow>`) for a registry-backed scope
- **THEN** the response body SHALL contain a tab strip with three tabs labelled `Invocations`, `Trigger`, and `Queues`
- **AND** exactly one tab SHALL render in the active state

#### Scenario: Queues tab is hidden on trigger-leaf URLs

- **WHEN** a UI surface is rendered at a registry-backed trigger-leaf URL (`/<surface>/<owner>/<repo>/<workflow>/<trigger>`, where `<surface>` is `/invocations` or `/trigger`)
- **THEN** the tab strip SHALL contain exactly two tabs labelled `Invocations` and `Trigger`
- **AND** the `Queues` tab SHALL NOT appear in the tab strip

#### Scenario: Active tab matches URL prefix

- **GIVEN** the user is on `/queue/acme/foo/build`
- **WHEN** the tab strip is rendered
- **THEN** the `Queues` tab SHALL render in the active state
- **AND** the `Invocations` and `Trigger` tabs SHALL render in the inactive state

#### Scenario: Tab click preserves scope, swaps prefix

- **GIVEN** the user is on `/invocations/acme/foo/deploy`
- **WHEN** the tab strip is rendered
- **THEN** the `Invocations` tab's `href` SHALL be `/invocations/acme/foo/deploy`
- **AND** the `Trigger` tab's `href` SHALL be `/trigger/acme/foo/deploy`
- **AND** the `Queues` tab's `href` SHALL be `/queue/acme/foo/deploy`

#### Scenario: Removed workflow scope shows only the Invocations tab

- **GIVEN** workflow `gone-wf` is absent from the registry for `(acme, foo)` but has invocation history
- **WHEN** the user is on `/invocations/acme/foo/gone-wf`
- **THEN** the tab strip SHALL contain exactly one tab labelled `Invocations`
- **AND** no `Trigger` or `Queue` tab anchor SHALL appear

#### Scenario: Removed trigger scope shows only the Invocations tab

- **GIVEN** workflow `deploy` is live but its trigger `legacy-run` has been removed, while `deploy/legacy-run` has invocation history
- **WHEN** the user is on `/invocations/acme/foo/deploy/legacy-run`
- **THEN** the tab strip SHALL contain exactly one tab labelled `Invocations`
- **AND** no `Trigger` or `Queue` tab anchor SHALL appear
