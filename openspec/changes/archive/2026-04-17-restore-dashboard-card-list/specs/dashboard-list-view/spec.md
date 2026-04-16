## MODIFIED Requirements

### Requirement: Dashboard lists invocations

The dashboard SHALL render invocations from the EventStore, ordered by `startedAt` descending. Each rendered invocation SHALL display: workflow, trigger, status (`pending` / `succeeded` / `failed`), `startedAt`, and duration (`completedAt - startedAt` when available).

#### Scenario: Latest invocations rendered

- **GIVEN** an EventStore with N invocation rows
- **WHEN** the invocation list is rendered
- **THEN** the response SHALL contain an entry per most-recent invocation sorted by `startedAt` descending
- **AND** each entry SHALL show workflow, trigger, status, started timestamp, and duration

#### Scenario: Pending invocation has no duration

- **GIVEN** an in-flight invocation with no `completedAt`
- **WHEN** the invocation list is rendered
- **THEN** the duration field for that entry SHALL display an empty indicator (e.g. `—`)

#### Scenario: Status rendered as a colored label

- **WHEN** the list renders an invocation
- **THEN** its status SHALL be shown as a textual label containing the status value (`pending`, `succeeded`, or `failed`)
- **AND** the label SHALL be visually distinguished by a color that differs per status value

#### Scenario: Each invocation has a stable DOM identity

- **WHEN** the list renders an invocation
- **THEN** the invocation's markup SHALL contain an identifier derived from the invocation id
- **AND** that identifier SHALL be stable across re-renders of the same invocation

#### Scenario: Empty list shows an empty-state message

- **GIVEN** no invocations exist in the EventStore
- **WHEN** the invocation list is rendered
- **THEN** the response SHALL contain user-visible text indicating the absence of invocations

## ADDED Requirements

### Requirement: Deferred list loading

The dashboard SHALL render a user-visible loading state before invocation data is available, and SHALL serve invocation data from an endpoint distinct from the page shell. The loading state SHALL be replaced by the invocation list (or the empty-state message) once data is received.

#### Scenario: Loading state visible before data arrives

- **WHEN** the dashboard page shell is first requested
- **THEN** the initial response SHALL contain a visible loading-state placeholder in place of the invocation list
- **AND** the initial response SHALL NOT contain any rendered invocation entries

#### Scenario: Invocation data served from a distinct endpoint

- **WHEN** the invocation list endpoint is requested
- **THEN** the response SHALL contain entries for the most recent invocations ordered by `startedAt` descending (subject to the list bound)
- **AND** the response SHALL NOT contain the page shell (topbar, sidebar, page header)

#### Scenario: Empty-state replaces the loading state when no invocations exist

- **GIVEN** the page shell is rendered and no invocations exist in the EventStore
- **WHEN** the invocation list endpoint response is applied to the shell
- **THEN** the loading-state placeholder SHALL be replaced by the empty-state message

#### Scenario: Loading state respects reduced-motion preference

- **GIVEN** the user has `prefers-reduced-motion: reduce` set
- **WHEN** the loading-state placeholder is rendered
- **THEN** it SHALL NOT apply motion-based animation
- **AND** it SHALL remain visible as a static placeholder
