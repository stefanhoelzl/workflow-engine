## MODIFIED Requirements

### Requirement: Dashboard lists invocations

The dashboard SHALL render a single flat list of invocations from the EventStore. The view is always a flat list — there is no drill-down tree, no lazy-loaded fragment per scope, and no per-repo nesting. Filtering is driven by the URL path: `/dashboard/:owner` narrows the list to that owner, `/dashboard/:owner/:repo` narrows to that repo, and `/dashboard/:owner/:repo/:workflow/:trigger` narrows to a single trigger's invocations. The root `/dashboard` view renders invocations across every `(owner, repo)` the caller has access to.

Each rendered invocation SHALL display: `owner/repo`, workflow, trigger, status (`pending` / `succeeded` / `failed`), `startedAt`, duration, and a dispatch indicator. The `owner/repo` prefix is rendered on every row at every filter level so an operator looking at the cross-scope view can attribute each invocation to its scope.

Rows SHALL be sorted in two groups:

1. Pending rows first, ordered by `startedTs` descending (live invocations stay on top).
2. Completed rows after, ordered by `completedTs` descending (most recently finished first, without mixing pending rows in between).

This "pending-first, then newest-completed" ordering is enforced by the page renderer (`sortInvocationRows`); the SQL query orders by `at` descending purely to bound the result set.

The dispatch indicator SHALL render as a text chip whose visible label is always `"manual"` when `meta.dispatch.source === "manual"`. The chip's `title` attribute SHALL carry the dispatching user's login (`meta.dispatch.user.login`) when present. The chip SHALL NOT be rendered when `source === "trigger"` or when the `trigger.request` event carries no `meta.dispatch`.

Duration SHALL be computed as `completedTs - startedTs` when both are available, formatted via the existing smart-unit formatter.

#### Scenario: Root renders invocations from every scope the user has

- **GIVEN** a user whose `orgs = ["acme", "alice"]` with registered bundles `(acme, foo)`, `(acme, bar)`, `(alice, utils)`, each with invocations
- **WHEN** `GET /dashboard` is requested
- **THEN** rows SHALL include invocations from all three `(owner, repo)` pairs
- **AND** each row SHALL display its `owner/repo` prefix

#### Scenario: Pending row sorted above completed row regardless of started-at

- **GIVEN** a completed invocation that started at 12:00:00 and finished at 12:00:02, and a pending invocation that started at 11:59:50
- **WHEN** the list is rendered
- **THEN** the pending row SHALL appear above the completed row

#### Scenario: Manual dispatch renders chip with user login in tooltip

- **GIVEN** an invocation whose `trigger.request` event carries `meta.dispatch = { source: "manual", user: { login: "alice", mail: "alice@example.com" } }`
- **WHEN** the list is rendered
- **THEN** the row SHALL render a chip whose visible label is `"manual"`
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

Expansion SHALL lazily load the flamegraph fragment via HTMX the first time the row is opened. The `hx-get` URL is constructed from the row's own `owner` and `repo` (not the page-level filter), so a cross-scope view still resolves each row's flamegraph correctly. Subsequent open/close cycles SHALL rely on native `<details>` behavior (no re-fetch). Multiple rows MAY be expanded simultaneously (no accordion coordination).

#### Scenario: Completed row uses its own scope in the hx-get URL

- **GIVEN** a cross-scope `/dashboard` request and a succeeded invocation `evt_abc` belonging to `(alice, utils)`
- **WHEN** the invocation list is rendered
- **THEN** the row's `<details>` SHALL carry `hx-get="/dashboard/alice/utils/invocations/evt_abc/flamegraph"` (not the page's current filter scope)

#### Scenario: Pending row has no expand affordance

- **GIVEN** a pending invocation `evt_ghi`
- **WHEN** the invocation list is rendered
- **THEN** the row SHALL NOT contain a `<details>` element and SHALL NOT carry any `hx-get` attribute referencing `/flamegraph`

## ADDED Requirements

### Requirement: Filter routes

The dashboard SHALL expose four filter levels, each of which renders the same flat-list shape with the filter's scope applied:

- `GET /dashboard` — every `(owner, repo)` the user has access to
- `GET /dashboard/:owner` — every repo under `:owner`
- `GET /dashboard/:owner/:repo` — that repo only
- `GET /dashboard/:owner/:repo/:workflow/:trigger` — invocations produced by that specific trigger

All routes SHALL require an authenticated session. `:owner` and `:repo` path parameters SHALL be validated against their regexes and SHALL enforce owner-membership via the shared authorization middleware; membership failure SHALL respond `404 Not Found` using the enumeration-prevention pattern.

Scope resolution is identical at every filter level — `resolveQueryScopes(user, registry, constraint?)` returns the `(owner, repo)` allow-list, narrowed by the URL's `owner`/`repo` when present. When the URL carries a `:workflow/:trigger` pair, the EventStore query additionally constrains `WHERE workflow = ? AND name = ?` so rows for other triggers in the same repo are excluded.

#### Scenario: Per-trigger filter narrows by workflow + trigger

- **GIVEN** `(acme, foo)` has triggers `build/webhook` and `deploy/webhook`, each with multiple invocations
- **WHEN** a member of `acme` requests `GET /dashboard/acme/foo/build/webhook`
- **THEN** rows SHALL include only `build/webhook` invocations
- **AND** rows for `deploy/webhook` SHALL NOT appear

#### Scenario: Non-member request at any filter level returns 404

- **WHEN** a user who is NOT a member of `evil-corp` requests `GET /dashboard/evil-corp` or `GET /dashboard/evil-corp/foo` or `GET /dashboard/evil-corp/foo/build/webhook`
- **THEN** every route SHALL respond `404 Not Found`
- **AND** the response body SHALL be identical in shape to the response for a non-existent owner

#### Scenario: Breadcrumb reflects filter level

- **WHEN** the dashboard page is rendered at each filter level
- **THEN** the breadcrumb SHALL show the path from root to the active filter (`All`, `All / owner`, `All / owner / repo`, `All / owner / repo / workflow / trigger`)
- **AND** each segment above the current level SHALL be a link to that broader filter
