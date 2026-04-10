## REMOVED Requirements

### Requirement: Dynamic workflow discovery from directory
**Reason**: Replaced by the WorkflowRegistry which loads workflows from the storage backend. `WORKFLOW_DIR` is removed.
**Migration**: Workflows are loaded via `registry.recover()` on startup and `registry.register(files)` via the upload endpoint at runtime.

### Requirement: Merge loaded workflows into shared registries
**Reason**: Replaced by WorkflowRegistry which owns validation, persistence, and in-memory state.
**Migration**: Use `WorkflowRegistry.register()` instead of one-shot `registerWorkflows()`.

### Requirement: Manifest-based workflow loading
**Reason**: The separate loader module is removed. Manifest parsing, validation, and workflow construction are owned by the WorkflowRegistry internally.
**Migration**: The WorkflowRegistry's `register()` and `recover()` methods handle all loading logic. Both paths use the same `loadWorkflow(files)` function internally.

## MODIFIED Requirements

### Requirement: Loaded workflows participate in dispatch

All actions from loaded workflows SHALL be included in the scheduler's fan-out logic via the WorkflowRegistry. The scheduler SHALL read `registry.actions` on each tick. The scheduler SHALL pass each action's `env` to the context factory when creating `ActionContext` for that action.

#### Scenario: Event matches actions from different workflows

- **WHEN** an event type matches actions from two different loaded workflows
- **THEN** the scheduler SHALL emit targeted events for all matching actions

#### Scenario: Action receives its declared env

- **GIVEN** an action loaded with `env: { "API_KEY": "secret", "BASE_URL": "https://example.com" }`
- **WHEN** the scheduler executes that action
- **THEN** the `ActionContext` SHALL have `env` set to `{ "API_KEY": "secret", "BASE_URL": "https://example.com" }`

## ADDED Requirements

### Requirement: Startup sequence ordering

The runtime SHALL follow this startup sequence:
1. Initialize storage backend (if configured)
2. Initialize event bus and consumers (work queue, event store, persistence, logging)
3. Recover events from storage backend (events fill work queue and event store; no action execution occurs)
4. Recover workflows via `registry.recover()`
5. Start scheduler and server

#### Scenario: Events recovered before workflows loaded

- **GIVEN** the storage backend contains persisted events and workflows
- **WHEN** the runtime starts
- **THEN** events SHALL be recovered into the work queue before workflows are loaded
- **AND** the scheduler SHALL NOT execute any actions until step 5

#### Scenario: Empty startup

- **GIVEN** no storage backend is configured
- **WHEN** the runtime starts
- **THEN** the runtime SHALL start with empty event bus consumers and an empty WorkflowRegistry
- **AND** the server SHALL accept upload requests immediately
