## MODIFIED Requirements

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
