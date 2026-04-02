## ADDED Requirements

### Requirement: HttpTriggerDefinition is a pure data type

An `HttpTriggerDefinition` SHALL be a plain object with the following properties:
- `path`: string — the trigger path relative to `/webhooks/` (e.g., `"order"`)
- `method`: string — the HTTP method to match (e.g., `"POST"`)
- `response`: object with `status` (number) and `body` (JSON-serializable value) — the static response returned when the trigger fires

#### Scenario: Define an HTTP trigger
- **WHEN** creating an `HttpTriggerDefinition` with path `"order"`, method `"POST"`, and response `{ status: 202, body: { accepted: true } }`
- **THEN** the definition is a plain object with no behavior or framework dependencies

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

The `httpTriggerMiddleware` SHALL be a Hono middleware that intercepts requests under the `/webhooks/` path prefix, strips the prefix, looks up the remaining path and method in the registry, and either handles the request or passes through.

The middleware factory SHALL accept a registry and a callback function.

#### Scenario: Matching trigger request
- **WHEN** a `POST /webhooks/order` request is received
- **AND** a trigger with path `"order"` and method `"POST"` is registered
- **THEN** the middleware SHALL parse the request body as JSON
- **AND** invoke the callback with the trigger definition and parsed body
- **AND** return the trigger's configured static response

#### Scenario: No matching trigger
- **WHEN** a `POST /webhooks/unknown` request is received
- **AND** no trigger is registered for path `"unknown"` and method `"POST"`
- **THEN** the middleware SHALL call `next()` to pass through to subsequent handlers

#### Scenario: Request outside /webhooks/ prefix
- **WHEN** a request to `/api/health` is received
- **THEN** the middleware SHALL call `next()` without consulting the registry

#### Scenario: Non-JSON request body
- **WHEN** a `POST /webhooks/order` request is received with a non-JSON body
- **AND** a trigger with path `"order"` and method `"POST"` is registered
- **THEN** the middleware SHALL return a `400` response
