## MODIFIED Requirements

### Requirement: HttpTriggerDefinition is a pure data type

An `HttpTriggerDefinition` SHALL be a plain object with the following properties:
- `name`: string — the trigger's unique identifier
- `type`: `'http'` — discriminant for trigger type
- `path`: string — the trigger path relative to `/webhooks/` (e.g., `"order"`)
- `method`: string (optional) — the HTTP method to match
- `event`: string — the event type the trigger produces (e.g., `"order.received"`)
- `response`: object (optional) with `status` (number, optional) and `body` (JSON-serializable value, optional) — the static response returned when the trigger fires

#### Scenario: Define an HTTP trigger with defaults

- **WHEN** creating an `HttpTriggerDefinition` with `name: "orders"`, `type: 'http'`, path `"order"`, and event `"order.received"`
- **THEN** the definition is a plain object with `name: "orders"`, `method` and `response` undefined

#### Scenario: Trigger definition declares its event type

- **GIVEN** an `HttpTriggerDefinition` with `name: "orders"`, path `"order"`, and event `"order.received"`
- **THEN** the definition's `event` field is `"order.received"`

#### Scenario: HTTP trigger with explicit method

- **WHEN** creating an `HttpTriggerDefinition` with `name: "orders"`, `type: 'http'`, path `"order"`, method `"PUT"`, and event `"order.received"`
- **THEN** the definition's `method` field is `"PUT"`

### Requirement: HttpTriggerRegistry resolves defaults on registration

The `HttpTriggerRegistry` SHALL resolve optional fields to defaults when registering a trigger definition, producing an `HttpTriggerResolved` object. Defaults: `method` → `"POST"`, `response.status` → `200`, `response.body` → `""`. The `name` field SHALL be preserved as-is.

#### Scenario: Register trigger with defaults

- **WHEN** registering an `HttpTriggerDefinition` with only `name`, `path`, `event`, and `type`
- **THEN** `lookup()` returns an `HttpTriggerResolved` with `name` preserved, `method: "POST"`, and `response: { status: 200, body: "" }`

#### Scenario: Register trigger with explicit values

- **WHEN** registering an `HttpTriggerDefinition` with `name: "orders"`, `method: "PUT"`, and `response: { status: 202, body: { ok: true } }`
- **THEN** `lookup()` returns an `HttpTriggerResolved` preserving the explicit values and `name: "orders"`
