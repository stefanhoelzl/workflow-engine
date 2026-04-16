## ADDED Requirements

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

## REMOVED Requirements

### Requirement: Registry exposes events

**Reason**: Events are removed; there is no event registry to expose.

**Migration**: Consumers that previously used the event registry now look up actions or triggers directly.
