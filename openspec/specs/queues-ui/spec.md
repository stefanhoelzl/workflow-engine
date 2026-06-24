# queues-ui Specification

## Purpose

Provide a read-only HTTP UI surface at `/queue` for inspecting per-workflow durable FIFO queues. Mirrors `/trigger`'s scope-based routing (`/queue`, `/queue/:owner`, `/queue/:owner/:repo`, `/queue/:owner/:repo/:workflow`) and shares the authentication contract: sealed session cookie + `requireOwnerMember()`, fail-closed 404 on non-membership. Each declared queue renders as a card showing an item count; expanding a card lazily fetches a server-rendered HTML fragment of items (default 50 per page, FIFO order) which paginate via a "Load more" control. Items render through the shared interactive JSON-tree component defined in `ui-foundation`. The surface is strictly read-only — no mutating routes (clear, peek-pop, enqueue) and no new sandbox or SDK API. Host-side reads use the contract documented in the `queues` capability (Host-side read-only inspection).
## Requirements
### Requirement: Queue UI middleware factory

The runtime SHALL expose a `/queue` middleware factory that mounts scope-filtered routes mirroring the trigger UI's filter levels:

- `GET /queue` — every queue card across every `(owner, repo)` the authenticated user has access to.
- `GET /queue/:owner` — every queue card across `:owner`'s repos.
- `GET /queue/:owner/:repo` — every queue card under `(owner, repo)`, grouped by workflow.
- `GET /queue/:owner/:repo/:workflow` — every queue card belonging to that workflow within `(owner, repo)`.
- `GET /queue/:owner/:repo/:workflow/:queue/items` — server-rendered HTML fragment containing items `[offset, offset+50)` from the named queue. The `offset` query parameter SHALL default to `0`. The fragment SHALL NOT be a full HTML document.

All routes SHALL require an authenticated session via the same middleware used by `/trigger`. `:owner` and `:repo` path parameters SHALL be validated against their existing regexes and enforced via `requireOwnerMember()`; membership failure SHALL respond `404 Not Found` indistinguishably from a non-existent owner/repo. The `:workflow` and `:queue` segments SHALL be resolved against the workflow registry's manifest for the authorised `(owner, repo)`; references to undeclared workflows or queues SHALL respond `404 Not Found`.

The middleware SHALL be mounted under `/queue` on the same Hono application that hosts `/trigger` and `/invocations`.

#### Scenario: Repo view lists queues grouped by workflow

- **GIVEN** `(acme, foo)` has two registered workflows, each declaring at least one queue
- **WHEN** a member of `acme` requests `GET /queue/acme/foo`
- **THEN** the response SHALL list every declared queue card for `(acme, foo)`, grouped by workflow
- **AND** SHALL NOT include queues from any other `(owner, repo)`

#### Scenario: Workflow view lists queues for one workflow

- **GIVEN** `(acme, foo)` has workflows `build` and `deploy`, only `build` declaring queues
- **WHEN** a member of `acme` requests `GET /queue/acme/foo/build`
- **THEN** the response SHALL list every declared queue card belonging to workflow `build`
- **AND** SHALL NOT include cards for workflow `deploy`

#### Scenario: Owner view lists queue cards across the owner's repos

- **GIVEN** member-of-`acme` user, with workflows declaring queues registered under `(acme, foo)` and `(acme, bar)`
- **WHEN** the user requests `GET /queue/acme`
- **THEN** the response SHALL list every declared queue card across both `(acme, foo)` and `(acme, bar)`

#### Scenario: Non-member is denied at any filter level

- **WHEN** a user who is NOT a member of `victim-org` requests `GET /queue/victim-org`, `GET /queue/victim-org/foo`, `GET /queue/victim-org/foo/build`, `GET /queue/victim-org/foo/build/jobs`, or `GET /queue/victim-org/foo/build/jobs/items`
- **THEN** the runtime SHALL respond `404 Not Found`
- **AND** the response SHALL be indistinguishable from the response for a non-existent owner

#### Scenario: Items fragment endpoint returns HTML fragment, not a full document

- **GIVEN** queue `acme/foo/build/jobs` with at least one item
- **WHEN** a member of `acme` requests `GET /queue/acme/foo/build/jobs/items`
- **THEN** the response SHALL have status `200`
- **AND** the response body SHALL NOT contain `<html>`, `<head>`, or `<body>` elements
- **AND** the response body SHALL contain one rendered `<article>` (or equivalent block) per included item

### Requirement: Queue cards listed at scope level

Each scope page (`/queue`, `/queue/:owner`, `/queue/:owner/:repo`, `/queue/:owner/:repo/:workflow`) SHALL render one collapsed card per *declared* queue within that scope. Queues are declared via `defineQueue` in workflow code and surfaced through the workflow registry's manifest. Workflows that declare no queues SHALL NOT appear on the page in any form. Queues that are declared but currently empty SHALL appear with an item count of `0`.

Each card SHALL display:

- A title in adaptive form: at root scope (`/queue`), the full path `<owner>/<repo>/<workflow>/<queue>`; at `/queue/:owner`, `<repo>/<workflow>/<queue>`; at `/queue/:owner/:repo`, `<workflow>/<queue>`; at `/queue/:owner/:repo/:workflow`, just `<queue>`.
- The current item count of the queue, computed at request time.

Cards SHALL be implemented as native `<details>` elements (matching the existing `/trigger` pattern), so expansion is a CSS-only toggle that requires no JavaScript state. The collapsed card body SHALL be empty until the user expands it.

#### Scenario: Empty declared queue renders with count zero

- **GIVEN** workflow `acme/foo/build` declares queue `jobs` and no items have ever been put
- **WHEN** a member of `acme` requests `GET /queue/acme/foo/build`
- **THEN** the response SHALL contain a card titled `jobs` with item count `0`

#### Scenario: Workflow with no declared queues is omitted

- **GIVEN** workflow `acme/foo/deploy` declares no queues, while `acme/foo/build` declares queue `jobs`
- **WHEN** a member of `acme` requests `GET /queue/acme/foo`
- **THEN** the response SHALL contain a card for `build/jobs`
- **AND** the response SHALL NOT contain any card or section attributable to `deploy`

#### Scenario: Adaptive title at root scope shows full breadcrumb

- **WHEN** a member with access to `acme/foo` and `acme/bar` requests `GET /queue`
- **AND** both repos have a workflow named `build` declaring a queue named `jobs`
- **THEN** the page SHALL render two cards titled `acme/foo/build/jobs` and `acme/bar/build/jobs` respectively

#### Scenario: Adaptive title at workflow scope shows queue name only

- **WHEN** a member of `acme` requests `GET /queue/acme/foo/build`
- **AND** the workflow declares queues `jobs` and `retries`
- **THEN** the page SHALL render two cards titled `jobs` and `retries`

### Requirement: Lazy items fragment on card expand with load-more

When a queue card is expanded for the first time on the client, the page SHALL fetch `GET /queue/:owner/:repo/:workflow/:queue/items?offset=0` and append the returned HTML fragment to the card body. Subsequent expansion of the same card within the same page load SHALL NOT refetch (the fragment is cached in DOM).

The fragment SHALL contain at most 50 items, rendered in FIFO order (oldest first — i.e. the next item to be dequeued appears first). Each item SHALL be rendered as a row using the shared `EntryRow` component defined in `ui-foundation`. The collapsed row SHALL show:

- the trigger-kind icon via the existing `TriggerKindIcon` component (kind sourced from the row's `trigger_kind` metadata column);
- a `›`-separated identity, scope-aware: at `/queue` show `owner/repo › workflow › trigger_name`; at narrower scopes the redundant leading segments SHALL be omitted such that the deepest scope segment shown matches the page's scope;
- a right-aligned relative-age cell sourced from the row's `enqueued_at` metadata column.

The collapsed row SHALL NOT show a JSON preview or any portion of the item payload. The expanded body SHALL render the item payload via the shared interactive JSON-tree component (`wfeJsonTree`, mandated by `ui-foundation` §"Shared interactive JSON-tree component"). The expanded body SHALL be lazy-mounted on first open per the existing card-expand pattern.

When the queue contains more items than have been loaded so far, the fragment SHALL include a "Load more" control whose activation issues `GET /queue/.../items?offset=N` (where `N` is the count of items already loaded) and appends the resulting fragment to the card body. When no further items remain, the fragment SHALL NOT include a "Load more" control.

The fragment endpoint SHALL be idempotent and side-effect-free; it SHALL NOT mutate queue contents.

#### Scenario: First expand fetches first 50 items

- **GIVEN** queue `acme/foo/build/jobs` contains 120 items
- **WHEN** a member of `acme` expands the `jobs` card on `/queue/acme/foo/build`
- **THEN** the client SHALL fetch `GET /queue/acme/foo/build/jobs/items` (or with `?offset=0`)
- **AND** the response SHALL contain 50 row elements rendered via `EntryRow`
- **AND** each row's collapsed view SHALL show the trigger-kind icon, the trigger-name identity segment, and a relative age — and SHALL NOT contain any element bearing the item payload's JSON
- **AND** the response SHALL contain a "Load more" control

#### Scenario: Expanded row reveals the JSON tree via the shared component

- **GIVEN** a fragment row whose item is `{"orderId": 42, "items": [{"sku": "X"}]}`
- **WHEN** the user activates the row's disclosure control
- **THEN** the row's body SHALL be populated with the shared `wfeJsonTree` component bound to the item value
- **AND** the row's body SHALL NOT contain a `<pre>` block whose textContent is `JSON.stringify` of that item

#### Scenario: Load more appends next 50 items

- **GIVEN** the user has already loaded the first 50 items of a 120-item queue
- **WHEN** the user activates the "Load more" control
- **THEN** the client SHALL fetch `GET /queue/.../jobs/items?offset=50`
- **AND** the response SHALL contain 50 further rows rendered via `EntryRow`
- **AND** the response SHALL contain a "Load more" control (since 70 items remain)

#### Scenario: Last page hides load-more control

- **GIVEN** the user has loaded items `[0, 100)` of a 120-item queue
- **WHEN** the user activates the "Load more" control with `offset=100`
- **THEN** the response SHALL contain 20 rows
- **AND** the response SHALL NOT contain a "Load more" control

#### Scenario: Empty queue fragment renders an empty-state, not a load-more

- **GIVEN** queue `jobs` contains 0 items
- **WHEN** the items fragment endpoint is requested with `offset=0`
- **THEN** the response SHALL contain zero rows
- **AND** the response SHALL NOT contain a "Load more" control
- **AND** the response MAY contain an empty-state message

#### Scenario: Items fragment is read-only

- **GIVEN** queue `jobs` contains items `[A, B, C]`
- **WHEN** the items fragment endpoint is requested
- **AND** subsequently a guest `get()` call dequeues `A`
- **THEN** the second `get()` SHALL pop `B` (i.e. the items fragment did NOT consume `A`)

### Requirement: Item rendering via shared JSON-tree component

Each item within an items fragment SHALL be rendered using the shared interactive JSON-tree component defined in `ui-foundation`, mounted inside the row body revealed by expanding the row's `EntryRow`. The component's default state for queue items SHALL be fully expanded. The fragment SHALL NOT render items as plain `<pre>` blocks containing `JSON.stringify` output, AND SHALL NOT render any preview, fragment, or partial of the item payload in the collapsed row.

#### Scenario: Items render via the JSON-tree component on expand

- **GIVEN** queue `jobs` contains item `{"orderId": 42, "items": [{"sku": "X"}]}`
- **WHEN** the items fragment for the queue is requested
- **AND** the user expands the row for that item
- **THEN** the expanded body SHALL contain the item rendered as the shared JSON-tree component's markup (e.g. an element bound to the registered Alpine component name)
- **AND** the response SHALL NOT contain a `<pre>` block whose textContent is `JSON.stringify` of that item

#### Scenario: Collapsed row contains no item payload content

- **GIVEN** queue `jobs` contains item `{"url": "https://example.com", "retries": 0}`
- **WHEN** the items fragment is requested
- **AND** the user has NOT expanded any row
- **THEN** the response's collapsed-row markup SHALL NOT contain the string `"https://example.com"`, the string `"retries"`, or any other token derived from the item payload
- **AND** the response's collapsed-row markup MAY contain values derived from producer metadata (e.g. the trigger name `submitJob`)

### Requirement: Queues tab in the in-page tab strip

The `Queues` tab SHALL appear in the shared in-page tab strip alongside `Invocations` and `Trigger`, with `href` pointing to `/queue` (preserving the current scope path) per `shared-layout`'s tab requirement.

#### Scenario: Queues tab is visible on every authenticated surface

- **WHEN** any authenticated UI surface is rendered (`/invocations/*`, `/trigger/*`, or `/queue/*`)
- **THEN** the in-page tab strip SHALL include a `Queues` tab linking to `/queue/<rest>`

#### Scenario: Active state on queue surface

- **GIVEN** the user is on `/queue/acme/foo/build`
- **WHEN** the tab strip is rendered
- **THEN** the `Queues` tab SHALL render in the active state
- **AND** the `Invocations` and `Trigger` tabs SHALL render in the inactive state

