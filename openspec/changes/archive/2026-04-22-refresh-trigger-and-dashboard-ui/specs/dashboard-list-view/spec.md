## ADDED Requirements

### Requirement: Timestamps rendered in the user's local timezone

Timestamp values surfaced in the dashboard UI (e.g. invocation started-at) SHALL be rendered in the viewer's local timezone on the client. The server SHALL emit timestamps as `<time datetime="<ISO>">` elements with the ISO string as both the `datetime` attribute and the initial text content, so that a client without JavaScript sees a legible UTC fallback. A client-side script served from `/static/local-time.js` SHALL, on DOM ready, find every such `<time>` element and replace its text content with a locale-formatted rendering produced from `new Date(datetime).toLocaleString(...)`.

The client-side rewrite SHALL NOT mutate the `datetime` attribute itself, so that machine-readable consumers of the DOM continue to see the ISO value.

#### Scenario: Server emits ISO fallback in both attribute and text content

- **WHEN** the dashboard list is rendered
- **THEN** every invocation's started-at timestamp SHALL appear inside a `<time>` element whose `datetime` attribute contains the ISO-8601 UTC string
- **AND** the element's initial text content SHALL contain the same ISO-8601 string (so JS-disabled clients remain legible)

#### Scenario: Client rewrites text content to the viewer's locale

- **GIVEN** a rendered dashboard list containing `<time datetime="2026-04-22T13:45:00Z">2026-04-22T13:45:00Z</time>`
- **WHEN** `/static/local-time.js` has loaded and run
- **THEN** the `<time>` element's text content SHALL be the result of `new Date("2026-04-22T13:45:00Z").toLocaleString(undefined, ...)`
- **AND** the `datetime` attribute SHALL still equal `"2026-04-22T13:45:00Z"`

### Requirement: Expandable invocation rows carry an expand affordance

Invocation rows that are expandable (those with terminal status, i.e. `succeeded` or `failed`) SHALL carry a visible expand affordance (e.g. a chevron glyph) that transitions to an "open" state when the row is expanded. Pending rows, which are not expandable, SHALL NOT carry this affordance.

The affordance SHALL be driven by the native `[open]` state of the `<details>` element, so that no client-side JavaScript is required to keep it in sync with the row's open/closed state.

#### Scenario: Expandable row shows an expand affordance

- **GIVEN** a succeeded invocation row rendered as a `<details>` element
- **WHEN** the row is rendered in its closed state
- **THEN** the row's summary SHALL contain a visible affordance element (e.g. an element with a class signalling "expand")

#### Scenario: Affordance transitions on open

- **GIVEN** an expandable row whose affordance is styled to rotate on `[open]`
- **WHEN** the row is expanded
- **THEN** the affordance element SHALL be in its transformed state (per the CSS rule selecting `[open] > summary <affordance>`)

#### Scenario: Pending row carries no affordance

- **GIVEN** a pending invocation row
- **WHEN** the row is rendered
- **THEN** the row SHALL NOT contain the expand affordance

### Requirement: Invocation list header surfaces count and ordering

The dashboard invocation list SHALL render, above the list itself, a header surface that communicates (a) the count of invocations visible and (b) the ordering direction. The count SHALL come from a machine-readable source in the list fragment (e.g. a `data-count` attribute on the list root) so the header can be populated without re-rendering the fragment.

#### Scenario: Header reports count and ordering

- **GIVEN** a dashboard list fragment containing N invocation rows with `data-count="N"` on its root
- **WHEN** the list is rendered
- **THEN** a header region above the list SHALL surface the text `N` (the count) and a phrase communicating the newest-first ordering

#### Scenario: Empty list does not conceal the ordering hint

- **GIVEN** a dashboard list fragment for a tenant with zero invocations
- **WHEN** the list is rendered
- **THEN** the header region MAY be omitted or MAY be present with a zero-count rendering; either is acceptable
- **AND** the empty-state message SHALL remain user-visible per the existing "Empty list shows an empty-state message" scenario

## MODIFIED Requirements

### Requirement: Summary line and ruler above the flamegraph

The flamegraph fragment is always consumed inside the dashboard's invocation card, which surfaces the invocation's workflow name, trigger name, started timestamp, total duration and status. To avoid duplication, the flamegraph fragment SHALL NOT repeat those identity/status fields; it SHALL emit only what the card does not: per-kind counts (actions, host calls, timers), a legend explaining the bar-kind colour coding and the meaning of marker glyphs, a horizontal time ruler, and the SVG itself.

The time ruler SHALL contain at least four tick labels whose values span from `0` to the invocation's total duration monotonically and whose formatting uses the existing smart-unit formatter (µs / ms / s / min).

The legend MAY render only colour swatches and the marker glyphs that are actually present in the SVG (i.e. an implementation MAY omit legend entries for element types not used in the current fragment).

Counts of zero SHALL be omitted from the fragment entirely. When all counts are zero, the fragment's per-kind-counts region MAY be omitted entirely rather than rendered empty.

#### Scenario: Nonzero counts are rendered

- **GIVEN** an invocation with 2 actions, 5 host calls, and 1 timer
- **WHEN** the flamegraph fragment is rendered
- **THEN** the fragment SHALL surface the count `2` associated with actions, the count `5` associated with host calls, and the count `1` associated with timers

#### Scenario: Zero counts are omitted

- **GIVEN** an invocation with 3 actions and 0 host calls
- **WHEN** the flamegraph fragment is rendered
- **THEN** the fragment SHALL surface the count `3` associated with actions
- **AND** the fragment SHALL NOT render a `0 host calls` label nor any empty "host calls" label

#### Scenario: Fragment does not duplicate card identity

- **GIVEN** an invocation rendered as a dashboard card whose summary already shows `workflow › trigger`, started timestamp, duration, and a status badge
- **WHEN** the card is expanded and the flamegraph fragment is swapped in beneath the summary
- **THEN** the fragment SHALL NOT carry a separate identity line (workflow + trigger), a separate duration label, or a separate status badge

#### Scenario: Legend explains the bar kinds and markers

- **GIVEN** a flamegraph fragment containing at least one trigger bar, one action bar, and one rest bar
- **WHEN** the fragment is rendered
- **THEN** the legend SHALL contain a visually-distinguished swatch for each kind present (trigger / action / rest)
- **AND** the legend SHALL explain any marker glyphs whose meaning is not obvious from the glyph alone

#### Scenario: Ruler contains monotonic tick labels

- **GIVEN** an invocation with total duration `1_000` µs
- **WHEN** the flamegraph fragment is rendered
- **THEN** the ruler SHALL contain at least four tick labels
- **AND** the first label SHALL correspond to `0`
- **AND** the last label SHALL correspond to the total duration
- **AND** intermediate labels SHALL be monotonically increasing

### Requirement: Orphan bar treatment for engine-crashed invocations

A paired request event whose matching response/error is missing from the event list (e.g. the runtime crashed before the bridge emitted the terminal) SHALL render with an `orphan` class and SHALL be sized to extend from `request.ts` to the invocation's terminal `trigger.error.ts`. The rendered orphan bar SHALL additionally carry a user-visible indicator that conveys the terminal-absence semantics unambiguously — at minimum a `<title>` element whose text communicates "no terminal event recorded" (or equivalent), and MAY additionally carry a trailing glyph (e.g. `⇥`) at the bar's right edge.

The indicator SHALL be present whether or not the bar is wide enough to also render a duration or error-icon label.

#### Scenario: Request without response extends to trigger.error

- **GIVEN** an event stream with `trigger.request.ts = 0`, `action.request.ts = 100` (no `action.response` or `action.error`), and `trigger.error.ts = 500`
- **WHEN** the flamegraph is rendered
- **THEN** the action bar SHALL carry the `orphan` class
- **AND** its `x + width` SHALL resolve to `100%`

#### Scenario: Orphan bar carries a terminal-absence title

- **GIVEN** an orphan action bar (paired request with no terminal)
- **WHEN** the flamegraph is rendered
- **THEN** the rendered SVG element corresponding to the bar SHALL contain a child `<title>` element
- **AND** the `<title>` text SHALL communicate that no terminal event was recorded (e.g. the string "No terminal event recorded" or a semantically equivalent message)
