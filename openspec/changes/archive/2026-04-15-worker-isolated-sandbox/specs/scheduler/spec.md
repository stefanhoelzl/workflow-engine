## MODIFIED Requirements

### Requirement: Processing lifecycle

The scheduler SHALL run a loop that dequeues events from the WorkQueue, emits state transitions via `EventSource.transition()`, and routes events based on whether `targetAction` is set. For undirected events, the scheduler performs fan-out. For directed events, the scheduler finds the target action by `name` and `on`, constructs an `ActionContext` via a factory function, executes the action via `Sandbox.run(actionName, ctx, extraMethods)`, and emits the terminal state via `EventSource.transition()`.

The scheduler SHALL obtain each `Sandbox` instance by calling `SandboxFactory.create(action.source)` from an injected `SandboxFactory`. The factory owns caching, death monitoring, and lifecycle; the scheduler SHALL NOT maintain its own `Map<source, Sandbox>`. On workflow reload or removal, the scheduler MAY prune stale sandboxes by calling `factory.dispose()` during shutdown; per-source proactive disposal is deferred.

For each dispatched event, the scheduler SHALL compose `extraMethods = { emit }` where `emit(type, payload)` closes over the current event and calls `EventSource.derive(event, type, payload, actionName)`.

#### Scenario: Successful action execution

- **GIVEN** a pending directed event in the WorkQueue
- **AND** exactly one action matches by `name` and `on`
- **WHEN** the scheduler dequeues the event
- **THEN** the scheduler calls `source.transition(event, { state: "processing" })`
- **AND** the scheduler calls `factory.create(action.source)` to obtain a `Sandbox`
- **AND** `sb.run(actionName, ctx, { emit })` is called
- **AND** on success (`{ ok: true, result, logs }`), the scheduler calls `source.transition(event, { state: "done", result: "succeeded" })`
- **AND** the scheduler persists `logs` against the event

#### Scenario: Action returns error result

- **GIVEN** a pending directed event in the WorkQueue
- **AND** an action whose source code throws `new Error("timeout")`
- **WHEN** the scheduler dequeues and runs the action via a sandbox obtained from `factory.create(action.source)`
- **THEN** the scheduler calls `source.transition(event, { state: "processing" })`
- **AND** `sb.run(...)` returns `{ ok: false, error: { message: "timeout", stack: "..." }, logs: [...] }`
- **AND** the scheduler calls `source.transition(event, { state: "done", result: "failed", error: { message: "timeout", stack: "..." } })`
- **AND** the scheduler persists `logs` against the event

#### Scenario: Sandbox reused across events for the same source

- **GIVEN** a workflow whose actions share a single `action.source` bundle
- **WHEN** the scheduler dispatches event E1 and then E2 to actions from that source
- **THEN** `factory.create(source)` SHALL be called twice but resolve to the same `Sandbox` reference (the factory's lazy cache handles reuse)
- **AND** module-level state set during E1 SHALL be observable during E2

#### Scenario: Dead sandbox is transparently replaced

- **GIVEN** the scheduler has processed events against a cached sandbox
- **WHEN** the sandbox's worker dies between events and the factory evicts it
- **AND** a subsequent event for the same source is dequeued
- **THEN** `factory.create(source)` SHALL resolve to a freshly spawned `Sandbox`
- **AND** the scheduler SHALL proceed with `sb.run(...)` as normal

#### Scenario: Undirected event triggers fan-out

- **GIVEN** a pending event with `targetAction: undefined`
- **WHEN** the scheduler dequeues the event
- **THEN** the scheduler performs fan-out (see "Fan-out for undirected events" requirement)

### Requirement: Scheduler is a closure-based factory

The scheduler SHALL be created via `createScheduler(workQueue, source, actions, createContext, options)` which returns a `Service` object. The factory accepts a `WorkQueue` for dequeuing events, an `EventSource` for creating/emitting events and state transitions, an actions array, a context factory function, and an `options` object carrying at minimum an injected `SandboxFactory`. The scheduler SHALL NOT construct sandboxes directly; all sandbox acquisition SHALL go through `options.sandboxFactory.create(action.source)`. There SHALL be no exported `Scheduler` class.

For test isolation, `options.sandboxFactory` MAY be replaced with a stub that returns fake `Sandbox` instances. Existing scheduler tests that previously injected a raw `sandbox()` function are expected to migrate to injecting a `SandboxFactory`-shaped stub.

#### Scenario: Factory returns Service

- **GIVEN** a valid WorkQueue, EventSource, actions array, context factory, and a `SandboxFactory` instance
- **WHEN** `createScheduler(workQueue, source, actions, createContext, { sandboxFactory })` is called
- **THEN** the returned object has `start` and `stop` methods
- **AND** no class instance is exposed
- **AND** the factory signature SHALL accept a `sandboxFactory` parameter rather than a raw `sandbox()` function

#### Scenario: Scheduler dispatches via injected factory

- **GIVEN** a scheduler constructed with a `SandboxFactory` spy
- **WHEN** an event is processed that targets an action
- **THEN** `sandboxFactory.create(action.source)` SHALL be invoked exactly once per unique source per dispatch
- **AND** the resulting `Sandbox`'s `run(...)` SHALL be invoked with the action's export name, the computed ctx, and `{ emit }` as extraMethods
