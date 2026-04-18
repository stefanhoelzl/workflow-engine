## MODIFIED Requirements

### Requirement: Manifest JSON format (v1)

The build output for each **tenant** SHALL include a single top-level `manifest.json` file at the root of the uploaded tarball. The manifest SHALL describe every workflow belonging to the tenant. The manifest SHALL NOT contain executable code or function references.

The top-level fields:
- `workflows`: array --- one entry per workflow in the tenant.

Each workflow entry SHALL have:
- `name`: string --- workflow name (`defineWorkflow({name})` if provided, otherwise the workflow file's filestem). Unique within the tenant; MAY collide with names in other tenants.
- `module`: string --- filename of the bundled workflow JS at the tarball root (e.g., `"cronitor.js"`).
- `env`: `Record<string, string>` --- workflow-level resolved env values.
- `actions`: array of action entries.
- `triggers`: array of trigger entries.

Each action entry SHALL have:
- `name`: string --- derived from the workflow file's export name.
- `input`: object --- JSON Schema for the action's input.
- `output`: object --- JSON Schema for the action's output.

Each trigger entry SHALL have:
- `name`: string --- derived from the export name.
- `type`: string --- discriminant for trigger type (e.g., `"http"`).
- Type-specific fields. For `type: "http"`: `path`, `method`, `body` (JSON Schema), `params` (string array), and optionally `query` (JSON Schema).

The manifest SHALL NOT contain an `events` array, action `on`/`emits` fields, per-action `module` field, per-action `env` field, or trigger `response` field. No per-workflow `manifest.json` files SHALL exist inside the tarball.

#### Scenario: Tenant manifest lists multiple workflows

- **GIVEN** a tenant with workflows "cronitor" and "notify"
- **WHEN** the build runs
- **THEN** the root `manifest.json` SHALL contain `workflows: [{ name: "cronitor", module: "cronitor.js", env, actions, triggers }, { name: "notify", module: "notify.js", env, actions, triggers }]`
- **AND** the tarball SHALL contain `cronitor.js` and `notify.js` at the tarball root alongside `manifest.json`
- **AND** the tarball SHALL NOT contain any per-workflow subdirectories or per-workflow `manifest.json` files

#### Scenario: Empty tenant manifest

- **GIVEN** a tenant with zero workflows to deploy
- **WHEN** the build runs
- **THEN** the root `manifest.json` SHALL contain `workflows: []`
- **AND** the tarball SHALL contain only `manifest.json`

#### Scenario: Workflow name defaults to filestem

- **GIVEN** a workflow file `src/cronitor.ts` with `defineWorkflow()` (no name)
- **WHEN** the build runs
- **THEN** the corresponding entry in `workflows` SHALL have `name: "cronitor"`

#### Scenario: HTTP trigger entry with parameterized path

- **GIVEN** `httpTrigger({ path: "users/:userId/status", body: z.object({ active: z.boolean() }), handler })`
- **WHEN** the build runs
- **THEN** the trigger entry SHALL have `path: "users/:userId/status"`, `params: ["userId"]`, `body: <JSON Schema for {active: boolean}>`, `method: "POST"`

#### Scenario: HTTP trigger entry with wildcard path

- **GIVEN** `httpTrigger({ path: "files/*rest", handler })`
- **WHEN** the build runs
- **THEN** the trigger entry SHALL have `path: "files/*rest"`, `params: ["rest"]`

### Requirement: ManifestSchema validation (v1)

The SDK SHALL export a `ManifestSchema` Zod object validating the v1 tenant-manifest shape. The schema SHALL require a top-level `workflows` array. Each workflow entry SHALL require `name`, `module`, `env`, `actions`, `triggers`. Each action entry SHALL require `name`, `input`, `output`. Each trigger entry SHALL require `name`, `type` and the type-specific fields. Workflow `name` values within a single manifest SHALL be unique; duplicate names SHALL cause validation to fail. The runtime SHALL parse every loaded manifest through `ManifestSchema`.

#### Scenario: Valid v1 tenant manifest passes validation

- **WHEN** a well-formed v1 `manifest.json` with one or more workflow entries is parsed through `ManifestSchema`
- **THEN** parsing SHALL succeed and return the typed manifest object

#### Scenario: Manifest missing top-level `workflows` field fails

- **WHEN** a manifest is missing the `workflows` array
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

#### Scenario: Workflow entry missing required field fails

- **WHEN** a manifest contains a workflow entry without `name`, `module`, or `actions`
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

#### Scenario: Duplicate workflow names within a tenant rejected

- **WHEN** a manifest's `workflows` array contains two entries with the same `name`
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error identifying the collision

#### Scenario: Action entry missing input schema fails

- **WHEN** a manifest contains an action entry without `input`
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

#### Scenario: Legacy events array rejected

- **WHEN** a manifest or workflow entry contains an `events` array
- **THEN** the field SHALL be ignored (extra fields stripped) and SHALL NOT appear on the parsed manifest type

### Requirement: Manifest type exported from SDK

The SDK SHALL export a `Manifest` TypeScript type derived from `ManifestSchema` for consumers that need to work with manifest data. The SDK SHALL additionally export a `WorkflowManifest` type alias for individual entries of `Manifest["workflows"]`.

#### Scenario: Manifest type matches schema

- **WHEN** a consumer imports `Manifest` from the SDK
- **THEN** the type SHALL match the shape validated by `ManifestSchema`
- **AND** SHALL expose `Manifest["workflows"][number]["actions"][number]["input"]` and `["output"]` as JSON Schema objects

#### Scenario: WorkflowManifest alias available

- **WHEN** a consumer imports `WorkflowManifest` from the SDK
- **THEN** the type SHALL be assignable from `Manifest["workflows"][number]`
