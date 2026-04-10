## MODIFIED Requirements

### Requirement: Manifest JSON format

The build output for each workflow SHALL include a `manifest.json` file containing serializable metadata: events (with JSON Schema), triggers, and actions. The manifest SHALL NOT contain executable code or function references.

Trigger entries SHALL NOT have an `event` field. The trigger `name` SHALL be used to resolve the corresponding event from the `events` array. Trigger-owned events SHALL appear in the `events` array with their full schema (including the HTTP payload wrapper fields `body`, `headers`, `path`, `method`).

#### Scenario: Manifest contains all workflow metadata

- **WHEN** a workflow defines 1 trigger, 1 action event, and 2 actions
- **THEN** `manifest.json` SHALL contain an `events` array with 2 entries (the trigger-owned event with HTTP payload schema and the action-owned event with plain schema), a `triggers` array with 1 entry (without an `event` field), and an `actions` array with 2 entries

#### Scenario: Trigger entry has no event field

- **WHEN** a workflow defines `trigger("webhook.order", http({ path: "order", body: z.object({ orderId: z.string() }) }))`
- **THEN** the trigger entry in `manifest.json` SHALL have `name: "webhook.order"`, `type: "http"`, `path: "order"`, `method: "POST"` (default)
- **AND** SHALL NOT have an `event` field

#### Scenario: Trigger-owned event in events array

- **WHEN** a workflow defines `trigger("webhook.order", http({ path: "order", body: z.object({ orderId: z.string() }) }))`
- **THEN** the `events` array SHALL contain an entry with `name: "webhook.order"` and a `schema` field containing a JSON Schema with `type: "object"`, `properties` for `body`, `headers`, `path`, `method`, and `required: ["body", "headers", "path", "method"]`

#### Scenario: Action-owned event in events array

- **WHEN** a workflow defines `event("notify.message", z.object({ message: z.string() }))`
- **THEN** the `events` array SHALL contain an entry with `name: "notify.message"` and a `schema` field containing a JSON Schema with `type: "object"`, `properties` for `message`

#### Scenario: Event schemas as JSON Schema

- **WHEN** a workflow defines an event with `z.object({ id: z.string(), type: z.enum(["A", "B"]) })`
- **THEN** the event entry in `manifest.json` SHALL have a `schema` field containing a valid JSON Schema object with `type: "object"`, `properties`, and `required` fields

### Requirement: ManifestSchema validation

The SDK SHALL export a `ManifestSchema` Zod object for validating `manifest.json` files. The runtime SHALL parse every manifest through `ManifestSchema` at load time. The trigger schema SHALL NOT require an `event` field.

#### Scenario: Valid manifest passes validation

- **WHEN** a well-formed `manifest.json` (with triggers lacking the `event` field) is parsed through `ManifestSchema`
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
