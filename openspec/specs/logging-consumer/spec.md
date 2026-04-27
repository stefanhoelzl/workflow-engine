## Purpose

Provide a dedicated bus consumer that centralizes all invocation lifecycle logging in a single location.

## Requirements

### Requirement: LoggingConsumer implements BusConsumer

The system SHALL provide a `LoggingConsumer` that implements the `BusConsumer` interface. It SHALL be created via `createLoggingConsumer(logger: Logger): BusConsumer`.

The logging consumer SHALL declare `name === "logging"` and `strict === false`. Per the event-bus contract (see `event-bus/spec.md § Requirement: EventBus interface`), best-effort consumer failures are logged as `bus.consumer-failed` and the bus continues to subsequent consumers — the runtime is not terminated. The logging consumer produces operator-facing structured output, not durability records, and a transient failure here is recoverable on the next event.

#### Scenario: Factory creates a BusConsumer

- **GIVEN** a Logger instance
- **WHEN** `createLoggingConsumer(logger)` is called
- **THEN** the returned object implements `handle()`
- **AND** exposes `name === "logging"`
- **AND** exposes `strict === false`

### Requirement: Logging consumer logs invocation lifecycle

The logging consumer SHALL implement `BusConsumer` and SHALL emit one structured pino log entry per invocation lifecycle event. The lifecycle kinds are the three protocol-level trigger kinds: `trigger.request` (logged as message `"invocation.started"` at `info` level), `trigger.response` (logged as `"invocation.completed"` at `info` level), and `trigger.error` (logged as `"invocation.failed"` at `error` level). The lifecycle identity is encoded in the pino message name, not as a separate `kind` field on the log record.

Each log entry SHALL include the invocation `id`, `workflow`, `trigger` (from `event.name`), and timestamp. The timestamp field in the log entry SHALL be named `ts` (for continuity with the existing log format) and SHALL be populated directly from `event.at` — i.e. the ISO 8601 string already on the event — without any conversion through `new Date(...)` or similar. `trigger.error` entries SHALL additionally include the serialized `event.error`.

The logging consumer SHALL NOT read or emit `event.ts` (the per-run monotonic microsecond value); that field is not meaningful in cross-invocation log streams.

#### Scenario: trigger.request event logged

- **WHEN** the consumer receives `{ kind: "trigger.request", id: "evt_a", workflow: "w", name: "t", at: "2026-04-17T10:00:00.000Z", ts: 0, ... }`
- **THEN** the consumer SHALL log a structured entry at `info` level with message `"invocation.started"` containing `id: "evt_a"`, `workflow: "w"`, `trigger: "t"`, and `ts: "2026-04-17T10:00:00.000Z"` (the ISO string from `event.at`, pass-through)
- **AND** the log entry SHALL NOT contain a `kind` field

#### Scenario: trigger.error event logged with error

- **WHEN** the consumer receives `{ kind: "trigger.error", id: "evt_a", at, ts, error: { message: "boom", stack }, ... }`
- **THEN** the consumer SHALL log a structured entry at `error` level with message `"invocation.failed"` including the serialized error
- **AND** the log entry's `ts` field SHALL equal the event's `at` ISO string

#### Scenario: Monotonic ts is not logged

- **WHEN** the consumer receives any lifecycle event
- **THEN** the emitted log entry SHALL NOT contain the event's `ts` (per-run µs) field under any log key

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

### Requirement: Logging consumer never throws

The logging consumer's `handle()` SHALL never throw. Any internal logging-library error SHALL be caught and swallowed (logged to stderr at most).

#### Scenario: Logger backend failure does not propagate

- **GIVEN** a logger whose write fails
- **WHEN** `handle(event)` is called
- **THEN** the consumer SHALL NOT propagate the error
- **AND** subsequent bus emissions SHALL be unaffected

### Requirement: Consumer ordering in bus

The LoggingConsumer SHALL be placed **after** the PersistenceConsumer and EventStore in the bus consumer array. This ensures logs confirm what has already been persisted and indexed.

#### Scenario: Logging consumer is last

- **GIVEN** a bus created with `[persistence, eventStore, logging]`
- **WHEN** `bus.emit(event)` is called
- **THEN** `persistence.handle()` is called before `logging.handle()`
