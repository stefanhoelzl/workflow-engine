# Scheduler Specification

## Purpose

Process events from the queue by routing them to actions, managing fan-out for undirected events, and handling success/failure outcomes.
## Requirements
### Requirement: Concurrent processing

The system SHALL process up to N events in parallel, where N is a configurable global concurrency limit.

#### Scenario: Concurrency limit reached

- GIVEN a concurrency limit of 10
- AND 10 actions are currently executing
- WHEN a new event is available in the pending list
- THEN the scheduler waits until a slot frees up before starting the next execution

### Requirement: Processing lifecycle

The scheduler SHALL run a loop that dequeues events from the WorkQueue, emits state transitions via `EventSource.transition()`, and routes events based on whether `targetAction` is set. For undirected events, the scheduler performs fan-out. For directed events, the scheduler finds the target action by `name` and `on`, constructs an `ActionContext` via a factory function, executes the action via `Sandbox.run(actionName, ctx, extraMethods)` on the per-workflow sandbox instance, and emits the terminal state via `EventSource.transition()`.

The scheduler SHALL maintain a `Map<workflowName, Sandbox>`. On first event for a workflow, the scheduler SHALL load the workflow's action source, call `sandbox(source, methods)` (with `methods` empty in v1 — all host methods are per-run), and cache the resulting `Sandbox`. Subsequent events for the same workflow SHALL reuse the cached `Sandbox`. On workflow reload or removal, the scheduler SHALL call `Sandbox.dispose()` on the cached instance and evict it.

For each dispatched event, the scheduler SHALL compose `extraMethods = { emit }` where `emit(type, payload)` closes over the current event and calls `EventSource.derive(event, type, payload, actionName)`.

#### Scenario: Successful action execution

- **GIVEN** a pending directed event in the WorkQueue
- **AND** exactly one action matches by `name` and `on`
- **WHEN** the scheduler dequeues the event
- **THEN** the scheduler calls `source.transition(event, { state: "processing" })`
- **AND** the scheduler ensures a `Sandbox` exists for the action's workflow (constructing it lazily on miss)
- **AND** `sb.run(actionName, ctx, { emit })` is called
- **AND** on success (`{ ok: true, result, logs }`), the scheduler calls `source.transition(event, { state: "done", result: "succeeded" })`
- **AND** the scheduler persists `logs` against the event

#### Scenario: Action returns error result

- **GIVEN** a pending directed event in the WorkQueue
- **AND** an action whose source code throws `new Error("timeout")`
- **WHEN** the scheduler dequeues and runs the action via the per-workflow sandbox
- **THEN** the scheduler calls `source.transition(event, { state: "processing" })`
- **AND** `sb.run(...)` returns `{ ok: false, error: { message: "timeout", stack: "..." }, logs: [...] }`
- **AND** the scheduler calls `source.transition(event, { state: "done", result: "failed", error: { message: "timeout", stack: "..." } })`
- **AND** the scheduler persists `logs` against the event

#### Scenario: Sandbox reused across events for the same workflow

- **GIVEN** a workflow with two actions `a` and `b`
- **WHEN** the scheduler dispatches event E1 to `a` and then E2 to `b`
- **THEN** the same `Sandbox` instance SHALL be used for both
- **AND** module-level state set during E1 SHALL be observable during E2
- **AND** `sandbox(source, ...)` SHALL NOT be called a second time

#### Scenario: Undirected event triggers fan-out

- **GIVEN** a pending event with `targetAction: undefined`
- **WHEN** the scheduler dequeues the event
- **THEN** the scheduler performs fan-out (see "Fan-out for undirected events" requirement)

### Requirement: Fan-out for undirected events

The scheduler SHALL handle events without a `targetAction` by finding all actions whose `on` field matches the event's `type`, creating a targeted copy for each via `EventSource.fork()`, and transitioning the original event to a terminal state via `EventSource.transition()`.

#### Scenario: Fan-out with multiple subscribers

- **GIVEN** actions `parseOrder` (on: `"order.received"`) and `sendEmail` (on: `"order.received"`)
- **AND** an event `{ id: "evt_001", type: "order.received", targetAction: undefined }`
- **WHEN** the scheduler dequeues the event
- **THEN** the scheduler calls `source.transition(event, { state: "processing" })`
- **AND** the scheduler creates two events via `source.fork()`:
  - `{ type: "order.received", targetAction: "parseOrder", parentEventId: "evt_001" }`
  - `{ type: "order.received", targetAction: "sendEmail", parentEventId: "evt_001" }`
- **AND** each forked event is automatically emitted by `source.fork()`
- **AND** the scheduler calls `source.transition(event, { state: "done", result: "succeeded" })`

#### Scenario: Fan-out with zero subscribers

- **GIVEN** no actions with `on: "audit.log"`
- **AND** an event `{ type: "audit.log", targetAction: undefined }`
- **WHEN** the scheduler dequeues the event
- **THEN** the scheduler calls `source.transition(event, { state: "processing" })`
- **AND** no forked events are created
- **AND** the scheduler calls `source.transition(event, { state: "done", result: "skipped" })`

#### Scenario: Fan-out preserves correlationId

- **GIVEN** an undirected event with `correlationId: "corr_xyz"`
- **WHEN** the scheduler fans out to two actions
- **THEN** both forked events inherit `correlationId: "corr_xyz"`

### Requirement: Directed event routing by name and on

The scheduler SHALL route directed events (with `targetAction` set) by finding the action where `action.name === event.targetAction` AND `action.on === event.type`.

#### Scenario: Directed event matches single action

- **GIVEN** an action `sendEmail` with `on: "order.received"`
- **AND** an event `{ type: "order.received", targetAction: "sendEmail" }`
- **WHEN** the scheduler dequeues the event
- **THEN** the `sendEmail` action's handler is executed

#### Scenario: Directed event with no matching action

- **GIVEN** no action with `name: "deleted"` and `on: "order.received"`
- **AND** an event `{ type: "order.received", targetAction: "deleted" }`
- **WHEN** the scheduler dequeues the event
- **THEN** the scheduler calls `source.transition(event, { state: "done", result: "skipped" })`

### Requirement: Scheduler start and stop

The scheduler SHALL be created via a `createScheduler()` factory function that returns a `Service` (with `start(): Promise<void>` and `stop(): Promise<void>`). The `start()` promise resolves when the scheduler is stopped cleanly and rejects if the loop encounters an unrecoverable error. `stop()` signals the scheduler to stop, aborts any pending `dequeue()` call via `AbortSignal`, and resolves when the loop has fully exited.

#### Scenario: Start the scheduler

- **GIVEN** a scheduler created via `createScheduler()` with a WorkQueue, EventBus, and registered actions
- **WHEN** `start()` is called
- **THEN** the scheduler begins awaiting events from the WorkQueue via `dequeue()`
- **AND** the returned promise remains pending while the scheduler is running

#### Scenario: Stop the scheduler cleanly

- **GIVEN** a running scheduler with no event being processed
- **WHEN** `stop()` is called
- **THEN** the pending `dequeue()` call is aborted via `AbortSignal`
- **AND** the scheduler loop exits
- **AND** the `start()` promise resolves
- **AND** the `stop()` promise resolves

#### Scenario: Stop the scheduler while processing an event

- **GIVEN** a running scheduler currently executing an action handler
- **WHEN** `stop()` is called
- **THEN** the current action handler is allowed to complete
- **AND** the scheduler does not dequeue further events
- **AND** both `start()` and `stop()` promises resolve after the handler finishes

#### Scenario: Scheduler loop error rejects start

- **GIVEN** a running scheduler
- **WHEN** a bus emit throws an unexpected error
- **THEN** the `start()` promise rejects with that error

### Requirement: Scheduler is a closure-based factory

The scheduler SHALL be created via `createScheduler(workQueue, source, actions, createContext)` which returns a `Service` object. The factory accepts a `WorkQueue` for dequeuing events, an `EventSource` for creating/emitting events and state transitions, an actions array, and a context factory function. The scheduler SHALL own its internal `Map<workflowName, Sandbox>` and construct sandboxes lazily; the factory SHALL NOT accept a pre-constructed `Sandbox` parameter. There SHALL be no exported `Scheduler` class.

#### Scenario: Factory returns Service

- **GIVEN** a valid WorkQueue, EventSource, actions array, and context factory
- **WHEN** `createScheduler(workQueue, source, actions, createContext)` is called
- **THEN** the returned object has `start` and `stop` methods
- **AND** no class instance is exposed
- **AND** the factory signature SHALL NOT include a `Sandbox` parameter

### Requirement: Actions receive Event not RuntimeEvent

The scheduler SHALL strip runtime fields (state, error, and infrastructure metadata) from the RuntimeEvent before passing it to the action context factory. Actions SHALL receive the SDK `Event` type (`{ name, payload }`), not `RuntimeEvent`.

#### Scenario: Action context receives clean Event

- **GIVEN** a RuntimeEvent with `id: "evt_abc"`, `type: "order.received"`, `state: "processing"`, `correlationId: "corr_xyz"`
- **WHEN** the scheduler creates an ActionContext
- **THEN** the action handler receives `ctx.event` as `{ name: "order.received", payload: ... }`
- **AND** `state`, `error`, `id`, `correlationId` are NOT visible to the action

