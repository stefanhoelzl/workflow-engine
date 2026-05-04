## MODIFIED Requirements

### Requirement: In-page surface tabs

Every authenticated UI surface SHALL render an in-page tab strip between the sidebar and the main content area. The strip SHALL contain three tabs — `Invocations`, `Trigger`, and `Queues` — corresponding to the `/invocations/*`, `/trigger/*`, and `/queue/*` URL prefixes, with one exception: at trigger-leaf scope (the URL has a trailing `:trigger` segment, e.g. `/trigger/:owner/:repo/:workflow/:trigger`), the `Queues` tab SHALL be omitted because `/queue` has no trigger-keyed counterpart and following the tab would 404. The tab matching the current URL prefix SHALL render in an "active" visual state; the other tabs SHALL render in an inactive state.

Each tab SHALL be a real anchor whose `href` swaps the URL prefix while preserving the rest of the path. Given the current URL `/<surface>/<rest>` (where `<rest>` is everything after the surface segment, possibly empty), the Invocations tab's `href` SHALL be `/invocations/<rest>`, the Trigger tab's `href` SHALL be `/trigger/<rest>`, and the Queues tab's `href` SHALL be `/queue/<rest>`. A tab click is therefore a pure surface swap that keeps the user's selected scope (owner / repo / workflow) intact.

The tab strip SHALL be a shared component used by all surfaces; surface-specific handlers SHALL NOT inline tab markup in their page content. The tab strip's visual treatment is implementation-defined (e.g. underline-style, segmented-control), with the constraint that the active tab is visually distinguishable from the inactive tabs in a way that matches the `ui-foundation` reduced-motion and dark-mode contracts.

The asymmetry between the singular `Trigger` tab label and the plural `Invocations` and `Queues` labels is deliberate; existing tab labels SHALL NOT be renamed as part of introducing the `Queues` tab.

#### Scenario: Tabs render on every authenticated surface

- **WHEN** any authenticated UI surface is rendered at root, owner, repo, or workflow scope (`/invocations`, `/invocations/<owner>/...` up to `/<surface>/<owner>/<repo>/<workflow>`)
- **THEN** the response body SHALL contain a tab strip with three tabs labelled `Invocations`, `Trigger`, and `Queues`
- **AND** exactly one tab SHALL render in the active state

#### Scenario: Queues tab is hidden on trigger-leaf URLs

- **WHEN** a UI surface is rendered at a trigger-leaf URL (`/<surface>/<owner>/<repo>/<workflow>/<trigger>`, where `<surface>` is `/invocations` or `/trigger`)
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

#### Scenario: Tabs at surface root preserve empty scope

- **GIVEN** the user is on `/invocations` (no scope segments)
- **WHEN** the tab strip is rendered
- **THEN** the `Invocations` tab's `href` SHALL be `/invocations`
- **AND** the `Trigger` tab's `href` SHALL be `/trigger`
- **AND** the `Queues` tab's `href` SHALL be `/queue`

#### Scenario: Trigger-only paths preserve trigger segment when swapping to Queues

- **GIVEN** the user is on `/trigger/acme/foo/deploy/run` (a single-trigger focus URL)
- **WHEN** the tab strip is rendered
- **THEN** the `Queues` tab's `href` SHALL be `/queue/acme/foo/deploy/run`
- **AND** the queue surface SHALL handle a trailing segment that does not match a declared queue by responding `404 Not Found` (per `queues-ui`)
