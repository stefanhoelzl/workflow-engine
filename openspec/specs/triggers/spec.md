# Triggers Specification

## Purpose

Receive external stimuli and convert them into typed events in the queue. Triggers are built into the platform runtime and are not user-extensible in v1.

## Requirements

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

### Requirement: HttpTriggerRegistry supports registration and lookup

The `HttpTriggerRegistry` SHALL allow registering `HttpTriggerDefinition` objects and looking them up by path and method.

The registry SHALL expose:
- `register(definition)` — stores a trigger definition
- `lookup(path, method)` — returns the matching definition or `null`

#### Scenario: Register and look up a trigger
- **WHEN** a trigger with path `"order"` and method `"POST"` is registered
- **THEN** `lookup("order", "POST")` SHALL return that trigger definition

#### Scenario: Lookup with no matching trigger
- **WHEN** no trigger is registered for path `"payment"` and method `"POST"`
- **THEN** `lookup("payment", "POST")` SHALL return `null`

#### Scenario: Lookup with wrong method
- **WHEN** a trigger is registered with path `"order"` and method `"POST"`
- **THEN** `lookup("order", "GET")` SHALL return `null`

### Requirement: httpTriggerMiddleware matches requests under /webhooks/

The `httpTriggerMiddleware` SHALL be a Hono middleware that intercepts requests under the `/webhooks/` path prefix, strips the prefix, looks up the remaining path and method in the registry, and either handles the request or returns 404.

The middleware factory SHALL accept a registry and an `EventSource`. It SHALL call `source.create(definition.event, body)` directly to create and emit the event. There SHALL be no intermediate context object.

#### Scenario: Matching trigger request

- **WHEN** a `POST /webhooks/order` request is received
- **AND** a trigger with path `"order"` and method `"POST"` is registered
- **THEN** the middleware SHALL parse the request body as JSON
- **AND** call `source.create(definition.event, body)` to create and emit the event
- **AND** return the trigger's configured static response

#### Scenario: Payload validation error

- **WHEN** a `POST /webhooks/order` request is received with a body that fails schema validation
- **AND** a trigger with path `"order"` is registered
- **THEN** the middleware SHALL catch the `PayloadValidationError` from `source.create()`
- **AND** return a 422 response with error details

#### Scenario: No matching trigger

- **WHEN** a `POST /webhooks/unknown` request is received
- **AND** no trigger is registered for path `"unknown"` and method `"POST"`
- **THEN** the middleware SHALL return a `404` response

#### Scenario: Non-JSON request body

- **WHEN** a `POST /webhooks/order` request is received with a non-JSON body
- **AND** a trigger with path `"order"` and method `"POST"` is registered
- **THEN** the middleware SHALL return a `400` response

### Requirement: Native implementation

Triggers SHALL be implemented as part of the platform runtime, not as user-provided sandboxed code.

#### Scenario: Trigger binds server port

- GIVEN the runtime starts with an HTTP trigger configured
- WHEN the runtime initializes
- THEN it binds the configured HTTP server port
- AND registers routes for all configured HTTP triggers
