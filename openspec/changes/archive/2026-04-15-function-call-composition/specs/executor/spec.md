## ADDED Requirements

### Requirement: Executor owns invocation lifecycle

The runtime SHALL provide an `Executor` component that owns the lifecycle of trigger invocations end-to-end. The executor SHALL expose `invoke(workflow, trigger, payload) → Promise<HttpTriggerResult>` as its sole public method. The executor SHALL be the only component that calls into a workflow's sandbox to execute a trigger handler.

#### Scenario: Executor invocation lifecycle

- **GIVEN** an executor created with `createExecutor({ bus, sandboxFactory })`
- **WHEN** `executor.invoke(workflow, trigger, payload)` is called
- **THEN** the executor SHALL construct an invocation record with a unique id, the workflow name, the trigger name, and the validated payload
- **AND** the executor SHALL emit a `started` lifecycle event via the bus before dispatching the handler
- **AND** the executor SHALL dispatch the trigger's handler in the workflow's sandbox via `sandbox.invokeHandler(trigger.name, payload)`
- **AND** on successful return the executor SHALL emit a `completed` lifecycle event via the bus carrying the result
- **AND** on thrown exception the executor SHALL emit a `failed` lifecycle event via the bus carrying a serialized error
- **AND** the executor's promise SHALL resolve to the handler's return value (success) or to `{ status: 500, body: { error: "internal_error" }, headers: {} }` (failure)

### Requirement: Per-workflow serialization via runQueue

The executor SHALL maintain one runQueue per workflow. The runQueue SHALL ensure that at most one trigger invocation runs at a time per workflow. The runQueue SHALL be a Promise-chain serializer that does not lose subsequent invocations on prior failure (failures unblock the queue).

#### Scenario: Two invocations of the same workflow serialize

- **GIVEN** workflow `w1` with two triggers `t1` and `t2`
- **WHEN** `executor.invoke(w1, t1, p1)` and `executor.invoke(w1, t2, p2)` are called concurrently
- **THEN** the second invocation's handler SHALL not begin executing until the first completes (success or failure)

#### Scenario: Two workflows run in parallel

- **GIVEN** workflows `w1` and `w2` each with one trigger
- **WHEN** invocations on `w1` and `w2` are dispatched concurrently
- **THEN** their handlers MAY execute in parallel (each in its own sandbox)

#### Scenario: Failure unblocks the queue

- **GIVEN** workflow `w1` whose invocation `i1` fails
- **WHEN** invocation `i2` is dispatched immediately after
- **THEN** `i2` SHALL begin executing rather than being blocked by `i1`'s failure

### Requirement: Lifecycle events emitted via bus

The executor SHALL emit invocation lifecycle events via `bus.emit(event)` for the three lifecycle transitions: `started`, `completed`, `failed`. Each lifecycle event SHALL carry the invocation id, the workflow name, the trigger name, a timestamp, and the appropriate payload (input on `started`, result on `completed`, error on `failed`). The executor SHALL await `bus.emit` so that synchronous-ordered consumers (notably persistence) commit before the executor proceeds.

#### Scenario: Persistence is committed before HTTP response

- **GIVEN** an in-flight invocation about to complete
- **WHEN** the executor emits the `completed` lifecycle event
- **THEN** the bus dispatch SHALL run the persistence consumer first, writing `archive/<id>.json`
- **AND** the executor SHALL only return to its caller after `bus.emit` resolves

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
