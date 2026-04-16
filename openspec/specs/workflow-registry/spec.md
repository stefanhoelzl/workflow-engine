### Requirement: WorkflowRegistry is the central owner of workflow state

The runtime SHALL provide a `WorkflowRegistry` created with an optional `StorageBackend` and a `Logger`. It SHALL own validation, persistence, and in-memory state for all workflows. It SHALL replace the one-shot `registerWorkflows()` function and the separate loader module.

#### Scenario: Register a workflow from file map

- **WHEN** `register(files)` is called with a `Map<string, string>` containing `manifest.json` and action source files
- **THEN** the registry SHALL validate the manifest, verify action sources exist, persist to storage backend (if configured), build the in-memory workflow, and rebuild derived indexes
- **AND** it SHALL return the workflow name on success

#### Scenario: Register returns undefined on validation failure

- **WHEN** `register(files)` is called with invalid or incomplete files
- **THEN** the registry SHALL return `undefined`
- **AND** it SHALL log the error reason

#### Scenario: Register replaces existing workflow

- **WHEN** `register(files)` is called with a manifest whose `name` matches an existing workflow
- **THEN** the old workflow SHALL be replaced with the new one
- **AND** the derived indexes SHALL be rebuilt

#### Scenario: Invalid register removes existing workflow

- **WHEN** `register(files)` is called with files that have a valid manifest name but fail validation (e.g., missing action source)
- **AND** a workflow with that name already exists in the registry
- **THEN** the existing workflow SHALL be removed
- **AND** the derived indexes SHALL be rebuilt without "foo"'s contributions

#### Scenario: Remove a workflow

- **WHEN** `remove("foo")` is called
- **THEN** the registry SHALL no longer contain "foo"
- **AND** the derived indexes SHALL be rebuilt without "foo"'s contributions

### Requirement: Persist before rebuild

When a storage backend is configured, `register()` SHALL persist the workflow files to the storage backend before updating in-memory state. If persistence fails, the in-memory state SHALL NOT be updated.

#### Scenario: Successful persistence

- **WHEN** `register(files)` is called and the storage backend write succeeds
- **THEN** the files SHALL be written to `workflows/{name}/` in the storage backend
- **AND** the in-memory workflow state SHALL be updated

#### Scenario: No storage backend

- **WHEN** `register(files)` is called and no storage backend is configured
- **THEN** the workflow SHALL exist only in memory
- **AND** it SHALL be lost on restart

### Requirement: Recover workflows from storage backend

The registry SHALL provide a `recover()` method that loads all workflows from the storage backend on startup. It SHALL use the same validation logic as `register()`.

#### Scenario: Recover loads persisted workflows

- **GIVEN** the storage backend contains `workflows/foo/manifest.json` and `workflows/foo/actions/handle.js`
- **WHEN** `recover()` is called
- **THEN** the registry SHALL contain workflow "foo" with its actions

#### Scenario: Recover with empty storage

- **GIVEN** the storage backend contains no keys under `workflows/`
- **WHEN** `recover()` is called
- **THEN** the registry SHALL remain empty

#### Scenario: Recover without storage backend

- **GIVEN** no storage backend is configured
- **WHEN** `recover()` is called
- **THEN** `recover()` SHALL be a no-op

#### Scenario: Recover skips invalid workflows

- **GIVEN** the storage backend contains a workflow with an invalid manifest or missing action sources
- **WHEN** `recover()` is called
- **THEN** the invalid workflow SHALL be skipped
- **AND** the error SHALL be logged

### Requirement: Derived indexes rebuilt eagerly

The registry SHALL maintain derived indexes that are rebuilt eagerly on every `register()` or `remove()` call:
- `.actions` --- flat array of all actions across all workflows
- `.triggerRegistry` --- merged HTTP trigger registry

#### Scenario: Actions from multiple workflows

- **GIVEN** workflow "foo" has actions `[handleA]` and workflow "bar" has actions `[handleB, handleC]`
- **WHEN** both are registered
- **THEN** `registry.actions` SHALL contain `[handleA, handleB, handleC]`

#### Scenario: Rebuild after removal

- **GIVEN** workflows "foo" and "bar" are registered
- **WHEN** `remove("foo")` is called
- **THEN** `registry.actions` SHALL contain only "bar"'s actions

### Requirement: Trigger conflict override

When a workflow is registered with trigger paths that conflict with triggers from a different workflow, the new workflow's triggers SHALL override the existing ones.

#### Scenario: Cross-workflow trigger override

- **GIVEN** workflow "foo" registers trigger path `/webhooks/orders` (POST)
- **WHEN** workflow "bar" is registered with the same trigger path `/webhooks/orders` (POST)
- **THEN** the trigger SHALL point to "bar"'s handler
- **AND** "foo"'s trigger for that path SHALL be replaced

### Requirement: WorkflowRegistry exposes workflows with actions and triggers

The runtime SHALL provide a `WorkflowRegistry` that loads manifests at startup and exposes per-workflow `WorkflowRunner` objects. Each `WorkflowRunner` SHALL provide:
- `name`: string
- `env`: `Readonly<Record<string, string>>`
- `sandbox`: the workflow's `Sandbox` instance
- `actions`: array of action descriptors `{ name, input, output }`
- `triggers`: array of typed trigger descriptors (e.g., `HttpTriggerDescriptor` with `name, type, path, method, body, params, query`)

The registry SHALL NOT expose any event types or schemas.

#### Scenario: Registry exposes loaded workflows

- **GIVEN** two workflows loaded at startup
- **WHEN** the registry is queried
- **THEN** the registry SHALL expose two `WorkflowRunner` entries, each with `name`, `env`, `sandbox`, `actions`, `triggers`
- **AND** no `events` field SHALL be present

#### Scenario: Trigger descriptors typed by trigger kind

- **GIVEN** a workflow with one HTTP trigger
- **WHEN** the registry is queried
- **THEN** the trigger entry SHALL be an `HttpTriggerDescriptor` with `type: "http"` and HTTP-specific fields
