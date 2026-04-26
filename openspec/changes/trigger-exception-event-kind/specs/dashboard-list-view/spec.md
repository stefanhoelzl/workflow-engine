## ADDED Requirements

### Requirement: Single-leaf trigger.exception invocations render inline

The dashboard invocation list SHALL render synthetic invocations consisting of a single `trigger.exception` event inline alongside real handler-driven invocations, in the same flat list and obeying the same `(owner, repo)` filtering and pending-first / completed-newest sort order. Single-leaf invocations are always in a terminal `failed` state (synthetic invocations have no pending phase) and MUST be sorted under the completed-rows group, ordered by their `at` timestamp (which equals both `startedAt` and `completedAt` for synthetic invocations).

A single-leaf invocation row SHALL display:

- The standard `owner/repo`, workflow, and trigger fields.
- A status of `"failed"`.
- The `at` timestamp rendered under the `startedAt` column.
- An empty or zero duration (synthetic invocations are atomically terminal).
- A distinct visual indicator — at minimum a wrench / settings glyph (or equivalent affordance distinct from the normal `failed` red indicator used for handler throws) and the label `"trigger setup failed"` accessible via `<title>` — so authors can distinguish trigger-setup failures from handler-throw failures at a glance.
- NO dispatch chip, regardless of any `meta.dispatch` content. `trigger.exception` events do not carry `meta.dispatch`.

#### Scenario: Single-leaf invocation appears in the list with distinct indicator

- **GIVEN** an `(owner, repo)` whose IMAP trigger has produced one synthetic invocation (single `trigger.exception` event with `stage: "connect"`) and one normal failed invocation (handler threw, with `trigger.request` + `trigger.error`)
- **WHEN** `GET /dashboard/<owner>/<repo>` is requested
- **THEN** both rows SHALL appear under the completed group
- **AND** the synthetic-invocation row SHALL render the wrench/settings glyph (or equivalent setup-failed affordance) with `<title>` text including `"trigger setup failed"`
- **AND** the handler-throw row SHALL render the standard red `failed` indicator
- **AND** the synthetic-invocation row SHALL NOT render a dispatch chip

#### Scenario: Single-leaf invocation has zero duration

- **GIVEN** a synthetic `trigger.exception` invocation with `at: "2026-04-26T10:00:00.000Z"`
- **WHEN** the row is rendered
- **THEN** the `startedAt` column SHALL display the local-time rendering of `2026-04-26T10:00:00.000Z`
- **AND** the duration SHALL render as `0` (or the minimal-unit zero rendering produced by the smart-unit formatter)

### Requirement: Single-leaf invocation flamegraph renders the leaf event

When a user expands a single-leaf `trigger.exception` invocation row, the flamegraph fragment endpoint SHALL render an instant-marker representation of the single `trigger.exception` event rather than attempting to render a paired-bar layout. The marker SHALL use a visual treatment consistent with other instant markers (see "Instant markers for single-record events") and SHALL carry a `<title>` containing the event's `name` (e.g. `"imap.poll-failed"`) and the `error.message` text so the author can read the failure cause without expanding further detail.

The flamegraph SHALL NOT attempt to render an `orphan` bar for a single-leaf `trigger.exception` invocation. The orphan-bar treatment is reserved for paired `*.request` events whose terminal is missing (engine-crashed invocations); single-leaf invocations have no opening request to orphan.

#### Scenario: Expanded synthetic invocation renders an instant marker

- **GIVEN** a synthetic invocation whose only event is `{ kind: "trigger.exception", name: "imap.poll-failed", payload: { stage: "search", failedUids: [], error: { message: "BAD UNKNOWN_KEYWORD" } } }`
- **WHEN** the user expands the row and the flamegraph fragment is rendered
- **THEN** the rendered SVG SHALL contain an instant-marker element for the `trigger.exception` event
- **AND** the marker's `<title>` SHALL include `"imap.poll-failed"` and `"BAD UNKNOWN_KEYWORD"`
- **AND** the rendered SVG SHALL NOT contain any `<rect>` with the `orphan` class
