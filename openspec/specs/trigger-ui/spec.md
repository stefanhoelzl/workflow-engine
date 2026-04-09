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
The system SHALL serve an HTML page at `GET /trigger/` listing all defined workflow events by name.

#### Scenario: Page lists all events
- **WHEN** a browser requests `GET /trigger/`
- **THEN** the response is an HTML document rendered via the shared layout
- **THEN** each event from the JSON Schema map is listed as a `<details>` element with the event name as the `<summary>`

#### Scenario: JSON Schema embedded per event
- **WHEN** the page is rendered
- **THEN** each `<details>` block contains a `<script type="application/json">` element with the event's JSON Schema

### Requirement: Lazy form initialization
The system SHALL initialize a Jedison form instance only when the user first expands an event's `<details>` block.

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
The system SHALL provide a global `submitEvent` function that reads the Jedison form value and submits it via `fetch()`.

#### Scenario: Submit button triggers fetch call
- **WHEN** the user clicks the submit button for an event
- **THEN** `jedison.getValue()` is called on the cached instance
- **THEN** `fetch('POST', '/trigger/:eventType', ...)` is called with the JSON body
- **THEN** the response HTML fragment is swapped into the banner target area inside the `<details>` block

### Requirement: Jedison static asset route
The system SHALL serve the Jedison library at `GET /trigger/jedison.js` vendored from `node_modules`.

#### Scenario: Jedison JS served
- **WHEN** a browser requests `GET /trigger/jedison.js`
- **THEN** the response has `Content-Type: application/javascript`
- **THEN** the response has `Cache-Control: public, max-age=31536000, immutable`
- **THEN** the response body is the contents of the `jedison` npm package dist file

### Requirement: Jedison styling
The system SHALL use Jedison's base theme with custom CSS that uses the shared layout's CSS variables for consistent light/dark mode theming.

#### Scenario: Form elements styled with CSS variables
- **WHEN** the Jedison form is rendered
- **THEN** `input`, `select`, and `textarea` elements use `var(--bg-elevated)` for background and `var(--border)` for borders
- **THEN** `label` elements use `var(--text-secondary)` for color

#### Scenario: Dark mode support
- **WHEN** the user's system preference is dark mode
- **THEN** form elements automatically use the dark mode CSS variable values
