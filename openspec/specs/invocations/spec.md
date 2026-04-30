# Invocations Specification

## Purpose

Define the invocation record shape, lifecycle events, and the relationship between trigger invocations and action calls.

Throughout this spec, "trigger" refers to the SDK-authored `httpTrigger`/`cronTrigger`/`manualTrigger` callable (the declared entry point in the workflow source). "Invocation" refers to a single *fire* of that trigger — one unit of persistence, one `id`, one lifecycle-event stream on the bus. An invocation is always *invocation-scoped*: dispatch provenance, timing, and status attach to the invocation record, not to the trigger definition. A single trigger can produce many invocations over its lifetime (one per HTTP request, one per cron tick, one per "Run now" click); each invocation is tracked independently and carries its own `meta.dispatch` (see "Dispatch provenance on trigger.request" below).
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

When the EventStore observes a `trigger.exception`, `trigger.rejection`, or `system.upload` event with a fresh `invocationId` and no preceding `trigger.request`, the invocation record builder SHALL construct a synthetic invocation record from the single leaf event. The record SHALL have:

- `id`: from `event.invocationId`
- `workflow`: from `event.workflow`
- `trigger`: from `event.name`-derived trigger name (or the literal `"upload"` for `system.upload` events)
- `input`: the empty object `{}` for `trigger.exception` and `trigger.rejection`; the per-workflow manifest sub-snapshot from `event.input` for `system.upload`
- `startedAt`: equal to `event.at`
- `completedAt`: equal to `event.at` (atomic terminal)
- `status`: `"failed"` for `trigger.exception` and `trigger.rejection`; `"succeeded"` for `system.upload`
- `error`: `event.error` (`trigger.exception`) or a derived summary of `event.input.issues` (`trigger.rejection`); absent for `system.upload`
- `result`: `{workflowSha: event.workflowSha}` for `system.upload`; absent for the other two

#### Scenario: Synthetic invocation reconstructed from a single trigger.exception event

- **GIVEN** the EventStore receives a single `trigger.exception` event with `invocationId: "evt_abc12345"`, `workflow: "ingest"`, `name: "imap.poll-failed"`, `at: "2026-04-26T10:00:00.000Z"`, `error: { message: "auth failed" }`
- **WHEN** the invocation record is read
- **THEN** the record SHALL have `id: "evt_abc12345"`, `workflow: "ingest"`, `input: {}`, `startedAt: "2026-04-26T10:00:00.000Z"`, `completedAt: "2026-04-26T10:00:00.000Z"`, `status: "failed"`, `error: { message: "auth failed" }`
- **AND** the record SHALL NOT have a `result` field

#### Scenario: Synthetic invocation reconstructed from a single trigger.rejection event

- **GIVEN** the EventStore receives a single `trigger.rejection` event with `invocationId: "evt_def67890"`, `workflow: "demo"`, `name: "http.body-validation"`, `input: {issues: [{path: ["name"], message: "Required"}], method: "POST", path: "/webhooks/local/demo/runDemo"}`, `at: "2026-04-26T11:00:00.000Z"`
- **WHEN** the invocation record is read
- **THEN** the record SHALL have `status: "failed"` and an `error` field summarizing the issues

#### Scenario: Synthetic invocation reconstructed from a single system.upload event

- **GIVEN** the EventStore receives a single `system.upload` event with `invocationId: "evt_uvw00001"`, `workflow: "demo"`, `workflowSha: "abc123"`, `name: "demo"`, `meta.dispatch: {source: "upload", user: {name: "alice", mail: "alice@acme"}}`, `at: "2026-04-26T12:00:00.000Z"`
- **WHEN** the invocation record is read
- **THEN** the record SHALL have `status: "succeeded"`, `result: {workflowSha: "abc123"}`, `trigger: "upload"`
- **AND** the record SHALL NOT have an `error` field

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

Every `trigger.request` invocation event SHALL carry a `meta.dispatch` object with the shape `{ source: "trigger" | "manual", user?: { name: string, mail: string } }`. Every `system.upload` invocation event SHALL carry a `meta.dispatch` object with the shape `{ source: "upload", user: { login: string, mail: string } }`.

- For `trigger.request`: `source` SHALL be `"trigger"` when the invocation was wired through a registered trigger backend (HTTP webhook POST at `/webhooks/*`, cron tick, future kinds). `source` SHALL be `"manual"` when the invocation was dispatched through the `/trigger/*` UI endpoint.
- For `system.upload`: `source` SHALL be `"upload"` and `user` SHALL be present (uploads are always authenticated; there is no anonymous upload path).
- For `trigger.request` with `source === "manual"`: `user` SHALL be present when the dispatching request carried an authenticated session (populated as `{ name, mail }`). For manual fires in open-mode dev without an authenticated session, `user` SHALL be populated with the sentinel `{ name: "local", mail: "" }`. `user` SHALL be absent for `source: "trigger"` dispatches.
- The `meta` container and the `dispatch` key it holds SHALL appear on `trigger.request` and `system.upload` events only. Other event kinds (`trigger.response`, `trigger.error`, `trigger.exception`, `trigger.rejection`, `action.*`, `system.request`, `system.response`, `system.error`, `system.call`, `system.exception`, `system.exhaustion`) SHALL NOT carry `meta.dispatch`.

The dispatch blob SHALL be stamped by the runtime, never by the sandbox or by plugin code. For `trigger.request`, stamping happens in `executor.sb.onEvent`. For `system.upload`, stamping happens in the upload handler's host-side emission path (uploads do not go through the sandbox). Both stamping sites SHALL assert on the kind to enforce the invariant.

Workflow handler code SHALL NOT see `meta.dispatch` — the `input` passed to the handler SHALL NOT include `dispatch`.

#### Scenario: External webhook POST produces source=trigger

- **GIVEN** an external caller sends `POST /webhooks/<owner>/<repo>/<workflow>/<name>` with a valid body
- **WHEN** the executor emits the `trigger.request` event for the resulting invocation
- **THEN** the event SHALL carry `meta.dispatch = { source: "trigger" }` with no `user` field

#### Scenario: Cron tick produces source=trigger

- **GIVEN** a cron trigger fires on schedule
- **WHEN** the executor emits the `trigger.request` event for the resulting invocation
- **THEN** the event SHALL carry `meta.dispatch = { source: "trigger" }` with no `user` field

#### Scenario: Authenticated UI fire produces source=manual with user

- **GIVEN** an authenticated user with session `{ name: "Jane Doe", mail: "jane@example.com" }` POSTs to `/trigger/<owner>/<repo>/<workflow>/<name>`
- **WHEN** the executor emits the `trigger.request` event for the resulting invocation
- **THEN** the event SHALL carry `meta.dispatch = { source: "manual", user: { name: "Jane Doe", mail: "jane@example.com" } }`

#### Scenario: UI fire without a user omits dispatch.user

- **GIVEN** a test that mounts `/trigger/*` with a stub `sessionMw` that does not set `c.set("user", …)` so `c.get("user")` is undefined
- **WHEN** the executor emits the `trigger.request` event for the resulting invocation
- **THEN** the event SHALL carry `meta.dispatch = { source: "manual" }` with no `user` field

#### Scenario: Workflow upload produces source=upload with user

- **GIVEN** an authenticated user `{ name: "alice", mail: "alice@acme" }` successfully uploads a bundle to `(owner: "acme", repo: "billing")`
- **WHEN** the upload handler emits a `system.upload` event for a workflow `demo`
- **THEN** the event SHALL carry `meta.dispatch = { source: "upload", user: { login: "alice", mail: "alice@acme" } }`

#### Scenario: Non-trigger non-upload events do not carry meta.dispatch

- **GIVEN** an invocation that emits `trigger.request`, `action.request`, `action.response`, and `trigger.response`
- **WHEN** the events are inspected
- **THEN** only `trigger.request` SHALL carry `meta.dispatch`
- **AND** `action.request`, `action.response`, and `trigger.response` SHALL NOT carry a `meta` field (or `meta` SHALL be empty of `dispatch`)

#### Scenario: Workflow handler input omits dispatch

- **GIVEN** a workflow handler bound to an HTTP trigger fired from the UI by a named user
- **WHEN** the handler runs with `payload` as its argument
- **THEN** `payload` SHALL contain `{ body, headers, url, method }` and SHALL NOT contain a `dispatch` field

### Requirement: system.exhaustion event kind

The runtime SHALL recognise a leaf event kind `system.exhaustion` under the existing reserved `system.*` prefix. The kind represents a per-run sandbox **terminal-class** resource-limit breach (cpu, output, pending) and SHALL carry:

```
kind: "system.exhaustion"
name: "cpu" | "output" | "pending"      // terminal dimensions ONLY
type: "leaf"
input: {
  budget: number,        // the configured cap in the unit of the dimension
  observed?: number      // present only when measurable post hoc:
                         //   cpu:     elapsed ms at terminate
                         //   output:  cumulative bytes including the breaching event
                         //   pending: in-flight count at the breaching dispatch
}
```

Recoverable-class breaches (memory, stack) SHALL NOT emit `system.exhaustion`. A recoverable breach surfaces as a normal QuickJS exception inside the guest; if uncaught, it produces an ordinary `RunResult{ok:false, error}` and a regular `trigger.error` close — no `system.exhaustion` precedes it. See `sandbox/spec.md` "Sandbox resource caps — two-class classification".

`system.exhaustion` events SHALL be emitted by the sandbox layer (`packages/sandbox/src/sandbox.ts`) on the main thread when a worker termination is classified as `{kind:"limit", dim}` via `worker-termination.cause()`. The leaf SHALL be emitted via `sequencer.next({type:"leaf", kind:"system.exhaustion", name: dim, input: {...}})` BEFORE `sequencer.finish({closeReason})` synthesises LIFO close events for any still-open frames. Seq/ref are stamped by the `RunSequencer`; no manual fabrication.

`system.exhaustion` SHALL NOT be emitted by:
- guest code (no SDK API exists for emitting arbitrary kinds)
- plugin code (the prefix is reserved for runtime-driven happenings)
- the executor (synthesis lives in the sandbox layer to keep it adjacent to the RunSequencer that owns seq/ref stamping)
- recovery (recovery's domain is process-restart synthesis of `engine_crashed` terminals; resource-limit breaches happen against a live sandbox that handles synthesis itself)

The synthesised `trigger.error` close emitted by `sequencer.finish({closeReason: \`limit:${dim}\`})` carries `error: { message: "limit:<dim>" }` and serves as the terminal event for the invocation. No additional `error.kind` discriminant or `error.dimension` field is added — the dimension is structurally available via the preceding `system.exhaustion` leaf for programmatic consumers, and via the message format for raw EventStore consumers.

#### Scenario: CPU breach emits system.exhaustion with observed elapsed

- **GIVEN** a sandbox with `cpuMs = 100` running an infinite loop
- **WHEN** the watchdog terminates the worker at ~100ms
- **THEN** the sandbox SHALL emit a `system.exhaustion` leaf with `name: "cpu"`, `input: { budget: 100, observed: <≈100> }`
- **AND** the synth `trigger.error` close emitted afterwards SHALL carry `error: { message: "limit:cpu" }`

#### Scenario: Memory breach does NOT emit system.exhaustion (recoverable)

- **GIVEN** a sandbox with `memoryBytes = 1048576` whose guest code OOMs
- **WHEN** the OOM exception surfaces inside the VM
- **THEN** NO `system.exhaustion` leaf SHALL be emitted (memory is a recoverable cap)
- **AND** the run SHALL produce an ordinary `RunResult{ok:false, error:{message: /out of memory/}}` if the guest does not catch, OR succeed if the guest catches

#### Scenario: Output breach reports cumulative bytes observed

- **GIVEN** a sandbox with `outputBytes = 4194304` whose guest emits 4194305 cumulative bytes
- **WHEN** the worker terminates
- **THEN** the leaf SHALL carry `name: "output"`, `input: { budget: 4194304, observed: <≥4194305> }`

#### Scenario: Crash termination emits no system.exhaustion

- **GIVEN** a sandbox whose worker dies of an uncaught non-limit error
- **WHEN** `termination.cause()` returns `{kind:"crash", err}`
- **THEN** NO `system.exhaustion` leaf SHALL be emitted
- **AND** `sequencer.finish({closeReason: \`crash:${err.message}\`})` SHALL still synthesise LIFO closes for any open frames

### Requirement: trigger.rejection is a leaf event kind for HTTP body validation failures

The runtime SHALL define `trigger.rejection` as a leaf invocation event kind for caller-payload-validation failures on the HTTP webhook surface that occur *before* any handler runs. `trigger.rejection` is emitted host-side, has no paired `trigger.request`, and does not participate in `RunSequencer` frame pairing. It is distinct from `trigger.exception` semantically: `trigger.exception` carries author-fixable *setup* failures (bad cron schedule, IMAP misconfiguration); `trigger.rejection` carries a single rejected request whose root cause is the caller (or the author's body schema being too strict for the caller's payload).

`trigger.rejection` events SHALL carry: a `name` discriminator (e.g. `"http.body-validation"`); an `input` field with shape `{issues: Array<{path, message}>, method: string, path: string}`; no `output`, no `error`. The HTTP request body SHALL NOT be persisted on the event.

`trigger.rejection` events SHALL be emitted exclusively via the `executor.fail(owner, repo, workflow, descriptor, params)` method using the same `entry.exception` plumbing that `trigger.exception` uses, so the runtime stamping path is identical: `seq = 0`, `ref = 0`, `ts = 0`, `at = new Date().toISOString()` at emission, runtime-stamped `owner` / `repo` / `workflow` / `workflowSha` / `id`. The `meta.dispatch` field SHALL NOT appear on `trigger.rejection` events.

Synthetic-invocation reconstruction (see "Synthetic invocation record from a single trigger.exception event") SHALL apply to `trigger.rejection` events identically: a `trigger.rejection` event with a fresh `invocationId` and no preceding `trigger.request` produces a synthetic failed invocation record whose `error` is derived from the `input.issues` summary.

#### Scenario: trigger.rejection event has the documented shape

- **GIVEN** an HTTP webhook handler whose body schema rejects a caller's POST
- **WHEN** the resulting `trigger.rejection` event reaches a bus consumer
- **THEN** the event SHALL have `kind: "trigger.rejection"`, `name: "http.body-validation"`, `seq: 0`, `ref: 0`, `ts: 0`
- **AND** the event's `input` SHALL contain `{issues: Array<{path, message}>, method, path}`
- **AND** the event SHALL NOT carry the request body
- **AND** the event SHALL NOT carry a `meta.dispatch` field

#### Scenario: trigger.rejection has no paired trigger.request

- **GIVEN** an HTTP rejection event for `invocationId: "evt_xyz"`
- **WHEN** the EventStore lists events for that `invocationId`
- **THEN** the result SHALL contain exactly one event of kind `trigger.rejection`
- **AND** SHALL NOT contain any event of kind `trigger.request`, `trigger.response`, or `trigger.error`

### Requirement: system.upload event kind for workflow uploads

The runtime SHALL recognise a leaf event kind `system.upload` under the existing reserved `system.*` prefix. The kind represents a successful registration of one workflow at a specific `workflowSha` and SHALL carry:

```
kind: "system.upload"
name: <workflow name>
type: "leaf"
input: <per-workflow manifest sub-snapshot>
meta: { dispatch: { source: "upload", user: { name, mail } } }
```

`system.upload` events SHALL be emitted by the upload handler (`packages/runtime/src/api/upload.ts`) AFTER `WorkflowRegistry` registration succeeds, ONCE per workflow in the bundle, AND ONLY when no prior `system.upload` event with matching `(owner, repo, workflow, workflowSha)` already exists in the EventStore (sha-based dedup). Re-uploading identical bytes SHALL NOT produce a new event.

`system.upload` events SHALL NOT be emitted by:

- guest code or plugin code (the prefix is reserved for runtime-driven happenings)
- the executor's invocation path (uploads do not go through the sandbox)
- any path other than the upload handler

The runtime SHALL stamp `owner`, `repo`, `workflow`, `workflowSha`, `id` (a fresh `evt_…`), `kind`, `name`, `seq` (set to `0`), `ref` (set to `0`), `ts` (set to `0`), `at` (set to `new Date().toISOString()` at emission), and `meta.dispatch = {source: "upload", user}` populated from the authenticated request context.

Synthetic-invocation reconstruction (see "Synthetic invocation record from a single trigger.exception event") SHALL apply to `system.upload` events: each event produces a synthetic invocation record with `status: "succeeded"`, `result: {workflowSha}`, `startedAt = completedAt = at`, and an empty `error` field. The synthetic record's `trigger` field SHALL be the literal string `"upload"` for rendering purposes.

#### Scenario: First upload of a (workflow, sha) emits a system.upload event

- **GIVEN** an authenticated user uploads a bundle containing workflow "demo" at sha `abc123` to `(owner: "acme", repo: "billing")` for the first time
- **WHEN** the upload handler completes successfully
- **THEN** the EventStore SHALL contain exactly one new event with `kind: "system.upload"`, `name: "demo"`, `owner: "acme"`, `repo: "billing"`, `workflow: "demo"`, `workflowSha: "abc123"`
- **AND** the event SHALL carry `meta.dispatch = {source: "upload", user: {name, mail}}` populated from the request's authenticated session

#### Scenario: Re-upload with identical sha emits no new event

- **GIVEN** a `system.upload` event with `owner: "acme"`, `repo: "billing"`, `workflow: "demo"`, `workflowSha: "abc123"` already exists in the EventStore
- **WHEN** the same user re-uploads a bundle whose `demo` workflow still hashes to `abc123`
- **THEN** NO new `system.upload` event SHALL be inserted for `(acme, billing, demo, abc123)`

#### Scenario: Mixed re-upload emits only changed workflows

- **GIVEN** a bundle whose `demo` is unchanged at sha `abc123` (already recorded) and whose `report` is now at a fresh sha `def456`
- **WHEN** the upload completes
- **THEN** the EventStore SHALL gain exactly one new event with `name: "report"`, `workflowSha: "def456"`
- **AND** SHALL NOT gain a new event for `demo`

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

