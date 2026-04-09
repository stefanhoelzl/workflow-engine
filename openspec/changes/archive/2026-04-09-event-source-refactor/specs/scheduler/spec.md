## MODIFIED Requirements

### Requirement: Scheduler is a closure-based factory

The scheduler SHALL be created via `createScheduler(workQueue, source, actions, createContext)` which returns a `Service` object. The factory accepts a `WorkQueue` for dequeuing events, an `EventSource` for creating/emitting events and state transitions, an actions array, and a context factory function. There SHALL be no exported `Scheduler` class.

#### Scenario: Factory returns Service

- **GIVEN** a valid WorkQueue, EventSource, actions array, and context factory
- **WHEN** `createScheduler(workQueue, source, actions, createContext)` is called
- **THEN** the returned object has `start` and `stop` methods
- **AND** no class instance is exposed

### Requirement: Processing lifecycle

The scheduler SHALL run a loop that dequeues events from the WorkQueue, emits state transitions via `EventSource.transition()`, and routes events based on whether `targetAction` is set. For undirected events, the scheduler performs fan-out. For directed events, the scheduler finds the target action by `name` and `on`, constructs an `ActionContext` via a factory function, executes the async handler, and emits the terminal state via `EventSource.transition()`.

#### Scenario: Successful action execution

- **GIVEN** a pending directed event in the WorkQueue
- **AND** exactly one action matches by `name` and `on`
- **WHEN** the scheduler dequeues the event
- **THEN** the scheduler calls `source.transition(event, { state: "processing" })`
- **AND** the matching action's handler is called with an `ActionContext`
- **AND** on success, the scheduler calls `source.transition(event, { state: "done", result: "succeeded" })`

#### Scenario: Action throws an error

- **GIVEN** a pending directed event in the WorkQueue
- **AND** an action that throws `new Error("timeout")` when handling it
- **WHEN** the scheduler dequeues and runs the action
- **THEN** the scheduler calls `source.transition(event, { state: "processing" })`
- **AND** on failure, the scheduler calls `source.transition(event, { state: "done", result: "failed", error: "timeout" })`

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

## REMOVED Requirements

### Requirement: Scheduler accepts EventFactory
**Reason**: Replaced by EventSource which combines EventFactory and EventBus functionality.
**Migration**: Pass EventSource instead of separate EventFactory and EventBus parameters.

### Requirement: Scheduler logging via constructor-injected Logger
**Reason**: All event lifecycle logging (action.started, action.completed, action.failed, event.no-match, event.fanout, event.fanout.skipped) is now handled by the LoggingConsumer bus consumer, which observes the same state transitions. Duration can be computed from event timestamps.
**Migration**: Remove Logger parameter from createScheduler. Remove all direct logger calls from scheduler.
