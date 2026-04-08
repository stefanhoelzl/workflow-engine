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

The scheduler SHALL run a loop that dequeues events from the WorkQueue, emits state transitions to the EventBus, and routes events based on whether `targetAction` is set. For undirected events, the scheduler performs fan-out. For directed events, the scheduler finds the target action by `name` and `on`, constructs an `ActionContext` via a factory function, executes the async handler, and emits the terminal state to the bus.

#### Scenario: Successful action execution

- **GIVEN** a pending directed event in the WorkQueue
- **AND** exactly one action matches by `name` and `on`
- **WHEN** the scheduler dequeues the event
- **THEN** the scheduler emits `{...event, state: "processing"}` to the bus
- **AND** the matching action's handler is called with an `ActionContext`
- **AND** on success, the scheduler emits `{...event, state: "done"}` to the bus

#### Scenario: Action throws an error

- **GIVEN** a pending directed event in the WorkQueue
- **AND** an action that throws when handling it
- **WHEN** the scheduler dequeues and runs the action
- **THEN** the scheduler emits `{...event, state: "processing"}` to the bus
- **AND** on failure, the scheduler emits `{...event, state: "failed", error: <serialized error>}` to the bus

#### Scenario: Undirected event triggers fan-out

- **GIVEN** a pending event with `targetAction: undefined`
- **WHEN** the scheduler dequeues the event
- **THEN** the scheduler performs fan-out (see "Fan-out for undirected events" requirement)

### Requirement: Fan-out for undirected events

The scheduler SHALL handle events without a `targetAction` by finding all actions whose `on` field matches the event's `type`, creating a targeted copy for each via `EventFactory.fork()`, emitting each copy to the EventBus, and transitioning the original event to a terminal state.

#### Scenario: Fan-out with multiple subscribers

- **GIVEN** actions `parseOrder` (on: `"order.received"`) and `sendEmail` (on: `"order.received"`)
- **AND** an event `{ id: "evt_001", type: "order.received", targetAction: undefined }`
- **WHEN** the scheduler dequeues the event
- **THEN** the scheduler emits `{ ...event, state: "processing" }` to the bus
- **AND** the scheduler creates two events via `EventFactory.fork()`:
  - `{ type: "order.received", targetAction: "parseOrder", parentEventId: "evt_001" }`
  - `{ type: "order.received", targetAction: "sendEmail", parentEventId: "evt_001" }`
- **AND** each forked event is emitted to the bus with `state: "pending"`
- **AND** the original event is emitted with `state: "done"`

#### Scenario: Fan-out with zero subscribers

- **GIVEN** no actions with `on: "audit.log"`
- **AND** an event `{ type: "audit.log", targetAction: undefined }`
- **WHEN** the scheduler dequeues the event
- **THEN** the scheduler emits `{ ...event, state: "processing" }` to the bus
- **AND** no forked events are created
- **AND** the original event is emitted with `state: "skipped"`

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
- **THEN** the event is emitted with `state: "skipped"`

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

The scheduler SHALL be created via `createScheduler(workQueue, bus, actions, eventFactory, createContext, logger)` which returns a `Service` object. The factory accepts a `WorkQueue` for dequeuing events, an `EventBus` for emitting state transitions, and an `EventFactory` for creating forked events during fan-out. There SHALL be no exported `Scheduler` class.

#### Scenario: Factory returns Service

- **GIVEN** a valid WorkQueue, EventBus, actions array, EventFactory, context factory, and logger
- **WHEN** `createScheduler(workQueue, bus, actions, eventFactory, createContext, logger)` is called
- **THEN** the returned object has `start` and `stop` methods
- **AND** no class instance is exposed

### Requirement: Scheduler accepts EventFactory

The `createScheduler` factory function SHALL accept an `EventFactory` parameter for creating forked events during fan-out.

#### Scenario: Scheduler creation with EventFactory

- **GIVEN** a WorkQueue, EventBus, actions array, EventFactory, context factory, and logger
- **WHEN** `createScheduler(workQueue, bus, actions, eventFactory, createContext, logger)` is called
- **THEN** the returned Service uses the EventFactory for fan-out operations

### Requirement: Isolate disposal

The system SHALL dispose the V8 Isolate after every action execution, regardless of success or failure.

#### Scenario: Memory reclamation

- GIVEN an action that allocates 7 MB of data
- WHEN the action completes
- THEN the isolate is disposed
- AND the 7 MB is reclaimed by the host process

### Requirement: Actions receive Event not RuntimeEvent

The scheduler SHALL strip runtime fields (state, error, and infrastructure metadata) from the RuntimeEvent before passing it to the action context factory. Actions SHALL receive the SDK `Event` type (`{ name, payload }`), not `RuntimeEvent`.

#### Scenario: Action context receives clean Event

- **GIVEN** a RuntimeEvent with `id: "evt_abc"`, `type: "order.received"`, `state: "processing"`, `correlationId: "corr_xyz"`
- **WHEN** the scheduler creates an ActionContext
- **THEN** the action handler receives `ctx.event` as `{ name: "order.received", payload: ... }`
- **AND** `state`, `error`, `id`, `correlationId` are NOT visible to the action

### Requirement: Scheduler logging via constructor-injected Logger

The Scheduler SHALL accept a `Logger` instance via its constructor. The Scheduler SHALL use this Logger to log lifecycle events at the following points:

- `action.started` at info level: correlationId, eventId, action name
- `action.completed` at info level: correlationId, eventId, action name, duration in ms
- `action.failed` at error level: correlationId, eventId, action name, error, duration in ms
- `event.no-match` at warn level: correlationId, eventId, event type
- `event.fanout` at info level: correlationId, eventId, event type, number of targets
- `event.fanout.skipped` at warn level: correlationId, eventId, event type (zero subscribers)

#### Scenario: Fan-out is logged

- **GIVEN** a Scheduler with a Logger
- **AND** an undirected event with `type: "order.received"` matching 2 actions
- **WHEN** the scheduler fans out the event
- **THEN** `event.fanout` is logged at info level with the event type and target count 2

#### Scenario: Fan-out with no subscribers is logged

- **GIVEN** a Scheduler with a Logger
- **AND** an undirected event with no matching actions
- **WHEN** the scheduler processes the event
- **THEN** `event.fanout.skipped` is logged at warn level with the event type

#### Scenario: Successful action is logged

- **GIVEN** a Scheduler with a Logger
- **AND** a directed event with correlationId `"corr_abc"` that matches action `"notify"`
- **WHEN** the event is dequeued and the action handler succeeds in 50ms
- **THEN** `action.started` is logged at info level with correlationId `"corr_abc"` and action `"notify"`
- **AND** `action.completed` is logged at info level with action `"notify"` and duration close to 50

#### Scenario: Failed action is logged

- **GIVEN** a Scheduler with a Logger
- **AND** a directed event that matches an action that throws `new Error("timeout")`
- **WHEN** the event is dequeued and the action handler throws
- **THEN** `action.failed` is logged at error level with the error message and duration

#### Scenario: No match for directed event is logged

- **GIVEN** a Scheduler with a Logger
- **AND** a directed event that no action matches
- **WHEN** the event is dequeued
- **THEN** `event.no-match` is logged at warn level with the event type
