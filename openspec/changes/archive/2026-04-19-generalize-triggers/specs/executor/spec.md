## MODIFIED Requirements

### Requirement: Executor owns invocation lifecycle

The runtime SHALL provide an `Executor` component that owns the lifecycle of trigger invocations end-to-end. The executor SHALL expose `invoke(workflow, descriptor, input): Promise<InvokeResult<output>>` as its sole public method, where `InvokeResult<T>` is the discriminated union `{ ok: true; output: T } | { ok: false; error: { message: string; stack?: string } }`. The executor SHALL be the only component that calls into a workflow's sandbox to execute a trigger handler. The executor SHALL be kind-agnostic: it SHALL NOT contain any HTTP-specific code or return type.

#### Scenario: Executor invocation lifecycle

- **GIVEN** an executor created with `createExecutor({ bus })`
- **WHEN** `executor.invoke(workflow, descriptor, input)` is called
- **THEN** the executor SHALL construct an invocation record with a unique id, the workflow name, the trigger name (from `descriptor.name`), and the validated input
- **AND** the executor SHALL emit a `started` lifecycle event via the bus before dispatching the handler
- **AND** the executor SHALL dispatch the trigger's handler in the workflow's sandbox via `sandbox.invokeHandler(descriptor.name, input)`
- **AND** on successful return the executor SHALL emit a `completed` lifecycle event via the bus carrying the handler's output
- **AND** on thrown exception the executor SHALL emit a `failed` lifecycle event via the bus carrying a serialized error
- **AND** the executor's promise SHALL resolve to `{ ok: true, output }` on success or `{ ok: false, error }` on failure — it SHALL NOT throw

### Requirement: HTTP trigger result shape

The handler's return value for an HTTP trigger SHALL conform to `HttpTriggerResult = { status?: number, body?: unknown, headers?: Record<string, string> }`. The executor SHALL pass the handler's return value through to the caller inside the `{ ok: true, output }` envelope without modification beyond serialization; the HTTP `TriggerSource` SHALL apply defaults (`status` = `200`, `body` = `""`, `headers` = `{}`) when shaping the HTTP response. On handler throw, the executor SHALL emit a `failed` lifecycle event and return `{ ok: false, error }`; the HTTP source SHALL map this to a `500` response with `{ error: "internal_error" }`.

#### Scenario: Handler returns full response

- **GIVEN** a handler that returns `{ status: 202, body: { ok: true }, headers: { "x-trace": "abc" } }`
- **WHEN** the executor invokes the trigger
- **THEN** the executor SHALL return `{ ok: true, output: { status: 202, body: { ok: true }, headers: { "x-trace": "abc" } } }`

#### Scenario: Handler returns partial response

- **GIVEN** a handler that returns `{ status: 204 }`
- **WHEN** the executor invokes the trigger
- **THEN** the executor SHALL return `{ ok: true, output: { status: 204 } }`
- **AND** the HTTP source SHALL apply defaults to produce `HTTP 204` with empty body and no extra headers

#### Scenario: Handler throws unhandled error

- **GIVEN** a handler that throws `new Error("boom")`
- **WHEN** the executor invokes the trigger
- **THEN** the executor SHALL return `{ ok: false, error: { message: "boom", stack: "..." } }`
- **AND** the executor SHALL emit a `failed` lifecycle event with the serialized error
- **AND** the HTTP source SHALL map the error sentinel to `{ status: 500, body: { error: "internal_error" }, headers: {} }`

### Requirement: Per-workflow serialization via runQueue

The executor SHALL maintain one runQueue per workflow. The runQueue SHALL ensure that at most one trigger invocation runs at a time per workflow, regardless of which source dispatched the invocation. The runQueue SHALL be a Promise-chain serializer that does not lose subsequent invocations on prior failure (failures unblock the queue).

#### Scenario: Two invocations of the same workflow serialize

- **GIVEN** workflow `w1` with two triggers `t1` and `t2`
- **WHEN** `executor.invoke(w1, d_t1, p1)` and `executor.invoke(w1, d_t2, p2)` are called concurrently
- **THEN** the second invocation's handler SHALL not begin executing until the first completes (success or failure)

#### Scenario: Two workflows run in parallel

- **GIVEN** workflows `w1` and `w2` each with one trigger
- **WHEN** invocations on `w1` and `w2` are dispatched concurrently
- **THEN** their handlers MAY execute in parallel (each in its own sandbox)

#### Scenario: Failure unblocks the queue

- **GIVEN** workflow `w1` whose invocation `i1` fails
- **WHEN** invocation `i2` is dispatched immediately after
- **THEN** `i2` SHALL begin executing rather than being blocked by `i1`'s failure

#### Scenario: Invocations from different sources for the same workflow serialize

- **GIVEN** workflow `w1` with both an HTTP trigger and a hypothetical cron trigger
- **WHEN** both sources call `executor.invoke(w1, ...)` concurrently
- **THEN** the runQueue SHALL serialize the two invocations — at most one executes at a time

### Requirement: Lifecycle events emitted via bus

The executor SHALL emit invocation lifecycle events via `bus.emit(event)` for the three lifecycle transitions: `started`, `completed`, `failed`. Each lifecycle event SHALL carry the invocation id, the workflow name, the trigger name (from `descriptor.name`), a timestamp, and the appropriate payload (input on `started`, result on `completed`, error on `failed`). The event shape is unchanged from v1 — the trigger kind is NOT stamped onto the event. Consumers that need the trigger kind SHALL resolve it from the workflow registry via `(workflow, name)` at read time. The executor SHALL await `bus.emit` so that synchronous-ordered consumers (notably persistence) commit before the executor proceeds.

#### Scenario: Persistence is committed before response

- **GIVEN** an in-flight invocation about to complete
- **WHEN** the executor emits the `completed` lifecycle event
- **THEN** the bus dispatch SHALL run the persistence consumer first, writing `archive/<id>.json`
- **AND** the executor SHALL only return to its caller after `bus.emit` resolves
