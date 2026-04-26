## ADDED Requirements

### Requirement: trigger.exception is a leaf event kind for pre-dispatch failures

The runtime SHALL define `trigger.exception` as a leaf invocation event kind for author-fixable trigger setup failures that occur *before* any handler runs. Unlike `trigger.error`, which closes a `trigger.request` frame opened by the in-sandbox trigger plugin, `trigger.exception` is emitted host-side, has no paired `trigger.request`, and does not participate in `RunSequencer` frame pairing.

`trigger.exception` events SHALL carry: a `name` discriminator (e.g. `"imap.poll-failed"`); an `error` field with shape `{ message: string }` and no `stack` field; and a per-name set of additional payload fields (e.g. IMAP's `stage`, `failedUids`) carried under the event's `input` slot. The event SHALL NOT carry a `result` field.

`trigger.exception` events SHALL be emitted exclusively via the `executor.fail(owner, repo, workflow, descriptor, params)` method. `TriggerSource` implementations SHALL NOT emit `trigger.exception` events directly; they call `entry.exception(params)` on the `TriggerEntry` they were given by the registry, mirroring the `entry.fire(input)` contract for handler dispatch (see `triggers` spec). The `entry.exception` callable is built per-trigger by `buildException(executor, owner, repo, workflow, descriptor)` and bound to the executor's `fail` method.

The runtime SHALL stamp `owner`, `repo`, `workflow`, `workflowSha`, `invocationId` (i.e. `id`), `kind`, `name`, `seq` (set to `0`), `ref` (set to `0`), `ts` (set to `0`), and `at` (set to `new Date().toISOString()` at emission) for `trigger.exception` events. The `meta.dispatch` field SHALL NOT appear on `trigger.exception` events; dispatch provenance is meaningful only for `trigger.request`.

#### Scenario: trigger.exception event has the documented shape

- **GIVEN** a `TriggerEntry` for `(owner: "acme", repo: "billing", workflow: "wf", trigger: "t")` whose `entry.exception` is invoked with `{ name: "imap.poll-failed", error: { message: "ECONNREFUSED" }, details: { stage: "connect", failedUids: [] } }`
- **WHEN** the resulting event reaches a bus consumer
- **THEN** the event SHALL have `kind: "trigger.exception"`, `name: "imap.poll-failed"`, `seq: 0`, `ref: 0`, `ts: 0`
- **AND** the event SHALL carry `error: { message: "ECONNREFUSED" }` with no `stack` field
- **AND** the event SHALL carry `owner: "acme"`, `repo: "billing"`, `workflow: "wf"`, an `id` matching `^evt_[A-Za-z0-9_-]{8,}$`, and an ISO 8601 `at`
- **AND** the event SHALL NOT carry a `meta.dispatch` field

#### Scenario: trigger.exception payload omits stack

- **GIVEN** a host-side trigger setup failure caused by an `Error("boom\n  at internal/imapflow:1:1")`
- **WHEN** the source calls `entry.exception` with the error
- **THEN** the event's `error` field SHALL contain `message: "boom"`
- **AND** the event's `error` field SHALL NOT contain a `stack` field

#### Scenario: TriggerSource never emits trigger.exception directly

- **GIVEN** a `TriggerSource` that needs to surface a pre-dispatch failure
- **WHEN** its source code is reviewed
- **THEN** it SHALL NOT import the `EventBus` or any direct stamping helper for `trigger.exception`
- **AND** it SHALL invoke `entry.exception(params)` on the `TriggerEntry` it received via `reconfigure(owner, repo, entries)`

### Requirement: Synthetic invocation record from a single trigger.exception event

When the EventStore observes a `trigger.exception` event with a fresh `invocationId` and no preceding `trigger.request`, the invocation record builder SHALL construct a complete failed invocation record from the single leaf event. The record SHALL have:

- `id`: from `event.invocationId`
- `workflow`: from `event.workflow`
- `trigger`: from `event.name`-derived trigger name (the helper passes the trigger declaration name as part of the call; runtime stamps it onto a dedicated event field for this purpose)
- `input`: the empty object `{}`
- `startedAt`: equal to `event.at`
- `completedAt`: equal to `event.at` (atomic terminal)
- `status`: `"failed"`
- `error`: `event.payload.error` (i.e. `{ message }` with no stack)
- the record SHALL NOT contain a `result` field

#### Scenario: Synthetic invocation reconstructed from single leaf event

- **GIVEN** the EventStore receives a single `trigger.exception` event with `invocationId: "evt_abc12345"`, `workflow: "ingest"`, `trigger: "inbound"`, `at: "2026-04-26T10:00:00.000Z"`, `error: { message: "auth failed" }`
- **WHEN** the invocation record is read
- **THEN** the record SHALL have `id: "evt_abc12345"`, `workflow: "ingest"`, `trigger: "inbound"`, `input: {}`, `startedAt: "2026-04-26T10:00:00.000Z"`, `completedAt: "2026-04-26T10:00:00.000Z"`, `status: "failed"`, `error: { message: "auth failed" }`
- **AND** the record SHALL NOT have a `result` field

#### Scenario: Synthetic invocation has no trigger.request and no trigger.response

- **GIVEN** the same single `trigger.exception` event
- **WHEN** the EventStore lists the events for that `invocationId`
- **THEN** the result SHALL contain exactly one event of kind `trigger.exception`
- **AND** SHALL NOT contain any event of kind `trigger.request`, `trigger.response`, or `trigger.error`

## MODIFIED Requirements

### Requirement: Invocation lifecycle events

The runtime SHALL define three invocation lifecycle event kinds emitted to the bus during normal operation: `started`, `completed`, `failed`. Each event SHALL carry the invocation id, workflow name, trigger name, and two orthogonal time fields: `at` (ISO 8601 wall-clock string with millisecond precision, produced by `new Date().toISOString()`) and `ts` (integer microseconds since the current sandbox run's monotonic anchor; resets to ≈ 0 at the start of each `sandbox.run()` and is monotonic within a run). `completed` events SHALL additionally carry the result; `failed` events SHALL additionally carry the serialized error.

Lifecycle events for *handler-running* invocations SHALL be emitted by the **trigger plugin** running inside the sandbox (see `sandbox-plugin/spec.md` and `executor/spec.md` "Requirement: Lifecycle events emitted via bus"), NOT synthesised by the executor. The trigger plugin SHALL emit `trigger.request` from `onBeforeRunStarted` capturing the returned `CallId`, and `trigger.response` (or `trigger.error`) from `onRunFinished` passing the captured `CallId` as the closing-call argument so the main-side `RunSequencer` pairs the close to its open via `callId` lookup. The executor's role is limited to forwarding each sandbox-emitted event through its `sb.onEvent` receiver, widening it with runtime-engine metadata (`tenant`, `workflow`, `workflowSha`, `invocationId`, and on the lifecycle "started" kind only `meta.dispatch`) before `bus.emit`.

For *pre-dispatch* failures (failures before any handler runs), the runtime SHALL emit a single `trigger.exception` leaf event (see "trigger.exception is a leaf event kind for pre-dispatch failures"). Pre-dispatch failures SHALL NOT emit `trigger.request`, `trigger.response`, or `trigger.error`.

The stamping boundary between sandbox and runtime SHALL split as follows:

- **Bridge-stamped (worker-side)**: `kind`, `name`, `ts`, `at`, `input`, `output`, `error`. The bridge ALSO assigns a worker-local `callId` for `*.request` / `*.response` / `*.error` events used in pairing; this token is consumed by the main-side `RunSequencer` and SHALL NOT be forwarded to bus consumers.
- **Sandbox-stamped (main-side, via `RunSequencer`)**: `seq` (monotonic per run, from 0), `ref` (parent-frame seq or null per the suffix-derived framing rule).
- **Runtime-stamped (in `executor.sb.onEvent`)**: `tenant`, `workflow`, `workflowSha`, `invocationId`, and on `trigger.request` only `meta.dispatch`.
- **Runtime-stamped (in `executor.fail`, host-side, no sandbox involved)**: `tenant` (a.k.a. `owner` in current runtime code), `repo`, `workflow`, `workflowSha`, `invocationId` (a.k.a. `id`), `kind = "trigger.exception"`, `name`, `seq = 0`, `ref = 0`, `ts = 0`, `at`. This stamping path SHALL be used ONLY for `trigger.exception` events; the executor's internal stamping primitive asserts on the kind to enforce the invariant. No other event kind may bypass the sandbox/sequencer.

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

#### Scenario: Pre-dispatch failure emits trigger.exception with no surrounding frame

- **GIVEN** an IMAP trigger whose configured server refuses TCP connections
- **WHEN** the IMAP source's poll cycle fails and the runtime helper emits a `trigger.exception`
- **THEN** the event SHALL carry `kind: "trigger.exception"`, `seq: 0`, `ref: 0`, `ts: 0`, an ISO 8601 `at`, runtime-stamped `tenant` / `workflow` / `workflowSha` / `invocationId`
- **AND** no `trigger.request`, `trigger.response`, or `trigger.error` event SHALL be emitted for the same `invocationId`
