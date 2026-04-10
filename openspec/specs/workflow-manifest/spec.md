### Requirement: Manifest JSON format

The build output for each workflow SHALL include a `manifest.json` file containing serializable metadata: name, events (with JSON Schema), triggers, and actions. The manifest SHALL NOT contain executable code or function references.

The manifest SHALL include a required `name` field containing the workflow name as specified in `createWorkflow("name")`.

Trigger entries SHALL NOT have an `event` field. The trigger `name` SHALL be used to resolve the corresponding event from the `events` array. Trigger-owned events SHALL appear in the `events` array with their full schema (including the HTTP payload wrapper fields `body`, `headers`, `url`, `method`).

Each action entry SHALL have a `module` field pointing to its source file under the `actions/` subdirectory (e.g., `"actions/handleCronitorEvent.js"`). There SHALL be no shared `module` field at the manifest root.

#### Scenario: Manifest contains name and all workflow metadata

- **WHEN** a workflow named "cronitor" defines 1 trigger, 1 action event, and 2 actions
- **THEN** `manifest.json` SHALL contain a `name` field with value `"cronitor"`, an `events` array with 2 entries, a `triggers` array with 1 entry (without an `event` field), and an `actions` array with 2 entries
- **AND** each action entry SHALL have its own `module` field

#### Scenario: Per-action module paths under actions directory

- **WHEN** a workflow defines actions `handleCronitorEvent` and `sendMessage`
- **THEN** the manifest SHALL contain action entries with `module: "actions/handleCronitorEvent.js"` and `module: "actions/sendMessage.js"` respectively
- **AND** there SHALL be no root-level `module` field

#### Scenario: Trigger entry has no event field

- **WHEN** a workflow defines `trigger("webhook.order", http({ path: "order", body: z.object({ orderId: z.string() }) }))`
- **THEN** the trigger entry in `manifest.json` SHALL have `name: "webhook.order"`, `type: "http"`, `path: "order"`, `method: "POST"` (default)
- **AND** SHALL NOT have an `event` field

#### Scenario: Trigger-owned event in events array

- **WHEN** a workflow defines `trigger("webhook.order", http({ path: "order", body: z.object({ orderId: z.string() }) }))`
- **THEN** the `events` array SHALL contain an entry with `name: "webhook.order"` and a `schema` field containing a JSON Schema with `type: "object"`, `properties` for `body`, `headers`, `url`, `method`, and `required: ["body", "headers", "url", "method"]`

#### Scenario: Action-owned event in events array

- **WHEN** a workflow defines `event("notify.message", z.object({ message: z.string() }))`
- **THEN** the `events` array SHALL contain an entry with `name: "notify.message"` and a `schema` field containing a JSON Schema with `type: "object"`, `properties` for `message`

#### Scenario: Event schemas as JSON Schema

- **WHEN** a workflow defines an event with `z.object({ id: z.string(), type: z.enum(["A", "B"]) })`
- **THEN** the event entry in `manifest.json` SHALL have a `schema` field containing a valid JSON Schema object with `type: "object"`, `properties`, and `required` fields

#### Scenario: Nullable field schema round-trip
- **WHEN** a workflow defines an event with `z.string().nullable()`
- **THEN** the JSON Schema representation SHALL use `anyOf: [{type: "string"}, {type: "null"}]`
- **AND** `z.fromJSONSchema()` on the result SHALL accept both `"value"` and `null`

#### Scenario: Action entry fields
- **WHEN** a workflow defines an action with `on: "event.a"`, `emits: ["event.b"]`, `env: { API_KEY: "resolved-value" }`
- **THEN** the action entry in `manifest.json` SHALL contain `name`, `module`, `on`, `emits`, and `env` fields
- **AND** `env` SHALL be a JSON object mapping string keys to string values
- **AND** `name` SHALL be the action identity (from export name or explicit override)
- **AND** `module` SHALL be the relative path to the action's source file under `actions/`

### Requirement: ManifestSchema validation

The SDK SHALL export a `ManifestSchema` Zod object for validating `manifest.json` files. The schema SHALL include a required `name` field of type `z.string()`. The `actions[].env` field in the schema SHALL be `z.record(z.string())`. The trigger schema SHALL NOT require an `event` field. The runtime SHALL parse every manifest through `ManifestSchema` at load time.

#### Scenario: Valid manifest passes validation
- **WHEN** a well-formed `manifest.json` with `name`, `env` as `Record<string, string>`, and triggers lacking the `event` field is parsed through `ManifestSchema`
- **THEN** parsing SHALL succeed and return the typed manifest object

#### Scenario: Manifest missing name field
- **WHEN** a `manifest.json` is missing the `name` field
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

#### Scenario: Malformed manifest rejected

- **WHEN** a `manifest.json` is missing the `events` field
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

#### Scenario: Action missing required fields

- **WHEN** a `manifest.json` contains an action entry without the `on` field
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

#### Scenario: Legacy array env format rejected
- **WHEN** a `manifest.json` contains an action with `env: ["API_KEY"]` (array format)
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

### Requirement: Manifest type exported from SDK

The SDK SHALL export a `Manifest` TypeScript type derived from `ManifestSchema` for consumers that need to work with manifest data.

#### Scenario: Manifest type matches schema
- **WHEN** a consumer imports `Manifest` from the SDK
- **THEN** the type SHALL match the shape validated by `ManifestSchema`
- **AND** `Manifest["actions"][number]["env"]` SHALL be `Record<string, string>`
