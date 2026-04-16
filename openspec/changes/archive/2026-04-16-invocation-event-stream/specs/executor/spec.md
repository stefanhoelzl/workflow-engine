## MODIFIED Requirements

### Requirement: Executor owns invocation lifecycle

The executor SHALL generate an `invocationId` (`evt_<uuid>`) for each invocation. It SHALL wire `workflow.onEvent` to forward events to the bus. It SHALL call `workflow.invokeHandler(invocationId, triggerName, payload)` and return the shaped `HttpTriggerResult`. The executor SHALL NOT construct or emit lifecycle events itself — trigger events are emitted by the sandbox worker.

#### Scenario: Executor invocation lifecycle
- **WHEN** `executor.invoke(workflow, triggerName, payload)` is called
- **THEN** it SHALL generate an invocation id, subscribe to events via `onEvent`, call `invokeHandler` with the id, and return the shaped HTTP result

#### Scenario: Events flow through bus
- **WHEN** the sandbox emits events during execution
- **THEN** the executor's `onEvent` wiring SHALL forward each event to `bus.emit()`

### Requirement: HTTP trigger result shape

The executor SHALL shape the raw return value from `invokeHandler` into an `HttpTriggerResult` with defaults: `status: 200`, `body: ""`, `headers: {}`. If `invokeHandler` throws, the executor SHALL return `{ status: 500, body: { error: "internal_error" }, headers: {} }`.

#### Scenario: Handler returns full response
- **WHEN** the handler returns `{ status: 201, body: "created", headers: { "x-id": "1" } }`
- **THEN** the executor SHALL return that value as-is

#### Scenario: Handler throws unhandled error
- **WHEN** the handler throws an error
- **THEN** the executor SHALL return `{ status: 500, body: { error: "internal_error" }, headers: {} }`

## REMOVED Requirements

### Requirement: Lifecycle events emitted via bus
**Reason**: The executor no longer constructs `StartedEvent`/`CompletedEvent`/`FailedEvent`. These are replaced by `trigger.*` events emitted by the sandbox. The executor just wires the `onEvent` callback.
**Migration**: Code that checked for `started`/`completed`/`failed` events from the executor now receives `trigger.request`/`trigger.response`/`trigger.error` events from the sandbox.
