## MODIFIED Requirements

### Requirement: Manifest JSON format

The build output for each workflow SHALL include a `manifest.json` file containing serializable metadata: name, module, events (with JSON Schema), triggers, and actions. The manifest SHALL NOT contain executable code or function references.

The manifest SHALL include a required `name` field containing the workflow name as specified in `createWorkflow("name")`.

The manifest SHALL include a required `module` field at the top level containing the relative path to the workflow's action module (e.g., `"actions.js"`). There SHALL be no `module` field on individual action entries.

Each action entry SHALL have an `export` field containing the name of the JavaScript export in the module that corresponds to this action's handler function.

Trigger entries SHALL NOT have an `event` field. The trigger `name` SHALL be used to resolve the corresponding event from the `events` array. Trigger-owned events SHALL appear in the `events` array with their full schema (including the HTTP payload wrapper fields `body`, `headers`, `url`, `method`).

#### Scenario: Manifest contains name, module, and all workflow metadata

- **WHEN** a workflow named "cronitor" defines 1 trigger, 1 action event, and 2 actions
- **THEN** `manifest.json` SHALL contain a `name` field with value `"cronitor"`, a `module` field with value `"actions.js"`, an `events` array with 2 entries, a `triggers` array with 1 entry (without an `event` field), and an `actions` array with 2 entries
- **AND** each action entry SHALL have an `export` field but no `module` field

#### Scenario: Top-level module with per-action export fields

- **WHEN** a workflow defines actions `handleCronitorEvent` and `sendMessage`
- **THEN** the manifest SHALL contain `module: "actions.js"` at the top level
- **AND** action entries SHALL have `export: "handleCronitorEvent"` and `export: "sendMessage"` respectively
- **AND** action entries SHALL NOT have a `module` field

#### Scenario: Trigger entry has no event field

- **WHEN** a workflow defines `trigger("webhook.order", http({ path: "order", body: z.object({ orderId: z.string() }) }))`
- **THEN** the trigger entry in `manifest.json` SHALL have `name: "webhook.order"`, `type: "http"`, `path: "order"`, `method: "POST"` (default)
- **AND** SHALL NOT have an `event` field

#### Scenario: Action entry fields

- **WHEN** a workflow defines an action with `on: "event.a"`, `emits: ["event.b"]`, `env: { API_KEY: "resolved-value" }`
- **THEN** the action entry in `manifest.json` SHALL contain `name`, `export`, `on`, `emits`, and `env` fields
- **AND** `env` SHALL be a JSON object mapping string keys to string values
- **AND** `name` SHALL be the action identity (from export name or explicit override)
- **AND** `export` SHALL be the JavaScript export name in the module

### Requirement: ManifestSchema validation

The SDK SHALL export a `ManifestSchema` Zod object for validating `manifest.json` files. The schema SHALL include a required `name` field of type `z.string()` and a required `module` field of type `z.string()` at the top level. The action schema SHALL include a required `export` field of type `z.string()` and SHALL NOT include a `module` field. The `actions[].env` field in the schema SHALL be `z.record(z.string())`. The trigger schema SHALL NOT require an `event` field. The runtime SHALL parse every manifest through `ManifestSchema` at load time.

#### Scenario: Valid manifest passes validation

- **WHEN** a well-formed `manifest.json` with `name`, `module`, actions with `export` fields, `env` as `Record<string, string>`, and triggers lacking the `event` field is parsed through `ManifestSchema`
- **THEN** parsing SHALL succeed and return the typed manifest object

#### Scenario: Manifest missing module field

- **WHEN** a `manifest.json` is missing the top-level `module` field
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

#### Scenario: Action missing export field

- **WHEN** a `manifest.json` contains an action entry without the `export` field
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

#### Scenario: Manifest missing name field

- **WHEN** a `manifest.json` is missing the `name` field
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

#### Scenario: Legacy per-action module field rejected

- **WHEN** a `manifest.json` contains an action entry with a `module` field
- **THEN** parsing through `ManifestSchema` SHALL still succeed (extra fields are ignored by default)
- **AND** the `module` field SHALL NOT be present on the parsed action type

