## MODIFIED Requirements

### Requirement: Lifecycle events emitted via bus

Invocation lifecycle events (`trigger.request`, `trigger.response`, `trigger.error`) SHALL be emitted by the trigger plugin running inside the sandbox (see `sandbox-plugin/spec.md` and `invocations/spec.md`), NOT synthesised by the executor. The trigger plugin SHALL capture the `CallId` returned by `ctx.emit("trigger.request", { name, input, type: "open" })` in `onBeforeRunStarted` and SHALL pass it to the matching `ctx.emit("trigger.response", { name, input, output, type: { close: callId } })` or `ctx.emit("trigger.error", { name, input, error, type: { close: callId } })` in `onRunFinished`. The executor's role is limited to forwarding every event it receives from the sandbox to the bus via `bus.emit`, after widening each event with the current run's `tenant`, `workflow`, `workflowSha`, and `invocationId` (and, on `trigger.request` only, `meta.dispatch` — see `Requirement: Runtime stamps runtime-engine metadata in onEvent`).

The executor SHALL NOT construct or emit any event outside of this forwarding path. All events originate in plugins (or in the sandbox's `RunSequencer.finish({ closeReason })` synthesis on worker death), flow through `sb.onEvent`, get stamped by the executor's widener, and hit the bus as fully-widened `InvocationEvent` objects.

In-process synthesis (worker death mid-run, including limit-breach termination) SHALL be performed automatically by the sandbox's `RunSequencer.finish({ closeReason })`. The executor SHALL NOT call any external `synthesise()` API and SHALL NOT maintain a `lastSeenSeq` mirror. Synthetic terminal events emitted by the sandbox on worker death SHALL flow through `sb.onEvent` to the executor's widener and thence to the bus, identical to the path real events take.

#### Scenario: Every sandbox-emitted event reaches the bus

- **GIVEN** a run during which the sandbox emits N events (including any synthesised on worker death)
- **WHEN** the executor's `sb.onEvent` callback fires
- **THEN** the bus SHALL receive exactly N events
- **AND** each bus event SHALL carry the run's tenant/workflow/workflowSha/invocationId
- **AND** no event SHALL be lost between sandbox emission and bus emission

#### Scenario: Worker death synthesis flows through sb.onEvent

- **GIVEN** a sandbox running a workflow that has emitted `trigger.request` and one open `system.request` (fetch in flight)
- **WHEN** the worker dies for any reason (OOM, crash, limit-breach termination)
- **THEN** the sandbox's `RunSequencer.finish({ closeReason })` SHALL synthesise one `system.error` and one `trigger.error` event
- **AND** both synthetic events SHALL be delivered to `sb.onEvent` in LIFO order
- **AND** the executor SHALL widen them with runtime metadata identically to real events
- **AND** no executor-side `lastSeenSeq` mirror computation SHALL exist
