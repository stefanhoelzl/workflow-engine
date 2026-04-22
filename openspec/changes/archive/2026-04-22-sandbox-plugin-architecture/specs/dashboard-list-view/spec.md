## MODIFIED Requirements

### Requirement: Bar visual treatment by kind and status

The flamegraph SHALL render bars with visual treatment determined by their kind, with the following kind union:

```ts
type BarKind = "trigger" | "action" | "rest";
```

The kind discriminator from event kinds SHALL be:

- `kind.startsWith("trigger.")` → `"trigger"`
- `kind.startsWith("action.")` → `"action"`
- `kind.endsWith(".request") || kind.endsWith(".response") || kind.endsWith(".error")` (and not matching the above) → `"rest"`
- Otherwise: not a bar (the event may be a marker, see the marker requirement)

The `trigger` bar SHALL use the outermost visual styling. The `action` bar SHALL use nested action styling. Any other request/response/error pair (fetch, timer, custom plugin-emitted pairs) SHALL render with the uniform `rest` styling. Per-prefix color coding MAY be layered on top as a presentation choice, but the layout logic treats all non-trigger, non-action request/response bars uniformly.

Bars SHALL use a red "errored" visual treatment when the terminal event (closing the span) has kind ending in `.error`. Otherwise they SHALL use the success treatment.

#### Scenario: fetch.request/response bars render as rest

- **GIVEN** a flamegraph layout for a run that emitted `fetch.request` and `fetch.response` events
- **WHEN** the flamegraph is rendered
- **THEN** a single bar SHALL appear for the fetch span
- **AND** the bar's kind SHALL be `"rest"`
- **AND** the bar SHALL use the standard rest styling (not trigger-styled, not action-styled)

#### Scenario: timer.request/response bars render as rest

- **GIVEN** a timer callback that fired and returned successfully
- **WHEN** the flamegraph renders its `timer.request`/`timer.response` pair
- **THEN** a bar SHALL be produced with kind `"rest"`

#### Scenario: trigger and action bars retain distinct styling

- **GIVEN** a flamegraph with `trigger.*`, `action.*`, and `fetch.*` events
- **WHEN** rendered
- **THEN** the trigger bar SHALL use trigger styling
- **AND** the action bar(s) SHALL use action styling
- **AND** the fetch bar(s) SHALL use rest styling

### Requirement: Timer callbacks render in a separate track

Timer callback bars (kinds `timer.request` / `timer.response` / `timer.error`) SHALL be classified as `"rest"` kind for styling purposes but MAY be laid out on a separate track from main-tree bars depending on their temporal relationship to the main tree (callbacks firing outside the trigger span are track-only; callbacks firing inside it may nest with the main tree). This is a layout concern, not a kind-discriminator concern.

#### Scenario: Callback nested under trigger remains in main tree

- **GIVEN** a setTimeout whose callback fires before trigger.response
- **WHEN** the flamegraph lays out the timer bar
- **THEN** the bar MAY be placed in the main tree if its `ref` points to an event still inside the trigger span

### Requirement: Instant markers for single-record events

Markers SHALL be rendered for leaf events (events not belonging to a request/response/error triple). The set of marker kinds is open-ended; the rendering SHALL accept any string kind and render as a small dot. Known marker kinds include at minimum:

- `timer.set` — timer was scheduled
- `timer.clear` — timer was cancelled
- `console.log` / `console.info` / `console.warn` / `console.error` / `console.debug` — guest console call
- `uncaught-error` — uncaught exception routed through reportError
- `wasi.clock_time_get` — WASI clock read (when the wasi plugin registers this telemetry)
- `wasi.random_get` — WASI random read
- `wasi.fd_write` — QuickJS engine diagnostic line (when wasi plugin forwards)

The previous marker kind `system.call` SHALL NOT be produced by any core plugin; consumers rendering historical data containing `system.call` markers SHALL treat them as legacy.

#### Scenario: Open-ended marker kinds

- **GIVEN** a flamegraph receiving a leaf event with kind `custom.emit` (from a hypothetical plugin)
- **WHEN** the flamegraph renders
- **THEN** a marker dot SHALL be placed at the event's timestamp
- **AND** the marker's label SHALL include the full kind string

#### Scenario: wasi.* markers replace system.call

- **GIVEN** a run producing WASI telemetry via the runtime wasi plugin
- **WHEN** the flamegraph renders
- **THEN** markers SHALL be labeled `wasi.clock_time_get` or `wasi.random_get` (or `wasi.fd_write`)
- **AND** no `system.call` markers SHALL be produced by current plugin code

