## ADDED Requirements

### Requirement: Service interface

The system SHALL define a `Service` interface with two methods: `start(): Promise<void>` and `stop(): Promise<void>`. All long-running runtime components SHALL implement this interface.

#### Scenario: Service starts and stops cleanly

- **GIVEN** a component implementing the `Service` interface
- **WHEN** `start()` is called and then `stop()` is called
- **THEN** `start()` resolves after `stop()` completes
- **AND** the component releases all resources

#### Scenario: Service start rejects on fatal error

- **GIVEN** a component implementing the `Service` interface
- **WHEN** `start()` is called and the component encounters a fatal error
- **THEN** the promise returned by `start()` rejects with the error

### Requirement: Graceful shutdown on process signals

The runtime entrypoint SHALL register handlers for SIGINT and SIGTERM that trigger a coordinated shutdown of all services.

#### Scenario: SIGINT triggers shutdown

- **GIVEN** a running runtime with scheduler and server services
- **WHEN** the process receives SIGINT
- **THEN** `stop()` is called on both services
- **AND** the process waits for both `stop()` promises to settle
- **AND** the process exits with code 0

#### Scenario: SIGTERM triggers shutdown

- **GIVEN** a running runtime with scheduler and server services
- **WHEN** the process receives SIGTERM
- **THEN** the same shutdown sequence as SIGINT is triggered

#### Scenario: Double signal is ignored

- **GIVEN** a shutdown is already in progress
- **WHEN** a second SIGINT or SIGTERM is received
- **THEN** the second signal is ignored
- **AND** the original shutdown continues

### Requirement: Fatal service error triggers shutdown

The runtime entrypoint SHALL catch rejections from any service's `start()` promise and trigger a full shutdown of all services with exit code 1.

#### Scenario: Scheduler failure shuts down server

- **GIVEN** a running runtime with scheduler and server services
- **WHEN** the scheduler's `start()` promise rejects
- **THEN** `stop()` is called on both services
- **AND** the process exits with code 1

#### Scenario: Server failure shuts down scheduler

- **GIVEN** a running runtime with scheduler and server services
- **WHEN** the server's `start()` promise rejects (e.g., port in use)
- **THEN** `stop()` is called on both services
- **AND** the process exits with code 1

### Requirement: Entrypoint uses async main function

The runtime entrypoint SHALL wrap all setup and service orchestration in an `async function main()`.

#### Scenario: Entrypoint structure

- **WHEN** the runtime starts
- **THEN** `main()` is called
- **AND** services are created via factory functions
- **AND** services are started with error handlers attached
- **AND** signal handlers are registered
