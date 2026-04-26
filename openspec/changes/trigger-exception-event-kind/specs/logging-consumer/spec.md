## MODIFIED Requirements

### Requirement: Only trigger.* lifecycle events are logged

The logging consumer SHALL handle only the three invocation lifecycle kinds (`trigger.request`, `trigger.response`, `trigger.error`). All other bus event kinds — `trigger.exception`, `action.*`, `system.*` (which now subsumes the previously distinct `fetch.*`, `mail.*`, `sql.*`, `timer.*`, `console.*`, `wasi.*` prefixes) — SHALL be ignored (no log entry emitted). Those kinds are captured by the EventStore for the dashboard and would be too verbose for the structured stdout log stream.

`trigger.exception` is intentionally NOT logged: it represents an *author-fixable* trigger setup failure (e.g. IMAP misconfiguration), not an operator-actionable engine event. Surfacing every misconfigured tenant trigger as an operator log line would re-introduce the noise this consumer was designed to avoid. Operator-relevant pre-dispatch failures (genuine engine bugs such as `cron.fire-threw`, `imap.fire-threw`, `cron.schedule-invalid`) are logged at their call sites by the trigger source itself, not by this consumer.

The consumer SHALL match strictly on `kind`, not on `name`. A `system.request` event with `name = "fetch"` SHALL be ignored at the same level as a `system.call` event with `name = "console.log"` — both fall outside the `trigger.{request,response,error}` filter. Likewise a `trigger.exception` event SHALL be ignored regardless of its `name` discriminator (`"imap.poll-failed"`, future trigger-source names, etc.).

#### Scenario: action.* event is not logged

- **WHEN** the consumer receives an event with `kind: "action.request"` (or any non-`trigger.{request,response,error}` kind)
- **THEN** the consumer SHALL NOT emit a log entry for that event

#### Scenario: system.* event is not logged regardless of name

- **GIVEN** the consumer receives any of: `system.request name="fetch"`, `system.response name="sendMail"`, `system.call name="console.log"`, `system.exception name="TypeError"`
- **WHEN** the consumer's `handle()` is called
- **THEN** the consumer SHALL NOT emit a log entry for any of those events

#### Scenario: trigger.exception is not logged

- **GIVEN** the consumer receives a `trigger.exception` event with `name: "imap.poll-failed"`, `payload: { stage: "connect", failedUids: [], error: { message: "ECONNREFUSED" } }`
- **WHEN** `handle()` is called
- **THEN** the consumer SHALL NOT emit a log entry for that event
- **AND** the consumer SHALL NOT throw

#### Scenario: trigger.exception is not logged regardless of name

- **GIVEN** any `trigger.exception` event with an arbitrary `name` discriminator
- **WHEN** `handle()` is called
- **THEN** no log entry SHALL be emitted
