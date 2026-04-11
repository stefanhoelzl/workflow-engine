### Requirement: Manifest JSON format

The build output for each workflow SHALL include a `manifest.json` file containing serializable metadata: name, module, events (with JSON Schema), triggers, and actions. The manifest SHALL NOT contain executable code or function references.

The manifest SHALL include a required `name` field containing the workflow name as specified in `createWorkflow("name")`.

The manifest SHALL include a required `module` field at the top level containing the relative path to the workflow's action module (e.g., `"actions.js"`). There SHALL be no `module` field on individual action entries.

Each action entry SHALL have an `export` field containing the name of the JavaScript export in the module that corresponds to this action's handler function.

Trigger entries SHALL NOT have an `event` field. The trigger `name` SHALL be used to resolve the corresponding event from the `events` array. Trigger-owned events SHALL appear in the `events` array with their full schema (including the HTTP payload wrapper fields `body`, `headers`, `url`, `method`, and `params`).

Each trigger entry SHALL include a `params` field containing an array of param names extracted from the path string. Static paths SHALL have `params: []`.

#### Scenario: Manifest contains name, module, and all workflow metadata

- **WHEN** a workflow named "cronitor" defines 1 trigger, 1 action event, and 2 actions
- **THEN** `manifest.json` SHALL contain a `name` field with value `"cronitor"`, a `module` field with value `"actions.js"`, an `events` array with 2 entries, a `triggers` array with 1 entry (without an `event` field), and an `actions` array with 2 entries
- **AND** each action entry SHALL have an `export` field but no `module` field

#### Scenario: Static trigger entry includes empty params

- **WHEN** a workflow defines `trigger("webhook.order", http({ path: "order", body: z.object({ orderId: z.string() }) }))`
- **THEN** the trigger entry in `manifest.json` SHALL have `name: "webhook.order"`, `type: "http"`, `path: "order"`, `method: "POST"` (default), and `params: []`
- **AND** SHALL NOT have an `event` field

#### Scenario: Parameterized trigger entry includes param names

- **WHEN** a workflow defines `trigger("webhook.user.status", http({ path: "users/:userId/status" }))`
- **THEN** the trigger entry in `manifest.json` SHALL have `path: "users/:userId/status"` and `params: ["userId"]`

#### Scenario: Wildcard trigger entry includes wildcard name

- **WHEN** a workflow defines `trigger("webhook.files", http({ path: "files/*rest" }))`
- **THEN** the trigger entry in `manifest.json` SHALL have `path: "files/*rest"` and `params: ["rest"]`

#### Scenario: Trigger-owned event includes params in schema

- **WHEN** a workflow defines `trigger("webhook.user.status", http({ path: "users/:userId/status", body: z.object({ active: z.boolean() }) }))`
- **THEN** the `events` array SHALL contain an entry with `name: "webhook.user.status"` and a `schema` field containing a JSON Schema with `type: "object"`, `properties` for `body`, `headers`, `url`, `method`, and `params`, and `required: ["body", "headers", "url", "method", "params"]`

#### Scenario: Top-level module with per-action export fields

- **WHEN** a workflow defines actions `handleCronitorEvent` and `sendMessage`
- **THEN** the manifest SHALL contain `module: "actions.js"` at the top level
- **AND** action entries SHALL have `export: "handleCronitorEvent"` and `export: "sendMessage"` respectively
- **AND** action entries SHALL NOT have a `module` field

#### Scenario: Action-owned event in events array

- **WHEN** a workflow defines `event("notify.message", z.object({ message: z.string() }))`
- **THEN** the `events` array SHALL contain an entry with `name: "notify.message"` and a `schema` field containing a JSON Schema with `type: "object"`, `properties` for `message`

#### Scenario: Action entry fields

- **WHEN** a workflow defines an action with `on: "event.a"`, `emits: ["event.b"]`, `env: { API_KEY: "resolved-value" }`
- **THEN** the action entry in `manifest.json` SHALL contain `name`, `export`, `on`, `emits`, and `env` fields
- **AND** `env` SHALL be a JSON object mapping string keys to string values
- **AND** `name` SHALL be the action identity (from export name or explicit override)
- **AND** `export` SHALL be the JavaScript export name in the module

### Requirement: ManifestSchema validation

The SDK SHALL export a `ManifestSchema` Zod object for validating `manifest.json` files. The schema SHALL include a required `name` field of type `z.string()` and a required `module` field of type `z.string()` at the top level. The action schema SHALL include a required `export` field of type `z.string()` and SHALL NOT include a `module` field. The `actions[].env` field in the schema SHALL be `z.record(z.string())`. The trigger schema SHALL NOT require an `event` field. The trigger schema SHALL include a `params` field of type `z.array(z.string())`. The runtime SHALL parse every manifest through `ManifestSchema` at load time.

#### Scenario: Valid manifest with params passes validation

- **WHEN** a well-formed `manifest.json` with `name`, `module`, actions with `export` fields, `env` as `Record<string, string>`, triggers with `params` arrays, and triggers lacking the `event` field is parsed through `ManifestSchema`
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

#### Scenario: Trigger missing params field rejected

- **WHEN** a `manifest.json` contains a trigger entry without the `params` field
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
