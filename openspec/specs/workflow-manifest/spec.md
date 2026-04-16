### Requirement: Manifest JSON format (v1)

The build output for each workflow SHALL include a `manifest.json` file containing serializable metadata: `name`, `module`, `env`, `actions`, `triggers`. The manifest SHALL NOT contain executable code or function references.

The top-level fields:
- `name`: string --- workflow name (`defineWorkflow({name})` if provided, otherwise the workflow file's filestem)
- `module`: string --- relative path to the bundled workflow JS file (e.g., `"cronitor.js"`). One bundle per workflow.
- `env`: `Record<string, string>` --- workflow-level resolved env values.

Each action entry SHALL have:
- `name`: string --- derived from the workflow file's export name
- `input`: object --- JSON Schema for the action's input (from the action's Zod input schema)
- `output`: object --- JSON Schema for the action's output (from the action's Zod output schema)

Each trigger entry SHALL have:
- `name`: string --- derived from the export name
- `type`: string --- discriminant for trigger type (e.g., `"http"`)
- Type-specific fields. For `type: "http"`: `path`, `method`, `body` (JSON Schema), `params` (string array), and optionally `query` (JSON Schema).

The manifest SHALL NOT contain an `events` array, action `on`/`emits` fields, per-action `module` field, per-action `env` field, or trigger `response` field.

#### Scenario: Manifest contains workflow-level fields and per-action input/output schemas

- **GIVEN** a workflow named "cronitor" with one HTTP trigger and two actions
- **WHEN** the build runs
- **THEN** `manifest.json` SHALL contain `name: "cronitor"`, `module: "cronitor.js"`, `env: {...}`, an `actions` array of length 2 (each with `name`, `input`, `output`), and a `triggers` array of length 1 (with `name`, `type: "http"`, `path`, `method`, `body`, `params`)
- **AND** SHALL NOT contain an `events` array
- **AND** action entries SHALL NOT contain `on`, `emits`, `module`, or `env` fields
- **AND** trigger entries SHALL NOT contain a `response` field

#### Scenario: Workflow name defaults to filestem

- **GIVEN** a workflow file `workflows/cronitor.ts` with `defineWorkflow()` (no name)
- **WHEN** the build runs
- **THEN** the manifest SHALL have `name: "cronitor"`

#### Scenario: HTTP trigger entry with parameterized path

- **GIVEN** `httpTrigger({ path: "users/:userId/status", body: z.object({ active: z.boolean() }), handler })`
- **WHEN** the build runs
- **THEN** the trigger entry SHALL have `path: "users/:userId/status"`, `params: ["userId"]`, `body: <JSON Schema for {active: boolean}>`, `method: "POST"`

#### Scenario: HTTP trigger entry with wildcard path

- **GIVEN** `httpTrigger({ path: "files/*rest", handler })`
- **WHEN** the build runs
- **THEN** the trigger entry SHALL have `path: "files/*rest"`, `params: ["rest"]`

### Requirement: ManifestSchema validation (v1)

The SDK SHALL export a `ManifestSchema` Zod object validating the v1 manifest shape. The schema SHALL require `name`, `module`, `env`, `actions`, `triggers` at the top level. Each action entry SHALL require `name`, `input`, `output`. Each trigger entry SHALL require `name`, `type` and the type-specific fields. The runtime SHALL parse every loaded manifest through `ManifestSchema`.

#### Scenario: Valid v1 manifest passes validation

- **WHEN** a well-formed v1 `manifest.json` is parsed through `ManifestSchema`
- **THEN** parsing SHALL succeed and return the typed manifest object

#### Scenario: Manifest missing required top-level field fails

- **WHEN** a manifest is missing `name`, `module`, or `actions`
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

#### Scenario: Action entry missing input schema fails

- **WHEN** a manifest contains an action entry without `input`
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

#### Scenario: Legacy events array rejected

- **WHEN** a manifest contains an `events` array
- **THEN** the field SHALL be ignored (extra fields stripped) and SHALL NOT appear on the parsed manifest type

### Requirement: Manifest type exported from SDK

The SDK SHALL export a `Manifest` TypeScript type derived from `ManifestSchema` for consumers that need to work with manifest data.

#### Scenario: Manifest type matches schema

- **WHEN** a consumer imports `Manifest` from the SDK
- **THEN** the type SHALL match the shape validated by `ManifestSchema`
- **AND** SHALL expose `Manifest["actions"][number]["input"]` and `["output"]` as JSON Schema objects
