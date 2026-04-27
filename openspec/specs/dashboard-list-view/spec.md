# Dashboard List View Specification

## Purpose

Provide a simple invocation list view for the dashboard, showing recent trigger invocations with their status and duration.
## Requirements
### Requirement: Dashboard lists invocations

The dashboard SHALL render a single flat list of invocations from the EventStore. The view is always a flat list — there is no drill-down tree, no lazy-loaded fragment per scope, and no per-repo nesting. Filtering is driven by the URL path: `/dashboard/:owner` narrows the list to that owner, `/dashboard/:owner/:repo` narrows to that repo, and `/dashboard/:owner/:repo/:workflow/:trigger` narrows to a single trigger's invocations. The root `/dashboard` view renders invocations across every `(owner, repo)` the caller has access to.

Each rendered invocation SHALL display: `owner/repo`, workflow, trigger, status (`pending` / `succeeded` / `failed`), `startedAt`, duration, and a dispatch indicator. The `owner/repo` prefix is rendered on every row at every filter level so an operator looking at the cross-scope view can attribute each invocation to its scope.

Rows SHALL be sorted in two groups:

1. Pending rows first, ordered by `startedTs` descending (live invocations stay on top).
2. Completed rows after, ordered by `completedTs` descending (most recently finished first, without mixing pending rows in between).

This "pending-first, then newest-completed" ordering is enforced by the page renderer (`sortInvocationRows`); the SQL query orders by `at` descending purely to bound the result set.

The dispatch indicator SHALL render as a text chip whose visible label is always `"manual"` when `meta.dispatch.source === "manual"`. The chip's `title` attribute SHALL carry the dispatching user's login (`meta.dispatch.user.login`) when present. The chip SHALL NOT be rendered when `source === "trigger"` or when the `trigger.request` event carries no `meta.dispatch`.

Duration SHALL be computed as `completedTs - startedTs` when both are available, formatted via the existing smart-unit formatter.

#### Scenario: Root renders invocations from every scope the user has

- **GIVEN** a user whose `orgs = ["acme", "alice"]` with registered bundles `(acme, foo)`, `(acme, bar)`, `(alice, utils)`, each with invocations
- **WHEN** `GET /dashboard` is requested
- **THEN** rows SHALL include invocations from all three `(owner, repo)` pairs
- **AND** each row SHALL display its `owner/repo` prefix

#### Scenario: Pending row sorted above completed row regardless of started-at

- **GIVEN** a completed invocation that started at 12:00:00 and finished at 12:00:02, and a pending invocation that started at 11:59:50
- **WHEN** the list is rendered
- **THEN** the pending row SHALL appear above the completed row

#### Scenario: Manual dispatch renders chip with user login in tooltip

- **GIVEN** an invocation whose `trigger.request` event carries `meta.dispatch = { source: "manual", user: { login: "alice", mail: "alice@example.com" } }`
- **WHEN** the list is rendered
- **THEN** the row SHALL render a chip whose visible label is `"manual"`
- **AND** the chip SHALL carry `title="alice"` for on-hover attribution

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

### Requirement: Invocation rows are expandable into an inline flamegraph

Each rendered invocation row (for `succeeded` or `failed` status) SHALL be wrapped in a native `<details>`/`<summary>` element that an operator can toggle open to reveal an inline flamegraph fragment for that invocation. Pending invocations SHALL NOT render an expand affordance.

Expansion SHALL lazily load the flamegraph fragment via HTMX the first time the row is opened. The `hx-get` URL is constructed from the row's own `owner` and `repo` (not the page-level filter), so a cross-scope view still resolves each row's flamegraph correctly. Subsequent open/close cycles SHALL rely on native `<details>` behavior (no re-fetch). Multiple rows MAY be expanded simultaneously (no accordion coordination).

#### Scenario: Completed row uses its own scope in the hx-get URL

- **GIVEN** a cross-scope `/dashboard` request and a succeeded invocation `evt_abc` belonging to `(alice, utils)`
- **WHEN** the invocation list is rendered
- **THEN** the row's `<details>` SHALL carry `hx-get="/dashboard/alice/utils/invocations/evt_abc/flamegraph"` (not the page's current filter scope)

#### Scenario: Pending row has no expand affordance

- **GIVEN** a pending invocation `evt_ghi`
- **WHEN** the invocation list is rendered
- **THEN** the row SHALL NOT contain a `<details>` element and SHALL NOT carry any `hx-get` attribute referencing `/flamegraph`

### Requirement: Flamegraph fragment endpoint

The runtime SHALL expose `GET /dashboard/:owner/:repo/invocations/:id/flamegraph` under the `/dashboard` path prefix. The endpoint SHALL validate `:owner` and `:repo` against their respective regexes, enforce owner-membership via the shared authorization middleware, and read the invocation's events via `eventStore.query([{owner, repo}]).where('id', '=', id).orderBy('seq', 'asc').execute()` and return an HTML fragment (not a full page shell).

The endpoint SHALL return `404 Not Found` when the supplied `(owner, repo)` is not registered or the user is not a member of `owner`, using the same fail-closed pattern as other scoped routes.

#### Scenario: Flamegraph fragment requires scope in URL

- **WHEN** a request arrives at `GET /dashboard/acme/foo/invocations/evt_abc/flamegraph` with a valid session for a member of `acme`
- **THEN** the endpoint SHALL return the flamegraph HTML fragment for invocation `evt_abc` scoped to `(acme, foo)`
- **AND** the response SHALL NOT include the page shell

#### Scenario: Flamegraph endpoint scoped by (owner, repo), not just owner

- **GIVEN** invocations `evt_abc` under `(acme, foo)` and `evt_abc` under `(acme, bar)` (same id, different scope — hypothetical)
- **WHEN** `GET /dashboard/acme/foo/invocations/evt_abc/flamegraph` is requested
- **THEN** only the events belonging to `(acme, foo)` SHALL be rendered
- **AND** events from `(acme, bar)` SHALL NOT appear in the fragment

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

The flamegraph SHALL render bars with visual treatment determined by their kind, with the following kind union:

```ts
type BarKind = "trigger" | "action" | "rest";
```

The kind discriminator from event kinds SHALL be:

- `kind.startsWith("trigger.")` → `"trigger"`
- `kind.startsWith("action.")` → `"action"`
- `kind.endsWith(".request") || kind.endsWith(".response") || kind.endsWith(".error")` (and not matching the above; covers the consolidated `system.*` family for fetch / sendMail / executeSql / setTimeout / setInterval / etc.) → `"rest"`
- Otherwise: not a bar (the event may be a marker — `system.call`, `system.exception` — see the marker requirements)

The `trigger` bar SHALL use the outermost visual styling. The `action` bar SHALL use nested action styling. Any other request/response/error pair (system.* operations across fetch, sendMail, executeSql, timers, custom plugin-emitted pairs) SHALL render with the uniform `rest` styling. Per-`name` color coding (e.g. distinguishing fetch from sendMail under the shared `system.*` prefix) MAY be layered on top as a presentation choice, but the layout logic treats all non-trigger, non-action request/response bars uniformly.

Bars SHALL use a red "errored" visual treatment when the terminal event (closing the span) has kind ending in `.error`. Otherwise they SHALL use the success treatment.

#### Scenario: system.request/response bars render as rest

- **GIVEN** a flamegraph layout for a run that emitted `system.request` and `system.response` events with `name = "fetch"`
- **WHEN** the flamegraph is rendered
- **THEN** a single bar SHALL appear for the fetch span
- **AND** the bar's kind SHALL be `"rest"`
- **AND** the bar SHALL use the standard rest styling (not trigger-styled, not action-styled)

#### Scenario: Timer firing emits paired system.* under rest

- **GIVEN** a setTimeout callback that fired and returned successfully via `system.request name="setTimeout"` / `system.response name="setTimeout"` events
- **WHEN** the flamegraph renders the pair
- **THEN** a bar SHALL be produced with kind `"rest"`

#### Scenario: trigger and action bars retain distinct styling

- **GIVEN** a flamegraph with `trigger.*`, `action.*`, and `system.*` events
- **WHEN** rendered
- **THEN** the trigger bar SHALL use trigger styling
- **AND** the action bar(s) SHALL use action styling
- **AND** the system.* bar(s) SHALL use rest styling

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

### Requirement: Timer callbacks render in a separate track

Timer callback bars (kinds `system.request` / `system.response` / `system.error` with `name` matching `"setTimeout"` or `"setInterval"`) SHALL be classified as `"rest"` kind for styling purposes but MAY be laid out on a separate track from main-tree bars depending on their temporal relationship to the main tree (callbacks firing outside the trigger span are track-only; callbacks firing inside it may nest with the main tree). This is a layout concern, not a kind-discriminator concern.

The flamegraph SHALL detect timer callback events by combining the kind suffix rule (`.request` / `.response` / `.error`) with a `name`-based filter (`setTimeout` / `setInterval`) under the `system.*` prefix. A `system.call` event with `name = "setTimeout"` / `"setInterval"` (registration) or `name = "clearTimeout"` / `"clearInterval"` (clear) SHALL be treated as a marker, not a bar.

#### Scenario: Callback nested under trigger remains in main tree

- **GIVEN** a setTimeout whose callback fires before trigger.response, identified by `kind="system.request"` with `name="setTimeout"`
- **WHEN** the flamegraph lays out the timer bar
- **THEN** the bar MAY be placed in the main tree if its `ref` points to an event still inside the trigger span

### Requirement: Timer connectors

For every `system.call` event with `name` in `{"setTimeout", "setInterval"}` (timer registration), the rendered SVG SHALL include one `<path>` element per `system.request` event sharing the same `input.timerId` and a matching `name`. Each path SHALL originate at the registration marker's position and terminate at the left edge of the corresponding `system.request` bar. Each connector path SHALL carry the class `timer-connector` and a `data-timer-id` attribute matching the shared `timerId`.

A `system.call` registration event with no matching `system.request` in the event stream (cleared before firing, or still pending) SHALL NOT produce any connector path. Markers associated with unpaired registrations SHALL still render.

#### Scenario: setTimeout firing once produces exactly one connector

- **GIVEN** a `system.call` with `name="setTimeout"`, `input.timerId = 7`, and a matching `system.request` with `name="setTimeout"`, `input.timerId = 7`
- **WHEN** the flamegraph is rendered
- **THEN** the fragment SHALL contain exactly one `<path class="timer-connector" data-timer-id="7">` element

#### Scenario: setInterval with three fires produces three connectors

- **GIVEN** a `system.call` with `name="setInterval"`, `input.timerId = 9`, and three `system.request` events with `name="setInterval"`, each with `input.timerId = 9`
- **WHEN** the flamegraph is rendered
- **THEN** the fragment SHALL contain exactly three `<path class="timer-connector" data-timer-id="9">` elements originating from the registration marker's position

### Requirement: Instant markers for single-record events

Markers SHALL be rendered for leaf events (events not belonging to a request/response/error triple). The set of marker kinds is open-ended; the rendering SHALL accept any string kind and render as a small dot. Known marker kinds include at minimum:

- `system.call` — fire-and-forget host calls (e.g. `setTimeout` registration, `clearTimeout`, `console.log`, `randomUUID`, WASI `clock_time_get` / `random_get` / `fd_write`)
- `system.exception` — uncaught guest throws routed through `reportError`
- `system.exhaustion` — sandbox resource-limit breach (see `invocations/spec.md` "Requirement: system.exhaustion event kind"). Synthesised main-side by `sandbox.ts` on a `{kind:"limit"}` termination, before the LIFO close events for open frames are emitted.

The previous marker kinds `timer.set`, `timer.clear`, `console.*`, `wasi.*`, and `uncaught-error` SHALL NOT be produced by any current core plugin; they were consolidated into the `system.*` family and consumers rendering historical data containing those kinds SHALL treat them as legacy. The previous marker kind `system.call` covers the consolidation target.

Markers SHALL NOT carry dedicated CSS classes per kind (no `kind-system`, no `kind-exhaustion`). All markers ride the generic `marker-call` class plus any kind-agnostic visual treatment defined in `/static/*.css`. Severity and failure visibility for the invocation overall are conveyed at the bar level: the synth `trigger.error` close emitted alongside a `system.exhaustion` leaf drives the trigger bar's existing `errored: true` red styling.

The marker's hover title SHALL include the event's `kind` and `name` at minimum. For `system.exhaustion`, the title SHOULD additionally include `input.budget` and `input.observed` (when present) so an operator hovering the marker sees the dimension, the configured cap, and the observed value at breach without expanding the leaf row. Example: `"system.exhaustion: cpu (budget=60000ms, observed=103ms)"`.

#### Scenario: Open-ended marker kinds

- **GIVEN** a flamegraph receiving a leaf event with kind `custom.emit` (from a hypothetical plugin)
- **WHEN** the flamegraph renders
- **THEN** a marker dot SHALL be placed at the event's timestamp
- **AND** the marker's label SHALL include the full kind string

#### Scenario: system.exhaustion renders as a marker

- **GIVEN** a flamegraph receiving a leaf event with kind `system.exhaustion`, `name: "cpu"`, `input: { budget: 60000, observed: 103 }`
- **WHEN** the flamegraph renders
- **THEN** a marker dot SHALL be placed at the event's timestamp
- **AND** the marker SHALL use the generic marker styling (no dedicated `kind-exhaustion` class)
- **AND** the hover title SHALL include the strings `"system.exhaustion"`, `"cpu"`, the budget value, and the observed value

#### Scenario: Trigger bar renders as failed when synth trigger.error close is present

- **GIVEN** a flamegraph for an invocation whose event stream contains a `system.exhaustion` leaf followed by a synthesised `trigger.error` close (terminal event)
- **WHEN** the flamegraph renders the trigger bar
- **THEN** the trigger bar SHALL use the existing `errored: true` styling (red + error icon)
- **AND** no separate styling SHALL be required for the `system.exhaustion` marker beyond the generic marker dot

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

### Requirement: No filters or detail page in v1

The v1 dashboard SHALL NOT support filters (by workflow, trigger, status, time range), detail pages per invocation, replay/retry buttons, or live-streaming updates.

#### Scenario: List is the only top-level dashboard view

- **WHEN** the user navigates to any dashboard URL other than the list or the per-invocation flamegraph fragment endpoint
- **THEN** the response SHALL be `404` (or the request SHALL be redirected to the list)

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

### Requirement: Filter routes

The dashboard SHALL expose four filter levels, each of which renders the same flat-list shape with the filter's scope applied:

- `GET /dashboard` — every `(owner, repo)` the user has access to
- `GET /dashboard/:owner` — every repo under `:owner`
- `GET /dashboard/:owner/:repo` — that repo only
- `GET /dashboard/:owner/:repo/:workflow/:trigger` — invocations produced by that specific trigger

All routes SHALL require an authenticated session. `:owner` and `:repo` path parameters SHALL be validated against their regexes and SHALL enforce owner-membership via the shared authorization middleware; membership failure SHALL respond `404 Not Found` using the enumeration-prevention pattern.

Scope resolution is identical at every filter level — `resolveQueryScopes(user, registry, constraint?)` returns the `(owner, repo)` allow-list, narrowed by the URL's `owner`/`repo` when present. When the URL carries a `:workflow/:trigger` pair, the EventStore query additionally constrains `WHERE workflow = ? AND name = ?` so rows for other triggers in the same repo are excluded.

#### Scenario: Per-trigger filter narrows by workflow + trigger

- **GIVEN** `(acme, foo)` has triggers `build/webhook` and `deploy/webhook`, each with multiple invocations
- **WHEN** a member of `acme` requests `GET /dashboard/acme/foo/build/webhook`
- **THEN** rows SHALL include only `build/webhook` invocations
- **AND** rows for `deploy/webhook` SHALL NOT appear

#### Scenario: Non-member request at any filter level returns 404

- **WHEN** a user who is NOT a member of `evil-corp` requests `GET /dashboard/evil-corp` or `GET /dashboard/evil-corp/foo` or `GET /dashboard/evil-corp/foo/build/webhook`
- **THEN** every route SHALL respond `404 Not Found`
- **AND** the response body SHALL be identical in shape to the response for a non-existent owner

#### Scenario: Breadcrumb reflects filter level

- **WHEN** the dashboard page is rendered at each filter level
- **THEN** the breadcrumb SHALL show the path from root to the active filter (`All`, `All / owner`, `All / owner / repo`, `All / owner / repo / workflow / trigger`)
- **AND** each segment above the current level SHALL be a link to that broader filter

### Requirement: Single-leaf trigger.exception invocations render inline

The dashboard invocation list SHALL render synthetic invocations consisting of a single leaf event (`trigger.exception`, `trigger.rejection`, or `system.upload`) inline alongside real handler-driven invocations, in the same flat list and obeying the same `(owner, repo)` filtering and pending-first / completed-newest sort order. Single-leaf invocations have no pending phase and SHALL be sorted under the completed-rows group, ordered by their `at` timestamp (which equals both `startedAt` and `completedAt` for synthetic invocations).

A synthetic-`trigger.exception` row SHALL display:

- The standard `owner/repo`, workflow, and trigger fields.
- A status of `"failed"`.
- The `at` timestamp under `startedAt`.
- An empty/zero duration.
- A wrench / settings glyph (or equivalent affordance distinct from the normal `failed` red indicator) and the label `"trigger setup failed"` accessible via `<title>`.
- NO dispatch chip.

A synthetic-`trigger.rejection` row SHALL display:

- The standard `owner/repo`, workflow, and trigger fields.
- A status of `"failed"`.
- The `at` timestamp under `startedAt`.
- An empty/zero duration.
- A shield-cross glyph (or equivalent rejected-by-validation affordance distinct from both `failed`-red and the wrench setup-failed glyph) and the label `"trigger rejected"` accessible via `<title>`. The `<title>` SHALL additionally include a brief summary of the first issue's path + message for at-a-glance debuggability.
- NO dispatch chip.

A synthetic-`system.upload` row SHALL display:

- The standard `owner/repo`, workflow, and trigger fields. The `trigger` field SHALL render as the literal `"upload"`.
- A status of `"uploaded"` (a third row status alongside `pending`/`succeeded`/`failed`).
- The `at` timestamp under `startedAt`.
- An empty/zero duration.
- An upload-arrow glyph and the label `"workflow uploaded"` accessible via `<title>`. The `<title>` SHALL additionally include `sha=<workflowSha-short>` for at-a-glance version identification.
- The dispatch chip SHALL render with visible label `"upload"` and `<title>` carrying the uploader's name and mail (from `meta.dispatch.user`).

For all three synthetic kinds, rows SHALL NOT carry a flamegraph link (single-leaf events have no paired-bar layout to graph) and SHALL NOT carry a dimension pill.

#### Scenario: trigger.exception synthetic row renders wrench glyph

- **GIVEN** an `(owner, repo)` whose IMAP trigger has produced one synthetic invocation (single `trigger.exception` event with `name: "imap.poll-failed"`)
- **WHEN** `GET /dashboard/<owner>/<repo>` is requested
- **THEN** the row SHALL render the wrench/settings glyph with `<title>` text including `"trigger setup failed"`
- **AND** the row SHALL NOT render a dispatch chip
- **AND** the row SHALL NOT render a flamegraph expand affordance

#### Scenario: trigger.rejection synthetic row renders shield-cross glyph

- **GIVEN** an `(owner, repo)` whose HTTP trigger has produced one synthetic invocation (single `trigger.rejection` event with `name: "http.body-validation"` and one issue `{path: ["name"], message: "Required"}`)
- **WHEN** the dashboard is requested
- **THEN** the row SHALL render the shield-cross glyph with `<title>` text including `"trigger rejected"` and a summary of the first issue
- **AND** the row SHALL NOT render a dispatch chip
- **AND** the row SHALL NOT render a flamegraph expand affordance

#### Scenario: system.upload synthetic row renders upload-arrow glyph and dispatch chip

- **GIVEN** an `(owner, repo)` with one `system.upload` event for workflow `demo` at sha `abc12345`, dispatched by user `{name: "alice", mail: "alice@acme"}`
- **WHEN** the dashboard is requested
- **THEN** the row SHALL render the upload-arrow glyph with `<title>` text including `"workflow uploaded"` and `sha=abc12345`
- **AND** the row's status SHALL render as `"uploaded"`
- **AND** the row SHALL render a dispatch chip with visible label `"upload"` and `<title>` containing `alice` and `alice@acme`
- **AND** the row SHALL NOT render a flamegraph expand affordance

#### Scenario: All three synthetic kinds have zero duration

- **GIVEN** any synthetic-row invocation
- **WHEN** the row is rendered
- **THEN** the duration SHALL render as `0` (or the minimal-unit zero rendering produced by the smart-unit formatter)

### Requirement: Single-leaf invocation flamegraph renders the leaf event

When a user expands a synthetic-row invocation (one of `trigger.exception`, `trigger.rejection`, `system.upload`) — to the extent the row exposes an expand affordance — the flamegraph fragment endpoint SHALL render an instant-marker representation of the single leaf event rather than attempting to render a paired-bar layout. The marker SHALL use a visual treatment consistent with other instant markers (see "Instant markers for single-record events") and SHALL carry a `<title>` containing the event's `kind` and `name` and (for `trigger.exception`) the `error.message` text or (for `trigger.rejection`) a brief summary of the first issue or (for `system.upload`) the `workflowSha`.

The flamegraph SHALL NOT attempt to render an `orphan` bar for a synthetic single-leaf invocation. The orphan-bar treatment is reserved for paired `*.request` events whose terminal is missing (engine-crashed invocations); single-leaf invocations have no opening request to orphan.

In the current implementation, `trigger.rejection` and `system.upload` rows do NOT expose a flamegraph expand affordance (per "Single-leaf trigger.exception invocations render inline" above). This requirement applies to `trigger.exception` rows today and is documented for forward consistency if expand affordances are extended to other single-leaf kinds.

#### Scenario: Expanded synthetic trigger.exception invocation renders an instant marker

- **GIVEN** a synthetic invocation whose only event is `{ kind: "trigger.exception", name: "imap.poll-failed", input: { stage: "search", failedUids: [] }, error: { message: "BAD UNKNOWN_KEYWORD" } }`
- **WHEN** the user expands the row and the flamegraph fragment is rendered
- **THEN** the rendered SVG SHALL contain an instant-marker element for the event
- **AND** the marker's `<title>` SHALL include `"trigger.exception"`, `"imap.poll-failed"`, and `"BAD UNKNOWN_KEYWORD"`
- **AND** the rendered SVG SHALL NOT contain any `<rect>` with the `orphan` class

### Requirement: Sandbox-exhaustion dimension pill on failed invocation rows

When a `failed` invocation row is rendered, the renderer SHALL look up an associated `system.exhaustion` event (single row, matched by `invocationId`) and, if found, render a small dimension pill next to the `failed` status indicator. The pill SHALL display one of `CPU`, `MEM`, `OUT`, or `PEND` corresponding to the event's `name` field (`"cpu" | "memory" | "output" | "pending"`). The pill's `<title>` SHALL contain `budget=<value>` and (when present) `observed=<value>` from the event's `input` field, with units appropriate to the dimension (`ms` for cpu, `bytes` for memory/output, no unit for pending).

If no `system.exhaustion` event is associated with the invocation, the row SHALL render exactly as today (failed status only, no pill). The pill SHALL NOT be rendered for `succeeded` or `pending` rows.

The lookup SHALL be implemented as a LEFT JOIN against the `events` table on `(invocationId, kind = 'system.exhaustion')`, fetching at most one row per invocation. Memory-class breaches do not produce `system.exhaustion` events (per `invocations/spec.md`) and SHALL therefore not produce a pill — though the dimension `MEM` is reserved for forward compatibility if memory ever becomes a terminal-class breach.

#### Scenario: CPU-killed invocation renders CPU pill

- **GIVEN** a failed invocation whose terminal `trigger.error` was preceded by a `system.exhaustion` event with `name: "cpu"`, `input: { budget: 60000, observed: 60002 }`
- **WHEN** the row is rendered
- **THEN** a `CPU` pill SHALL appear next to the `failed` status
- **AND** the pill's `<title>` SHALL include `budget=60000ms` and `observed=60002ms`

#### Scenario: Output-bytes breach renders OUT pill

- **GIVEN** a failed invocation associated with `system.exhaustion { name: "output", input: { budget: 4194304, observed: 4194305 } }`
- **WHEN** the row is rendered
- **THEN** an `OUT` pill SHALL appear next to the `failed` status

#### Scenario: Pending-callables breach renders PEND pill

- **GIVEN** a failed invocation associated with `system.exhaustion { name: "pending", input: { budget: 100, observed: 101 } }`
- **WHEN** the row is rendered
- **THEN** a `PEND` pill SHALL appear next to the `failed` status

#### Scenario: Plain handler-throw failed row has no pill

- **GIVEN** a failed invocation whose terminal `trigger.error` has no preceding `system.exhaustion` event
- **WHEN** the row is rendered
- **THEN** NO dimension pill SHALL appear
