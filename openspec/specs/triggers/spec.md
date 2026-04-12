# Triggers Specification

## Purpose

Receive external stimuli and convert them into typed events in the queue. Triggers are built into the platform runtime and are not user-extensible in v1.

## Requirements

### Requirement: HTTP trigger payload shape

HTTP trigger events SHALL have a payload containing the full HTTP request context as a structured object with five fields: `body`, `headers`, `url`, `method`, and `params`.

- `body`: The JSON-parsed request body, validated against the trigger's body schema (or `z.unknown()` if no body schema is provided).
- `headers`: All HTTP request headers as `Record<string, string>`. Multi-value headers SHALL be joined with `, ` (per HTTP spec).
- `url`: The full request path including query string (e.g. `/webhooks/cronitor?source=api`).
- `method`: The HTTP method string (e.g. `"POST"`).
- `params`: Path parameters extracted from the URL as `Record<string, string>`. Empty `{}` for static paths.

#### Scenario: HTTP trigger with body schema and static path

- **GIVEN** a trigger defined as `trigger("webhook.order", http({ path: "order", body: z.object({ orderId: z.string() }) }))`
- **WHEN** a `POST /webhooks/order` request is received with body `{ "orderId": "abc" }` and header `x-signature: sha256=...`
- **THEN** the event payload SHALL be `{ body: { orderId: "abc" }, headers: { "x-signature": "sha256=...", ... }, url: "/webhooks/order", method: "POST", params: {} }`

#### Scenario: HTTP trigger with path parameters

- **GIVEN** a trigger defined as `trigger("webhook.user.status", http({ path: "users/:userId/status", body: z.object({ active: z.boolean() }) }))`
- **WHEN** a `POST /webhooks/users/abc123/status` request is received with body `{ "active": true }`
- **THEN** the event payload SHALL be `{ body: { active: true }, headers: { ... }, url: "/webhooks/users/abc123/status", method: "POST", params: { userId: "abc123" } }`

#### Scenario: HTTP trigger without body schema

- **GIVEN** a trigger defined as `trigger("webhook.ping", http({ path: "ping", method: "GET" }))`
- **WHEN** a `GET /webhooks/ping?check=true` request is received with body `{}`
- **THEN** the event payload SHALL have `body` validated against `z.unknown()`, `url` as `"/webhooks/ping?check=true"`, `method` as `"GET"`, and `params: {}`

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
- `path`: string (required) — webhook path relative to `/webhooks/`, supports `:param` named segments and `*wildcard` catch-all segments
- `method`: string (optional, default `"POST"`) — HTTP method to match
- `body`: `z.ZodType` (optional, default `z.unknown()`) — schema for the JSON request body
- `params`: `z.ZodObject` (optional) — schema for path parameters; keys must match param names in path
- `response`: object (optional) with `status` (number) and `body` (unknown) — static response

The returned `TriggerDef` SHALL carry a generated schema wrapping the body with `headers`, `url`, `method`, and `params` fields: `z.object({ body: <bodySchema>, headers: z.record(z.string(), z.string()), url: z.string(), method: z.string(), params: <paramsSchema> })`.

When no `params` schema is provided, the params field in the generated schema SHALL be a `z.object()` with keys inferred from the path (each typed as `z.string()`), or `z.record(z.string(), z.string())` if the path is a non-literal string.

#### Scenario: http() with body schema and static path

- **WHEN** `http({ path: "order", body: z.object({ orderId: z.string() }) })` is called
- **THEN** the returned `TriggerDef` SHALL have a schema equivalent to `z.object({ body: z.object({ orderId: z.string() }), headers: z.record(z.string(), z.string()), url: z.string(), method: z.string(), params: z.object({}) })`

#### Scenario: http() with parameterized path

- **WHEN** `http({ path: "users/:userId/status" })` is called
- **THEN** the returned `TriggerDef` SHALL have a schema with `params` typed as `{ userId: string }` via inference

#### Scenario: http() with explicit params schema

- **WHEN** `http({ path: "users/:userId", params: z.object({ userId: z.string().uuid() }) })` is called
- **THEN** the returned `TriggerDef` SHALL use the provided params schema for validation
- **AND** the inferred params type SHALL be `{ userId: string }`

#### Scenario: http() without body schema

- **WHEN** `http({ path: "ping", method: "GET" })` is called
- **THEN** the returned `TriggerDef` SHALL have a schema with `body: z.unknown()`, `headers: z.record(z.string(), z.string())`, `url: z.string()`, `method: z.string()`, `params: z.object({})`

#### Scenario: http() with response config

- **WHEN** `http({ path: "order", body: z.object({ orderId: z.string() }), response: { status: 202, body: { accepted: true } } })` is called
- **THEN** the returned `TriggerDef` SHALL carry the response config for the runtime

#### Scenario: http() preserves body and params type information

- **GIVEN** `const def = http({ path: "users/:userId", body: z.object({ orderId: z.string() }) })`
- **WHEN** the `TriggerDef` schema is inferred via `z.infer`
- **THEN** the inferred type SHALL be `{ body: { orderId: string }, headers: Record<string, string>, url: string, method: string, params: { userId: string } }`

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

### Requirement: HttpTriggerRegistry supports registration and lookup

The `HttpTriggerRegistry` SHALL allow registering `HttpTriggerDefinition` objects and looking them up by path and method. The registry SHALL use the `URLPattern` Web Standard API to match incoming request paths against registered trigger patterns. Each trigger's `path` field SHALL be compiled to a `URLPattern` instance at registration time.

The registry SHALL support three types of path segments:
- Static segments: `orders`, `users/admin`
- Named parameters: `:param` — matches a single path segment, captured as a named group
- Wildcard catch-all: `*name` — matches one or more remaining path segments, captured as a named group

The registry SHALL expose:
- `register(definition)` — stores a trigger definition and compiles its path to a `URLPattern`
- `lookup(path, method)` — returns the matching definition with extracted `params` as `Record<string, string>`, or `null`

#### Scenario: Register and look up a static trigger

- **WHEN** a trigger with path `"order"` and method `"POST"` is registered
- **THEN** `lookup("order", "POST")` SHALL return that trigger definition with `params: {}`

#### Scenario: Register and look up a parameterized trigger

- **WHEN** a trigger with path `"users/:userId"` and method `"POST"` is registered
- **THEN** `lookup("users/abc123", "POST")` SHALL return that trigger definition with `params: { userId: "abc123" }`

#### Scenario: Multiple named parameters

- **WHEN** a trigger with path `"orgs/:orgId/members/:memberId"` and method `"POST"` is registered
- **THEN** `lookup("orgs/acme/members/user42", "POST")` SHALL return that trigger with `params: { orgId: "acme", memberId: "user42" }`

#### Scenario: Wildcard catch-all extraction

- **WHEN** a trigger with path `"files/*rest"` and method `"POST"` is registered
- **THEN** `lookup("files/docs/2024/report.pdf", "POST")` SHALL return that trigger with `params: { rest: "docs/2024/report.pdf" }`

#### Scenario: Lookup with no matching trigger

- **WHEN** no trigger is registered for a path matching `"payment"` and method `"POST"`
- **THEN** `lookup("payment", "POST")` SHALL return `null`

#### Scenario: Lookup with wrong method

- **WHEN** a trigger is registered with path `"order"` and method `"POST"`
- **THEN** `lookup("order", "GET")` SHALL return `null`

#### Scenario: Parameterized path does not match wrong segment count

- **WHEN** a trigger with path `"users/:userId/status"` and method `"POST"` is registered
- **THEN** `lookup("users/abc123", "POST")` SHALL return `null`

### Requirement: httpTriggerMiddleware matches requests under /webhooks/

The `httpTriggerMiddleware` SHALL be a Hono middleware that intercepts requests under the `/webhooks/` path prefix, strips the prefix, looks up the remaining path and method in the registry, and either handles the request or returns 404.

The middleware SHALL always JSON-parse the request body. On parse failure, the middleware SHALL return a 422 response. The middleware SHALL construct a payload object with `body` (the parsed JSON), `headers` (all request headers as `Record<string, string>`), `url` (full request path including query string), `method` (HTTP method string), and `params` (extracted path parameters as `Record<string, string>`), then call `source.create(definition.name, payload, definition.name)` to create and emit the event using the trigger name as both event type and source name.

#### Scenario: Matching trigger request with full payload and path params

- **WHEN** a `POST /webhooks/users/abc123/status?source=api` request is received with headers `Content-Type: application/json`, `X-Signature: abc123` and body `{ "active": true }`
- **AND** a trigger with path `"users/:userId/status"` and method `"POST"` is registered with name `"webhook.user.status"`
- **THEN** the middleware SHALL parse the request body as JSON
- **AND** construct payload `{ body: { active: true }, headers: { "content-type": "application/json", "x-signature": "abc123", ... }, url: "/webhooks/users/abc123/status?source=api", method: "POST", params: { userId: "abc123" } }`
- **AND** call `source.create("webhook.user.status", payload, "webhook.user.status")`
- **AND** return the trigger's configured static response

#### Scenario: Static trigger payload includes empty params

- **WHEN** a `POST /webhooks/order` request is received with body `{ "orderId": "abc" }`
- **AND** a trigger with path `"order"` is registered
- **THEN** the payload SHALL include `params: {}`

#### Scenario: Payload validation error

- **WHEN** a `POST /webhooks/order` request is received with a body that fails schema validation
- **AND** a trigger with path `"order"` is registered
- **THEN** the middleware SHALL catch the `PayloadValidationError` from `source.create()`
- **AND** return a 422 response with error details

#### Scenario: No matching trigger

- **WHEN** a `POST /webhooks/unknown` request is received
- **AND** no trigger is registered matching path `"unknown"` and method `"POST"`
- **THEN** the middleware SHALL return a `404` response

#### Scenario: Non-JSON request body

- **WHEN** a `POST /webhooks/order` request is received with a non-JSON body
- **AND** a trigger with path `"order"` and method `"POST"` is registered
- **THEN** the middleware SHALL return a `422` response

### Requirement: Native implementation

Triggers SHALL be implemented as part of the platform runtime, not as user-provided sandboxed code.

#### Scenario: Trigger binds server port

- **GIVEN** the runtime starts with an HTTP trigger configured
- **WHEN** the runtime initializes
- **THEN** it binds the configured HTTP server port
- **AND** registers routes for all configured HTTP triggers

### Requirement: Static paths take priority over parameterized paths

When multiple registered triggers could match the same request path and method, the `HttpTriggerRegistry` SHALL prefer static (exact) matches over parameterized matches.

A trigger SHALL be classified as static if its path contains no `:param` or `*wildcard` segments.

#### Scenario: Static path preferred over parameterized

- **GIVEN** trigger A with path `"users/admin"` and trigger B with path `"users/:userId"`, both method `"POST"`
- **WHEN** `lookup("users/admin", "POST")` is called
- **THEN** the result SHALL be trigger A (the static match)

#### Scenario: Parameterized path used when no static match

- **GIVEN** trigger A with path `"users/admin"` and trigger B with path `"users/:userId"`, both method `"POST"`
- **WHEN** `lookup("users/xyz", "POST")` is called
- **THEN** the result SHALL be trigger B with `params: { userId: "xyz" }`

### Requirement: Template literal type inference for path params

The SDK SHALL infer path parameter names from the `path` string at the TypeScript level using recursive template literal types. The inferred type SHALL be `Record<ExtractedParamNames, string>`.

When the path is a string literal, `payload.params` SHALL be typed with the exact extracted keys. When the path is a non-literal `string`, `payload.params` SHALL fall back to `Record<string, string>`.

#### Scenario: Single named param inferred

- **GIVEN** `http({ path: "users/:userId" })`
- **WHEN** `z.infer` is applied to the trigger's schema
- **THEN** the `params` field SHALL be typed as `{ userId: string }`

#### Scenario: Multiple named params inferred

- **GIVEN** `http({ path: "orgs/:orgId/members/:memberId" })`
- **WHEN** `z.infer` is applied to the trigger's schema
- **THEN** the `params` field SHALL be typed as `{ orgId: string; memberId: string }`

#### Scenario: Wildcard param inferred

- **GIVEN** `http({ path: "files/*rest" })`
- **WHEN** `z.infer` is applied to the trigger's schema
- **THEN** the `params` field SHALL be typed as `{ rest: string }`

#### Scenario: Static path infers empty params

- **GIVEN** `http({ path: "orders" })`
- **WHEN** `z.infer` is applied to the trigger's schema
- **THEN** the `params` field SHALL be typed as `Record<string, never>` (empty object)

#### Scenario: Non-literal path falls back to Record

- **GIVEN** a variable `const p: string = getPath()` and `http({ path: p })`
- **WHEN** `z.infer` is applied to the trigger's schema
- **THEN** the `params` field SHALL be typed as `Record<string, string>`

### Requirement: Optional params Zod schema with key enforcement

The `http()` helper SHALL accept an optional `params` field containing a Zod object schema for runtime validation of extracted path parameters.

When provided, TypeScript SHALL enforce at compile time that the schema's keys exactly match the param names extracted from the path string. A mismatch SHALL produce a type error.

When the params schema is provided, its types SHALL be used for `payload.params` instead of the default `Record<keys, string>`.

#### Scenario: Params schema with matching keys

- **GIVEN** `http({ path: "users/:userId", params: z.object({ userId: z.string().uuid() }) })`
- **WHEN** the trigger definition is compiled
- **THEN** it SHALL compile without type errors
- **AND** `payload.params` SHALL be typed as `{ userId: string }` (the Zod-inferred type)

#### Scenario: Params schema with mismatched keys

- **GIVEN** `http({ path: "users/:userId", params: z.object({ id: z.string() }) })`
- **WHEN** the trigger definition is compiled
- **THEN** it SHALL produce a TypeScript type error indicating the key mismatch

#### Scenario: Params schema validation at runtime

- **GIVEN** a trigger with path `"users/:userId"` and `params: z.object({ userId: z.string().uuid() })`
- **WHEN** a request to `/webhooks/users/not-a-uuid` is received
- **THEN** the payload validation SHALL fail with a `PayloadValidationError`

### Requirement: Build-time param name extraction

The build system SHALL extract param names from trigger path strings and include them in the manifest. Param names SHALL be extracted by parsing `:name` and `*name` segments from the path.

#### Scenario: Param names in manifest

- **GIVEN** a trigger with path `"users/:userId/status"`
- **WHEN** the workflow is built
- **THEN** the manifest trigger entry SHALL include `params: ["userId"]`

#### Scenario: Wildcard param name in manifest

- **GIVEN** a trigger with path `"files/*rest"`
- **WHEN** the workflow is built
- **THEN** the manifest trigger entry SHALL include `params: ["rest"]`

#### Scenario: Static path has empty params in manifest

- **GIVEN** a trigger with path `"orders"`
- **WHEN** the workflow is built
- **THEN** the manifest trigger entry SHALL include `params: []`

#### Scenario: Multiple params in manifest

- **GIVEN** a trigger with path `"orgs/:orgId/members/:memberId"`
- **WHEN** the workflow is built
- **THEN** the manifest trigger entry SHALL include `params: ["orgId", "memberId"]`

### Requirement: Security context

The implementation SHALL conform to the threat model documented at
`/SECURITY.md §3 Webhook Ingress`, which enumerates the trust level,
entry points, threats, current mitigations, residual risks, and rules
governing this capability. Triggers — HTTP webhooks in particular —
are the project's PUBLIC ingress surface; the threat model treats all
trigger input as attacker-controlled.

Changes to this capability that introduce new threats, weaken or remove
a documented mitigation, add new trigger types, extend the payload
shape passed to the sandbox, change trigger-to-route mapping
semantics, or conflict with the rules listed in `/SECURITY.md §3`
MUST update `/SECURITY.md §3` in the same change proposal.

#### Scenario: Change alters behaviors covered by the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change affects a threat, mitigation, residual risk, or
  rule enumerated in `/SECURITY.md §3`
- **THEN** the proposal SHALL include the corresponding updates to
  `/SECURITY.md §3`
- **AND** the updates SHALL be reviewed before the change is archived

#### Scenario: Change is orthogonal to the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change does not affect any item enumerated in
  `/SECURITY.md §3`
- **THEN** no update to `/SECURITY.md §3` is required
- **AND** the proposal SHALL note that threat-model alignment was
  checked
