## ADDED Requirements

### Requirement: Executor.fail emits trigger.exception leaf events

The `Executor` SHALL expose a `fail(owner, repo, workflow, descriptor, params)` method, sibling to `invoke`, for emitting `trigger.exception` leaf events. `params` SHALL have shape `{ name: string, error: { message: string }, details?: Readonly<Record<string, unknown>> }`. `fail` SHALL resolve to `Promise<void>`.

`fail` SHALL NOT touch the `SandboxStore`, `runQueue`, or any sandbox/run lifecycle machinery — pre-dispatch failures have no run, no frame, and no sandbox to resolve. The method SHALL construct a fully-stamped `InvocationEvent` with `kind = "trigger.exception"`, a freshly minted `evt_<uuid>` `id` (also serving as `invocationId`), `seq = 0`, `ref = 0`, `ts = 0`, `at = new Date().toISOString()`, plus the runtime-owned identity fields (`owner`, `repo`, `workflow.name`, `workflow.sha`), and emit it onto the bus exactly once. The event SHALL NOT carry `meta.dispatch`.

The executor's internal stamping primitive for `fail` SHALL hard-code `kind: "trigger.exception"` and assert on it (e.g. via an `assertTriggerExceptionKind` guard). Any future contributor extending the primitive to other event kinds is breaking SECURITY.md §2 R-8's host-side carve-out — the assertion is the single chokepoint that prevents this.

#### Scenario: fail emits one trigger.exception event with the documented stamping

- **GIVEN** an executor wired to a bus consumer that records emitted events
- **WHEN** `executor.fail("acme", "billing", workflowManifest, descriptor, { name: "imap.poll-failed", error: { message: "ECONNREFUSED" }, details: { stage: "connect", failedUids: [] } })` is invoked
- **THEN** exactly one event SHALL reach the consumer
- **AND** the event SHALL have `kind: "trigger.exception"`, `name: "imap.poll-failed"`, `seq: 0`, `ref: 0`, `ts: 0`
- **AND** the event SHALL have `owner: "acme"`, `repo: "billing"`, `workflow: workflowManifest.name`, `workflowSha: workflowManifest.sha`
- **AND** the event's `id` SHALL match `^evt_[A-Za-z0-9_-]{8,}$`
- **AND** the event SHALL carry `error: { message: "ECONNREFUSED" }` with no `stack` field
- **AND** the event SHALL NOT carry a `meta.dispatch` field

#### Scenario: fail does not interact with sandbox lifecycle

- **GIVEN** an executor whose `SandboxStore` is asserted on every access
- **WHEN** `executor.fail(...)` is invoked
- **THEN** the `SandboxStore` SHALL NOT be touched
- **AND** the `runQueue` SHALL NOT be entered
- **AND** the executor's `sb.onEvent` widener SHALL NOT be invoked

## MODIFIED Requirements

### Requirement: Executor is called only from fire closures

The `Executor.invoke(tenant, workflow, descriptor, input, options)` method SHALL be called exclusively from the `fire` closures constructed by `WorkflowRegistry.buildFire`. The `Executor.fail(tenant, repo, workflow, descriptor, params)` method SHALL be called exclusively from the `exception` closures constructed by `WorkflowRegistry.buildException`. No `TriggerSource` implementation SHALL import or call the executor directly.

The `options` argument to `invoke` SHALL be a bag of the form `{ bundleSource: string, dispatch?: DispatchMeta }` where `DispatchMeta` is `{ source: "trigger" | "manual", user?: { name: string, mail: string } }`. When `dispatch` is omitted the executor SHALL default to `{ source: "trigger" }`.

This rule makes the backend plugin contract cleanly decoupled: backends see only `TriggerEntry.fire(input, dispatch?)` and `TriggerEntry.exception(params)`, callbacks, with no knowledge of tenants, workflows, bundle sources, or the executor itself. Identity is captured inside each closure at construction time. The `dispatch` argument is forwarded as-is from the fire call to the executor — backends never construct it directly. The `params` argument is forwarded as-is from the exception call to `executor.fail`.

#### Scenario: No backend imports executor

- **GIVEN** the set of `packages/runtime/src/triggers/*.ts` files (excluding `build-fire.ts` and `build-exception.ts`, which are registry-level helpers)
- **WHEN** their import graph is inspected
- **THEN** no file SHALL import from `packages/runtime/src/executor/`

#### Scenario: Executor invocation observable via fire

- **GIVEN** a fire closure built by `buildFire`
- **WHEN** the closure is invoked with valid input and no dispatch argument
- **THEN** the closure SHALL call `executor.invoke(tenant, workflow, descriptor, validatedInput, { bundleSource })` exactly once
- **AND** the closure's resolution SHALL equal the executor's returned `InvokeResult`

#### Scenario: Dispatch argument forwarded through fire

- **GIVEN** a fire closure built by `buildFire` and a caller that passes `dispatch = { source: "manual", user: { name: "Jane", mail: "jane@example.com" } }`
- **WHEN** the closure is invoked with valid input and that dispatch
- **THEN** the closure SHALL call `executor.invoke(tenant, workflow, descriptor, validatedInput, { bundleSource, dispatch })` forwarding the dispatch blob unchanged

#### Scenario: Executor.fail observable via exception

- **GIVEN** an exception closure built by `buildException`
- **WHEN** the closure is invoked with `params = { name: "imap.poll-failed", error: { message: "..." }, details: { stage: "connect", failedUids: [] } }`
- **THEN** the closure SHALL call `executor.fail(tenant, workflow, descriptor, params)` exactly once
- **AND** the closure's resolution SHALL equal the executor's returned `Promise<void>`
