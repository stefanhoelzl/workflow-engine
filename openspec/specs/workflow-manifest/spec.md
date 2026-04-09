### Requirement: Manifest JSON format

The build output for each workflow SHALL include a `manifest.json` file containing serializable metadata: events (with JSON Schema), triggers, and actions. The manifest SHALL NOT contain executable code or function references.

#### Scenario: Manifest contains all workflow metadata
- **WHEN** a workflow defines 2 events, 1 trigger, and 2 actions
- **THEN** `manifest.json` SHALL contain an `events` array with 2 entries (each with `name` and `schema`), a `triggers` array with 1 entry, and an `actions` array with 2 entries

#### Scenario: Event schemas as JSON Schema
- **WHEN** a workflow defines an event with `z.object({ id: z.string(), type: z.enum(["A", "B"]) })`
- **THEN** the event entry in `manifest.json` SHALL have a `schema` field containing a valid JSON Schema object with `type: "object"`, `properties`, and `required` fields

#### Scenario: Nullable field schema round-trip
- **WHEN** a workflow defines an event with `z.string().nullable()`
- **THEN** the JSON Schema representation SHALL use `anyOf: [{type: "string"}, {type: "null"}]`
- **AND** `z.fromJSONSchema()` on the result SHALL accept both `"value"` and `null`

#### Scenario: Action entry fields
- **WHEN** a workflow defines an action with `on: "event.a"`, `emits: ["event.b"]`, `env: ["API_KEY"]`
- **THEN** the action entry in `manifest.json` SHALL contain `name`, `handler`, `on`, `emits`, and `env` fields
- **AND** `name` SHALL be the action identity (from export name or explicit override)
- **AND** `handler` SHALL be the export name in `actions.js`

#### Scenario: Module path field
- **WHEN** a manifest is generated
- **THEN** it SHALL contain a `module` field with value `"./actions.js"`

### Requirement: ManifestSchema validation

The SDK SHALL export a `ManifestSchema` Zod object for validating `manifest.json` files. The runtime SHALL parse every manifest through `ManifestSchema` at load time.

#### Scenario: Valid manifest passes validation
- **WHEN** a well-formed `manifest.json` is parsed through `ManifestSchema`
- **THEN** parsing SHALL succeed and return the typed manifest object

#### Scenario: Malformed manifest rejected
- **WHEN** a `manifest.json` is missing the `events` field
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

#### Scenario: Action missing required fields
- **WHEN** a `manifest.json` contains an action entry without the `on` field
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

### Requirement: Manifest type exported from SDK

The SDK SHALL export a `Manifest` TypeScript type derived from `ManifestSchema` for consumers that need to work with manifest data.

#### Scenario: Manifest type matches schema
- **WHEN** a consumer imports `Manifest` from the SDK
- **THEN** the type SHALL match the shape validated by `ManifestSchema`
