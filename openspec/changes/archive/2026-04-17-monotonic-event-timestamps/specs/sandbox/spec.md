## MODIFIED Requirements

### Requirement: Monotonic clock anchor lifecycle

The sandbox SHALL maintain a single mutable monotonic anchor shared by the `CLOCK_MONOTONIC` branch of the WASI `clock_time_get` override and every `InvocationEvent` emission site. The anchor SHALL live in a single cell held on `wasiState` and accessed by the bridge via `bridge.anchorNs()` / `bridge.tsUs()` / `bridge.resetAnchor()`:

- `bridge.resetAnchor()` — overwrites the cell with `BigInt(Math.trunc(performance.now() * 1_000_000))`.
- `bridge.anchorNs()` — returns the cell's current BigInt nanoseconds value.
- `bridge.tsUs()` — returns `Math.round((performance.now() - Number(anchorNs)/1_000_000) * 1000)` as an integer Number.

The anchor cell SHALL be seeded via an initial `perfNowNs()` read BEFORE `QuickJS.create()` is invoked, so the WASI monotonic clock returns small values during VM initialization. This prevents QuickJS from caching a large reference internally for `performance.now()` on its first read. The anchor SHALL then be re-seeded via `bridge.resetAnchor()` each time `bridge.setRunContext` is called for a new run.

Guest reads of `performance.now()` across reruns of a cached sandbox SHALL therefore start near zero at the beginning of every run, regardless of how much wall-clock time has elapsed between runs. The anchor source read by the WASI clock and by event `ts` fields SHALL be the same cell, so host-side events and WASI-exposed monotonic readings never drift against each other.

Note: QuickJS captures its own `performance.now()` reference internally on first read (during VM init). As a consequence, guest `performance.now()` readings are offset by the VM-init-to-run-start gap (a few milliseconds) relative to the current host-side event `ts`. Both values remain small (sub-second for realistic runs) and monotonic within a run; they do not need to be byte-identical.

#### Scenario: Monotonic resets between runs on a cached sandbox

- **GIVEN** a cached sandbox that has completed one run in which `performance.now()` reached value V1
- **WHEN** a second run begins via `sandbox.run(...)`
- **AND** guest code in the second run invokes `performance.now()` as the first monotonic read
- **THEN** the returned value SHALL be within a small epsilon of `0`
- **AND** SHALL be strictly less than V1

#### Scenario: WASI monotonic clock and event ts are both run-anchored

- **GIVEN** a sandbox run in progress
- **WHEN** guest code reads `performance.now()` and the runtime immediately thereafter emits an InvocationEvent
- **THEN** the guest's reading (in ms) SHALL have absolute value under one second
- **AND** the event's `ts` (in µs) SHALL be greater than or equal to zero and under one second in magnitude
- **AND** the WASI monotonic clock override and `bridge.tsUs()` SHALL read their anchor from the same underlying cell

### Requirement: WASI clock_time_get override

The sandbox worker SHALL install a WASI `clock_time_get` override at QuickJS VM creation. For `CLOCK_REALTIME` the override SHALL return `BigInt(Date.now()) * 1_000_000n` nanoseconds (pass-through to the host wall clock). For `CLOCK_MONOTONIC` the override SHALL return `(BigInt(Math.trunc(performance.now() * 1_000_000)) - bridge.anchorNs())` where `bridge.anchorNs()` returns the bridge-owned monotonic anchor defined in the "Monotonic clock anchor lifecycle" requirement.

While a run context is active (i.e. `bridge.getRunContext()` returns non-null), each invocation of the override SHALL emit one InvocationEvent with `kind = "system.call"`, `name = "wasi.clock_time_get"`, `input = { clockId: "REALTIME" | "MONOTONIC" }`, and `output = { ns: <number> }`. Invocations that fire without a run context (VM initialization, WASI libc init, guest source evaluation before the first run) SHALL NOT emit events.

#### Scenario: Realtime read passes through and emits event during a run

- **GIVEN** a running sandbox with no clock controls
- **WHEN** guest code inside an active run invokes `Date.now()`
- **THEN** the returned value SHALL approximate the host wall-clock time at call time
- **AND** one `system.call` event with `name = "wasi.clock_time_get"`, `input.clockId = "REALTIME"`, and `output.ns` matching the returned value times `1_000_000` SHALL be emitted

#### Scenario: Monotonic read is anchored to the current run

- **GIVEN** a running sandbox
- **WHEN** guest code inside an active run invokes `performance.now()` as the first monotonic read of that run
- **THEN** the returned value SHALL be within a small epsilon of `0`
- **AND** a subsequent `performance.now()` later in the same run SHALL return a strictly greater non-negative value

#### Scenario: Pre-run clock reads do not emit events

- **GIVEN** a sandbox whose `handleInit` has completed but `handleRun` has not started
- **WHEN** any WASI `clock_time_get` read fires (including QuickJS PRNG seeding or workflow source IIFE construction)
- **THEN** no InvocationEvent SHALL be emitted for that read

## ADDED Requirements

### Requirement: Event `at` and `ts` fields sourced from the bridge

Every InvocationEvent emitted by the sandbox during an active run SHALL carry two time fields populated at emission time:

- `at: string` — `new Date().toISOString()` captured at emission.
- `ts: number` — `bridge.tsUs()` captured at emission (integer µs since the current run's anchor).

All three emission sites — `installEmitEvent` for action events, `emitTriggerEvent` for trigger events, and the bridge's internal `buildEvent` for system events — SHALL populate these fields from the same helpers. Neither field SHALL be derived by a VM round-trip; both are computed on the host side at the moment of emission.

#### Scenario: Action event carries at and ts

- **GIVEN** a guest that calls `ctx.emit("did-thing", { ... })` during a run
- **WHEN** the resulting `action.request` InvocationEvent is observed
- **THEN** it SHALL carry a non-empty `at` string parseable as an ISO 8601 date
- **AND** it SHALL carry an integer `ts` value greater than or equal to zero

#### Scenario: System event carries at and ts

- **GIVEN** a guest whose execution triggers a bridge `system.request` event
- **WHEN** the event is observed
- **THEN** it SHALL carry the same `at` / `ts` shape as action events
- **AND** `ts` SHALL be less than or equal to the `ts` of the corresponding `system.response`

#### Scenario: Trigger terminal event ts exceeds trigger.request ts

- **GIVEN** a completed sandbox run
- **WHEN** the `trigger.request` event has `ts = T_req` and the terminal `trigger.response` (or `trigger.error`) has `ts = T_term`
- **THEN** `T_term >= T_req` SHALL hold
- **AND** `T_term - T_req` SHALL equal the sandbox-observable execution duration in microseconds
