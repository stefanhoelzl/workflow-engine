## MODIFIED Requirements

### Requirement: Loaded workflows participate in dispatch

All actions from loaded workflows SHALL be included in the scheduler's fan-out logic via the WorkflowRegistry. The scheduler SHALL read `registry.actions` on each tick. The scheduler SHALL pass each action's `env` to the context factory when creating `ActionContext` for that action.

The scheduler SHALL maintain a `Map<workflowName, Sandbox>` and lazily construct a `Sandbox` for each workflow on first event dispatch, using `sandbox(action.source, methods)` with `methods` empty in v1. For each event, the scheduler SHALL invoke `sb.run(action.name, ctx, { emit })` where `action.name` is the exported handler name in the workflow's action source (from the manifest's `actions[].export` field).

The workflow registry SHALL load the action module source from the manifest's top-level `module` field and attach it to each `Action` object. Each action SHALL carry an `exportName` field from the manifest's `actions[].export` field, which the scheduler uses as the `name` argument to `Sandbox.run()`.

#### Scenario: Event matches actions from different workflows

- **WHEN** an event type matches actions from two different loaded workflows
- **THEN** the scheduler SHALL emit targeted events for all matching actions
- **AND** each action SHALL be dispatched via its own workflow's `Sandbox` instance

#### Scenario: Action receives its declared env

- **GIVEN** an action loaded with `env: { "API_KEY": "secret", "BASE_URL": "https://example.com" }`
- **WHEN** the scheduler executes that action
- **THEN** the ctx passed to `Sandbox.run()` SHALL have `env` set to `{ "API_KEY": "secret", "BASE_URL": "https://example.com" }`

#### Scenario: Action executed with correct export name

- **GIVEN** a workflow with `module: "actions.js"` and an action with `export: "sendMessage"`
- **WHEN** the scheduler executes the `sendMessage` action
- **THEN** the workflow's `Sandbox` SHALL be used (constructed from the content of `actions.js` on first use)
- **AND** `sb.run("sendMessage", ctx, { emit })` SHALL be called
