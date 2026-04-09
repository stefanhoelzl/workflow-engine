## MODIFIED Requirements

### Requirement: Manifest-based workflow loading
The loader SHALL read and parse `manifest.json` from each workflow subdirectory using the SDK's `ManifestSchema` for validation. Event schemas SHALL be reconstructed from JSON Schema via `z.fromJSONSchema()`. Handler functions SHALL be imported from the actions module specified by the manifest's `module` field. Each loaded action SHALL carry its `env: Record<string, string>` from the manifest.

#### Scenario: Valid manifest and actions module
- **WHEN** a subdirectory contains a valid `manifest.json` with actions having `env: { "API_KEY": "value" }` and a matching `actions.js`
- **THEN** the loader SHALL parse the manifest, reconstruct Zod schemas for each event, import the actions module, and match named exports to action entries via the `handler` field
- **AND** each loaded `Action` object SHALL include its `env: Record<string, string>` from the manifest

#### Scenario: Manifest fails validation
- **WHEN** a `manifest.json` fails `ManifestSchema` parsing
- **THEN** the loader SHALL log a warning with the directory name and validation error
- **AND** the loader SHALL skip that workflow and continue loading remaining workflows

#### Scenario: Actions module fails to import
- **WHEN** `manifest.json` is valid but the actions module specified by `module` cannot be imported
- **THEN** the loader SHALL log a warning and skip that workflow

#### Scenario: Handler export missing
- **WHEN** `manifest.json` lists an action with `handler: "processEvent"` but the actions module has no export named `processEvent`
- **THEN** the loader SHALL log a warning and skip that workflow

### Requirement: Loaded workflows participate in dispatch
All actions from loaded workflows SHALL be included in the scheduler's fan-out logic. The scheduler SHALL pass each action's `env` to the context factory when creating `ActionContext` for that action.

#### Scenario: Event matches actions from different workflows
- **WHEN** an event type matches actions from two different loaded workflows
- **THEN** the scheduler SHALL emit targeted events for all matching actions

#### Scenario: Action receives its declared env
- **GIVEN** an action loaded with `env: { "API_KEY": "secret", "BASE_URL": "https://example.com" }`
- **WHEN** the scheduler executes that action
- **THEN** the `ActionContext` SHALL have `env` set to `{ "API_KEY": "secret", "BASE_URL": "https://example.com" }`
