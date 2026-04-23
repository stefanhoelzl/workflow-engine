# Invocations Specification

## Purpose

Define the invocation record shape, lifecycle events, and the relationship between trigger invocations and action calls.

## Requirements

### Requirement: Invocation record shape

An invocation record SHALL be the unit of persistence and indexing for a trigger run. The record SHALL contain: `id` (prefixed `evt_`), `workflow` (string), `trigger` (string), `input` (validated trigger payload), `startedAt` (ISO timestamp), `completedAt` (ISO timestamp, set on terminal transition), `status` (`"succeeded" | "failed"`), and one of `result` (when succeeded) or `error` (when failed).

#### Scenario: Succeeded invocation record

- **GIVEN** a successful trigger handler returning `{ status: 202 }`
- **WHEN** the invocation completes
- **THEN** the record SHALL contain `status: "succeeded"`, `result: { status: 202, body: "", headers: {} }`, `startedAt`, `completedAt`
- **AND** the record SHALL NOT contain an `error` field

#### Scenario: Failed invocation record

- **GIVEN** a trigger handler that throws `Error("boom")`
- **WHEN** the invocation completes
- **THEN** the record SHALL contain `status: "failed"`, `error: { message: "boom", stack: "..." }`, `startedAt`, `completedAt`
- **AND** the record SHALL NOT contain a `result` field

### Requirement: Invocation lifecycle events

The runtime SHALL define three invocation lifecycle event kinds emitted to the bus during normal operation: `started`, `completed`, `failed`. Each event SHALL carry the invocation id, workflow name, trigger name, and two orthogonal time fields: `at` (ISO 8601 wall-clock string with millisecond precision, produced by `new Date().toISOString()`) and `ts` (integer microseconds since the current sandbox run's monotonic anchor; resets to ≈ 0 at the start of each `sandbox.run()` and is monotonic within a run). `completed` events SHALL additionally carry the result; `failed` events SHALL additionally carry the serialized error.

Events emitted outside an active sandbox run (currently only the synthetic `trigger.error` produced by recovery) SHALL carry `at = new Date().toISOString()` at emission time and SHALL carry a `ts` value copied from the last replayed event's `ts` (or `0` if no events were replayed).

`ts` is a per-run measurement and SHALL NOT be used to order events across different invocations; cross-invocation ordering SHALL use `at`.

#### Scenario: Started event has no terminal payload

- **GIVEN** an invocation about to begin
- **WHEN** the executor emits the `started` lifecycle event
- **THEN** the event SHALL carry `{ id, workflow, trigger, input, at, ts }`
- **AND** the event SHALL NOT carry `result` or `error`

#### Scenario: Completed event carries result

- **WHEN** the executor emits a `completed` lifecycle event
- **THEN** the event SHALL carry `{ id, workflow, trigger, at, ts, result }`

#### Scenario: Failed event carries error

- **WHEN** the executor emits a `failed` lifecycle event
- **THEN** the event SHALL carry `{ id, workflow, trigger, at, ts, error }`
- **AND** when emitted by recovery for crashed pendings, the event SHALL carry `error: { kind: "engine_crashed" }`

#### Scenario: ts is monotonic and anchored per run

- **GIVEN** two events emitted during the same sandbox run, the earlier with `ts = T_a` and the later with `ts = T_b`
- **THEN** `T_b >= T_a` SHALL hold
- **AND** `T_a` for the first event emitted in the run (typically `trigger.request`) SHALL be within a small epsilon of `0`

#### Scenario: Recovery synthetic terminal reuses the last replayed ts

- **GIVEN** a crashed invocation whose last pending event has `ts = T_last`
- **WHEN** recovery emits the synthetic `trigger.error`
- **THEN** the synthetic event SHALL have `ts = T_last`
- **AND** the synthetic event SHALL have `at` equal to the wall-clock time of the emission

### Requirement: Action calls are not separate invocations

Action calls made within a trigger handler (e.g., `await sendNotification(input)`) SHALL be nested function calls within the trigger invocation, not separate persisted invocations. They SHALL NOT produce their own `pending/<id>.json` or `archive/<id>.json` files. They SHALL NOT emit lifecycle events to the bus.

#### Scenario: Action call inside trigger handler

- **GIVEN** a trigger handler that calls `await sendNotification({ message: "x" })`
- **WHEN** the handler executes
- **THEN** exactly one invocation record SHALL be persisted (for the trigger)
- **AND** no separate record SHALL be created for the `sendNotification` call

### Requirement: Invocation IDs are unique

Each invocation SHALL receive a unique id at creation. The id SHALL be prefixed `evt_` and SHALL be globally unique across the runtime.

#### Scenario: Generated id has expected prefix

- **WHEN** a new invocation is constructed
- **THEN** its id SHALL match the regex `^evt_[A-Za-z0-9_-]{8,}$`

### Requirement: Dispatch provenance on trigger.request

Every `trigger.request` invocation event SHALL carry a `meta.dispatch` object with the shape `{ source: "trigger" | "manual", user?: { name: string, mail: string } }`.

- `source` SHALL be `"trigger"` when the invocation was wired through a registered trigger backend (HTTP webhook POST at `/webhooks/*`, cron tick, future kinds).
- `source` SHALL be `"manual"` when the invocation was dispatched through the `/trigger/*` UI endpoint.
- `user` SHALL be present when `source === "manual"` AND the dispatching request carried an authenticated session (populated from the session as `{ name, mail }`). For manual fires in open-mode dev without an authenticated session, `user` SHALL be populated with the sentinel `{ name: "local", mail: "" }` so downstream UI chip tooltips have a non-empty attribution. `user` SHALL be absent for `source: "trigger"` dispatches.
- The `meta` container and the `dispatch` key it holds SHALL appear on the `trigger.request` event only. Other event kinds (`trigger.response`, `trigger.error`, `action.*`, `timer.*`, `fetch.*`, `wasi.*`, `system.*`) SHALL NOT carry `meta.dispatch`.

The dispatch blob SHALL be stamped by the runtime, never by the sandbox or by plugin code (see `executor` spec "Runtime stamps runtime-engine metadata in onEvent"). Workflow handler code SHALL NOT see `meta.dispatch` — the `input` passed to the handler SHALL NOT include `dispatch`.

#### Scenario: External webhook POST produces source=trigger

- **GIVEN** an external caller sends `POST /webhooks/<tenant>/<workflow>/<name>` with a valid body
- **WHEN** the executor emits the `trigger.request` event for the resulting invocation
- **THEN** the event SHALL carry `meta.dispatch = { source: "trigger" }` with no `user` field

#### Scenario: Cron tick produces source=trigger

- **GIVEN** a cron trigger fires on schedule
- **WHEN** the executor emits the `trigger.request` event for the resulting invocation
- **THEN** the event SHALL carry `meta.dispatch = { source: "trigger" }` with no `user` field

#### Scenario: Authenticated UI fire produces source=manual with user

- **GIVEN** an authenticated user with session `{ name: "Jane Doe", mail: "jane@example.com" }` POSTs to `/trigger/<tenant>/<workflow>/<name>`
- **WHEN** the executor emits the `trigger.request` event for the resulting invocation
- **THEN** the event SHALL carry `meta.dispatch = { source: "manual", user: { name: "Jane Doe", mail: "jane@example.com" } }`

#### Scenario: Unauthenticated open-mode UI fire produces source=manual with sentinel user

- **GIVEN** the server is running in open-mode dev and `/trigger/*` receives a POST with no session cookie (`c.get("authOpen")` is `true` and `c.get("user")` is undefined)
- **WHEN** the executor emits the `trigger.request` event for the resulting invocation
- **THEN** the event SHALL carry `meta.dispatch = { source: "manual", user: { name: "local", mail: "" } }`

#### Scenario: Non-trigger events do not carry meta.dispatch

- **GIVEN** an invocation that emits `trigger.request`, `action.request`, `action.response`, and `trigger.response`
- **WHEN** the events are inspected
- **THEN** only `trigger.request` SHALL carry `meta.dispatch`
- **AND** `action.request`, `action.response`, and `trigger.response` SHALL NOT carry a `meta` field (or `meta` SHALL be empty of `dispatch`)

#### Scenario: Workflow handler input omits dispatch

- **GIVEN** a workflow handler bound to an HTTP trigger fired from the UI by a named user
- **WHEN** the handler runs with `payload` as its argument
- **THEN** `payload` SHALL contain `{ body, headers, url, method }` and SHALL NOT contain a `dispatch` field
