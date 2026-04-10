## ADDED Requirements

### Requirement: HTTP trigger payload shape

HTTP trigger events SHALL have a payload containing the full HTTP request context as a structured object with four fields: `body`, `headers`, `path`, and `method`.

- `body`: The JSON-parsed request body, validated against the trigger's body schema (or `z.unknown()` if no body schema is provided).
- `headers`: All HTTP request headers as `Record<string, string>`. Multi-value headers SHALL be joined with `, ` (per HTTP spec).
- `path`: The full request path including query string (e.g. `/webhooks/cronitor?source=api`).
- `method`: The HTTP method string (e.g. `"POST"`).

#### Scenario: HTTP trigger with body schema

- **GIVEN** a trigger defined as `trigger("webhook.order", http({ path: "order", body: z.object({ orderId: z.string() }) }))`
- **WHEN** a `POST /webhooks/order` request is received with body `{ "orderId": "abc" }` and header `x-signature: sha256=...`
- **THEN** the event payload SHALL be `{ body: { orderId: "abc" }, headers: { "x-signature": "sha256=...", ... }, path: "/webhooks/order", method: "POST" }`

#### Scenario: HTTP trigger without body schema

- **GIVEN** a trigger defined as `trigger("webhook.ping", http({ path: "ping", method: "GET" }))`
- **WHEN** a `GET /webhooks/ping?check=true` request is received with body `{}`
- **THEN** the event payload SHALL have `body` validated against `z.unknown()`, `path` as `"/webhooks/ping?check=true"`, and `method` as `"GET"`

#### Scenario: Headers include all request headers

- **GIVEN** a request with headers `Content-Type: application/json`, `Authorization: Bearer token`, `X-Custom: value`
- **WHEN** the HTTP trigger fires
- **THEN** the payload `headers` SHALL contain all three headers with their values

#### Scenario: Multi-value headers joined

- **GIVEN** a request with repeated header `X-Forwarded-For: 1.2.3.4` and `X-Forwarded-For: 5.6.7.8`
- **WHEN** the HTTP trigger fires
- **THEN** the payload `headers["x-forwarded-for"]` SHALL be `"1.2.3.4, 5.6.7.8"`

### Requirement: http() helper function

The SDK SHALL export an `http(config)` function that accepts trigger configuration and returns a `TriggerDef` object suitable for passing to `WorkflowBuilder.trigger()`.

The config SHALL accept:
- `path`: string (required) — webhook path relative to `/webhooks/`
- `method`: string (optional, default `"POST"`) — HTTP method to match
- `body`: `z.ZodType` (optional, default `z.unknown()`) — schema for the JSON request body
- `response`: object (optional) with `status` (number) and `body` (unknown) — static response

The returned `TriggerDef` SHALL carry a generated schema wrapping the body with `headers`, `path`, and `method` fields: `z.object({ body: <bodySchema>, headers: z.record(z.string(), z.string()), path: z.string(), method: z.string() })`.

#### Scenario: http() with body schema

- **WHEN** `http({ path: "order", body: z.object({ orderId: z.string() }) })` is called
- **THEN** the returned `TriggerDef` SHALL have a schema equivalent to `z.object({ body: z.object({ orderId: z.string() }), headers: z.record(z.string(), z.string()), path: z.string(), method: z.string() })`

#### Scenario: http() without body schema

- **WHEN** `http({ path: "ping", method: "GET" })` is called
- **THEN** the returned `TriggerDef` SHALL have a schema with `body: z.unknown()`, `headers: z.record(z.string(), z.string())`, `path: z.string()`, `method: z.string()`

#### Scenario: http() with response config

- **WHEN** `http({ path: "order", body: z.object({ orderId: z.string() }), response: { status: 202, body: { accepted: true } } })` is called
- **THEN** the returned `TriggerDef` SHALL carry the response config for the runtime

#### Scenario: http() preserves body schema type information

- **GIVEN** `const def = http({ path: "order", body: z.object({ orderId: z.string() }) })`
- **WHEN** the `TriggerDef` schema is inferred via `z.infer`
- **THEN** the inferred type SHALL be `{ body: { orderId: string }, headers: Record<string, string>, path: string, method: string }`

## MODIFIED Requirements

### Requirement: HttpTriggerDefinition is a pure data type

An `HttpTriggerDefinition` SHALL be a plain object with the following properties:
- `name`: string — the trigger's unique identifier, also used as the event name
- `type`: `'http'` — discriminant for trigger type
- `path`: string — the trigger path relative to `/webhooks/` (e.g., `"order"`)
- `method`: string (optional) — the HTTP method to match
- `response`: object (optional) with `status` (number, optional) and `body` (JSON-serializable value, optional) — the static response returned when the trigger fires

The `event` field is removed. The trigger name SHALL be used as the event name.

#### Scenario: Define an HTTP trigger with defaults

- **WHEN** creating an `HttpTriggerDefinition` with `name: "webhook.order"`, `type: 'http'`, path `"order"`
- **THEN** the definition is a plain object with `name: "webhook.order"`, `method` and `response` undefined
- **AND** there is no `event` field

#### Scenario: Trigger name is used as event name

- **GIVEN** an `HttpTriggerDefinition` with `name: "webhook.order"` and path `"order"`
- **WHEN** the trigger fires
- **THEN** the event type emitted SHALL be `"webhook.order"`

### Requirement: HttpTriggerRegistry resolves defaults on registration

The `HttpTriggerRegistry` SHALL resolve optional fields to defaults when registering a trigger definition, producing an `HttpTriggerResolved` object. Defaults: `method` -> `"POST"`, `response.status` -> `200`, `response.body` -> `""`. The `name` field SHALL be preserved as-is and used as the event name.

#### Scenario: Register trigger with defaults

- **WHEN** registering an `HttpTriggerDefinition` with only `name`, `path`, and `type`
- **THEN** `lookup()` returns an `HttpTriggerResolved` with `name` preserved, `method: "POST"`, and `response: { status: 200, body: "" }`

#### Scenario: Register trigger with explicit values

- **WHEN** registering an `HttpTriggerDefinition` with `name: "webhook.order"`, `method: "PUT"`, and `response: { status: 202, body: { ok: true } }`
- **THEN** `lookup()` returns an `HttpTriggerResolved` preserving the explicit values and `name: "webhook.order"`

### Requirement: httpTriggerMiddleware matches requests under /webhooks/

The `httpTriggerMiddleware` SHALL be a Hono middleware that intercepts requests under the `/webhooks/` path prefix, strips the prefix, looks up the remaining path and method in the registry, and either handles the request or returns 404.

The middleware SHALL always JSON-parse the request body. On parse failure, the middleware SHALL return a 422 response. The middleware SHALL construct a payload object with `body` (the parsed JSON), `headers` (all request headers as `Record<string, string>`), `path` (full request path including query string), and `method` (HTTP method string), then call `source.create(definition.name, payload, definition.name)` to create and emit the event using the trigger name as both event type and source name.

#### Scenario: Matching trigger request with full payload

- **WHEN** a `POST /webhooks/order?source=shopify` request is received with headers `Content-Type: application/json`, `X-Signature: abc123` and body `{ "orderId": "abc" }`
- **AND** a trigger with path `"order"` and method `"POST"` is registered with name `"webhook.order"`
- **THEN** the middleware SHALL parse the request body as JSON
- **AND** construct payload `{ body: { orderId: "abc" }, headers: { "content-type": "application/json", "x-signature": "abc123", ... }, path: "/webhooks/order?source=shopify", method: "POST" }`
- **AND** call `source.create("webhook.order", payload, "webhook.order")`
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
- **THEN** the middleware SHALL return a `422` response

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

### Requirement: Native implementation

Triggers SHALL be implemented as part of the platform runtime, not as user-provided sandboxed code.

#### Scenario: Trigger binds server port

- **GIVEN** the runtime starts with an HTTP trigger configured
- **WHEN** the runtime initializes
- **THEN** it binds the configured HTTP server port
- **AND** registers routes for all configured HTTP triggers
