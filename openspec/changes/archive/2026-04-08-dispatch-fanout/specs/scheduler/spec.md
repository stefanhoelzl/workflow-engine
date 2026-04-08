## ADDED Requirements

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

### Requirement: Scheduler accepts EventFactory

The `createScheduler` factory function SHALL accept an `EventFactory` parameter for creating forked events during fan-out.

#### Scenario: Scheduler creation with EventFactory

- **GIVEN** a WorkQueue, EventBus, actions array, EventFactory, context factory, and logger
- **WHEN** `createScheduler(workQueue, bus, actions, eventFactory, createContext, logger)` is called
- **THEN** the returned Service uses the EventFactory for fan-out operations

## MODIFIED Requirements

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

### Requirement: Scheduler is a closure-based factory

The scheduler SHALL be created via `createScheduler(workQueue, bus, actions, eventFactory, createContext, logger)` which returns a `Service` object. The factory accepts a `WorkQueue` for dequeuing events, an `EventBus` for emitting state transitions, and an `EventFactory` for creating forked events during fan-out. There SHALL be no exported `Scheduler` class.

#### Scenario: Factory returns Service

- **GIVEN** a valid WorkQueue, EventBus, actions array, EventFactory, context factory, and logger
- **WHEN** `createScheduler(workQueue, bus, actions, eventFactory, createContext, logger)` is called
- **THEN** the returned object has `start` and `stop` methods
- **AND** no class instance is exposed

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

## REMOVED Requirements

### Requirement: Ambiguous match handling
**Reason**: With declarative `on` + `name` routing, ambiguous matches are impossible for directed events (unique by `name`). For undirected events, multiple actions matching the same type is the intended fan-out behavior, not an error.
**Migration**: Remove ambiguous match error handling from the scheduler. Fan-out handles multi-match by design.
