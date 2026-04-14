## MODIFIED Requirements

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

### Requirement: Scheduler is a closure-based factory

The scheduler SHALL be created via `createScheduler(workQueue, source, actions, createContext)` which returns a `Service` object. The factory accepts a `WorkQueue` for dequeuing events, an `EventSource` for creating/emitting events and state transitions, an actions array, and a context factory function. The scheduler SHALL own its internal `Map<workflowName, Sandbox>` and construct sandboxes lazily; the factory SHALL NOT accept a pre-constructed `Sandbox` parameter. There SHALL be no exported `Scheduler` class.

#### Scenario: Factory returns Service

- **GIVEN** a valid WorkQueue, EventSource, actions array, and context factory
- **WHEN** `createScheduler(workQueue, source, actions, createContext)` is called
- **THEN** the returned object has `start` and `stop` methods
- **AND** no class instance is exposed
- **AND** the factory signature SHALL NOT include a `Sandbox` parameter

## REMOVED Requirements

### Requirement: Isolate disposal
**Reason**: VM lifecycle posture has changed from fresh-per-invocation to workflow-scoped. Per-action disposal is no longer performed; disposal happens on workflow reload/unload via `Sandbox.dispose()`. All lifecycle guarantees about the sandbox are consolidated into the `sandbox` capability spec.
**Migration**: See the `sandbox` capability's "Workflow-scoped VM lifecycle" requirement. The scheduler SHALL call `Sandbox.dispose()` when evicting a workflow from its sandbox map (on workflow reload or unload), not per-action.
