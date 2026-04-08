## MODIFIED Requirements

### Requirement: Scheduler start and stop

The scheduler SHALL be created via a `createScheduler()` factory function that returns a `Service` (with `start(): Promise<void>` and `stop(): Promise<void>`). The `start()` promise resolves when the scheduler is stopped cleanly and rejects if the loop encounters an unrecoverable error. `stop()` signals the scheduler to stop, aborts any pending `dequeue()` call via `AbortSignal`, and resolves when the loop has fully exited.

#### Scenario: Start the scheduler

- **GIVEN** a scheduler created via `createScheduler()` with a queue and registered actions
- **WHEN** `start()` is called
- **THEN** the scheduler begins awaiting events from the queue
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
- **WHEN** a queue operation (ack, fail) throws an unexpected error
- **THEN** the `start()` promise rejects with that error

### Requirement: Scheduler is a closure-based factory

The scheduler SHALL be created via `createScheduler(queue, actions, createContext, logger)` which returns a `Service` object. There SHALL be no exported `Scheduler` class.

#### Scenario: Factory returns Service

- **GIVEN** a valid queue, actions array, context factory, and logger
- **WHEN** `createScheduler(queue, actions, createContext, logger)` is called
- **THEN** the returned object has `start` and `stop` methods
- **AND** no class instance is exposed
