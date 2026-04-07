## ADDED Requirements

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

