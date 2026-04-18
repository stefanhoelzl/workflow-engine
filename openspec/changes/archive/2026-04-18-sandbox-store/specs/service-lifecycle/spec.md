## MODIFIED Requirements

### Requirement: Startup sequence wires executor and recovery

The runtime startup sequence SHALL execute in this order: (1) initialize storage backend, (2) initialize bus and consumers (EventStore consumer bootstraps from `archive/` directly), (3) construct the `SandboxFactory`, (4) construct the `SandboxStore` over the factory, (5) construct the `WorkflowRegistry` (metadata-only) and run `registry.recover()` to load persisted tenants, (6) construct the executor with `{ bus, sandboxStore }`, (7) run `recover(persistence, bus)` to sweep crashed pendings, (8) start the Hono HTTP server and bind the HTTP trigger middleware (which calls `registry.lookup` and delegates to `executor.invoke`).

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
