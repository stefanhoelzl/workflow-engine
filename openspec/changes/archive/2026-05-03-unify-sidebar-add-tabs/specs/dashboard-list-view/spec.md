## MODIFIED Requirements

### Requirement: Filter routes

The dashboard SHALL expose five filter levels, each of which renders the same flat-list shape with the filter's scope applied:

- `GET /dashboard` — every `(owner, repo)` the user has access to
- `GET /dashboard/:owner` — every repo under `:owner`
- `GET /dashboard/:owner/:repo` — that repo only
- `GET /dashboard/:owner/:repo/:workflow` — invocations produced by triggers belonging to that workflow within `(owner, repo)`
- `GET /dashboard/:owner/:repo/:workflow/:trigger` — invocations produced by that specific trigger

All routes SHALL require an authenticated session. `:owner` and `:repo` path parameters SHALL be validated against their regexes and SHALL enforce owner-membership via the shared authorization middleware; membership failure SHALL respond `404 Not Found` using the enumeration-prevention pattern. The `:workflow` segment SHALL be validated against the `WorkflowRegistry` for the authorised `(owner, repo)` **only when the registry has any entries for that `(owner, repo)`**: if entries exist and none of them carry the supplied workflow name, the route SHALL respond `404 Not Found` matching the response shape used for non-existent owner/repo. When the registry has no entries for `(owner, repo)` (e.g. all workflows have been deleted), the workflow segment SHALL NOT 404 — historical synthetic events (`trigger.exception`, `system.upload`) under that scope remain visible via the EventStore.

Scope resolution is identical at every filter level — `resolveQueryScopes(user, registry, constraint?)` returns the `(owner, repo)` allow-list, narrowed by the URL's `owner`/`repo` when present. When the URL carries a `:workflow` segment without a `:trigger`, the EventStore query SHALL additionally constrain `WHERE workflow = ?` so rows belonging to other workflows in the same repo are excluded. When the URL carries `:workflow/:trigger`, the query SHALL additionally constrain `WHERE workflow = ? AND name = ?`.

#### Scenario: Per-workflow filter narrows by workflow

- **GIVEN** `(acme, foo)` has workflows `build` and `deploy`, each with multiple triggers and invocations
- **WHEN** a member of `acme` requests `GET /dashboard/acme/foo/build`
- **THEN** rows SHALL include only invocations whose workflow is `build`
- **AND** rows belonging to workflow `deploy` SHALL NOT appear

#### Scenario: Per-trigger filter narrows by workflow + trigger

- **GIVEN** `(acme, foo)` has triggers `build/webhook` and `deploy/webhook`, each with multiple invocations
- **WHEN** a member of `acme` requests `GET /dashboard/acme/foo/build/webhook`
- **THEN** rows SHALL include only `build/webhook` invocations
- **AND** rows for `deploy/webhook` SHALL NOT appear

#### Scenario: Non-member request at any filter level returns 404

- **WHEN** a user who is NOT a member of `evil-corp` requests `GET /dashboard/evil-corp` or `GET /dashboard/evil-corp/foo` or `GET /dashboard/evil-corp/foo/build` or `GET /dashboard/evil-corp/foo/build/webhook`
- **THEN** every route SHALL respond `404 Not Found`
- **AND** the response body SHALL be identical in shape to the response for a non-existent owner

#### Scenario: Nonexistent workflow under a populated repo returns 404

- **GIVEN** `(acme, foo)` is registered with workflows `build` and `deploy` only
- **WHEN** a member of `acme` requests `GET /dashboard/acme/foo/no-such-workflow`
- **THEN** the response status SHALL be `404 Not Found`
- **AND** the response body SHALL be identical in shape to the response for a non-existent owner or repo

#### Scenario: Workflow URL under an empty registry does not 404

- **GIVEN** `(acme, foo)` has no registered workflows but the EventStore holds historical `trigger.exception` events for workflow `imap-poll`
- **WHEN** a member of `acme` requests `GET /dashboard/acme/foo/imap-poll`
- **THEN** the response status SHALL be `200 OK`
- **AND** rows SHALL include the historical synthetic events

#### Scenario: Breadcrumb reflects filter level

- **WHEN** the dashboard page is rendered at each filter level
- **THEN** the breadcrumb SHALL show the path from root to the active filter (`All`, `All / owner`, `All / owner / repo`, `All / owner / repo / workflow`, `All / owner / repo / workflow / trigger`)
- **AND** each segment above the current level SHALL be a link to that broader filter

### Requirement: No filters or detail page in v1

The v1 dashboard SHALL NOT support filters (by status, time range), detail pages per invocation, replay/retry buttons, or live-streaming updates. Scope-based filtering by URL path (owner / repo / workflow / trigger) is supported per "Filter routes"; this requirement excludes only orthogonal filters such as time-range or status pickers.

#### Scenario: List is the only top-level dashboard view

- **WHEN** the user navigates to any dashboard URL other than the list (at any filter level) or the per-invocation flamegraph fragment endpoint
- **THEN** the response SHALL be `404` (or the request SHALL be redirected to the list)
