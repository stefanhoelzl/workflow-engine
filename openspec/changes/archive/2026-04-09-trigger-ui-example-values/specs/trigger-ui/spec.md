## ADDED Requirements

### Requirement: Example values on schema fields
Workflow authors SHALL be able to attach example values to Zod event schema fields using `.meta({ example: <value> })`. These values are for UI pre-filling only and SHALL NOT affect server-side validation behavior.

#### Scenario: Example on a string field
- **WHEN** an event schema defines `z.string().meta({ example: "ORD-12345" })`
- **THEN** `z.toJSONSchema()` produces `{ "type": "string", "example": "ORD-12345" }`

#### Scenario: Example on a number field
- **WHEN** an event schema defines `z.number().meta({ example: 42.99 })`
- **THEN** `z.toJSONSchema()` produces `{ "type": "number", "example": 42.99 }`

#### Scenario: Example does not create a schema default
- **WHEN** an event schema defines `z.string().meta({ example: "ORD-12345" })`
- **THEN** parsing an empty object with the schema SHALL fail validation
- **THEN** the field remains required

### Requirement: Example-to-default promotion in schema preparation
The `prepareSchema` function SHALL recursively walk the JSON Schema and copy `example` values into `default` for fields that do not already have a `default`.

#### Scenario: Field with example and no default
- **WHEN** a JSON Schema field has `"example": "ORD-12345"` and no `"default"` key
- **THEN** `prepareSchema` SHALL set `"default": "ORD-12345"` on that field

#### Scenario: Field with both example and default
- **WHEN** a JSON Schema field has `"example": "ORD-12345"` and `"default": "REAL-DEFAULT"`
- **THEN** `prepareSchema` SHALL preserve `"default": "REAL-DEFAULT"` unchanged

#### Scenario: Field with no example
- **WHEN** a JSON Schema field has no `"example"` key
- **THEN** `prepareSchema` SHALL not add a `"default"` key

#### Scenario: Nested object properties
- **WHEN** a JSON Schema has nested `"properties"` containing fields with `"example"` values
- **THEN** `prepareSchema` SHALL recurse into nested properties and promote examples at all depths

### Requirement: Pre-filled form rendering
Jedison forms SHALL render with example values pre-filled in form inputs via the promoted `default` values in the JSON Schema.

#### Scenario: Form loads with pre-filled values
- **WHEN** a user expands an event's `<details>` block
- **THEN** form inputs for fields with examples SHALL display the example values
- **THEN** the user can edit or submit the pre-filled values

#### Scenario: Submission with pre-filled values succeeds
- **WHEN** a user submits the form without modifying the pre-filled example values
- **THEN** the server SHALL validate and accept the payload (examples are valid values)

## MODIFIED Requirements

### Requirement: JSON Schema embedded per event
- **WHEN** the page is rendered
- **THEN** each `<details>` block contains a `<script type="application/json">` element with the event's JSON Schema processed through `prepareSchema` (nullable simplification and example-to-default promotion)

#### Scenario: JSON Schema embedded per event
- **WHEN** the page is rendered
- **THEN** each `<details>` block contains a `<script type="application/json">` element with the event's JSON Schema
- **THEN** the schema has been processed by `prepareSchema` which simplifies nullable unions and promotes `example` values to `default`
