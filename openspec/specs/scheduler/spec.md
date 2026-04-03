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

### Requirement: Structured logging

The system SHALL log every event lifecycle transition as a structured JSON line including: event ID, event type, action name, correlation ID, trace ID, duration, outcome (success/failure), and error message if applicable.

#### Scenario: Log output for successful execution

- GIVEN event `evt_001` targeting `parseOrder` completes in 12ms
- THEN a log line is emitted containing `{"eventId":"evt_001","action":"parseOrder","status":"done","durationMs":12,"correlationId":"corr_...","traceId":"trace_..."}`
