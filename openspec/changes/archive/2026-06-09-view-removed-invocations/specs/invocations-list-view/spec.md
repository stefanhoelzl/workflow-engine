## MODIFIED Requirements

### Requirement: Filter routes

The invocations view SHALL expose five filter levels, each of which renders the same flat-list shape with the filter's scope applied:

- `GET /invocations` — every `(owner, repo)` the user has access to
- `GET /invocations/:owner` — every repo under `:owner`
- `GET /invocations/:owner/:repo` — that repo only
- `GET /invocations/:owner/:repo/:workflow` — invocations produced by triggers belonging to that workflow within `(owner, repo)`
- `GET /invocations/:owner/:repo/:workflow/:trigger` — invocations produced by that specific trigger

All routes SHALL require an authenticated session. `:owner` and `:repo` path parameters SHALL be validated against their regexes and SHALL enforce owner-membership via the shared authorization middleware; membership failure SHALL respond `404 Not Found` using the enumeration-prevention pattern.

The `:workflow` segment SHALL be considered to **exist** for the authorised `(owner, repo)` when it is present in the `WorkflowRegistry` **OR** when the EventStore holds at least one event for that `(owner, repo, workflow)`. The route SHALL respond `404 Not Found` (matching the response shape used for non-existent owner/repo) only when the supplied workflow name is in **neither** the registry **nor** the EventStore. This widening means a removed or renamed workflow that still has historical events remains navigable by URL; the existence probe SHALL be a bounded `LIMIT 1` lookup, not a full scan.

The `:trigger` segment SHALL NOT be separately validated for existence: a trigger name only narrows the EventStore query (`WHERE name = ?`), yielding an empty list when nothing matches. Validating it against the `name` column would wrongly `404` `trigger.exception` / `trigger.rejection` history, which stamps the trigger declaration name into `input.trigger` rather than the `name` column. A removed or renamed trigger therefore stays navigable whenever its owning workflow resolves (live in the registry, or present in history). Because membership is enforced before the workflow check, a non-member still receives `404` and the historical-existence widening confirms nothing beyond what the authorised member already owns.

Scope resolution is identical at every filter level — `resolveQueryScopes(user, registry, constraint?)` returns the `(owner, repo)` allow-list, narrowed by the URL's `owner`/`repo` when present. When the URL carries a `:workflow` segment without a `:trigger`, the EventStore query SHALL additionally constrain `WHERE workflow = ?` so rows belonging to other workflows in the same repo are excluded. When the URL carries `:workflow/:trigger`, the query SHALL additionally constrain `WHERE workflow = ? AND name = ?`.

#### Scenario: Per-workflow filter narrows by workflow

- **GIVEN** `(acme, foo)` has workflows `build` and `deploy`, each with multiple triggers and invocations
- **WHEN** a member of `acme` requests `GET /invocations/acme/foo/build`
- **THEN** rows SHALL include only invocations whose workflow is `build`
- **AND** rows belonging to workflow `deploy` SHALL NOT appear

#### Scenario: Per-trigger filter narrows by workflow + trigger

- **GIVEN** `(acme, foo)` has triggers `build/webhook` and `deploy/webhook`, each with multiple invocations
- **WHEN** a member of `acme` requests `GET /invocations/acme/foo/build/webhook`
- **THEN** rows SHALL include only `build/webhook` invocations
- **AND** rows for `deploy/webhook` SHALL NOT appear

#### Scenario: Non-member request at any filter level returns 404

- **WHEN** a user who is NOT a member of `evil-corp` requests `GET /invocations/evil-corp` or `GET /invocations/evil-corp/foo` or `GET /invocations/evil-corp/foo/build` or `GET /invocations/evil-corp/foo/build/webhook`
- **THEN** every route SHALL respond `404 Not Found`
- **AND** the response body SHALL be identical in shape to the response for a non-existent owner

#### Scenario: Workflow absent from both registry and history returns 404

- **GIVEN** `(acme, foo)` is registered with workflows `build` and `deploy` only, and the EventStore holds no events for any other workflow under `(acme, foo)`
- **WHEN** a member of `acme` requests `GET /invocations/acme/foo/no-such-workflow`
- **THEN** the response status SHALL be `404 Not Found`

#### Scenario: Removed workflow with history is navigable

- **GIVEN** `(acme, foo)` is registered with workflow `build` only, but the EventStore holds historical invocations for a workflow `deploy` that is no longer registered
- **WHEN** a member of `acme` requests `GET /invocations/acme/foo/deploy`
- **THEN** the response status SHALL be `200 OK`
- **AND** rows SHALL include the historical `deploy` invocations

#### Scenario: Removed trigger with history is navigable

- **GIVEN** workflow `deploy` is live (or present in history) but its trigger `legacy-run` has been removed, while the EventStore retains `deploy/legacy-run` invocations
- **WHEN** a member of `acme` requests `GET /invocations/acme/foo/deploy/legacy-run`
- **THEN** the response status SHALL be `200 OK` (the owning workflow resolves; the trigger segment only narrows the query)
- **AND** rows SHALL include only the historical `deploy/legacy-run` invocations

#### Scenario: Workflow URL under an empty registry does not 404

- **GIVEN** `(acme, foo)` has no registered workflows but the EventStore holds historical `trigger.exception` events for workflow `imap-poll`
- **WHEN** a member of `acme` requests `GET /invocations/acme/foo/imap-poll`
- **THEN** the response status SHALL be `200 OK`
- **AND** rows SHALL include the historical synthetic events

## ADDED Requirements

### Requirement: Removed trigger invocations are marked in the list

An invocation row whose `(workflow, trigger)` pair is no longer present in the `WorkflowRegistry` for its `(owner, repo)` SHALL be rendered as **removed**: with the `removed` (archive, muted) leading kind-indicator in place of a live trigger-kind icon, consistent with the removed node treatment in the navigation sidebar. The removed state SHALL be derived from the same registry lookup already performed to resolve a row's trigger kind — a lookup that yields no live kind indicates an removed trigger — and SHALL NOT require an additional per-row query.

Synthetic `system.upload` rows SHALL NOT be marked removed, because their `name` is a workflow name rather than a trigger name and would always fail the trigger lookup; removed-workflow awareness for uploads is conveyed by the removed workflow node in the sidebar tree instead.

#### Scenario: Row for a removed trigger renders the removed marker

- **GIVEN** the EventStore holds invocations for trigger `deploy/legacy-run` that is no longer in the registry
- **WHEN** the repo-wide list `GET /invocations/acme/foo` is rendered
- **THEN** the `deploy/legacy-run` rows SHALL render with the `removed` (archive, muted) leading indicator
- **AND** rows whose trigger is still live SHALL render with their live trigger-kind icon

#### Scenario: Upload rows are never marked removed

- **GIVEN** a live workflow `deploy` with a synthetic `system.upload` invocation, and a separately removed workflow `imap-poll` with a `system.upload` invocation
- **WHEN** the repo-wide list is rendered
- **THEN** neither `system.upload` row SHALL carry the `removed` marker
- **AND** the `system.upload` rows SHALL retain their `upload`-kind leading icon
