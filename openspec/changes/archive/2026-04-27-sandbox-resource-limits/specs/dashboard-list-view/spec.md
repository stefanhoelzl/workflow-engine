## MODIFIED Requirements

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
