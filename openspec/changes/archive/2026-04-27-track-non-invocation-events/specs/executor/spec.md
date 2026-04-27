## MODIFIED Requirements

### Requirement: Executor.fail emits trigger.exception leaf events

The `Executor` SHALL expose a `fail(owner, repo, workflow, descriptor, params)` method, sibling to `invoke`, for emitting `trigger.exception` and `trigger.rejection` leaf events. `params` SHALL have shape `{ kind: "trigger.exception" | "trigger.rejection", name: string, error?: { message: string }, input?: Readonly<Record<string, unknown>> }` (default `kind` is `"trigger.exception"` for backward compatibility with existing call sites). `fail` SHALL resolve to `Promise<void>`.

`fail` SHALL NOT touch the `SandboxStore`, `runQueue`, or any sandbox/run lifecycle machinery — pre-dispatch failures have no run, no frame, and no sandbox to resolve. The method SHALL construct a fully-stamped `InvocationEvent` with `kind = params.kind`, a freshly minted `evt_<uuid>` `id` (also serving as `invocationId`), `seq = 0`, `ref = 0`, `ts = 0`, `at = new Date().toISOString()`, plus the runtime-owned identity fields (`owner`, `repo`, `workflow.name`, `workflow.sha`), and emit it onto the bus exactly once. The event SHALL NOT carry `meta.dispatch`.

The executor's internal stamping primitive for `fail` SHALL assert that `kind ∈ {"trigger.exception", "trigger.rejection"}` (e.g. via an `assertHostFailKind` guard). Any future contributor extending the primitive to other event kinds is breaking SECURITY.md §2 R-8's host-side carve-out — the assertion is the single chokepoint that prevents this.

#### Scenario: fail emits one trigger.exception event with the documented stamping

- **GIVEN** an executor wired to a bus consumer that records emitted events
- **WHEN** `executor.fail("acme", "billing", workflowManifest, descriptor, { name: "imap.poll-failed", error: { message: "ECONNREFUSED" }, input: { stage: "connect", failedUids: [] } })` is invoked
- **THEN** exactly one event SHALL reach the consumer
- **AND** the event SHALL have `kind: "trigger.exception"`, `name: "imap.poll-failed"`, `seq: 0`, `ref: 0`, `ts: 0`
- **AND** the event SHALL have `owner: "acme"`, `repo: "billing"`, `workflow: workflowManifest.name`, `workflowSha: workflowManifest.sha`
- **AND** the event's `id` SHALL match `^evt_[A-Za-z0-9_-]{8,}$`
- **AND** the event SHALL carry `error: { message: "ECONNREFUSED" }` with no `stack` field
- **AND** the event SHALL NOT carry a `meta.dispatch` field

#### Scenario: fail emits one trigger.rejection event with the documented stamping

- **GIVEN** an executor wired to a bus consumer that records emitted events
- **WHEN** `executor.fail("acme", "billing", workflowManifest, descriptor, { kind: "trigger.rejection", name: "http.body-validation", input: { issues: [{path: ["name"], message: "Required"}], method: "POST", path: "/webhooks/acme/billing/wf/t" } })` is invoked
- **THEN** exactly one event SHALL reach the consumer
- **AND** the event SHALL have `kind: "trigger.rejection"`, `name: "http.body-validation"`, `seq: 0`, `ref: 0`, `ts: 0`
- **AND** the event SHALL carry the issues + method + path under `input`
- **AND** the event SHALL NOT carry a request body
- **AND** the event SHALL NOT carry a `meta.dispatch` field

#### Scenario: fail does not interact with sandbox lifecycle

- **GIVEN** an executor whose `SandboxStore` is asserted on every access
- **WHEN** `executor.fail(...)` is invoked with either `kind`
- **THEN** the `SandboxStore` SHALL NOT be touched
- **AND** the `runQueue` SHALL NOT be entered
- **AND** the executor's `sb.onEvent` widener SHALL NOT be invoked

### Requirement: Runtime stamps runtime-engine metadata in onEvent

The executor SHALL wire `sb.onEvent(cb)` on every sandbox it drives. The callback SHALL stamp the current run's `owner`, `repo`, `workflow`, `workflowSha`, and `invocationId` onto every event received from the sandbox before forwarding to `bus.emit`. The executor SHALL track the "current run" metadata in a variable populated before `sandbox.run()` is called and cleared after it returns.

The callback SHALL stamp `meta.dispatch = { source, user? }` onto events whose `kind === "trigger.request"`. The dispatch blob SHALL be sourced from the dispatch-context object passed by the trigger backend (HTTP source, cron source, manual UI handler) into `executor.invoke`. Events of any other `kind` SHALL NOT have `meta.dispatch` stamped by `sb.onEvent`.

`meta.dispatch = { source: "upload", user }` for `system.upload` events is stamped at host-side emission time by the upload handler's emission path, not by `sb.onEvent` (uploads do not go through the sandbox). The two stamping sites SHALL each assert on the kind they are responsible for: `sb.onEvent` asserts `kind === "trigger.request"` for its dispatch-stamping branch; the upload handler's host emitter asserts `kind === "system.upload"` for its dispatch-stamping branch.

#### Scenario: Trigger.request gets meta.dispatch stamped in onEvent

- **GIVEN** the executor invokes a trigger with dispatch context `{ source: "manual", user: { name: "alice", mail: "alice@acme" } }`
- **WHEN** the sandbox emits `trigger.request`
- **THEN** the widened event SHALL carry `meta.dispatch = { source: "manual", user: { name: "alice", mail: "alice@acme" } }`

#### Scenario: Other kinds do not get meta.dispatch stamped in onEvent

- **GIVEN** the same invocation
- **WHEN** the sandbox emits `action.request` or `system.request`
- **THEN** the widened event SHALL NOT carry `meta.dispatch`

#### Scenario: System.upload meta.dispatch is stamped at host-side emission, not in onEvent

- **GIVEN** the upload handler completes a successful upload by the user `{ name: "alice", mail: "alice@acme" }`
- **WHEN** a `system.upload` event is emitted host-side
- **THEN** the event SHALL carry `meta.dispatch = { source: "upload", user: { name: "alice", mail: "alice@acme" } }`
- **AND** the executor's `sb.onEvent` callback SHALL NOT be on the call stack for that emission
