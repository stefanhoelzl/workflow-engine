## MODIFIED Requirements

### Requirement: Lazy items fragment on card expand with load-more

When a queue card is expanded for the first time on the client, the page SHALL fetch `GET /queue/:owner/:repo/:workflow/:queue/items?offset=0` and append the returned HTML fragment to the card body. Subsequent expansion of the same card within the same page load SHALL NOT refetch (the fragment is cached in DOM).

The fragment SHALL contain at most 50 items, rendered in FIFO order (oldest first — i.e. the next item to be dequeued appears first). Items of every key partition SHALL be listed together in one interleaved FIFO stream ordered by `seq`; the fragment SHALL NOT split, group, or paginate by key. Each item SHALL be rendered as a row using the shared `EntryRow` component defined in `ui-foundation`. The collapsed row SHALL show:

- the trigger-kind icon via the existing `TriggerKindIcon` component (kind sourced from the row's `trigger_kind` metadata column);
- a `›`-separated identity, scope-aware: at `/queue` show `owner/repo › workflow › trigger_name`; at narrower scopes the redundant leading segments SHALL be omitted such that the deepest scope segment shown matches the page's scope;
- a `key` badge sourced from the row's `key` column, indicating which partition the item belongs to; a row whose `key` is the empty string (the unkeyed partition) SHALL render without a key badge (or with a neutral `—` placeholder), visually distinct from a non-empty key. The key badge is *addressing* metadata and SHALL be visually distinguishable from the provenance identity segment;
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

#### Scenario: Keyed rows show a key badge; unkeyed rows do not

- **GIVEN** queue `acme/foo/build/jobs` contains one item under key `"alice"` and one item under the unkeyed partition
- **WHEN** a member of `acme` expands the `jobs` card
- **THEN** the row for the keyed item SHALL render a key badge showing `alice`
- **AND** the row for the unkeyed item SHALL NOT render a non-empty key badge
- **AND** both rows SHALL appear in one interleaved list ordered by `seq`

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
