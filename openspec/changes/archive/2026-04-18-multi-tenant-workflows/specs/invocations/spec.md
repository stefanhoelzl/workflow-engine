## MODIFIED Requirements

### Requirement: Invocation record shape

An invocation record SHALL be the unit of persistence and indexing for a trigger run. The record SHALL contain: `id` (prefixed `evt_`), `tenant` (string; the owning tenant of the workflow), `workflow` (string), `trigger` (string), `input` (validated trigger payload), `startedAt` (ISO timestamp), `completedAt` (ISO timestamp, set on terminal transition), `status` (`"succeeded" | "failed"`), and one of `result` (when succeeded) or `error` (when failed).

#### Scenario: Succeeded invocation record carries tenant

- **GIVEN** a successful trigger handler returning `{ status: 202 }` from workflow "foo" in tenant "acme"
- **WHEN** the invocation completes
- **THEN** the record SHALL contain `tenant: "acme"`, `workflow: "foo"`, `status: "succeeded"`, `result: { status: 202, body: "", headers: {} }`, `startedAt`, `completedAt`
- **AND** the record SHALL NOT contain an `error` field

#### Scenario: Failed invocation record carries tenant

- **GIVEN** a trigger handler in tenant "contoso" that throws `Error("boom")`
- **WHEN** the invocation completes
- **THEN** the record SHALL contain `tenant: "contoso"`, `status: "failed"`, `error: { message: "boom", stack: "..." }`, `startedAt`, `completedAt`

### Requirement: Invocation lifecycle events

The runtime SHALL define three invocation lifecycle event kinds emitted to the bus during normal operation: `started`, `completed`, `failed`. Each event SHALL carry the invocation id, `tenant` (the owning tenant of the workflow), workflow name, trigger name, and two orthogonal time fields: `at` (ISO 8601 wall-clock string with millisecond precision, produced by `new Date().toISOString()`) and `ts` (integer microseconds since the current sandbox run's monotonic anchor; resets to ≈ 0 at the start of each `sandbox.run()` and is monotonic within a run). `completed` events SHALL additionally carry the result; `failed` events SHALL additionally carry the serialized error.

Events emitted outside an active sandbox run (the synthetic `trigger.error` produced by recovery) SHALL carry `tenant` copied from the first replayed event (which itself carries the tenant from the originating runner), SHALL carry `at = new Date().toISOString()` at emission time, and SHALL carry a `ts` value copied from the last replayed event's `ts` (or `0` if no events were replayed).

The `tenant` field SHALL be stamped by the emitting `WorkflowRunner` from its immutable `tenant` property at event construction time. Sandbox code SHALL NOT be able to set, override, or observe this field.

`ts` is a per-run measurement and SHALL NOT be used to order events across different invocations; cross-invocation ordering SHALL use `at`.

#### Scenario: Started event carries tenant

- **GIVEN** an invocation about to begin on a workflow owned by tenant "acme"
- **WHEN** the executor emits the `started` lifecycle event
- **THEN** the event SHALL carry `{ id, tenant: "acme", workflow, trigger, input, at, ts }`
- **AND** the event SHALL NOT carry `result` or `error`

#### Scenario: Completed event carries tenant and result

- **WHEN** the executor emits a `completed` lifecycle event
- **THEN** the event SHALL carry `{ id, tenant, workflow, trigger, at, ts, result }`

#### Scenario: Failed event carries tenant and error

- **WHEN** the executor emits a `failed` lifecycle event
- **THEN** the event SHALL carry `{ id, tenant, workflow, trigger, at, ts, error }`
- **AND** when emitted by recovery for crashed pendings, the event SHALL carry `error: { kind: "engine_crashed" }`

#### Scenario: ts is monotonic and anchored per run

- **GIVEN** two events emitted during the same sandbox run, the earlier with `ts = T_a` and the later with `ts = T_b`
- **THEN** `T_b >= T_a` SHALL hold
- **AND** `T_a` for the first event emitted in the run (typically `trigger.request`) SHALL be within a small epsilon of `0`

#### Scenario: Recovery synthetic terminal reuses the last replayed ts and preserves tenant

- **GIVEN** a crashed invocation whose first replayed event has `tenant = "acme"` and last pending event has `ts = T_last`
- **WHEN** recovery emits the synthetic `trigger.error`
- **THEN** the synthetic event SHALL have `tenant = "acme"`
- **AND** the synthetic event SHALL have `ts = T_last`
- **AND** the synthetic event SHALL have `at` equal to the wall-clock time of the emission

#### Scenario: Tenant field cannot be influenced by sandbox code

- **WHEN** sandbox-hosted code attempts to emit an event with a spoofed `tenant` field
- **THEN** the runner SHALL overwrite the field with its own `tenant` value before the event reaches the bus
