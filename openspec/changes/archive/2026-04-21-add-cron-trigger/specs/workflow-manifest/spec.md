## MODIFIED Requirements

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
- `type`: string --- discriminant for trigger kind (`"http"` or `"cron"`)
- Type-specific fields.
  - For `type: "http"`: `path`, `method`, `body` (JSON Schema), `params` (string array), and optionally `query` (JSON Schema).
  - For `type: "cron"`: `schedule` (string, standard 5-field cron), `tz` (string, IANA timezone identifier), `inputSchema` (JSON Schema for the empty input object), `outputSchema` (JSON Schema for `unknown`).

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

#### Scenario: Cron trigger entry with schedule and tz

- **GIVEN** `export const nightly = cronTrigger({ schedule: "0 2 * * *", tz: "Europe/Berlin", handler })`
- **WHEN** the build runs
- **THEN** the trigger entry SHALL have `name: "nightly"`, `type: "cron"`, `schedule: "0 2 * * *"`, `tz: "Europe/Berlin"`
- **AND** SHALL have `inputSchema: {"type":"object","properties":{},"additionalProperties":false}` (or equivalent JSON Schema for `z.object({})`)
- **AND** SHALL have `outputSchema: {}` (or equivalent JSON Schema for `z.unknown()`)
- **AND** SHALL NOT contain `path`, `method`, `body`, `params`, or `query` fields

### Requirement: ManifestSchema validation (v1)

The SDK SHALL export a `ManifestSchema` Zod object validating the v1 manifest shape. The schema SHALL require `name`, `module`, `env`, `actions`, `triggers` at the top level. Each action entry SHALL require `name`, `input`, `output`. Each trigger entry SHALL require `name`, `type` and the type-specific fields.

The `triggers[].type` discriminant SHALL accept the literals `"http"` and `"cron"`. HTTP entries SHALL require `path`, `method`, `body`, `params`, and optionally `query`. Cron entries SHALL require `schedule` (validated against a standard 5-field cron regex), `tz` (validated against the host's IANA timezone set — see the new "IANA timezone validation" requirement), `inputSchema`, and `outputSchema`.

The runtime SHALL parse every loaded manifest through `ManifestSchema`. Invalid manifests SHALL be rejected at upload with a `400` response carrying the validation issues.

#### Scenario: Valid v1 manifest passes validation

- **WHEN** a well-formed v1 `manifest.json` is parsed through `ManifestSchema`
- **THEN** parsing SHALL succeed and return the typed manifest object

#### Scenario: Manifest missing required top-level field fails

- **WHEN** a manifest is missing `name`, `module`, or `actions`
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

#### Scenario: Action entry missing input schema fails

- **WHEN** a manifest contains an action entry without `input`
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

#### Scenario: Cron trigger with invalid schedule fails

- **WHEN** a manifest contains a cron trigger with `schedule: "not a cron"` (does not match the 5-field pattern)
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error identifying the `schedule` field

#### Scenario: Cron trigger missing tz fails

- **WHEN** a manifest contains a cron trigger without a `tz` field
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error identifying the missing `tz`

#### Scenario: Legacy events array rejected

- **WHEN** a manifest contains an `events` array
- **THEN** the field SHALL be ignored (extra fields stripped) and SHALL NOT appear on the parsed manifest type

## ADDED Requirements

### Requirement: IANA timezone validation on upload

The `ManifestSchema` Zod schema in `@workflow-engine/core` SHALL validate every cron trigger's `tz` field against the runtime host's IANA timezone set, probed once per zone via `new Intl.DateTimeFormat('en-US', { timeZone })` in a try/catch (memoized in a process-local cache), via a Zod `.refine()` predicate. The workflow upload endpoint (`POST /api/workflows/<tenant>`) already runs `ManifestSchema.parse()` on incoming manifests (see `workflow-registry.ts`); uploads with an unknown `tz` SHALL therefore be rejected with `422 Unprocessable Entity` and the Zod-reported issues.

#### Scenario: Known IANA timezone passes

- **GIVEN** a manifest with a cron trigger whose `tz` is `"Europe/Berlin"`
- **WHEN** `ManifestSchema.parse()` runs
- **THEN** parsing SHALL succeed

#### Scenario: Unknown IANA timezone fails

- **GIVEN** a manifest with a cron trigger whose `tz` is `"Not/AZone"`
- **WHEN** the manifest is uploaded
- **THEN** `ManifestSchema.parse()` SHALL throw with a Zod issue identifying `tz` as invalid
- **AND** the upload endpoint SHALL return `422` with the issues payload

#### Scenario: Empty tz fails

- **GIVEN** a manifest with a cron trigger whose `tz` is the empty string `""`
- **WHEN** the manifest is uploaded
- **THEN** the upload endpoint SHALL return `422`
