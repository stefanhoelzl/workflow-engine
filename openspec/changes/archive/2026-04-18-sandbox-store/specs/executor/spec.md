## MODIFIED Requirements

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
