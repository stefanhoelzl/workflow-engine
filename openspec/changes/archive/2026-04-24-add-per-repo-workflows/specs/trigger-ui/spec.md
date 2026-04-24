## MODIFIED Requirements

### Requirement: Trigger middleware factory

The runtime SHALL expose a `/trigger` middleware factory that mounts drill-down routes mirroring the dashboard shape plus a single-trigger focus view:

- `GET /trigger` — cross-owner tree. Every owner the user is a member of renders as a collapsible node; expanding shows that owner's repos as inline-expandable nodes whose bodies lazy-load trigger cards via HTMX.
- `GET /trigger/:owner` — owner-scope tree with `:owner` pre-expanded; repos beneath it lazy-load trigger cards on expand. Clicking a repo in this tree expands it inline and does NOT change the URL.
- `GET /trigger/:owner/:repo` — repo leaf. Renders every trigger card for `(owner, repo)` grouped by workflow.
- `GET /trigger/:owner/:repo/:workflow/:trigger` — single-trigger focus view. Renders only the named trigger's card, pre-expanded with its form ready.
- `POST /trigger/:owner/:repo/:workflow/:trigger` — manual fire endpoint (see `manual-trigger` spec). Same path as the GET; Hono dispatches by method.

All GET routes SHALL require an authenticated session. `:owner` and `:repo` path parameters SHALL be validated against their regexes and enforced via `requireOwnerMember()`; membership failure SHALL respond `404 Not Found`.

#### Scenario: Leaf view lists triggers for the exact scope

- **GIVEN** `(acme, foo)` has two registered workflows with triggers
- **WHEN** a member of `acme` requests `GET /trigger/acme/foo`
- **THEN** the response SHALL list both workflows' triggers
- **AND** SHALL NOT include triggers from any other `(owner, repo)`

#### Scenario: Non-member is denied at any drill-down level

- **WHEN** a user who is NOT a member of `victim-org` requests `GET /trigger/victim-org`, `GET /trigger/victim-org/foo`, or `GET /trigger/victim-org/foo/deploy/run`
- **THEN** the runtime SHALL respond `404 Not Found`
- **AND** the response SHALL be indistinguishable from the response for a non-existent owner

### Requirement: Triggers grouped by workflow

At the leaf view (`/trigger/:owner/:repo`) and at the single-trigger view (`/trigger/:owner/:repo/:workflow/:trigger`), trigger cards SHALL be rendered at the top level grouped by their declaring workflow under a `<section>` per workflow. The single-trigger view SHALL filter this grouping down to exactly one card.

At the owner-scope view (`/trigger/:owner`) and at the root view (`/trigger`), the top-level container SHALL be the tree: owners on top, repos nested under owners (when expanded), trigger cards nested inside repos (when expanded).

#### Scenario: Leaf view groups cards by workflow

- **GIVEN** `GET /trigger/acme/foo` is requested and `(acme, foo)` declares two workflows each with multiple triggers
- **WHEN** the response is rendered
- **THEN** cards SHALL be grouped under a `<section>` per workflow
- **AND** the page header SHALL identify the current scope as `acme / foo`

## ADDED Requirements

### Requirement: Single-trigger focused page

The runtime SHALL expose `GET /trigger/:owner/:repo/:workflow/:trigger` that renders exactly one trigger card, pre-expanded (`<details open>`), with its form ready for immediate input. The page SHALL carry the same shell (sidebar, topbar, breadcrumb) as the other trigger views.

The breadcrumb SHALL show `Trigger / owner / repo / workflow / trigger` with every segment above the current one as a link to its broader scope.

When `(workflow, trigger)` does not match any registered descriptor in the `(owner, repo)` bundle, the page SHALL render an `empty-state` message saying "Trigger not found" — it SHALL NOT respond `404`, because the `(owner, repo)` is legitimate and authorisation has already passed (the operator should see "the trigger was deleted", not "the owner does not exist").

The form inside the pre-opened `<details>` SHALL initialise on page load. Because `toggle` never fires for a server-opened `<details>`, the trigger-forms JS SHALL also initialise every already-open trigger card during `DOMContentLoaded`; this is the only code path that reaches pre-opened cards.

#### Scenario: Single-trigger page pre-expands the card

- **WHEN** `GET /trigger/acme/foo/deploy/run` is requested by a member of `acme` and `(acme, foo)` declares workflow `deploy` with trigger `run`
- **THEN** the response SHALL contain exactly one `<details>` element for the `run` trigger
- **AND** that `<details>` SHALL carry the `open` attribute
- **AND** its form controls SHALL be initialised (input editors present) without the user needing to click the summary

#### Scenario: Missing trigger under a valid scope renders empty state

- **GIVEN** `(acme, foo)` is registered but declares no trigger `build/deleted`
- **WHEN** a member of `acme` requests `GET /trigger/acme/foo/build/deleted`
- **THEN** the response status SHALL be `200 OK`
- **AND** the body SHALL contain a "Trigger not found" message
- **AND** SHALL NOT be a `404 Not Found`

### Requirement: HTMX fragment for repo trigger cards

The runtime SHALL expose `GET /trigger/:owner/:repo/cards` that returns the same workflow-grouped cards fragment rendered inline in the leaf view, without the page shell. The `/trigger/:owner` tree uses this endpoint via `hx-get` + `hx-trigger="toggle once"` to lazy-load each repo's cards when its `<details>` is opened.

#### Scenario: Repo expand in tree triggers HTMX fragment

- **GIVEN** the `foo` `<details>` (nested under `acme`) is collapsed on `/trigger/acme`
- **WHEN** the user expands it
- **THEN** HTMX SHALL fire `GET /trigger/acme/foo/cards` with `hx-trigger="toggle once"`
- **AND** the response SHALL contain the trigger cards for `(acme, foo)` grouped by workflow
- **AND** the URL in the browser SHALL remain `/trigger/acme`
