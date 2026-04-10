## MODIFIED Requirements

### Requirement: Manifest JSON format

The build output for each workflow SHALL include a `manifest.json` file containing serializable metadata: events (with JSON Schema), triggers, and actions. The manifest SHALL NOT contain executable code or function references.

Trigger entries SHALL NOT have an `event` field. The trigger `name` SHALL be used to resolve the corresponding event from the `events` array. Trigger-owned events SHALL appear in the `events` array with their full schema (including the HTTP payload wrapper fields `body`, `headers`, `url`, `method`).

Each action entry SHALL have a `module` field pointing to its individual source file (e.g., `"./handleCronitorEvent.js"`). There SHALL be no shared `module` field at the manifest root.

#### Scenario: Manifest contains all workflow metadata

- **WHEN** a workflow defines 1 trigger, 1 action event, and 2 actions
- **THEN** `manifest.json` SHALL contain an `events` array with 2 entries, a `triggers` array with 1 entry (without an `event` field), and an `actions` array with 2 entries
- **AND** each action entry SHALL have its own `module` field

#### Scenario: Per-action module paths

- **WHEN** a workflow defines actions `handleCronitorEvent` and `sendMessage`
- **THEN** the manifest SHALL contain action entries with `module: "./handleCronitorEvent.js"` and `module: "./sendMessage.js"` respectively
- **AND** there SHALL be no root-level `module` field

#### Scenario: Action entry fields

- **WHEN** a workflow defines an action with `on: "event.a"`, `emits: ["event.b"]`, `env: { API_KEY: "resolved-value" }`
- **THEN** the action entry in `manifest.json` SHALL contain `name`, `module`, `on`, `emits`, and `env` fields
- **AND** `env` SHALL be a JSON object mapping string keys to string values
- **AND** `name` SHALL be the action identity (from export name or explicit override)
- **AND** `module` SHALL be the relative path to the action's source file

## REMOVED Requirements

### Requirement: Module path field

**Reason**: Replaced by per-action `module` fields. The root-level `module: "./actions.js"` is removed because each action now has its own source file.
**Migration**: Use per-action `module` fields in the `actions` array instead.
