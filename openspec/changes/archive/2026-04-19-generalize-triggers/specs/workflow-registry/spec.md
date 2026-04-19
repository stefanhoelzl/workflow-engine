## MODIFIED Requirements

### Requirement: WorkflowRegistry is the central owner of workflow state

The runtime SHALL provide a `WorkflowRegistry` created with an optional `StorageBackend`, a `Logger`, an `Executor`, and a `sources: ReadonlyArray<TriggerSource>` list. It SHALL own validation, persistence, and in-memory state for all workflows. It SHALL replace the one-shot `registerWorkflows()` function and the separate loader module. It SHALL also act as the plugin host for `TriggerSource` instances: on every state change (`register`, `remove`, `recover`) the registry SHALL invoke `source.reconfigure(kindFilteredView)` on every registered source synchronously as part of the state-mutation call.

#### Scenario: Register a workflow from file map

- **WHEN** `register(files)` is called with a `Map<string, string>` containing `manifest.json` and action source files
- **THEN** the registry SHALL validate the manifest, verify action sources exist, persist to storage backend (if configured), build the in-memory workflow, rebuild derived indexes, and invoke `reconfigure(view)` on every registered source
- **AND** it SHALL return the workflow name on success

#### Scenario: Register returns undefined on validation failure

- **WHEN** `register(files)` is called with invalid or incomplete files
- **THEN** the registry SHALL return `undefined`
- **AND** it SHALL log the error reason
- **AND** it SHALL NOT call `reconfigure` on any source

#### Scenario: Register replaces existing workflow

- **WHEN** `register(files)` is called with a manifest whose `name` matches an existing workflow
- **THEN** the old workflow SHALL be replaced with the new one
- **AND** the derived indexes SHALL be rebuilt
- **AND** every registered source SHALL receive a `reconfigure` call reflecting the replaced state

#### Scenario: Invalid register removes existing workflow

- **WHEN** `register(files)` is called with files that have a valid manifest name but fail validation (e.g., missing action source)
- **AND** a workflow with that name already exists in the registry
- **THEN** the existing workflow SHALL be removed
- **AND** the derived indexes SHALL be rebuilt without "foo"'s contributions
- **AND** every registered source SHALL receive a `reconfigure` call reflecting the removal

#### Scenario: Remove a workflow

- **WHEN** `remove("foo")` is called
- **THEN** the registry SHALL no longer contain "foo"
- **AND** the derived indexes SHALL be rebuilt without "foo"'s contributions
- **AND** every registered source SHALL receive a `reconfigure` call with a view missing "foo"'s triggers

### Requirement: Derived indexes rebuilt eagerly

The registry SHALL maintain derived indexes that are rebuilt eagerly on every `register()` or `remove()` call:
- `.actions` — flat array of all actions across all workflows
- kind-filtered trigger views — built from the full list of `TriggerDescriptor` instances across workflows and partitioned by `descriptor.kind`. The registry SHALL pass each partitioned slice into the matching source via `reconfigure`.

The registry SHALL NOT maintain a bespoke `HttpTriggerRegistry` field. Any HTTP-specific URL-pattern map SHALL live inside the HTTP `TriggerSource`, populated via its `reconfigure` call.

#### Scenario: Actions from multiple workflows

- **GIVEN** workflow "foo" has actions `[handleA]` and workflow "bar" has actions `[handleB, handleC]`
- **WHEN** both are registered
- **THEN** `registry.actions` SHALL contain `[handleA, handleB, handleC]`

#### Scenario: Rebuild after removal

- **GIVEN** workflows "foo" and "bar" are registered
- **WHEN** `remove("foo")` is called
- **THEN** `registry.actions` SHALL contain only "bar"'s actions
- **AND** every source's `reconfigure` receives a view missing "foo"'s descriptors

### Requirement: WorkflowRegistry exposes workflows with actions and triggers

The runtime SHALL provide a `WorkflowRegistry` that loads manifests at startup and exposes per-workflow `WorkflowRunner` objects. Each `WorkflowRunner` SHALL provide:
- `name`: string
- `env`: `Readonly<Record<string, string>>`
- `sandbox`: the workflow's `Sandbox` instance
- `actions`: array of action descriptors `{ name, input, output }`
- `triggers`: array of `TriggerDescriptor` instances (discriminated by `kind`; each carries `name`, `kind`, `inputSchema`, `outputSchema`, and kind-specific fields)

The registry SHALL NOT expose any event types or schemas.

#### Scenario: Registry exposes loaded workflows

- **GIVEN** two workflows loaded at startup
- **WHEN** the registry is queried
- **THEN** the registry SHALL expose two `WorkflowRunner` entries, each with `name`, `env`, `sandbox`, `actions`, `triggers`
- **AND** no `events` field SHALL be present

#### Scenario: Trigger descriptors typed by kind

- **GIVEN** a workflow with one HTTP trigger
- **WHEN** the registry is queried
- **THEN** the trigger entry SHALL be a `TriggerDescriptor<"http">` with `kind: "http"`, `name`, `inputSchema`, `outputSchema`, and HTTP-specific fields

### Requirement: Trigger conflict override

When a workflow is registered with trigger paths that conflict with triggers from a different workflow within the same tenant, the new workflow's triggers SHALL override the existing ones. Conflict resolution SHALL happen inside each `TriggerSource` during `reconfigure` — the registry SHALL NOT pre-deduplicate; it SHALL pass the full view and each source SHALL apply its own conflict policy. For HTTP, last-write-wins by `(tenant, path, method)`.

#### Scenario: Cross-workflow trigger override

- **GIVEN** workflow "foo" registers trigger path `/webhooks/<tenant>/foo/orders` (POST)
- **WHEN** workflow "bar" is registered with the same trigger path `/webhooks/<tenant>/bar/orders` (POST) (different workflow, same path)
- **THEN** the HTTP source's URL-pattern map SHALL contain both entries keyed by `(tenant, workflow, method, path)` — they do not actually conflict since workflow is part of the key

#### Scenario: Intra-tenant path collision resolution

- **GIVEN** two workflows in the same tenant that declare the same `(path, method)` on the same trigger name
- **WHEN** the second workflow is registered
- **THEN** the HTTP source's `reconfigure` SHALL apply last-write-wins

## REMOVED Requirements

### Requirement: Persist before rebuild

**Reason**: Behaviour unchanged; folded into the "WorkflowRegistry is the central owner of workflow state" scenarios which already describe register ordering. Keeping it as a standalone requirement was redundant given the explicit `reconfigure` call ordering in the modified requirement.

**Migration**: None. The persist-before-rebuild ordering is preserved in implementation — this refactor only collapses the spec.

### Requirement: Recover workflows from storage backend

**Reason**: Behaviour unchanged except that `recover()` now calls `source.reconfigure(view)` on every registered source exactly once after all workflows have been loaded. The requirement's scenarios are preserved; the `reconfigure` fire-after-recover behaviour is covered by the "Reconfigure fires once on recover" scenario in the `triggers` capability.

**Migration**: None. Existing `recover()` callers see identical behaviour.
