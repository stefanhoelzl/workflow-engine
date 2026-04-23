## MODIFIED Requirements

### Requirement: Dashboard lists invocations

The dashboard SHALL render invocations from the EventStore, ordered by `startedAt` descending with `id` descending as tiebreak. Each rendered invocation SHALL display: workflow, trigger, status (`pending` / `succeeded` / `failed`), `startedAt` (formatted from the ISO string), duration, and a dispatch indicator sourced from the invocation's `trigger.request` event.

The dispatch indicator SHALL render as a text chip whose visible label is always `"manual"` when `meta.dispatch.source === "manual"`. The chip's `title` attribute (shown on hover) SHALL carry the dispatching user's name (`meta.dispatch.user.name`) when present, and SHALL be empty when no `user` is present (open-mode dev). The chip SHALL NOT be rendered when `source === "trigger"` or when the `trigger.request` event carries no `meta.dispatch` (legacy invocations persisted before this change).

Duration SHALL be computed as `completedTs - startedTs` (monotonic microseconds) when both values are available, and rendered using a smart-unit formatter:

- `d < 1_000` (µs) → `"N µs"` (integer)
- `1_000 ≤ d < 1_000_000` (µs) → `"N.N ms"` (one decimal)
- `1_000_000 ≤ d < 60_000_000` (µs) → `"N.N s"` (one decimal)
- `d ≥ 60_000_000` (µs) → `"N.N min"` (one decimal)

When `completedTs` is missing (invocation still pending), the duration field SHALL display an empty indicator (e.g. `—`).

Duration SHALL NOT be derived from the wall-clock ISO strings (`startedAt` / `completedAt`); the wall-clock fields are used only for the "started" column and for ordering.

#### Scenario: Latest invocations rendered

- **GIVEN** an EventStore with N invocation rows
- **WHEN** the invocation list is rendered
- **THEN** the response SHALL contain an entry per most-recent invocation sorted by `startedAt` descending, tiebroken by `id` descending
- **AND** each entry SHALL show workflow, trigger, status, started timestamp (formatted from `startedAt`), and duration

#### Scenario: Duration uses smart-unit formatter

- **GIVEN** a completed invocation with `startedTs = 0` and `completedTs = 123`
- **WHEN** the list is rendered
- **THEN** the duration field SHALL contain `"123 µs"`

- **GIVEN** a completed invocation with `startedTs = 0` and `completedTs = 12_345`
- **WHEN** the list is rendered
- **THEN** the duration field SHALL contain `"12.3 ms"`

- **GIVEN** a completed invocation with `startedTs = 0` and `completedTs = 1_234_567`
- **WHEN** the list is rendered
- **THEN** the duration field SHALL contain `"1.2 s"`

- **GIVEN** a completed invocation with `startedTs = 0` and `completedTs = 75_000_000`
- **WHEN** the list is rendered
- **THEN** the duration field SHALL contain `"1.2 min"`

#### Scenario: Pending invocation has no duration

- **GIVEN** an in-flight invocation with no `completedTs`
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

#### Scenario: Recovered invocation duration reflects last recorded ts

- **GIVEN** a recovered invocation where `trigger.request.ts = 0` and the synthetic `trigger.error.ts = 4_200` (copied from the last pending event)
- **WHEN** the list is rendered
- **THEN** the duration field SHALL contain `"4.2 ms"` (i.e. the smart-unit rendering of 4 200 µs)

#### Scenario: Manual dispatch renders chip with user name in tooltip

- **GIVEN** an invocation whose `trigger.request` event carries `meta.dispatch = { source: "manual", user: { name: "Jane Doe", mail: "jane@example.com" } }`
- **WHEN** the list is rendered
- **THEN** the row for that invocation SHALL render a chip whose visible label is `"manual"`
- **AND** the chip SHALL carry `title="Jane Doe"` for on-hover attribution

#### Scenario: Manual dispatch without user has an empty tooltip

- **GIVEN** an invocation whose `trigger.request` event carries `meta.dispatch = { source: "manual" }` with no `user`
- **WHEN** the list is rendered
- **THEN** the row for that invocation SHALL render a chip whose visible label is `"manual"`
- **AND** the chip's `title` attribute SHALL be empty

#### Scenario: Trigger-source dispatch renders no chip

- **GIVEN** an invocation whose `trigger.request` event carries `meta.dispatch = { source: "trigger" }`
- **WHEN** the list is rendered
- **THEN** the row for that invocation SHALL NOT render a dispatch chip

#### Scenario: Legacy invocation without meta renders no chip

- **GIVEN** a legacy invocation archived before this change whose `trigger.request` event has no `meta` field
- **WHEN** the list is rendered
- **THEN** the row for that invocation SHALL NOT render a dispatch chip
