## MODIFIED Requirements

### Requirement: Scheduler is a closure-based factory

The scheduler SHALL be created via `createScheduler(workQueue, source, actions, createContext, sandbox)` which returns a `Service` object. The factory accepts a `WorkQueue` for dequeuing events, an `EventSource` for creating/emitting events and state transitions, an actions array, a context factory function, and a `Sandbox` for executing action code. There SHALL be no exported `Scheduler` class.

#### Scenario: Factory returns Service

- **GIVEN** a valid WorkQueue, EventSource, actions array, context factory, and Sandbox
- **WHEN** `createScheduler(workQueue, source, actions, createContext, sandbox)` is called
- **THEN** the returned object has `start` and `stop` methods
- **AND** no class instance is exposed

### Requirement: Processing lifecycle

The scheduler SHALL run a loop that dequeues events from the WorkQueue, emits state transitions via `EventSource.transition()`, and routes events based on whether `targetAction` is set. For undirected events, the scheduler performs fan-out. For directed events, the scheduler finds the target action by `name` and `on`, constructs an `ActionContext` via a factory function, executes the action via `sandbox.spawn(action.source, ctx)`, and emits the terminal state via `EventSource.transition()`.

#### Scenario: Successful action execution

- **GIVEN** a pending directed event in the WorkQueue
- **AND** exactly one action matches by `name` and `on`
- **WHEN** the scheduler dequeues the event
- **THEN** the scheduler calls `source.transition(event, { state: "processing" })`
- **AND** `sandbox.spawn(action.source, ctx)` is called
- **AND** on success (`{ ok: true }`), the scheduler calls `source.transition(event, { state: "done", result: "succeeded" })`

#### Scenario: Action returns error result

- **GIVEN** a pending directed event in the WorkQueue
- **AND** an action whose source code throws `new Error("timeout")`
- **WHEN** the scheduler dequeues and runs the action via sandbox
- **THEN** the scheduler calls `source.transition(event, { state: "processing" })`
- **AND** `sandbox.spawn()` returns `{ ok: false, error: { message: "timeout", stack: "..." } }`
- **AND** the scheduler calls `source.transition(event, { state: "done", result: "failed", error: { message: "timeout", stack: "..." } })`

#### Scenario: Undirected event triggers fan-out

- **GIVEN** a pending event with `targetAction: undefined`
- **WHEN** the scheduler dequeues the event
- **THEN** the scheduler performs fan-out (see "Fan-out for undirected events" requirement)

### Requirement: Isolate disposal

The system SHALL ensure the QuickJS context is disposed after every action execution, regardless of success or failure. This is handled by the `Sandbox.spawn()` method internally.

#### Scenario: Memory reclamation

- **GIVEN** an action that allocates data inside QuickJS
- **WHEN** the action completes
- **THEN** the QuickJS context is disposed by `spawn()`
- **AND** WASM memory is reclaimed
