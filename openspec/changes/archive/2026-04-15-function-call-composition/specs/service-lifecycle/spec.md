## ADDED Requirements

### Requirement: Startup sequence wires executor and recovery

The runtime startup sequence SHALL execute in this order: (1) initialize storage backend, (2) initialize bus and consumers (EventStore consumer bootstraps from `archive/` directly), (3) load workflow manifests and instantiate one `WorkflowRunner` per workflow (each with its own QuickJS sandbox), (4) build the HTTP trigger registry from manifests, (5) construct the executor with `{ bus, sandboxFactory }`, (6) run `recover(persistence, bus)` to sweep crashed pendings, (7) start the Hono HTTP server and bind triggers.

The HTTP server SHALL NOT bind its port before recovery completes.

#### Scenario: Server bound only after recovery

- **WHEN** the runtime starts
- **THEN** `recover()` SHALL complete before the HTTP server begins accepting requests
- **AND** no `/webhooks/*` request SHALL be processed until the executor and HTTP middleware are wired

#### Scenario: Executor receives bus and sandboxFactory

- **WHEN** the executor is constructed
- **THEN** the runtime SHALL pass `{ bus, sandboxFactory }` from the initialized services
- **AND** the executor SHALL not receive a persistence reference directly (persistence is reached only via the bus)

### Requirement: Scheduler service is removed

The runtime SHALL NOT include a separate scheduler service. The executor (combined with per-workflow runQueue and the HTTP trigger middleware as the dispatch driver) replaces the scheduler. There SHALL be no background loop dequeuing from a work queue.

#### Scenario: No scheduler service in startup

- **WHEN** the runtime starts
- **THEN** no service named `scheduler` SHALL be initialized
- **AND** there SHALL be no `WorkQueue` instance in the runtime

## REMOVED Requirements

### Requirement: Scheduler service started at runtime

**Reason**: Replaced by `executor` + per-workflow `runQueue`. The HTTP trigger middleware drives invocation lifecycle directly via `executor.invoke(...)`; there is no background loop to start.

**Migration**: Remove scheduler initialization from startup; wire executor + recovery as described above.
