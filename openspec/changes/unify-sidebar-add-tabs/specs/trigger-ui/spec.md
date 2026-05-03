## MODIFIED Requirements

### Requirement: Trigger middleware factory

The runtime SHALL expose a `/trigger` middleware factory that mounts scope-filtered routes mirroring the dashboard's filter levels:

- `GET /trigger` — every trigger card across every `(owner, repo)` the user has access to.
- `GET /trigger/:owner` — every trigger card across `:owner`'s repos.
- `GET /trigger/:owner/:repo` — every trigger card under `(owner, repo)`, grouped by workflow.
- `GET /trigger/:owner/:repo/:workflow` — every trigger card belonging to that workflow within `(owner, repo)`.
- `GET /trigger/:owner/:repo/:workflow/:trigger` — single-trigger focus view; renders only the named trigger's card, pre-expanded with its form ready.
- `POST /trigger/:owner/:repo/:workflow/:trigger` — manual fire endpoint (see `manual-trigger` spec). Same path as the GET; Hono dispatches by method.

Each GET route SHALL render a flat list of trigger cards filtered to the URL's scope. The view SHALL NOT contain a tree, an inline-expandable owner/repo control, or any HTMX fragment lazy-loading per scope. Navigation between scopes is the responsibility of the shared sidebar tree (`shared-layout`); the main view always reflects the current URL's scope as flat content.

All GET routes SHALL require an authenticated session. `:owner` and `:repo` path parameters SHALL be validated against their regexes and enforced via `requireOwnerMember()`; membership failure SHALL respond `404 Not Found`. The `:workflow` segment SHALL be resolved against the `WorkflowRegistry` for the authorised `(owner, repo)`; if no workflow with the supplied name is registered, the route SHALL respond `404 Not Found` matching the response shape used for non-existent owner/repo. The `:trigger` segment retains the empty-state behaviour described in "Single-trigger focused page" — a missing trigger under a valid `(owner, repo, workflow)` renders an empty-state message rather than a 404.

#### Scenario: Repo view lists triggers grouped by workflow

- **GIVEN** `(acme, foo)` has two registered workflows each with multiple triggers
- **WHEN** a member of `acme` requests `GET /trigger/acme/foo`
- **THEN** the response SHALL list every trigger card for `(acme, foo)`, grouped by workflow under a `<section>` per workflow
- **AND** SHALL NOT include triggers from any other `(owner, repo)`

#### Scenario: Workflow view lists triggers for one workflow

- **GIVEN** `(acme, foo)` has workflows `build` and `deploy`, each with multiple triggers
- **WHEN** a member of `acme` requests `GET /trigger/acme/foo/build`
- **THEN** the response SHALL list every trigger card belonging to workflow `build`
- **AND** SHALL NOT include cards for workflow `deploy` or any other `(owner, repo)`

#### Scenario: Owner view lists trigger cards across the owner's repos

- **GIVEN** member-of-`acme` user, with workflows registered under `(acme, foo)` and `(acme, bar)`
- **WHEN** the user requests `GET /trigger/acme`
- **THEN** the response SHALL list every trigger card across both `(acme, foo)` and `(acme, bar)`
- **AND** SHALL NOT contain a tree or per-repo lazy-load control

#### Scenario: Non-member is denied at any filter level

- **WHEN** a user who is NOT a member of `victim-org` requests `GET /trigger/victim-org`, `GET /trigger/victim-org/foo`, `GET /trigger/victim-org/foo/build`, or `GET /trigger/victim-org/foo/deploy/run`
- **THEN** the runtime SHALL respond `404 Not Found`
- **AND** the response SHALL be indistinguishable from the response for a non-existent owner

#### Scenario: Nonexistent workflow returns 404

- **GIVEN** `(acme, foo)` is registered with workflows `build` and `deploy` only
- **WHEN** a member of `acme` requests `GET /trigger/acme/foo/no-such-workflow`
- **THEN** the response status SHALL be `404 Not Found`
- **AND** the response body SHALL be identical in shape to the response for a non-existent owner or repo

### Requirement: Triggers grouped by workflow

At the repo view (`GET /trigger/:owner/:repo`), the workflow view (`GET /trigger/:owner/:repo/:workflow`), and the single-trigger view (`GET /trigger/:owner/:repo/:workflow/:trigger`), trigger cards SHALL be rendered grouped by their declaring workflow under a `<section>` per workflow. The workflow view SHALL filter this grouping down to the named workflow's section; the single-trigger view SHALL filter further to exactly one card.

At the owner view (`GET /trigger/:owner`) and the root view (`GET /trigger`), trigger cards SHALL be rendered grouped first by `(owner, repo)` and then by workflow within each repo. The grouping is a flat layout — there SHALL NOT be an inline-expandable tree, lazy-loaded fragment, or HTMX-driven progressive disclosure. All cards within the URL scope are rendered in the initial response.

#### Scenario: Repo view groups cards by workflow

- **GIVEN** `GET /trigger/acme/foo` is requested and `(acme, foo)` declares two workflows each with multiple triggers
- **WHEN** the response is rendered
- **THEN** cards SHALL be grouped under a `<section>` per workflow
- **AND** the page header SHALL identify the current scope as `acme / foo`

#### Scenario: Workflow view renders one workflow section

- **GIVEN** `GET /trigger/acme/foo/deploy` is requested and `(acme, foo)` declares workflows `build` and `deploy`
- **WHEN** the response is rendered
- **THEN** cards SHALL be rendered under exactly one `<section>` for workflow `deploy`
- **AND** no `<section>` for workflow `build` SHALL appear

#### Scenario: Owner view renders flat list grouped by repo and workflow

- **GIVEN** `GET /trigger/acme` is requested and `acme` owns `(acme, foo)` and `(acme, bar)` each with workflows and triggers
- **WHEN** the response is rendered
- **THEN** every trigger card under both repos SHALL be rendered in the initial HTML response
- **AND** the response SHALL NOT contain `hx-get`, `hx-trigger`, or any HTMX-driven lazy-loading attribute on a card-bearing container

## REMOVED Requirements

### Requirement: HTMX fragment for repo trigger cards

**Reason**: The `/trigger` main view no longer contains an inline-expandable tree of repos and cards. The shared sidebar tree (`shared-layout`) is the sole navigator for both surfaces; the trigger main view is a flat list of cards filtered to the current URL scope. With no inline expansion, the lazy-load fragment endpoint that backed it is unreachable.

**Migration**: No external migration is required — the fragment endpoint (`GET /trigger/:owner/:repo/cards`) was an internal HTMX target consumed only by the now-removed inline-expansion UI. Internal callers SHALL navigate to the corresponding scope-filtered route instead (`GET /trigger/:owner/:repo` or `GET /trigger/:owner/:repo/:workflow`), which renders the equivalent cards with the page shell included. The companion repo-list fragment endpoint (`GET /trigger/:owner/repos`) was likewise consumed only by the removed inline-expansion control on `/trigger/:owner` and is removed alongside this requirement.
