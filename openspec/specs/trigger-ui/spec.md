# Trigger UI Specification

## Purpose

Provide a web UI at `/trigger` for manually triggering workflow events via auto-generated forms derived from Zod event schemas.

## Requirements

### Requirement: Trigger middleware factory
The system SHALL provide a `triggerMiddleware` factory function that accepts a JSON Schema map (`Record<string, object>`) and an `EventSource`, and returns a standard `Middleware` object (`{ match, handler }`).

#### Scenario: Middleware creation
- **WHEN** `triggerMiddleware(allJsonSchemas, source)` is called
- **THEN** a `Middleware` is returned with `match` set to `"/trigger/*"`

#### Scenario: Middleware integrates with existing server
- **WHEN** the trigger middleware is passed to `createServer` alongside other middleware
- **THEN** `/trigger/*` routes are served from the same Hono server

### Requirement: Event list page
The system SHALL serve an HTML page at `GET /trigger/` listing all defined workflow events by name, rendered with authenticated user identity.

#### Scenario: Page lists all events with user identity
- **WHEN** a browser requests `GET /trigger/` with `X-Auth-Request-User: stefan` and `X-Auth-Request-Email: stefan@example.com` headers
- **THEN** the response is an HTML document rendered via the shared layout with user and email
- **THEN** each event from the JSON Schema map is listed as a `<details>` element with the event name as the `<summary>`

#### Scenario: JSON Schema embedded per event
- **WHEN** the page is rendered
- **THEN** each `<details>` block contains a `<script type="application/json">` element with the event's JSON Schema
- **THEN** the schema has been processed by `prepareSchema` which promotes `example` values to `default` and labels `anyOf` variants with type titles

### Requirement: Lazy form initialization
The system SHALL provide a global `initForm` function in the external JavaScript file (`/static/trigger-forms.js`) that initializes a Jedison form instance when a `<details>` block is first expanded.

#### Scenario: First expansion creates form
- **WHEN** a `<details>` block is opened for the first time
- **THEN** the embedded JSON Schema is read from the `<script>` element
- **THEN** a Jedison instance is created targeting the form container inside that `<details>` block
- **THEN** the Jedison instance is cached on the DOM element

#### Scenario: Subsequent toggles reuse instance
- **WHEN** a `<details>` block is collapsed and re-opened
- **THEN** no new Jedison instance is created
- **THEN** the previously entered form data is preserved

### Requirement: Event submission
The system SHALL accept `POST /trigger/:eventType` with a JSON body and emit the event via `EventSource.create()`.

#### Scenario: Successful submission
- **WHEN** a POST request is sent to `/trigger/webhook.cronitor` with a valid JSON payload
- **THEN** `source.create("webhook.cronitor", payload, "trigger-ui")` is called
- **THEN** the response is an HTML fragment containing a success banner

#### Scenario: Validation failure
- **WHEN** a POST request is sent with a payload that fails Zod schema validation
- **THEN** the `PayloadValidationError` is caught
- **THEN** the response is an HTML fragment containing an error banner with field-level validation messages

#### Scenario: Unknown event type
- **WHEN** a POST request is sent to `/trigger/nonexistent.event`
- **THEN** `source.create()` throws a `PayloadValidationError` (no schema found)
- **THEN** the response is an HTML fragment containing an error banner

### Requirement: Form submission via fetch
The system SHALL provide a global `submitEvent` function in an external JavaScript file (`/static/trigger-forms.js`) that reads the Jedison form value and submits it via `fetch()`.

#### Scenario: Submit button triggers fetch call
- **WHEN** the user clicks the submit button for an event
- **THEN** `jedison.getValue()` is called on the cached instance
- **THEN** `fetch('POST', '/trigger/:eventType', ...)` is called with the JSON body
- **THEN** the response HTML fragment is swapped into the banner target area inside the `<details>` block

### Requirement: Jedison styling
The system SHALL use Jedison's base theme with custom CSS that uses the shared layout's CSS variables for consistent light/dark mode theming.

#### Scenario: Form elements styled with CSS variables
- **WHEN** the Jedison form is rendered
- **THEN** `input`, `select`, and `textarea` elements use `var(--bg-elevated)` for background and `var(--border)` for borders
- **THEN** `label` elements use `var(--text-secondary)` for color

#### Scenario: Dark mode support
- **WHEN** the user's system preference is dark mode
- **THEN** form elements automatically use the dark mode CSS variable values

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
