## MODIFIED Requirements

### Requirement: HttpTriggerDefinition is a pure data type

An `HttpTriggerDefinition` SHALL be a plain object with the following properties:
- `type`: `'http'` — discriminant for trigger type
- `path`: string — the trigger path relative to `/webhooks/` (e.g., `"order"`)
- `method`: string (optional) — the HTTP method to match
- `event`: string — the event type the trigger produces (e.g., `"order.received"`)
- `response`: object (optional) with `status` (number, optional) and `body` (JSON-serializable value, optional) — the static response returned when the trigger fires

#### Scenario: Define an HTTP trigger with defaults

- **WHEN** creating an `HttpTriggerDefinition` with `type: 'http'`, path `"order"`, and event `"order.received"`
- **THEN** the definition is a plain object with `method` and `response` undefined

#### Scenario: Trigger definition declares its event type

- **GIVEN** an `HttpTriggerDefinition` with path `"order"` and event `"order.received"`
- **THEN** the definition's `event` field is `"order.received"`

#### Scenario: HTTP trigger with explicit method

- **WHEN** creating an `HttpTriggerDefinition` with `type: 'http'`, path `"order"`, method `"PUT"`, and event `"order.received"`
- **THEN** the definition's `method` field is `"PUT"`

### Requirement: HttpTriggerRegistry resolves defaults on registration

The `HttpTriggerRegistry` SHALL resolve optional fields to defaults when registering a trigger definition, producing an `HttpTriggerResolved` object. Defaults: `method` → `"POST"`, `response.status` → `200`, `response.body` → `""`.

#### Scenario: Register trigger with defaults

- **WHEN** registering an `HttpTriggerDefinition` with only `path`, `event`, and `type`
- **THEN** `lookup()` returns an `HttpTriggerResolved` with `method: "POST"` and `response: { status: 200, body: "" }`

#### Scenario: Register trigger with explicit values

- **WHEN** registering an `HttpTriggerDefinition` with `method: "PUT"` and `response: { status: 202, body: { ok: true } }`
- **THEN** `lookup()` returns an `HttpTriggerResolved` preserving the explicit values
