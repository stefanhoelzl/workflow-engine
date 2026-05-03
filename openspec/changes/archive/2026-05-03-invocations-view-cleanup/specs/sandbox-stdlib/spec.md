## MODIFIED Requirements

### Requirement: timers correlate via timerId

The `timer.set` leaf's `input.timerId` SHALL match the `timer.request`'s `input.timerId` for the same scheduled callback. `clearTimeout` / `clearInterval` leaf events SHALL carry `input.timerId` matching the cleared timer. This correlation is the basis for the invocations view's "Timer connectors" flamegraph rendering (see `invocations-list-view`).

#### Scenario: Matching timerIds across events

- **GIVEN** `const id = setTimeout(cb, 100)` followed by the callback firing
- **WHEN** the event stream is inspected
- **THEN** the `timer.set` and `timer.request` events SHALL share a single `timerId`
- **AND** that `timerId` SHALL equal `id`
