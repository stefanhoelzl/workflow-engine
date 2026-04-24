## MODIFIED Requirements

### Requirement: Trigger middleware factory

The runtime SHALL expose a `/trigger` middleware factory that mounts drill-down routes mirroring the dashboard:

- `GET /trigger` — cross-owner view. Lists all triggers across every `(owner, repo)` the user has access to, grouped by owner then repo via the same collapsible-tree pattern as the dashboard.
- `GET /trigger/:owner` — owner-scope view. Lists triggers across every repo under `:owner`, grouped by repo.
- `GET /trigger/:owner/:repo` — leaf-scope view. Lists triggers for `(owner, repo)` (flat list matching the pre-drill-down UX).
- `POST /trigger/:owner/:repo/:workflow/:trigger` — manual fire endpoint (see `manual-trigger` spec).

All GET routes SHALL require an authenticated session. `:owner` and `:repo` path parameters SHALL be validated against their regexes and enforced via `requireOwnerMember()`; membership failure SHALL respond `404 Not Found`.

Each scoped GET route SHALL resolve its trigger allow-list as follows:

- `/trigger` → every registered trigger under every `(owner, repo)` the user is a member of.
- `/trigger/:owner` → every registered trigger under repos of `:owner`.
- `/trigger/:owner/:repo` → every registered trigger in `(owner, repo)`.

#### Scenario: Leaf view lists triggers for the exact scope

- **GIVEN** `(acme, foo)` has two registered workflows with triggers
- **WHEN** a member of `acme` requests `GET /trigger/acme/foo`
- **THEN** the response SHALL list both workflows' triggers
- **AND** SHALL NOT include triggers from any other `(owner, repo)`

#### Scenario: Non-member is denied at any drill-down level

- **WHEN** a user who is NOT a member of `victim-org` requests `GET /trigger/victim-org` or `GET /trigger/victim-org/foo`
- **THEN** the runtime SHALL respond `404 Not Found`
- **AND** the response SHALL be indistinguishable from the response for a non-existent owner

### Requirement: Triggers grouped by workflow

At the leaf view (`/trigger/:owner/:repo`), triggers SHALL be grouped by their declaring workflow under a collapsible `<details>` per workflow. This matches the pre-drill-down UX at the finest scope.

At the owner-scope view (`/trigger/:owner`), the top level SHALL be one `<details>` per repo; within each repo, triggers SHALL be grouped by workflow as at the leaf view.

At the root view (`/trigger`), the top level SHALL be one `<details>` per owner; within each owner, one `<details>` per repo; within each repo, triggers grouped by workflow.

#### Scenario: Root view renders owner → repo → workflow hierarchy

- **GIVEN** a user with scope allow-list `[(acme, foo), (acme, bar), (alice, utils)]`, each with 2 workflows and several triggers per workflow
- **WHEN** `GET /trigger` is requested
- **THEN** the response SHALL contain two top-level `<details>` for `acme` and `alice`
- **AND** under `acme`, two nested `<details>` for `foo` and `bar`
- **AND** within each repo, one `<details>` per workflow with its triggers inside

#### Scenario: Leaf view omits owner/repo levels

- **GIVEN** `GET /trigger/acme/foo` is requested by a member of `acme`
- **WHEN** the response is rendered
- **THEN** the top-level groups SHALL be workflows (no owner or repo wrapper)
- **AND** the page header SHALL identify the current scope as `acme / foo`

### Requirement: HTTP trigger cards submit through /trigger/*

HTTP trigger cards rendered at any `/trigger/*` scope SHALL submit through the `POST /trigger/:owner/:repo/:workflow/:trigger` endpoint (the same kind-agnostic endpoint used by manual triggers). The card SHALL derive its scope from the current view: at `/trigger/:owner/:repo`, the scope is unambiguous; at `/trigger/:owner` and `/trigger`, each card SHALL carry its scope identifiers in hidden form fields or data attributes so the submission targets the correct `(owner, repo)`.

#### Scenario: Card at root view includes scope in submission

- **GIVEN** `GET /trigger` renders a card for trigger `deploy/webhook` under `(acme, foo)`
- **WHEN** the user submits the card
- **THEN** the submission SHALL POST to `/trigger/acme/foo/deploy/webhook`
- **AND** the POST body SHALL match the trigger's input schema
