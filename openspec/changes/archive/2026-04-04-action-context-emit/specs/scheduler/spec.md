## MODIFIED Requirements

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
