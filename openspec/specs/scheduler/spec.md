# Scheduler Specification

## Purpose

Process events from the queue by loading action code into sandboxed isolates, managing concurrency, and handling success/failure outcomes.

## Requirements

### Requirement: Concurrent processing

The system SHALL process up to N events in parallel, where N is a configurable global concurrency limit.

#### Scenario: Concurrency limit reached

- GIVEN a concurrency limit of 10
- AND 10 actions are currently executing
- WHEN a new event is available in the pending list
- THEN the scheduler waits until a slot frees up before starting the next execution

### Requirement: Processing lifecycle

The scheduler SHALL run a loop that dequeues events, matches them to actions, constructs an `ActionContext` via a factory function, executes the async handler, and acknowledges or fails the event.

#### Scenario: Successful action execution

- **GIVEN** a pending event in the queue
- **AND** exactly one action matches the event
- **WHEN** the scheduler dequeues the event
- **THEN** the scheduler calls the context factory function with the event to create an `ActionContext`
- **AND** the matching action's handler is called with the `ActionContext`
- **AND** the handler is awaited (async)
- **AND** on success, the event is acknowledged (marked done)

#### Scenario: Action throws an error

- **GIVEN** a pending event in the queue
- **AND** an action that throws when handling it
- **WHEN** the scheduler dequeues and runs the action
- **THEN** the event is marked as failed

#### Scenario: No matching action

- **GIVEN** a pending event in the queue
- **AND** no action's `match` returns true for the event
- **WHEN** the scheduler dequeues the event
- **THEN** the event is acknowledged (marked done)
- **AND** no handler is executed

#### Scenario: Multiple matching actions

- **GIVEN** a pending event in the queue
- **AND** more than one action's `match` returns true for the event
- **WHEN** the scheduler dequeues the event
- **THEN** the event is marked as failed (ambiguous match is a configuration error)

### Requirement: Scheduler start and stop

The scheduler SHALL expose `start()` and `stop()` methods to control the processing loop. The loop awaits `dequeue()` which blocks until an event is available.

#### Scenario: Start the scheduler

- **GIVEN** a scheduler with a queue and registered actions
- **WHEN** `start()` is called
- **THEN** the scheduler begins awaiting events from the queue

#### Scenario: Stop the scheduler

- **GIVEN** a running scheduler
- **WHEN** `stop()` is called
- **THEN** the scheduler stops after the current event (if any) finishes processing
- **AND** the blocking `dequeue()` is resolved or abandoned

### Requirement: Isolate disposal

The system SHALL dispose the V8 Isolate after every action execution, regardless of success or failure.

#### Scenario: Memory reclamation

- GIVEN an action that allocates 7 MB of data
- WHEN the action completes
- THEN the isolate is disposed
- AND the 7 MB is reclaimed by the host process

### Requirement: Scheduler logging via constructor-injected Logger

The Scheduler SHALL accept a `Logger` instance via its constructor. The Scheduler SHALL use this Logger to log lifecycle events at the following points:

- `action.started` at info level: correlationId, eventId, action name
- `action.completed` at info level: correlationId, eventId, action name, duration in ms
- `action.failed` at error level: correlationId, eventId, action name, error, duration in ms
- `event.no-match` at warn level: correlationId, eventId, event type
- `event.ambiguous-match` at error level: correlationId, eventId, action names

#### Scenario: Successful action is logged

- **GIVEN** a Scheduler with a Logger
- **AND** an event with correlationId `"corr_abc"` that matches action `"notify"`
- **WHEN** the event is dequeued and the action handler succeeds in 50ms
- **THEN** `action.started` is logged at info level with correlationId `"corr_abc"` and action `"notify"`
- **AND** `action.completed` is logged at info level with action `"notify"` and duration close to 50

#### Scenario: Failed action is logged

- **GIVEN** a Scheduler with a Logger
- **AND** an event that matches an action that throws `new Error("timeout")`
- **WHEN** the event is dequeued and the action handler throws
- **THEN** `action.failed` is logged at error level with the error message and duration

#### Scenario: No match is logged

- **GIVEN** a Scheduler with a Logger
- **AND** an event that no action matches
- **WHEN** the event is dequeued
- **THEN** `event.no-match` is logged at warn level with the event type

#### Scenario: Ambiguous match is logged

- **GIVEN** a Scheduler with a Logger
- **AND** an event that matches two actions `"a"` and `"b"`
- **WHEN** the event is dequeued
- **THEN** `event.ambiguous-match` is logged at error level with action names `["a", "b"]`
