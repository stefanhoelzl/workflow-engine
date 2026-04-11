## MODIFIED Requirements

### Requirement: Manifest JSON format

The build output for each workflow SHALL include a `manifest.json` file containing serializable metadata: name, events (with JSON Schema), triggers, and actions. The manifest SHALL NOT contain executable code or function references.

The manifest SHALL include a required `name` field containing the workflow name as specified in `createWorkflow("name")`.

Trigger entries SHALL NOT have an `event` field. The trigger `name` SHALL be used to resolve the corresponding event from the `events` array. Trigger-owned events SHALL appear in the `events` array with their full schema (including the HTTP payload wrapper fields `body`, `headers`, `url`, `method`, and `params`).

Each trigger entry SHALL include a `params` field containing an array of param names extracted from the path string. Static paths SHALL have `params: []`.

Each action entry SHALL have a `module` field pointing to its source file under the `actions/` subdirectory (e.g., `"actions/handleCronitorEvent.js"`). There SHALL be no shared `module` field at the manifest root.

#### Scenario: Manifest contains name and all workflow metadata

- **WHEN** a workflow named "cronitor" defines 1 trigger, 1 action event, and 2 actions
- **THEN** `manifest.json` SHALL contain a `name` field with value `"cronitor"`, an `events` array with 2 entries, a `triggers` array with 1 entry (without an `event` field), and an `actions` array with 2 entries
- **AND** each action entry SHALL have its own `module` field

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

#### Scenario: Per-action module paths under actions directory

- **WHEN** a workflow defines actions `handleCronitorEvent` and `sendMessage`
- **THEN** the manifest SHALL contain action entries with `module: "actions/handleCronitorEvent.js"` and `module: "actions/sendMessage.js"` respectively
- **AND** there SHALL be no root-level `module` field

#### Scenario: Action-owned event in events array

- **WHEN** a workflow defines `event("notify.message", z.object({ message: z.string() }))`
- **THEN** the `events` array SHALL contain an entry with `name: "notify.message"` and a `schema` field containing a JSON Schema with `type: "object"`, `properties` for `message`

### Requirement: ManifestSchema validation

The SDK SHALL export a `ManifestSchema` Zod object for validating `manifest.json` files. The schema SHALL include a required `name` field of type `z.string()`. The `actions[].env` field in the schema SHALL be `z.record(z.string())`. The trigger schema SHALL NOT require an `event` field. The trigger schema SHALL include a `params` field of type `z.array(z.string())`. The runtime SHALL parse every manifest through `ManifestSchema` at load time.

#### Scenario: Valid manifest with params passes validation

- **WHEN** a well-formed `manifest.json` with `name`, `env` as `Record<string, string>`, triggers with `params` arrays, and triggers lacking the `event` field is parsed through `ManifestSchema`
- **THEN** parsing SHALL succeed and return the typed manifest object

#### Scenario: Manifest missing name field

- **WHEN** a `manifest.json` is missing the `name` field
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

#### Scenario: Malformed manifest rejected

- **WHEN** a `manifest.json` is missing the `events` field
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

#### Scenario: Trigger missing params field rejected

- **WHEN** a `manifest.json` contains a trigger entry without the `params` field
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

#### Scenario: Action missing required fields

- **WHEN** a `manifest.json` contains an action entry without the `on` field
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error

#### Scenario: Legacy array env format rejected

- **WHEN** a `manifest.json` contains an action with `env: ["API_KEY"]` (array format)
- **THEN** parsing through `ManifestSchema` SHALL throw a validation error
