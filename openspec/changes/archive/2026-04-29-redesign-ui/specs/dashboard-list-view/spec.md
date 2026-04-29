## MODIFIED Requirements

### Requirement: Invocation rows are expandable into an inline flamegraph

Each rendered invocation row whose status is `succeeded` or `failed` SHALL provide an expand affordance that, when activated by the user, reveals an inline flamegraph fragment for that invocation. Pending invocations SHALL NOT provide an expand affordance. Multiple rows MAY be expanded simultaneously (no accordion coordination).

The flamegraph fragment SHALL be loaded on demand the first time a row is expanded, scoped to that row's own `(owner, repo)` rather than to the page-level filter — so a cross-scope view still resolves each row's flamegraph correctly. Subsequent toggles on a row that has already loaded its fragment SHALL NOT trigger a re-fetch.

#### Scenario: Completed row's flamegraph is fetched from its own scope

- **GIVEN** a cross-scope `/dashboard` request and a succeeded invocation `evt_abc` belonging to `(alice, utils)`
- **WHEN** the user expands the row for `evt_abc`
- **THEN** the runtime SHALL request the flamegraph fragment for `evt_abc` scoped to `(alice, utils)`, not to the page's current filter scope

#### Scenario: Pending row has no expand affordance

- **GIVEN** a pending invocation `evt_ghi`
- **WHEN** the invocation list is rendered
- **THEN** the row SHALL NOT include an expand affordance
- **AND** activating the row SHALL NOT trigger a flamegraph fetch

### Requirement: Bar visual treatment by kind and status

The flamegraph SHALL classify each rendered bar by a kind discriminator derived from the event-kind prefix:

- A bar produced from `trigger.request` / `trigger.response` / `trigger.error` events is a `trigger` bar.
- A bar produced from `action.request` / `action.response` / `action.error` events is an `action` bar.
- A bar produced from `system.*` request / response / error pairs (covering fetch, sendMail, executeSql, timers, custom plugin-emitted pairs) is a `rest` bar.
- An event that is not the closing half of a `request → response/error` pair (e.g. `system.call`, `system.exception`) SHALL NOT render as a bar; it MAY render as an instant marker (see "Instant markers for single-record events").

Bars SHALL render using the cross-surface kind colour mapping defined in `ui-foundation` ("Cross-surface kind colour mapping"); the flamegraph SHALL NOT use a colour palette distinct from the rest of the UI for kind colouring.

Bars whose terminal event ends with `.error` SHALL render with an error visual treatment (consistent with the "failed" status colour token); otherwise they SHALL render with the success treatment.

#### Scenario: system.request/response bars render as rest

- **GIVEN** a flamegraph layout for a run that emitted `system.request` and `system.response` events with `name = "fetch"`
- **WHEN** the flamegraph is rendered
- **THEN** a single bar SHALL appear for the fetch span
- **AND** the bar's kind SHALL be `rest`

#### Scenario: Trigger and action bars retain distinct visual identity

- **GIVEN** a flamegraph with `trigger.*`, `action.*`, and `system.*` events
- **WHEN** the flamegraph is rendered
- **THEN** the trigger bar SHALL render with a colour distinct from the action bar
- **AND** both SHALL render with colours distinct from rest bars
- **AND** the colours used SHALL match the cross-surface kind palette per `ui-foundation`

#### Scenario: Errored bar uses error visual treatment

- **GIVEN** a span whose terminal event has kind ending in `.error`
- **WHEN** the flamegraph renders that span
- **THEN** the bar SHALL render with the error colour treatment
- **AND** non-error bars in the same flamegraph SHALL render with the success treatment
