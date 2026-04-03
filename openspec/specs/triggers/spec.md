# Triggers Specification

## Purpose

Receive external stimuli and convert them into typed events in the queue. Triggers are built into the platform runtime and are not user-extensible in v1.

## Requirements

### Requirement: HttpTriggerDefinition is a pure data type

An `HttpTriggerDefinition` SHALL be a plain object with the following properties:
- `path`: string — the trigger path relative to `/webhooks/` (e.g., `"order"`)
- `method`: string — the HTTP method to match (e.g., `"POST"`)
- `event`: string — the event type the trigger produces (e.g., `"order.received"`)
- `response`: object with `status` (number) and `body` (JSON-serializable value) — the static response returned when the trigger fires

#### Scenario: Define an HTTP trigger
- **WHEN** creating an `HttpTriggerDefinition` with path `"order"`, method `"POST"`, event `"order.received"`, and response `{ status: 202, body: { accepted: true } }`
- **THEN** the definition is a plain object with no behavior or framework dependencies

#### Scenario: Trigger definition declares its event type
- **GIVEN** an `HttpTriggerDefinition` with path `"order"`, method `"POST"`, and event `"order.received"`
- **THEN** the definition's `event` field is `"order.received"`

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

The middleware factory SHALL accept a registry and a context factory function `(body, definition) => HttpTriggerContext`.

#### Scenario: Matching trigger request

- **WHEN** a `POST /webhooks/order` request is received
- **AND** a trigger with path `"order"` and method `"POST"` is registered
- **THEN** the middleware SHALL parse the request body as JSON
- **AND** call the context factory function with the parsed body and trigger definition
- **AND** call `ctx.emit(definition.event, body)` to create and enqueue the event
- **AND** return the trigger's configured static response

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
