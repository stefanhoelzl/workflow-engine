## MODIFIED Requirements

### Requirement: Manifest JSON format (v1)

The build output for each workflow SHALL include a `manifest.json` file containing serializable metadata: `name`, `module`, `env`, `actions`, `triggers`. The manifest SHALL NOT contain executable code or function references.

The top-level fields:
- `name`: string — workflow name (`defineWorkflow({name})` if provided, otherwise the workflow file's filestem)
- `module`: string — relative path to the bundled workflow JS file (e.g., `"cronitor.js"`). One bundle per workflow.
- `env`: `Record<string, string>` — workflow-level resolved env values.

Each action entry SHALL have:
- `name`: string — derived from the workflow file's export name
- `input`: object — JSON Schema for the action's input (from the action's Zod input schema)
- `output`: object — JSON Schema for the action's output (from the action's Zod output schema)

Each trigger entry SHALL have:
- `name`: string — derived from the export name
- `type`: string — discriminant for trigger kind (e.g., `"http"`)
- `inputSchema`: object — JSON Schema for the handler's input (derived from the trigger's `inputSchema` Zod schema)
- `outputSchema`: object — JSON Schema for the handler's return value (derived from the trigger's `outputSchema` Zod schema)
- Kind-specific fields. For `type: "http"`: `path`, `method`, `body` (JSON Schema), `params` (string array), and optionally `query` (JSON Schema).

The manifest SHALL NOT contain an `events` array, action `on`/`emits` fields, per-action `module` field, per-action `env` field, or trigger `response` field.

**BREAKING CHANGE**: trigger entries now require `inputSchema` and `outputSchema`. Previously-uploaded tarballs missing these fields SHALL fail manifest validation. The upgrade path (documented in `CLAUDE.md` Upgrade notes) requires wiping the `workflows/` storage prefix and re-uploading each tenant.

#### Scenario: Manifest contains workflow-level fields and per-action/trigger schemas

- **GIVEN** a workflow named "cronitor" with one HTTP trigger and two actions
- **WHEN** the build runs
- **THEN** `manifest.json` SHALL contain `name: "cronitor"`, `module: "cronitor.js"`, `env: {...}`, an `actions` array of length 2 (each with `name`, `input`, `output`), and a `triggers` array of length 1
- **AND** the trigger entry SHALL contain `name`, `type: "http"`, `path`, `method`, `body`, `params`, `inputSchema`, `outputSchema`
- **AND** SHALL NOT contain an `events` array
- **AND** action entries SHALL NOT contain `on`, `emits`, `module`, or `env` fields
- **AND** trigger entries SHALL NOT contain a `response` field

#### Scenario: Workflow name defaults to filestem

- **GIVEN** a workflow file `workflows/cronitor.ts` with `defineWorkflow()` (no name)
- **WHEN** the build runs
- **THEN** the manifest SHALL have `name: "cronitor"`

#### Scenario: HTTP trigger entry with parameterized path carries inputSchema

- **GIVEN** `httpTrigger({ path: "users/:userId/status", body: z.object({ active: z.boolean() }), handler })`
- **WHEN** the build runs
- **THEN** the trigger entry SHALL have `path: "users/:userId/status"`, `params: ["userId"]`, `body: <JSON Schema for {active: boolean}>`, `method: "POST"`
- **AND** SHALL have `inputSchema` describing the composite `{ body, headers, url, method, params, query }`
- **AND** SHALL have `outputSchema` describing `{ status?, body?, headers? }`

#### Scenario: HTTP trigger entry with wildcard path

- **GIVEN** `httpTrigger({ path: "files/*rest", handler })`
- **WHEN** the build runs
- **THEN** the trigger entry SHALL have `path: "files/*rest"`, `params: ["rest"]`, `inputSchema`, `outputSchema`

### Requirement: ManifestSchema validation (v1)

The SDK SHALL export a `ManifestSchema` Zod object validating the v1 manifest shape. The schema SHALL require `name`, `module`, `env`, `actions`, `triggers` at the top level. Each action entry SHALL require `name`, `input`, `output`. Each trigger entry SHALL require `name`, `type`, `inputSchema`, `outputSchema`, and the kind-specific fields. The runtime SHALL parse every loaded manifest through `ManifestSchema` and SHALL reject manifests missing `inputSchema` or `outputSchema` on any trigger entry.

#### Scenario: Valid v1 manifest passes validation

- **WHEN** a well-formed v1 `manifest.json` including `inputSchema` + `outputSchema` on every trigger is parsed through `ManifestSchema`
- **THEN** parsing SHALL succeed and return the typed manifest object

#### Scenario: Manifest missing trigger inputSchema fails

- **WHEN** a manifest contains a trigger entry without `inputSchema`
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

#### Scenario: Manifest missing required top-level field fails

- **WHEN** a manifest is missing `name`, `module`, or `actions`
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

#### Scenario: Action entry missing input schema fails

- **WHEN** a manifest contains an action entry without `input`
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

#### Scenario: Legacy events array rejected

- **WHEN** a manifest contains an `events` array
- **THEN** the field SHALL be ignored (extra fields stripped) and SHALL NOT appear on the parsed manifest type
