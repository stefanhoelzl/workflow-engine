## MODIFIED Requirements

### Requirement: Dashboard lists invocations

The dashboard SHALL render invocations from the EventStore, ordered by `startedAt` descending with `id` descending as tiebreak. Each rendered invocation SHALL display: workflow, trigger, status (`pending` / `succeeded` / `failed`), `startedAt` (formatted from the ISO string), duration, and a dispatch indicator sourced from the invocation's `trigger.request` event.

At the leaf-scope view (`/dashboard/:owner/:repo`), rows SHALL show workflow, trigger, status, started timestamp, and duration without `owner` or `repo` columns (both are redundant with the URL path).

At the owner-scope view (`/dashboard/:owner`), rows SHALL additionally surface the `repo` for each invocation, either as a dedicated column or inside a nested `<details>` structure per-repo (see "Drill-down tree").

At the root view (`/dashboard`), invocations are grouped under their owner first and then their repo via the drill-down tree (see "Drill-down tree"); flat cross-owner row display without grouping SHALL NOT be produced by this view.

The dispatch indicator SHALL render as a text chip whose visible label is always `"manual"` when `meta.dispatch.source === "manual"`. The chip's `title` attribute (shown on hover) SHALL carry the dispatching user's login (`meta.dispatch.user.login`) when present, and SHALL be empty when no `user` is present. The chip SHALL NOT be rendered when `source === "trigger"` or when the `trigger.request` event carries no `meta.dispatch`.

Duration SHALL be computed as `completedTs - startedTs` (monotonic microseconds) when both values are available, and rendered using a smart-unit formatter (see existing scenarios, unchanged).

#### Scenario: Leaf view renders rows without owner/repo columns

- **GIVEN** a request to `GET /dashboard/acme/foo`
- **WHEN** the invocation list is rendered
- **THEN** the rows SHALL show workflow, trigger, status, started, duration
- **AND** the rows SHALL NOT include `owner` or `repo` columns (the URL path already carries them)

#### Scenario: Manual dispatch renders chip with user login in tooltip

- **GIVEN** an invocation whose `trigger.request` event carries `meta.dispatch = { source: "manual", user: { login: "alice", mail: "alice@example.com" } }`
- **WHEN** the list is rendered
- **THEN** the row for that invocation SHALL render a chip whose visible label is `"manual"`
- **AND** the chip SHALL carry `title="alice"` for on-hover attribution

### Requirement: Flamegraph fragment endpoint

The runtime SHALL expose `GET /dashboard/:owner/:repo/invocations/:id/flamegraph` under the `/dashboard` path prefix. The endpoint SHALL validate `:owner` and `:repo` against their respective regexes, enforce owner-membership via the shared authorization middleware, and read the invocation's events via `eventStore.query([{owner, repo}]).where('id', '=', id).orderBy('seq', 'asc').execute()` and return an HTML fragment (not a full page shell).

The endpoint SHALL return `404 Not Found` when the supplied `(owner, repo)` is not registered or the user is not a member of `owner`, using the same fail-closed pattern as other scoped routes.

#### Scenario: Flamegraph fragment requires scope in URL

- **WHEN** a request arrives at `GET /dashboard/acme/foo/invocations/evt_abc/flamegraph` with a valid session for a member of `acme`
- **THEN** the endpoint SHALL return the flamegraph HTML fragment for invocation `evt_abc` scoped to `(acme, foo)`
- **AND** the response SHALL NOT include the page shell

#### Scenario: Flamegraph endpoint scoped by (owner, repo), not just owner

- **GIVEN** invocations `evt_abc` under `(acme, foo)` and `evt_abc` under `(acme, bar)` (same id, different scope — hypothetical)
- **WHEN** `GET /dashboard/acme/foo/invocations/evt_abc/flamegraph` is requested
- **THEN** only the events belonging to `(acme, foo)` SHALL be rendered
- **AND** events from `(acme, bar)` SHALL NOT appear in the fragment

### Requirement: Invocation rows are expandable into an inline flamegraph

Each rendered invocation row (for `succeeded` or `failed` status) SHALL be wrapped in a native `<details>`/`<summary>` element that an operator can toggle open to reveal an inline flamegraph fragment for that invocation. Pending invocations SHALL NOT render an expand affordance.

Expansion SHALL lazily load the flamegraph fragment via HTMX the first time the row is opened. The `hx-get` URL SHALL include `:owner` and `:repo` segments drawn from the current scope. Subsequent open/close cycles SHALL rely on native `<details>` behavior (no re-fetch). Multiple rows MAY be expanded simultaneously (no accordion coordination).

#### Scenario: Completed row exposes HTMX lazy-load attributes

- **GIVEN** a succeeded invocation `evt_abc` in scope `(acme, foo)`
- **WHEN** the invocation list is rendered
- **THEN** its row SHALL contain a `<details>` element whose attributes include `hx-get="/dashboard/acme/foo/invocations/evt_abc/flamegraph"`, `hx-trigger="toggle once"`, and an `hx-target` pointing at a descendant container that will receive the fragment

#### Scenario: Failed row is also expandable

- **GIVEN** a failed invocation `evt_def` in scope `(alice, utils)`
- **WHEN** the invocation list is rendered
- **THEN** its row SHALL contain a `<details>` element with the same HTMX lazy-load attributes as a succeeded row, targeting `/dashboard/alice/utils/invocations/evt_def/flamegraph`

#### Scenario: Pending row has no expand affordance

- **GIVEN** a pending invocation `evt_ghi`
- **WHEN** the invocation list is rendered
- **THEN** the row SHALL NOT contain a `<details>` element and SHALL NOT carry any `hx-get` attribute referencing `/flamegraph`

## ADDED Requirements

### Requirement: Drill-down routes

The dashboard SHALL expose three related routes:

- `GET /dashboard` — cross-owner view. Renders invocations for every `(owner, repo)` the current user has access to, grouped via the collapsible tree (see "Drill-down tree").
- `GET /dashboard/:owner` — owner-scope view. Renders invocations for every repo under `:owner`, grouped by repo via the collapsible tree.
- `GET /dashboard/:owner/:repo` — leaf-scope view. Renders a flat invocation list for `(owner, repo)` matching the pre-drill-down UX.

All three routes SHALL require an authenticated session. `:owner` and `:repo` path parameters SHALL be validated against their regexes and SHALL enforce owner-membership via the shared authorization middleware; membership failure SHALL respond `404 Not Found` using the enumeration-prevention pattern.

Each scoped route SHALL resolve its query scopes as follows:

- `/dashboard` → the full allow-list returned by `resolveQueryScopes(user)` — every `(owner, repo)` the user is a member of AND that is registered in the workflow registry.
- `/dashboard/:owner` → the allow-list filtered to `owner === :owner`.
- `/dashboard/:owner/:repo` → the single-element allow-list `[{owner: :owner, repo: :repo}]`, provided the pair is registered (empty state shown if not registered but the user is a member of `:owner`).

#### Scenario: Root view serves all user's scopes

- **GIVEN** a user whose `orgs = ["acme", "alice"]` with registered bundles `(acme, foo)`, `(acme, bar)`, `(alice, utils)`
- **WHEN** `GET /dashboard` is requested
- **THEN** the view SHALL render the collapsible tree with three leaves covering all three scopes

#### Scenario: Owner view filters to one owner

- **GIVEN** the same user and registry as above
- **WHEN** `GET /dashboard/acme` is requested
- **THEN** the view SHALL render the collapsible tree with leaves for `(acme, foo)` and `(acme, bar)`
- **AND** `(alice, utils)` SHALL NOT appear in the response

#### Scenario: Owner view for non-member returns 404

- **WHEN** a user who is NOT a member of `evil-corp` requests `GET /dashboard/evil-corp`
- **THEN** the view SHALL respond `404 Not Found`
- **AND** the response body SHALL be identical in shape to the response for a non-existent owner

#### Scenario: Leaf view with no bundle registered renders empty state

- **GIVEN** a user who is a member of `acme` but `acme/never-uploaded` has no registered bundle
- **WHEN** `GET /dashboard/acme/never-uploaded` is requested
- **THEN** the view SHALL respond `200 OK` with an empty-state message
- **AND** the view SHALL NOT respond `404` (the user is a member; absence of bundle is a legitimate empty state)

### Requirement: Drill-down tree

The cross-scope views (`/dashboard` and `/dashboard/:owner`) SHALL render a hierarchical collapsible tree using native `<details>` / `<summary>` elements:

- At `/dashboard`: tree root contains one `<details>` per owner in the user's scope allow-list. Each owner's body contains one `<details>` per repo under that owner. Each repo's body lazy-loads the invocation list fragment via HTMX when first expanded (`hx-trigger="toggle once"`).
- At `/dashboard/:owner`: root contains one `<details>` per repo under `:owner`. The owner's summary is implicit in the page header.

Each `<details>` `<summary>` SHALL include a cheap aggregate count of invocations in the window (e.g. "acme (12)", "foo (7)"). Counts SHALL be computed server-side on initial render via a single DuckDB aggregate query over the user's scope allow-list — NOT by N scoped round-trips.

Default expansion state SHALL be all collapsed, EXCEPT when the user's scope allow-list contains exactly one owner, in which case that owner's `<details>` SHALL be rendered with the `open` attribute. When an owner contains exactly one repo and its owner is also the only owner, that repo's `<details>` SHALL also be rendered `open`.

Fragment endpoints for lazy loads:

- `GET /dashboard/:owner/repos` — returns the collapsible list of repos for an owner (used when expanding an owner at `/dashboard`).
- `GET /dashboard/:owner/:repo/invocations` — returns the flat invocation list fragment for a repo.

Both fragment endpoints SHALL enforce owner membership via the shared middleware.

Pagination at the leaf: each repo's invocation list SHALL cap at 100 rows. When more invocations exist, the fragment SHALL append a "load more" button (`hx-get` targeting the same fragment URL with an offset cursor query parameter) at the end of the list. The button SHALL replace itself with the next batch on click. The offset cursor SHALL encode the last-rendered `(at, id)` tuple to provide stable pagination against newly-appended invocations.

All HTML MUST comply with the CSP invariants already applied to dashboard fragments: no inline `<script>`, no inline `<style>`, no `on*=` event attributes, no `style=` attributes.

#### Scenario: Root view renders owner tree with counts

- **GIVEN** a user with scope allow-list `[(acme, foo), (acme, bar), (alice, utils)]` and 12/7/3 invocations respectively in the display window
- **WHEN** `GET /dashboard` is requested
- **THEN** the response SHALL contain two top-level `<details>` elements for `acme` (19 total) and `alice` (3 total)
- **AND** both SHALL be collapsed (no `open` attribute) because the user has more than one owner

#### Scenario: Single-owner case auto-expands

- **GIVEN** a user whose scope allow-list is `[(acme, foo), (acme, bar)]` (single owner, multiple repos)
- **WHEN** `GET /dashboard` is requested
- **THEN** the response SHALL contain the `acme` `<details>` rendered with `open`
- **AND** the repo `<details>` for `foo` and `bar` SHALL be collapsed

#### Scenario: Single-owner-single-repo fully expanded

- **GIVEN** a user whose scope allow-list is `[(alice, utils)]`
- **WHEN** `GET /dashboard` is requested
- **THEN** both the owner `<details>` and the repo `<details>` SHALL be rendered with `open`

#### Scenario: Owner expand triggers HTMX fragment

- **GIVEN** the `acme` `<details>` is collapsed at `/dashboard`
- **WHEN** the user expands it
- **THEN** HTMX SHALL fire `GET /dashboard/acme/repos` with `hx-trigger="toggle once"`
- **AND** the response SHALL contain the collapsible list of `acme`'s repos with per-repo invocation counts

#### Scenario: Repo expand triggers HTMX fragment for invocations

- **GIVEN** the `foo` `<details>` (nested under `acme`) is collapsed
- **WHEN** the user expands it
- **THEN** HTMX SHALL fire `GET /dashboard/acme/foo/invocations` with `hx-trigger="toggle once"`
- **AND** the response SHALL contain up to 100 invocation rows for `(acme, foo)`

#### Scenario: Load more paginates by cursor

- **GIVEN** `(acme, foo)` has 250 invocations in the display window and the first fragment rendered the latest 100
- **WHEN** the user clicks "load more"
- **THEN** HTMX SHALL fire `GET /dashboard/acme/foo/invocations?cursor=<encoded>` where the cursor encodes the last-rendered row's `(at, id)`
- **AND** the response SHALL contain the next 100 rows older than the cursor
- **AND** the response SHALL replace the "load more" button with either the next batch + a new "load more" button, or with an end-of-list marker
