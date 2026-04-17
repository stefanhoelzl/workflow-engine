## MODIFIED Requirements

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
