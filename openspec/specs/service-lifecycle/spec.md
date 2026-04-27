# Service Lifecycle Specification

## Purpose

Define the shared service contract, graceful shutdown coordination, error-triggered process termination, and the startup sequence for the runtime.

## Requirements

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

- **GIVEN** a running runtime with server service
- **WHEN** the process receives SIGINT
- **THEN** `stop()` is called on the service
- **AND** the process waits for the `stop()` promise to settle
- **AND** the process exits with code 0

#### Scenario: SIGTERM triggers shutdown

- **GIVEN** a running runtime with server service
- **WHEN** the process receives SIGTERM
- **THEN** the same shutdown sequence as SIGINT is triggered

#### Scenario: Double signal is ignored

- **GIVEN** a shutdown is already in progress
- **WHEN** a second SIGINT or SIGTERM is received
- **THEN** the second signal is ignored
- **AND** the original shutdown continues

### Requirement: Fatal service error triggers shutdown

The runtime entrypoint SHALL catch rejections from any service's `start()` promise and trigger a full shutdown of all services with exit code 1.

#### Scenario: Server failure triggers shutdown

- **GIVEN** a running runtime with server service
- **WHEN** the server's `start()` promise rejects (e.g., port in use)
- **THEN** `stop()` is called on all services
- **AND** the process exits with code 1

### Requirement: Entrypoint uses main function

The runtime entrypoint SHALL wrap all setup and service orchestration in a `function main()`.

#### Scenario: Entrypoint structure

- **WHEN** the runtime starts
- **THEN** `main()` is called
- **AND** services are created via factory functions
- **AND** services are started with error handlers attached
- **AND** signal handlers are registered

### Requirement: Startup sequence wires executor and recovery

The runtime startup sequence SHALL execute in this order: (1) initialize storage backend, (2) initialize bus and consumers (EventStore consumer bootstraps from `archive/` directly), (3) construct the `SandboxFactory`, (4) construct the `SandboxStore` over the factory, (5) construct the executor with `{ bus, sandboxStore }`, (6) construct the trigger backends (`http`, `cron`, `manual`) and call `start()` on every backend, (7) construct the `WorkflowRegistry` (metadata-only) and run `registry.recover()` to load persisted tenants (which calls `reconfigure(tenant, entries)` on every started backend), (8) run `recover(persistence, bus)` to sweep crashed pendings, (9) start the Hono HTTP server with the HTTP trigger backend's middleware mounted (which resolves tenant/workflow/trigger and delegates to the registry-built `fire` closure).

The HTTP server SHALL NOT bind its port before recovery completes.

#### Scenario: Server bound only after recovery

- **WHEN** the runtime starts
- **THEN** `recover()` SHALL complete before the HTTP server begins accepting requests
- **AND** no `/webhooks/*` request SHALL be processed until the executor and HTTP middleware are wired

#### Scenario: Executor receives bus and sandboxStore

- **WHEN** the executor is constructed
- **THEN** the runtime SHALL pass `{ bus, sandboxStore }` from the initialized services
- **AND** the executor SHALL not receive a persistence reference directly (persistence is reached only via the bus)
- **AND** the executor SHALL not receive a `SandboxFactory` directly; sandbox resolution is owned by the `SandboxStore`

#### Scenario: SandboxStore is disposed on shutdown

- **GIVEN** a running runtime with a `SandboxStore` holding sandboxes
- **WHEN** the process receives a shutdown signal and the runtime's `stop()` sequence executes
- **THEN** `sandboxStore.dispose()` SHALL be called
- **AND** every cached sandbox SHALL have `dispose()` invoked on it before the process exits

#### Scenario: Trigger backends are started before registry.recover() and stopped on shutdown

- **GIVEN** a running runtime with trigger backends (`http`, `cron`, `manual`)
- **WHEN** the startup sequence executes
- **THEN** every backend's `start()` SHALL be awaited before `registry.recover()` calls `reconfigure(tenant, entries)` on it
- **AND** on shutdown every backend's `stop()` SHALL be awaited before `sandboxStore.dispose()` runs

### Requirement: Shutdown completion log line

The runtime SHALL emit a structured log line `{msg: "shutdown.complete", code, durationMs}` at the end of its shutdown handler, after `Promise.allSettled` of all service stops, immediately before `process.exit(code)`.

#### Scenario: Graceful shutdown emits shutdown.complete

- **GIVEN** a running runtime
- **WHEN** the process receives SIGTERM (or SIGINT) and all services stop cleanly
- **THEN** the runtime SHALL emit a single info-level log line via `runtimeLogger.info("shutdown.complete", {code: 0, durationMs: <total drain time in ms>})`
- **AND** the line SHALL appear on stdout BEFORE the process exits
- **AND** `durationMs` SHALL measure the time from signal receipt (or fatal-error trigger) until just before `process.exit`

#### Scenario: Forced shutdown also emits shutdown.complete

- **GIVEN** a running runtime
- **WHEN** the shutdown sequence completes with a non-zero exit code (e.g. fatal service error)
- **THEN** the runtime SHALL still emit `shutdown.complete` with the appropriate `code` and `durationMs` before exiting
- **AND** the line SHALL be the LAST log line emitted before exit

#### Scenario: Line position is load-bearing for E2E tests

- **WHEN** the e2e SIGTERM-drain test sends SIGTERM and observes the child's stdout
- **THEN** the test SHALL await the `shutdown.complete` line as the synchronization signal that graceful shutdown finished
- **AND** the runtime SHALL guarantee the line is emitted only after all in-flight invocations have either completed or hit the shutdown deadline

### Requirement: Scheduler service is removed

The runtime SHALL NOT include a separate scheduler service. The executor (combined with per-workflow runQueue and the HTTP trigger middleware as the dispatch driver) replaces the scheduler. There SHALL be no background loop dequeuing from a work queue.

#### Scenario: No scheduler service in startup

- **WHEN** the runtime starts
- **THEN** no service named `scheduler` SHALL be initialized
- **AND** there SHALL be no `WorkQueue` instance in the runtime
