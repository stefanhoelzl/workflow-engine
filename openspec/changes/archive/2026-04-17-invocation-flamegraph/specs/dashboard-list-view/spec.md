## ADDED Requirements

### Requirement: Invocation rows are expandable into an inline flamegraph

Each rendered invocation row (for `succeeded` or `failed` status) SHALL be wrapped in a native `<details>`/`<summary>` element that an operator can toggle open to reveal an inline flamegraph fragment for that invocation. Pending invocations SHALL NOT render an expand affordance.

Expansion SHALL lazily load the flamegraph fragment via HTMX the first time the row is opened. Subsequent open/close cycles SHALL rely on native `<details>` behavior (no re-fetch). Multiple rows MAY be expanded simultaneously (no accordion coordination).

#### Scenario: Completed row exposes HTMX lazy-load attributes

- **GIVEN** a succeeded invocation `evt_abc`
- **WHEN** the invocation list is rendered
- **THEN** its row SHALL contain a `<details>` element whose attributes include `hx-get="/dashboard/invocations/evt_abc/flamegraph"`, `hx-trigger="toggle once"`, and an `hx-target` pointing at a descendant container that will receive the fragment

#### Scenario: Failed row is also expandable

- **GIVEN** a failed invocation `evt_def`
- **WHEN** the invocation list is rendered
- **THEN** its row SHALL contain a `<details>` element with the same HTMX lazy-load attributes as a succeeded row, targeting `/dashboard/invocations/evt_def/flamegraph`

#### Scenario: Pending row has no expand affordance

- **GIVEN** a pending invocation `evt_ghi`
- **WHEN** the invocation list is rendered
- **THEN** the row SHALL NOT contain a `<details>` element and SHALL NOT carry any `hx-get` attribute referencing `/flamegraph`

### Requirement: Flamegraph fragment endpoint

The runtime SHALL expose `GET /dashboard/invocations/:id/flamegraph` under the `/dashboard` path prefix. The endpoint SHALL read the invocation's events via `eventStore.query.where('id', '=', id).orderBy('seq', 'asc').execute()` and return an HTML fragment (not a full page shell). The response status SHALL be `200` regardless of whether the requested id exists — unknown, malformed, and in-flight ids return a one-line empty-state fragment instead.

The endpoint SHALL NOT validate the id string against any format regex; it SHALL pass the raw path parameter to the parameterized DuckDB query.

#### Scenario: Completed invocation returns a flamegraph SVG fragment

- **GIVEN** `evt_abc` has a full event stream terminating in `trigger.response`
- **WHEN** `GET /dashboard/invocations/evt_abc/flamegraph` is called
- **THEN** the response SHALL be `200` and its body SHALL be an HTML fragment containing an `<svg>` element

#### Scenario: Unknown id returns empty-state fragment with 200

- **GIVEN** no events exist in the EventStore for id `evt_missing`
- **WHEN** `GET /dashboard/invocations/evt_missing/flamegraph` is called
- **THEN** the response SHALL be `200` and its body SHALL contain the empty-state fragment with user-visible text indicating no flamegraph is available
- **AND** the body SHALL NOT contain an `<svg>` element

#### Scenario: Pending invocation returns empty-state fragment

- **GIVEN** `evt_ghi` has a `trigger.request` event but no `trigger.response` or `trigger.error`
- **WHEN** `GET /dashboard/invocations/evt_ghi/flamegraph` is called
- **THEN** the response SHALL be `200` and its body SHALL contain the empty-state fragment

### Requirement: Flamegraph SVG structure

The rendered flamegraph fragment SHALL consist of an outer container element whose `max-height` is constrained to `40vh` with `overflow-y: auto`, housing a single `<svg>` element whose `width` attribute is `100%` and whose `height` equals `(mainRows + trackRows) × rowHeight` pixels. Row height SHALL be a stable constant shared by the main tree and the timer track.

The SVG SHALL be accompanied by a one-line summary and a horizontal time ruler rendered above it.

Layout SHALL NOT rely on a stretched `viewBox` for horizontal responsiveness; bar `x` and `width` SHALL be expressed as percentages of the invocation's monotonic `ts` span.

#### Scenario: Fragment carries width and height hooks

- **WHEN** a flamegraph fragment is rendered for any completed invocation
- **THEN** its `<svg>` element SHALL have `width="100%"`
- **AND** a numeric `height` attribute in pixel units

#### Scenario: Fragment container scrolls vertically when the row count exceeds the cap

- **WHEN** a flamegraph fragment is rendered
- **THEN** the `<svg>` SHALL be contained in an element whose rendered `max-height` resolves to `40vh` and whose `overflow-y` resolves to `auto`

### Requirement: Main-tree row assignment

Events with `ref != null` SHALL be laid out in a main tree rooted at `trigger.request`. Each event's row index in the main tree SHALL equal its depth from the root via the `ref` chain. Events at the same depth whose `[ts, ts+duration)` windows do not overlap SHALL share a row; events whose windows overlap SHALL be assigned to sub-rows so no two rendered bars visually intersect.

#### Scenario: Direct child of trigger lands at depth 1

- **GIVEN** a `trigger.request` at `seq: 0` and an `action.request` at `seq: 1` with `ref: 0`
- **WHEN** the flamegraph is rendered
- **THEN** the action's bar SHALL be positioned on the row immediately below the trigger row

#### Scenario: Nested host call lands at depth 2

- **GIVEN** a `trigger.request` at `seq: 0`, an `action.request` at `seq: 1` with `ref: 0`, and a `system.request` at `seq: 2` with `ref: 1`
- **WHEN** the flamegraph is rendered
- **THEN** the `system.request` bar SHALL be positioned two rows below the trigger row

### Requirement: Bar positioning and sizing

Each paired event pair (request/response or request/error) SHALL render as a single `<rect>` whose horizontal position and width encode its monotonic timing:
- `x` SHALL equal `request.ts / trigger.total_duration_ts × 100%`.
- `width` SHALL equal `(response_or_error.ts − request.ts) / trigger.total_duration_ts × 100%`.

Where the computed `width` in visual pixels would fall below a minimum-width floor (implementation-defined, at least one visible pixel at the rendered container width), the rendered element SHALL be widened to the floor so the bar remains hoverable and visible.

#### Scenario: Bar position reflects monotonic ts

- **GIVEN** `trigger.request.ts = 0`, `trigger.response.ts = 1000`, and an `action.request.ts = 200`, `action.response.ts = 600`
- **WHEN** the flamegraph is rendered
- **THEN** the action bar's `x` attribute SHALL be `"20%"` and its `width` attribute SHALL be `"40%"`

#### Scenario: Sub-microsecond bar receives minimum width

- **GIVEN** a paired event where `request.ts === response.ts`
- **WHEN** the flamegraph is rendered
- **THEN** the rendered `<rect>` SHALL have a non-zero `width` whose computed pixel value is at least the minimum-width floor

### Requirement: Bar visual treatment by kind and status

Each paired-event bar SHALL carry a CSS class identifying its kind, from the set `kind-trigger`, `kind-action`, `kind-system`, `kind-timer`. Kind colors SHALL be distinct from each other and distinct from the error-red used for failure indicators; kind colors SHALL NOT use green or red.

A bar whose terminal event is `*.error` SHALL additionally carry the `bar-error` class and SHALL include a child element carrying an error indicator recognizable to operators (an error icon or glyph). The kind class (and therefore the kind color) SHALL remain applied to errored bars.

A bar whose duration exceeds a width threshold SHALL include a child `<text>` element whose content begins with the event's `name`; a sub-caption `<text>` with the duration in smart-unit format MAY additionally appear when space permits. Bars narrower than the threshold SHALL omit the text elements but SHALL still render the `<rect>`.

#### Scenario: Kind classes are applied

- **WHEN** a trigger, action, host-bridge, and timer-callback bar are rendered in the same flamegraph
- **THEN** the trigger bar SHALL carry `kind-trigger`, the action bar `kind-action`, the host-bridge bar `kind-system`, and the timer-callback bar `kind-timer`

#### Scenario: Failed action bar carries error treatment

- **GIVEN** an `action.request` at `seq: 1` and a matching `action.error` at `seq: 2`
- **WHEN** the flamegraph is rendered
- **THEN** the action bar SHALL carry both `kind-action` and `bar-error` classes
- **AND** the bar SHALL contain a child element signaling an error to operators

### Requirement: Orphan bar treatment for engine-crashed invocations

A paired request event whose matching response/error is missing from the event list (e.g. the runtime crashed before the bridge emitted the terminal) SHALL render with an `orphan` class and SHALL be sized to extend from `request.ts` to the invocation's terminal `trigger.error.ts`.

#### Scenario: Request without response extends to trigger.error

- **GIVEN** an event stream with `trigger.request.ts = 0`, `action.request.ts = 100` (no `action.response` or `action.error`), and `trigger.error.ts = 500`
- **WHEN** the flamegraph is rendered
- **THEN** the action bar SHALL carry the `orphan` class
- **AND** its `x + width` SHALL resolve to `100%`

### Requirement: Timer callbacks render in a separate track

`timer.request` events (whose `ref` is `null`) SHALL NOT render in the main tree. The rendered SVG SHALL contain a distinct `<g>` group representing the timer-callback track, separated from the main tree by a divider and a textual `TIMER CALLBACKS` label. The label SHALL render in the text layer so that no bar or marker occludes it.

Within the timer track, each `timer.request` bar SHALL be placed on a track row. Events with `ref` equal to a `timer.request.seq` SHALL be laid out in sub-rows below their parent firing using the same overlap-stacking rule as the main tree. Timer bars whose `[ts, ts+duration)` windows overlap SHALL push to new track rows.

If no `timer.request` events exist for the invocation, the track area SHALL still render its divider and label (with content indicating the track is empty).

#### Scenario: timer.request renders inside the timer-callback group

- **GIVEN** an invocation with one `timer.request` at `seq: 3` (`ref: null`)
- **WHEN** the flamegraph is rendered
- **THEN** the `<rect>` for that timer bar SHALL be a descendant of an SVG group carrying a `timer-track` class
- **AND** it SHALL NOT be a descendant of a main-tree group

#### Scenario: Empty track still renders divider and label

- **GIVEN** an invocation with no `timer.request` events
- **WHEN** the flamegraph is rendered
- **THEN** the fragment SHALL still contain the timer-track divider element and the `TIMER CALLBACKS` label text

### Requirement: Timer connectors

For every `timer.set` event, the rendered SVG SHALL include one `<path>` element per `timer.request` event sharing its `input.timerId`. Each path SHALL originate at the set marker's position and terminate at the left edge of the corresponding `timer.request` bar. Each connector path SHALL carry the class `timer-connector` and a `data-timer-id` attribute matching the shared `timerId`.

A `timer.set` event with no matching `timer.request` in the event stream (cleared before firing, or still pending) SHALL NOT produce any connector path. Markers associated with unpaired sets SHALL still render.

#### Scenario: setTimeout firing once produces exactly one connector

- **GIVEN** a `timer.set` with `input.timerId = 7` and a matching `timer.request` with `input.timerId = 7`
- **WHEN** the flamegraph is rendered
- **THEN** the fragment SHALL contain exactly one `<path class="timer-connector" data-timer-id="7">` element

#### Scenario: setInterval with three fires produces three connectors

- **GIVEN** a `timer.set` with `input.timerId = 9` and three `timer.request` events, each with `input.timerId = 9`
- **WHEN** the flamegraph is rendered
- **THEN** the fragment SHALL contain exactly three `<path class="timer-connector" data-timer-id="9">` elements originating from the set-marker's position

#### Scenario: Unpaired set produces no connector

- **GIVEN** a `timer.set` with `input.timerId = 11` and no `timer.request` events with `timerId = 11` in the event stream
- **WHEN** the flamegraph is rendered
- **THEN** the fragment SHALL contain zero `<path class="timer-connector" data-timer-id="11">` elements

### Requirement: Instant markers for single-record events

Events with `kind` in the set `{timer.set, timer.clear, system.call}` SHALL render as instant markers on the row identified by their `ref`. A `ref` of `null` on a `timer.clear` SHALL place the marker on the main-tree trigger row (row 0).

- `timer.set` SHALL render as a `<rect>` carrying class `marker-set`, fill = kind-timer color, full row height, and a small fixed horizontal extent (narrower than a typical bar).
- `timer.clear` SHALL render as a `<rect>` carrying class `marker-clear-bg` (same dimensions as `marker-set`) PLUS two `<line>` elements carrying class `marker-x` drawn as diagonals forming a `×` inside the rect.
- `system.call` SHALL render as a small marker (e.g. a `<circle>` or short `<rect>`) distinct from the timer markers, on the ref's row at the event's `ts`.
- A `timer.clear` event whose `ref` is `null` SHALL additionally carry class `marker-auto` so it renders with reduced opacity, visually distinguishing auto-cleanup at run-end from explicit operator-initiated clears.

#### Scenario: timer.set marker anchors to its ref's row

- **GIVEN** an `action.request` at `seq: 1` (`ref: 0`) and a `timer.set` at `seq: 2` with `ref: 1`
- **WHEN** the flamegraph is rendered
- **THEN** the rendered `marker-set` element SHALL have its `y` coordinate match the y of the action bar (depth 1)

#### Scenario: timer.clear renders with × glyph

- **GIVEN** a `timer.clear` with `input.timerId = 7` and `ref != null`
- **WHEN** the flamegraph is rendered
- **THEN** the fragment SHALL contain a `<rect class="marker-clear-bg" data-timer-id="7">` element
- **AND** at least two `<line class="marker-x" data-timer-id="7">` elements positioned to form diagonals across the rect

#### Scenario: Auto-clear renders on row 0 with marker-auto

- **GIVEN** a `timer.clear` with `ref: null` (auto-cleanup at run-end) and `input.timerId = 7`
- **WHEN** the flamegraph is rendered
- **THEN** the marker's rect SHALL carry both `marker-clear-bg` and `marker-auto` classes
- **AND** its `y` coordinate SHALL equal the y of the trigger row (row 0)

### Requirement: Timer-id cross-highlight wiring

Every timer-related SVG element — `timer.set` markers, `timer.clear` markers (rect + lines), `timer.request`/`timer.response` bars, and `timer-connector` paths — SHALL carry a `data-timer-id` attribute whose value is the shared `timerId` string. Non-timer elements (trigger, action, `system.*`, `system.call` markers) SHALL NOT carry `data-timer-id`.

The rendered fragment MAY rely on a page-level delegated listener (in `/static/flamegraph.js`) to add cross-highlight CSS classes on `mouseover`; the spec requires only that the DOM hooks exist so such a listener can find them.

#### Scenario: All elements for one timer share the data-timer-id attribute

- **GIVEN** a timer with `timerId = 7` represented by one `timer.set`, one `timer.clear`, one `timer.request`/`timer.response` pair, and one connector path
- **WHEN** the flamegraph is rendered
- **THEN** every one of those SVG elements SHALL carry `data-timer-id="7"`

#### Scenario: Non-timer elements carry no data-timer-id

- **WHEN** a flamegraph containing a trigger bar, an action bar, and a host-bridge bar is rendered
- **THEN** none of those bars SHALL carry a `data-timer-id` attribute

### Requirement: Click interaction hooks

Each rendered bar (paired event) SHALL carry a `data-event-pair` attribute encoding the `seq` of its request event and the `seq` of its response or error event (format is implementation-defined but MUST identify both seqs deterministically). Each rendered instant marker (single-record event) SHALL carry a `data-event-seq` attribute encoding its `seq`. These attributes exist so a page-level delegated click listener can look up the correct `InvocationEvent` objects and open the shared result dialog.

The spec requires only the DOM hooks; actual modal-open behavior (dialog animation, JSON formatting, clipboard button behavior) is out of scope.

#### Scenario: Paired bar carries data-event-pair

- **GIVEN** an `action.request` at `seq: 1` and `action.response` at `seq: 2`
- **WHEN** the flamegraph is rendered
- **THEN** the action bar SHALL carry a `data-event-pair` attribute whose value references both seq 1 and seq 2

#### Scenario: Instant marker carries data-event-seq

- **GIVEN** a `timer.set` at `seq: 4`
- **WHEN** the flamegraph is rendered
- **THEN** the rendered set marker SHALL carry `data-event-seq="4"`

### Requirement: Summary line and ruler above the flamegraph

The flamegraph fragment SHALL render, above the SVG, (a) a single-line text summary containing the invocation's workflow name, trigger name, total duration, count of action bars, count of system bars, and status; and (b) a horizontal time ruler with at least four tick labels whose values span from `0` to the invocation's total duration monotonically and whose formatting uses the existing smart-unit formatter (µs / ms / s / min).

#### Scenario: Summary line contains the required fields

- **GIVEN** an invocation of workflow `onSignup`, trigger `cronitorWebhook`, total duration 420 µs, 2 actions, 5 host calls, status succeeded
- **WHEN** the flamegraph fragment is rendered
- **THEN** the summary line text SHALL contain the strings `"onSignup"`, `"cronitorWebhook"`, a smart-unit rendering of `420 µs`, a count of `2` actions, a count of `5` host calls, and the status string

#### Scenario: Ruler contains monotonic tick labels

- **GIVEN** an invocation with total duration `1_000` µs
- **WHEN** the flamegraph fragment is rendered
- **THEN** the ruler SHALL contain at least four tick labels
- **AND** the first label SHALL correspond to `0`
- **AND** the last label SHALL correspond to the total duration
- **AND** intermediate labels SHALL be monotonically increasing

### Requirement: Empty-state fragment

When the endpoint returns the empty-state path (no events for the requested id), the response body SHALL be a single `<div>` element carrying class `flame-empty` whose text content is a concise user-visible message indicating no flamegraph is available. The empty-state fragment SHALL NOT contain an `<svg>` element, ruler, summary line, or any of the flamegraph-specific DOM hooks (`data-timer-id`, `data-event-pair`, `data-event-seq`).

#### Scenario: Empty-state fragment shape

- **WHEN** the flamegraph endpoint is called for an id with no events
- **THEN** the response body SHALL contain exactly one `<div class="flame-empty">` element
- **AND** SHALL NOT contain `<svg>`, `<path>`, `data-timer-id`, `data-event-pair`, or `data-event-seq`

### Requirement: Rendered fragment obeys CSP invariants

No flamegraph fragment (SVG variant or empty-state variant) SHALL contain inline `style=` attributes, inline `<style>` elements, inline `<script>` elements, `on*=` event-handler attributes, or string-form Alpine `:style` bindings. All styling SHALL flow through CSS class names applied to server-rendered elements; all interactivity SHALL be wired via delegated listeners registered in `/static/flamegraph.js`.

#### Scenario: Fragment contains no inline styling or scripting

- **WHEN** any flamegraph fragment is rendered for any invocation (completed, failed, unknown id, or pending id)
- **THEN** the HTML body SHALL NOT contain any occurrence of `style="`, `<style`, `<script`, `onclick=`, `onmouseover=`, or `:style="`

## MODIFIED Requirements

### Requirement: No filters or detail page in v1

The v1 dashboard SHALL NOT support filters (by workflow, trigger, status, time range), detail pages per invocation, replay/retry buttons, or live-streaming updates.

#### Scenario: List is the only top-level dashboard view

- **WHEN** the user navigates to any dashboard URL other than the list or the per-invocation flamegraph fragment endpoint
- **THEN** the response SHALL be `404` (or the request SHALL be redirected to the list)
