## MODIFIED Requirements

### Requirement: Invocation lifecycle events

The runtime SHALL define three invocation lifecycle event kinds emitted to the bus during normal operation: `started`, `completed`, `failed`. Each event SHALL carry the invocation id, workflow name, trigger name, and two orthogonal time fields: `at` (ISO 8601 wall-clock string with millisecond precision, produced by `new Date().toISOString()`) and `ts` (integer microseconds since the current sandbox run's monotonic anchor; resets to ≈ 0 at the start of each `sandbox.run()` and is monotonic within a run). `completed` events SHALL additionally carry the result; `failed` events SHALL additionally carry the serialized error.

Lifecycle events SHALL be emitted by the **trigger plugin** running inside the sandbox (see `sandbox-plugin/spec.md` and `executor/spec.md` "Requirement: Lifecycle events emitted via bus"), NOT synthesised by the executor. The trigger plugin SHALL emit `trigger.request` from `onBeforeRunStarted` capturing the returned `CallId`, and `trigger.response` (or `trigger.error`) from `onRunFinished` passing the captured `CallId` as the closing-call argument so the main-side `RunSequencer` pairs the close to its open via `callId` lookup. The executor's role is limited to forwarding each sandbox-emitted event through its `sb.onEvent` receiver, widening it with runtime-engine metadata (`tenant`, `workflow`, `workflowSha`, `invocationId`, and on the lifecycle "started" kind only `meta.dispatch`) before `bus.emit`.

The stamping boundary between sandbox and runtime SHALL split as follows:

- **Bridge-stamped (worker-side)**: `kind`, `name`, `ts`, `at`, `input`, `output`, `error`. The bridge ALSO assigns a worker-local `callId` for `*.request` / `*.response` / `*.error` events used in pairing; this token is consumed by the main-side `RunSequencer` and SHALL NOT be forwarded to bus consumers.
- **Sandbox-stamped (main-side, via `RunSequencer`)**: `seq` (monotonic per run, from 0), `ref` (parent-frame seq or null per the suffix-derived framing rule).
- **Runtime-stamped (in `executor.sb.onEvent`)**: `tenant`, `workflow`, `workflowSha`, `invocationId`, and on `trigger.request` only `meta.dispatch`.

In-process synthesis (worker death mid-run, including limit-breach termination) SHALL be performed by the sandbox's `RunSequencer.finish({ closeReason })` automatically when worker death is observed. The Sandbox SHALL synthesise one `<prefix>.error` close event per still-open frame in LIFO order using the captured `name` / `prefix` and the supplied `closeReason`, and SHALL forward those synthetic events through `sb.onEvent` to the runtime's stamping receiver. No external `synthesise()` API SHALL exist.

Out-of-process synthesis (recovery's cold-start path, when the owning worker process is gone before the trigger plugin could emit a terminal event) SHALL remain the sole responsibility of recovery and SHALL be performed by deriving `seq = lastPersistedSeq + 1` from the persisted event stream — the in-memory `RunSequencer` is not available in this case. Synthetic terminal events emitted by recovery SHALL carry `at = new Date().toISOString()` at emission time and SHALL carry a `ts` value copied from the last replayed event's `ts` (or `0` if no events were replayed).

`ts` is a per-run measurement and SHALL NOT be used to order events across different invocations; cross-invocation ordering SHALL use `at`.

#### Scenario: Started event has no terminal payload

- **GIVEN** an invocation about to begin
- **WHEN** the trigger plugin emits the `started` lifecycle event and the executor forwards it
- **THEN** the widened event SHALL carry `{ id, workflow, trigger, input, at, ts }` plus runtime-stamped `tenant`, `workflowSha`, `invocationId`, and `meta.dispatch`
- **AND** the event SHALL NOT carry `result` or `error`

#### Scenario: Completed event carries result

- **WHEN** the trigger plugin emits a `completed` lifecycle event and the executor forwards it
- **THEN** the widened event SHALL carry `{ id, workflow, trigger, at, ts, result }` plus runtime-stamped `tenant`, `workflowSha`, `invocationId`

#### Scenario: Failed event carries error

- **WHEN** the trigger plugin emits a `failed` lifecycle event and the executor forwards it
- **THEN** the widened event SHALL carry `{ id, workflow, trigger, at, ts, error }` plus runtime-stamped `tenant`, `workflowSha`, `invocationId`
- **AND** when emitted by recovery for crashed pendings, the event SHALL carry `error: { kind: "engine_crashed" }`

#### Scenario: Worker death mid-run synthesises closes via the sequencer

- **GIVEN** a sandbox running a workflow that has emitted `trigger.request` and is mid-fetch (a `system.request` open frame is on the refStack)
- **WHEN** the worker dies (OOM, crash, or limit-breach termination)
- **THEN** `RunSequencer.finish({ closeReason })` SHALL synthesise one `system.error` event closing the fetch frame and one `trigger.error` event closing the trigger frame
- **AND** both events SHALL flow through `sb.onEvent` to the runtime stamping receiver in the same way real events do
- **AND** no `lastSeenSeq + 1` mirror computation SHALL exist outside the `RunSequencer`

#### Scenario: Recovery synthetic terminal reuses the last replayed ts

- **GIVEN** a crashed invocation whose last pending event has `ts = T_last`
- **WHEN** recovery emits the synthetic `trigger.error` from outside any live sandbox
- **THEN** the synthetic event SHALL have `ts = T_last`
- **AND** the synthetic event SHALL have `at` equal to the wall-clock time of the emission
- **AND** recovery SHALL derive `seq` by reading the last persisted event's seq and incrementing, NOT via any `RunSequencer` instance
