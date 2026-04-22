# Executor Specification

## Purpose

Own the lifecycle of trigger invocations end-to-end, including per-workflow serialization, lifecycle event emission via the bus, and HTTP response shaping.
## Requirements
### Requirement: Executor owns invocation lifecycle

The runtime SHALL provide an `Executor` component that owns the lifecycle of trigger invocations end-to-end. The executor SHALL expose `invoke(tenant, workflow, triggerName, payload) -> Promise<HttpTriggerResult>` as its sole public method. The executor SHALL be the only component that calls `sandbox.run(...)` to execute a trigger handler.

#### Scenario: Executor invocation lifecycle

- **GIVEN** an executor created with `createExecutor({ bus, sandboxStore })`
- **WHEN** `executor.invoke(tenant, workflow, triggerName, payload)` is called
- **THEN** the executor SHALL resolve a `Sandbox` via `sandboxStore.get(tenant, workflow, bundleSource)`
- **AND** the executor SHALL construct an invocation record with a unique id, the tenant, the workflow name, the trigger name, and the validated payload
- **AND** the executor SHALL emit a `started` lifecycle event via the bus before dispatching the handler
- **AND** the executor SHALL dispatch the trigger's handler by calling `sandbox.run("__trigger_<triggerName>", payload, { invocationId, tenant, workflow: workflow.name, workflowSha: workflow.sha })`
- **AND** on successful return the executor SHALL emit a `completed` lifecycle event via the bus carrying the result
- **AND** on thrown exception the executor SHALL emit a `failed` lifecycle event via the bus carrying a serialized error
- **AND** the executor's promise SHALL resolve to the handler's return value (success) or to `{ status: 500, body: { error: "internal_error" }, headers: {} }` (failure)

### Requirement: Per-workflow serialization via runQueue

The executor SHALL maintain one runQueue per `(tenant, workflow.sha)` pair. The runQueue SHALL ensure that at most one trigger invocation runs at a time against a given sandbox. The runQueue SHALL be a Promise-chain serializer that does not lose subsequent invocations on prior failure (failures unblock the queue).

#### Scenario: Two invocations of the same workflow serialize

- **GIVEN** tenant `t1`, workflow `w1`, with two triggers `ta` and `tb`
- **WHEN** `executor.invoke(t1, w1, ta, pa)` and `executor.invoke(t1, w1, tb, pb)` are called concurrently
- **THEN** the second invocation's handler SHALL not begin executing until the first completes (success or failure)

#### Scenario: Two workflows run in parallel

- **GIVEN** tenant `t1`, workflows `w1` and `w2` each with one trigger
- **WHEN** invocations on `w1` and `w2` are dispatched concurrently
- **THEN** their handlers MAY execute in parallel (each in its own sandbox)

#### Scenario: Two tenants run in parallel

- **GIVEN** tenants `tA` and `tB` each with a registered workflow whose bundles hash to identical shas
- **WHEN** invocations on `tA` and `tB` are dispatched concurrently
- **THEN** their handlers MAY execute in parallel, each against its tenant-scoped sandbox

#### Scenario: Failure unblocks the queue

- **GIVEN** tenant `t1`, workflow `w1`, whose invocation `i1` fails
- **WHEN** invocation `i2` is dispatched immediately after
- **THEN** `i2` SHALL begin executing rather than being blocked by `i1`'s failure

### Requirement: Lifecycle events emitted via bus

The executor SHALL forward all events received from the sandbox to the bus via `bus.emit` after stamping `tenant`, `workflow`, `workflowSha`, and `invocationId` onto each event. The executor SHALL NOT emit synthesized trigger/action events outside of this forwarding path — all events originate in plugins, flow through `sb.onEvent`, get stamped, and hit the bus.

#### Scenario: Every sandbox-emitted event reaches the bus

- **GIVEN** a run during which the sandbox emits N events
- **WHEN** the executor's `sb.onEvent` callback fires
- **THEN** the bus SHALL receive exactly N events
- **AND** each bus event SHALL carry the run's tenant/workflow/workflowSha/invocationId
- **AND** no event SHALL be lost between sandbox emission and bus emission

### Requirement: HTTP trigger result shape

The executor's return value `HttpTriggerResult` SHALL be `{ status: number, body: unknown, headers: Record<string, string> }`. When the handler returns an object with `status?`, `body?`, `headers?` fields, those SHALL be used as-is with defaults (`status` defaults to `200`, `body` to `""`, `headers` to `{}`). When the handler throws, the executor SHALL return `{ status: 500, body: { error: "internal_error" }, headers: {} }`.

#### Scenario: Handler returns full response

- **GIVEN** a handler that returns `{ status: 202, body: { ok: true }, headers: { "x-trace": "abc" } }`
- **WHEN** the executor invokes the trigger
- **THEN** the executor SHALL return `{ status: 202, body: { ok: true }, headers: { "x-trace": "abc" } }`

#### Scenario: Handler returns partial response

- **GIVEN** a handler that returns `{ status: 204 }`
- **WHEN** the executor invokes the trigger
- **THEN** the executor SHALL return `{ status: 204, body: "", headers: {} }`

#### Scenario: Handler throws unhandled error

- **GIVEN** a handler that throws `new Error("boom")`
- **WHEN** the executor invokes the trigger
- **THEN** the executor SHALL return `{ status: 500, body: { error: "internal_error" }, headers: {} }`
- **AND** the executor SHALL emit a `failed` lifecycle event with the serialized error

### Requirement: Executor has no retry logic in v1

The v1 executor SHALL NOT implement retry. A handler throw SHALL transition the invocation to `failed` immediately, with no auto-retry and no operator-triggered retry available.

#### Scenario: Handler failure is terminal in v1

- **GIVEN** a handler that throws on every invocation
- **WHEN** the executor invokes the trigger
- **THEN** the invocation SHALL be marked `failed` once and the executor SHALL not re-attempt

### Requirement: Executor is called only from fire closures

The `Executor.invoke(tenant, workflow, descriptor, input, bundleSource)` method SHALL be called exclusively from the `fire` closures constructed by `WorkflowRegistry.buildFire`. No `TriggerSource` implementation SHALL import or call the executor directly.

This rule makes the backend plugin contract cleanly decoupled: backends see only `TriggerEntry.fire(input)`, a callback, with no knowledge of tenants, workflows, bundle sources, or the executor itself. Identity is captured inside the closure at construction time.

#### Scenario: No backend imports executor

- **GIVEN** the set of `packages/runtime/src/triggers/*.ts` files
- **WHEN** their import graph is inspected
- **THEN** no file SHALL import from `packages/runtime/src/executor/`

#### Scenario: Executor invocation observable via fire

- **GIVEN** a fire closure built by `buildFire`
- **WHEN** the closure is invoked with valid input
- **THEN** the closure SHALL call `executor.invoke(tenant, workflow, descriptor, validatedInput, bundleSource)` exactly once
- **AND** the closure's resolution SHALL equal the executor's returned `InvokeResult`

### Requirement: Executor return shape is kind-agnostic

The `Executor.invoke(…)` method SHALL resolve to a discriminated `InvokeResult<unknown>`:

```
type InvokeResult<T> =
  | { ok: true; output: T }
  | { ok: false; error: { message: string; stack?: string } };
```

The shape SHALL be identical for every trigger kind (HTTP, cron, future kinds). Protocol-specific response shaping (HTTP status/body/headers) SHALL be performed by the calling backend after receiving the `InvokeResult`, NOT by the executor.

`InvokeResult` SHALL NOT embed HTTP-specific fields (`status`, `body`, `headers`). Those are derived by the HTTP `TriggerSource` from the `output` field when `ok: true`, or from a standard `500 internal_error` shape when `ok: false`.

#### Scenario: Executor returns generic InvokeResult

- **GIVEN** a handler that returns `{status: 202, body: {ok: true}}`
- **WHEN** the executor invokes the trigger
- **THEN** `InvokeResult` SHALL be `{ok: true, output: {status: 202, body: {ok: true}}}`
- **AND** the HTTP response shaping (serializing `output` to an HTTP response) SHALL be the HTTP source's responsibility, not the executor's

#### Scenario: Executor reports handler error uniformly

- **GIVEN** a handler that throws `new Error("boom")`
- **WHEN** the executor invokes the trigger
- **THEN** `InvokeResult` SHALL be `{ok: false, error: {message: "boom", stack: <stack>}}`
- **AND** the HTTP source SHALL map this to a 500 response with `{error: "internal_error"}` in its body
- **AND** the cron source SHALL log the failure (no protocol response) and arm the next tick

### Requirement: Runtime stamps runtime-engine metadata in onEvent

The executor SHALL wire `sb.onEvent(cb)` on every sandbox it drives. The callback SHALL stamp the current run's `tenant`, `workflow`, `workflowSha`, and `invocationId` onto every event received from the sandbox before forwarding to `bus.emit`. The executor SHALL track the "current run" metadata in a variable populated before `sandbox.run()` is called and cleared after it returns.

```ts
// Wiring in runtime/executor:
sb.onEvent((event) => {
  bus.emit({
    ...event,
    tenant: currentRun.tenant,
    workflow: currentRun.workflow,
    workflowSha: currentRun.workflowSha,
    invocationId: currentRun.invocationId,
  });
});

async function invoke(trigger, input, runMeta) {
  currentRun = runMeta;
  try {
    return await sb.run(trigger, input);
  } finally {
    currentRun = null;
  }
}
```

The sandbox SHALL NOT know about tenant/workflow/etc.; stamping is the executor's responsibility. Tenant isolation (§1 I-T2) is enforced at the runtime layer — the executor ensures `currentRun.tenant` matches the tenant that owns the cached sandbox, and scoped query APIs (`EventStore.query(tenant)`, `WorkflowRegistry` per tenant) enforce boundary at read time.

#### Scenario: Events arriving from sandbox get tenant stamped

- **GIVEN** an executor invoking sandbox.run for tenant "acme"
- **WHEN** the sandbox emits `action.request` with no tenant field
- **THEN** the executor's `sb.onEvent` callback SHALL add `tenant: "acme"` to the event
- **AND** forward the stamped event to `bus.emit`

#### Scenario: One run at a time per cached sandbox

- **GIVEN** a sandbox cached for `(tenant, sha)` with a run in flight
- **WHEN** a new invocation arrives for the same `(tenant, sha)`
- **THEN** the second invocation SHALL queue until the first completes
- **AND** `currentRun` metadata SHALL correctly correspond to the single active run at any time

### Requirement: Executor composes trigger plugin

The executor SHALL include `createTriggerPlugin()` in the plugin list for every production sandbox. Tests MAY compose sandboxes without the trigger plugin for silent runs.

#### Scenario: Production composition includes trigger plugin

- **GIVEN** an executor building a sandbox for a tenant workflow
- **WHEN** the plugin array is assembled
- **THEN** `createTriggerPlugin()` SHALL be present
- **AND** every production run SHALL produce `trigger.request` and `trigger.response`/`trigger.error` events

