## ADDED Requirements

### Requirement: List correlation summaries
The system SHALL serve an HTML fragment at `GET /dashboard/list` containing one entry row per `correlationId`.

#### Scenario: Entry row content
- **WHEN** the list fragment is requested
- **THEN** each row displays: a colored state dot, the initial event type (root event where `parentEventId` is null), the count of distinct events, and the timestamp of the most recent event

#### Scenario: Empty state
- **WHEN** the list fragment is requested and no events exist in the EventStore
- **THEN** the response contains an empty state message

### Requirement: Aggregate state derivation
The system SHALL derive an aggregate state per `correlationId` from the current states of its events.

#### Scenario: Pending state
- **WHEN** any event in the correlationId has current state `pending` or `processing`
- **THEN** the aggregate state is `pending` (yellow pulsing dot, PENDING badge)

#### Scenario: Failed state
- **WHEN** no events are `pending` or `processing` and any event has current state `failed`
- **THEN** the aggregate state is `failed` (red dot, FAILED badge)

#### Scenario: Done state
- **WHEN** all events have current state `done` or `skipped`
- **THEN** the aggregate state is `done` (green dot, DONE badge)

### Requirement: Sort order
The system SHALL sort entries with pending items first, then all remaining entries by latest event timestamp descending.

#### Scenario: Pending entries float to top
- **WHEN** the list contains entries with mixed states
- **THEN** all pending entries appear before failed and done entries
- **THEN** within each group, entries are ordered by latest event timestamp descending

### Requirement: State filter
The system SHALL support filtering by aggregate state via a query parameter.

#### Scenario: Filter by pending
- **WHEN** `GET /dashboard/list?state=pending` is requested
- **THEN** only entries with aggregate state `pending` are returned

#### Scenario: Filter by failed
- **WHEN** `GET /dashboard/list?state=failed` is requested
- **THEN** only entries with aggregate state `failed` are returned

#### Scenario: Filter by done
- **WHEN** `GET /dashboard/list?state=done` is requested
- **THEN** only entries with aggregate state `done` are returned

#### Scenario: No filter (all)
- **WHEN** `GET /dashboard/list` is requested without a `state` parameter
- **THEN** entries of all states are returned

### Requirement: Event type filter
The system SHALL support filtering by initial event type via a query parameter.

#### Scenario: Filter by event type
- **WHEN** `GET /dashboard/list?type=order.created` is requested
- **THEN** only entries whose root event type is `order.created` are returned

#### Scenario: Filter dropdown options
- **WHEN** the page is rendered
- **THEN** the event type dropdown contains all distinct event types where `parentEventId` is null

### Requirement: Infinite scroll pagination
The system SHALL support cursor-based pagination for the entry list.

#### Scenario: Initial page load
- **WHEN** `GET /dashboard/list` is requested without a cursor
- **THEN** the first page of entries is returned
- **THEN** the response includes a sentinel element with `hx-trigger="revealed"` pointing to the next page

#### Scenario: Load more on scroll
- **WHEN** the sentinel element scrolls into the viewport
- **THEN** HTMX requests `GET /dashboard/list?cursor=<value>`
- **THEN** the next page of entries is appended after the current entries

#### Scenario: Last page
- **WHEN** there are no more entries beyond the cursor
- **THEN** no sentinel element is included in the response

### Requirement: Header stats
The system SHALL display summary counts in the page header.

#### Scenario: Stats display
- **WHEN** the dashboard page is loaded
- **THEN** the header shows the count of correlationIds in each aggregate state (pending, failed, done)
