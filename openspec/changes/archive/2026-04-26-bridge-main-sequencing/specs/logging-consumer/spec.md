## MODIFIED Requirements

### Requirement: Only trigger.* lifecycle events are logged

The logging consumer SHALL handle only the three invocation lifecycle kinds (`trigger.request`, `trigger.response`, `trigger.error`). All other bus event kinds — `action.*`, `system.*` (which now subsumes the previously distinct `fetch.*`, `mail.*`, `sql.*`, `timer.*`, `console.*`, `wasi.*` prefixes) — SHALL be ignored (no log entry emitted). Those kinds are captured by the EventStore for the dashboard and would be too verbose for the structured stdout log stream.

The consumer SHALL match strictly on `kind`, not on `name`. A `system.request` event with `name = "fetch"` SHALL be ignored at the same level as a `system.call` event with `name = "console.log"` — both fall outside the `trigger.*` filter.

#### Scenario: action.* event is not logged

- **WHEN** the consumer receives an event with `kind: "action.request"` (or any non-`trigger.*` kind)
- **THEN** the consumer SHALL NOT emit a log entry for that event

#### Scenario: system.* event is not logged regardless of name

- **GIVEN** the consumer receives any of: `system.request name="fetch"`, `system.response name="sendMail"`, `system.call name="console.log"`, `system.exception name="TypeError"`
- **WHEN** the consumer's `handle()` is called
- **THEN** the consumer SHALL NOT emit a log entry for any of those events
