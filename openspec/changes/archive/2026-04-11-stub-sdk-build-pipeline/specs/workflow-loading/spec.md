## MODIFIED Requirements

### Requirement: Loaded workflows participate in dispatch

All actions from loaded workflows SHALL be included in the scheduler's fan-out logic via the WorkflowRegistry. The scheduler SHALL read `registry.actions` on each tick. The scheduler SHALL pass each action's `env` to the context factory when creating `ActionContext` for that action. The scheduler SHALL pass `action.source` and `action.exportName` to `sandbox.spawn()` so the sandbox can evaluate the correct module and extract the correct handler.

The workflow registry SHALL load the action module source from the manifest's top-level `module` field and attach it to each `Action` object. Each action SHALL carry an `exportName` field from the manifest's `actions[].export` field.

#### Scenario: Event matches actions from different workflows

- **WHEN** an event type matches actions from two different loaded workflows
- **THEN** the scheduler SHALL emit targeted events for all matching actions

#### Scenario: Action receives its declared env

- **GIVEN** an action loaded with `env: { "API_KEY": "secret", "BASE_URL": "https://example.com" }`
- **WHEN** the scheduler executes that action
- **THEN** the `ActionContext` SHALL have `env` set to `{ "API_KEY": "secret", "BASE_URL": "https://example.com" }`

#### Scenario: Action executed with correct export name

- **GIVEN** a workflow with `module: "actions.js"` and an action with `export: "sendMessage"`
- **WHEN** the scheduler executes the `sendMessage` action
- **THEN** `sandbox.spawn()` SHALL be called with the content of `actions.js` as `source` and `exportName: "sendMessage"` in options

