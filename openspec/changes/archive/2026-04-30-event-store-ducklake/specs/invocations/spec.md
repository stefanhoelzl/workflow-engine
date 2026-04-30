## ADDED Requirements

### Requirement: Executor emits invocation lifecycle log lines

The runtime executor SHALL emit structured log lines for invocation lifecycle events. These log lines are independent of the durable archive (they go to the runtime logger, not to the events table) and SHALL be emitted after the corresponding `eventStore.record(event)` call returns, so that a logged lifecycle line implies a corresponding accumulator-or-DuckLake state transition.

The executor SHALL discriminate on `event.kind` and emit:

- `invocation.started` (level `info`) on `event.kind === "trigger.request"`, with fields `{ id, workflow, trigger, ts }` where `trigger` is `event.name` and `ts` is `event.at`.
- `invocation.completed` (level `info`) on `event.kind === "trigger.response"`, with the same four fields.
- `invocation.failed` (level `error`) on `event.kind === "trigger.error"`, with the same four fields plus `error: event.error`.

Action-level events (`action.request`, `action.response`, `action.error`) and system events (`system.upload`, `system.exhaustion`, `trigger.exception`, `trigger.rejection`) SHALL NOT produce lifecycle log lines — they remain in the durable events table for the dashboard but are too verbose for structured logs.

A logger failure (the `logger.info` / `logger.error` call throws) SHALL NOT propagate. The executor SHALL wrap the log emission in a try/catch with a `console.error` fallback as a last-resort safety net, so that lifecycle logging never poisons the durable record path.

#### Scenario: trigger.request emits invocation.started

- **GIVEN** the executor processes an event with kind `trigger.request`, `id: "evt_a"`, `workflow: "demo"`, `name: "webhook"`, `at: "2026-04-30T10:00:00.000Z"`
- **WHEN** the event has been recorded into EventStore
- **THEN** the runtime logger SHALL receive `info("invocation.started", { id: "evt_a", workflow: "demo", trigger: "webhook", ts: "2026-04-30T10:00:00.000Z" })`

#### Scenario: trigger.response emits invocation.completed

- **GIVEN** the executor processes an event with kind `trigger.response`, `id: "evt_a"`, `workflow: "demo"`, `name: "webhook"`, `at: "2026-04-30T10:00:01.000Z"`
- **WHEN** the event has been recorded into EventStore
- **THEN** the runtime logger SHALL receive `info("invocation.completed", { id: "evt_a", workflow: "demo", trigger: "webhook", ts: "2026-04-30T10:00:01.000Z" })`

#### Scenario: trigger.error emits invocation.failed at error level with the error payload

- **GIVEN** the executor processes an event with kind `trigger.error`, `id: "evt_a"`, `workflow: "demo"`, `name: "webhook"`, `at: "2026-04-30T10:00:02.000Z"`, `error: { message: "boom", kind: "engine_crashed" }`
- **WHEN** the event has been recorded into EventStore
- **THEN** the runtime logger SHALL receive `error("invocation.failed", { id: "evt_a", workflow: "demo", trigger: "webhook", ts: "2026-04-30T10:00:02.000Z", error: { message: "boom", kind: "engine_crashed" } })`

#### Scenario: action and system events do not emit lifecycle log lines

- **GIVEN** the executor processes events with kinds `action.request`, `action.response`, `system.upload`
- **WHEN** each event has been recorded into EventStore
- **THEN** the runtime logger SHALL NOT receive any `invocation.started`, `invocation.completed`, or `invocation.failed` line for those events

#### Scenario: Logger failure does not propagate

- **GIVEN** the runtime logger's `info` method throws on every call
- **WHEN** the executor processes a `trigger.request` event
- **THEN** the executor SHALL NOT propagate the logger exception
- **AND** the `eventStore.record(event)` call SHALL still have completed normally
- **AND** a `console.error` line SHALL have been emitted as a last-resort fallback

### Requirement: Lifecycle logging is independent of archive durability

A logged lifecycle line means the application observed the invocation reach that state. It does NOT mean the event is durably archived. If `eventStore.record(event)` later drops the invocation (retry exhaustion, see the `event-store` capability), the application-side lifecycle log lines for that invocation may have been emitted while no row exists in the durable archive. Operators triaging "where did this invocation go?" SHALL distinguish the two streams: lifecycle logs (`invocation.*`) describe application observation; archive logs (`event-store.*`) describe durability outcomes.

#### Scenario: Dropped invocation has lifecycle line but no archive row

- **GIVEN** an invocation `evt_a` whose terminal commit has exhausted retries and dropped
- **WHEN** the operator inspects the runtime logs
- **THEN** they SHALL find an `invocation.completed { id: "evt_a", ... }` line emitted at terminal time
- **AND** an `event-store.commit-dropped { id: "evt_a", ... }` line emitted at drop time
- **AND** `eventStore.query(scopes)` SHALL NOT return any rows for `evt_a`
