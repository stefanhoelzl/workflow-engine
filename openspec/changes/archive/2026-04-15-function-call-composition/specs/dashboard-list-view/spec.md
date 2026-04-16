## ADDED Requirements

### Requirement: Dashboard lists invocations

The dashboard SHALL render a single page listing invocations from the EventStore, ordered by `startedAt` descending. Each row SHALL display: workflow, trigger, status (`pending` / `succeeded` / `failed`), `startedAt`, and duration (`completedAt - startedAt` when available).

#### Scenario: Latest invocations rendered

- **GIVEN** an EventStore with N invocation rows
- **WHEN** the dashboard list page is requested
- **THEN** the response SHALL contain rows for the most recent invocations sorted by `startedAt` descending
- **AND** each row SHALL show workflow, trigger, status, started timestamp, and duration

#### Scenario: Pending invocation has no duration

- **GIVEN** an in-flight invocation with no `completedAt`
- **WHEN** the dashboard list page is rendered
- **THEN** the duration column SHALL show "—" or be empty for that row

### Requirement: No filters or detail page in v1

The v1 dashboard SHALL NOT support filters (by workflow, trigger, status, time range), detail pages per invocation, replay/retry buttons, flame graph rendering, or live-streaming updates.

#### Scenario: List is the only dashboard view

- **WHEN** the user navigates to any dashboard URL other than the list
- **THEN** the response SHALL be `404` (or the request SHALL be redirected to the list)

## REMOVED Requirements

### Requirement: Dashboard renders correlation-grouped event timeline

**Reason**: Correlation IDs and event timelines are tied to the event-graph model that is removed in v1. The dashboard list view shows invocations directly; cross-invocation correlation is deferred until subscribers and/or events are reintroduced.

**Migration**: For v1, the dashboard list view replaces the timeline. A future timeline view can be reintroduced when subscribers/events return.
