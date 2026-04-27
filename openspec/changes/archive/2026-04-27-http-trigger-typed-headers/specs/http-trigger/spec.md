## MODIFIED Requirements

### Requirement: httpTrigger factory creates branded HttpTrigger

The SDK SHALL export an `httpTrigger(config)` factory that returns an `HttpTrigger` value that is BOTH branded with `Symbol.for("@workflow-engine/http-trigger")` AND callable as `(payload) => Promise<HttpTriggerResult>`. Invoking the callable SHALL run the user-supplied `handler(payload)` and return its result.

The config SHALL accept exactly these top-level fields:

- `method` (optional string, default `"POST"`) — the HTTP method that routes to this trigger; the route discriminant for `/webhooks/*` matching.
- `request` (optional object) — request-shape declarations:
  - `body` (optional Zod schema, default `z.any()`) — the request body schema.
  - `headers` (optional Zod schema, default a Zod object with no declared properties — i.e. an empty record) — the request headers schema.
- `response` (optional object) — response-shape declarations:
  - `body` (optional Zod schema, default absent — loose body) — the response body schema.
  - `headers` (optional Zod schema, default absent — loose `Record<string, string>`) — the response headers schema.
- `handler` (required `(payload) => Promise<HttpTriggerResult>`).

The config SHALL NOT accept `path`, `params`, or `query` fields, NOR top-level `body` / `responseBody` / `headers` / `responseHeaders` (those have moved into `request` / `response`); passing any of them is a TypeScript error. The grouped shape is a *config* concept only — the handler payload remains flat at runtime.

The returned value SHALL expose `method`, `request` (with `.body` and `.headers` Zod schema properties), `response` (with `.body` and `.headers` Zod schema properties; either or both MAY be `undefined` when not declared), `inputSchema`, and `outputSchema` as readonly own properties. The captured `handler` SHALL NOT be exposed as a public property — the callable IS the handler invocation path.

The factory SHALL synthesise `inputSchema` and `outputSchema` on the returned callable:
- `inputSchema` SHALL be a Zod schema describing the composite payload `{ body, headers, url, method }` composed from `request.body`, `request.headers` (or the empty-record default), and the declared `method`.
- `outputSchema` SHALL be a Zod schema describing `HttpTriggerResult`. When `response.body` is omitted, `outputSchema` SHALL describe `{ status?: number, body?: unknown, headers?: <response.headers or Record<string,string>> }` with no required fields. When `response.body` is declared, `outputSchema` SHALL describe `{ status?: number, body: <response.body>, headers?: <response.headers or Record<string,string>> }` — `body` becomes required and carries the declared schema's content constraint. When `response.headers` is declared, the `headers` property's content schema SHALL be `response.headers` (replacing the loose `Record<string,string>`); when `response.headers` is omitted, the `headers` property remains a loose `Record<string,string>`. Both shapes SHALL emit with `additionalProperties: false` at the envelope (Zod v4 default); tenants opting into a passthrough body SHALL apply `.loose()` on their own `response.body` schema.

The runtime SHALL invoke the trigger by calling `Sandbox.run(triggerExportName, payload, ctx)` where `triggerExportName` is the user's export name from the workflow manifest.

#### Scenario: httpTrigger returns branded callable

- **GIVEN** `const t = httpTrigger({ request: { body: z.object({}) }, handler: async () => ({}) })`
- **WHEN** the value is inspected
- **THEN** `t` SHALL be a function (callable)
- **AND** `t[HTTP_TRIGGER_BRAND]` SHALL be `true`
- **AND** `t.method`, `t.request.body`, `t.request.headers`, `t.response`, `t.inputSchema`, `t.outputSchema` SHALL be exposed as readonly properties
- **AND** `t.handler`, `t.path`, `t.params`, `t.query`, `t.body`, `t.responseBody`, `t.headers`, `t.responseHeaders` SHALL NOT be defined as own properties

#### Scenario: httpTrigger callable invokes the handler

- **GIVEN** `const t = httpTrigger({ handler: async (p) => ({ status: 202, body: p.body }) })`
- **WHEN** `await t({ body: { hello: "world" }, headers: {}, url: "/webhooks/t/w/x", method: "POST" })` is called
- **THEN** the result SHALL equal `{ status: 202, body: { hello: "world" } }`

#### Scenario: Default method is POST

- **WHEN** `httpTrigger({ handler: ... })` is called without `method`
- **THEN** the returned value's `.method` property SHALL equal `"POST"`

#### Scenario: Default request.body schema is z.any

- **WHEN** `httpTrigger({ handler: ... })` is called without `request.body` (or without `request` entirely)
- **THEN** the returned value's `.request.body` property SHALL be a Zod schema that accepts any value

#### Scenario: Default request.headers schema is empty record

- **WHEN** `httpTrigger({ handler: ... })` is called without `request.headers` (or without `request` entirely)
- **THEN** the returned value's `.request.headers` property SHALL be a Zod object schema with no declared properties
- **AND** the synthesised `inputSchema`'s JSON Schema representation SHALL describe `headers` as `{ type: "object", properties: {}, additionalProperties: false }`
- **AND** the handler's `payload.headers` SHALL be the empty object `{}` at runtime

#### Scenario: Declaring request.headers exposes only declared keys to the handler

- **GIVEN** `const t = httpTrigger({ request: { headers: z.object({ "x-trace-id": z.string() }) }, handler: async (p) => ({ body: p.headers }) })`
- **AND** an incoming request carries headers `x-trace-id: abc`, `user-agent: curl/8`, `cookie: session=…`
- **WHEN** the handler is invoked
- **THEN** `payload.headers` SHALL equal `{ "x-trace-id": "abc" }`
- **AND** `payload.headers["user-agent"]` SHALL be `undefined`
- **AND** `payload.headers["cookie"]` SHALL be `undefined`

#### Scenario: Declaring request.headers with a missing required key returns 422

- **GIVEN** `const t = httpTrigger({ request: { headers: z.object({ "x-trace-id": z.string() }) }, handler })`
- **WHEN** an incoming request omits `x-trace-id`
- **THEN** the HTTP `TriggerSource` SHALL return `422` with `{ error: "payload_validation_failed", issues: [...] }`
- **AND** the handler SHALL NOT be invoked
- **AND** no `trigger.request` event SHALL be emitted to the bus

#### Scenario: outputSchema envelope is strict by default

- **GIVEN** `const t = httpTrigger({ handler: async () => ({ status: 202 }) })` with no `response.body` declared
- **WHEN** the synthesised `outputSchema`'s JSON Schema representation is inspected
- **THEN** it SHALL describe an object whose `status`, `body`, and `headers` properties are all optional
- **AND** it SHALL set `additionalProperties: false` at the envelope
- **AND** a handler return of `{ status: 202 }` SHALL validate successfully against it
- **AND** a handler return of `{ statusCode: 202 }` (typo) SHALL NOT validate successfully against it

#### Scenario: Declaring response.body makes body required and content-strict

- **GIVEN** `const t = httpTrigger({ response: { body: z.object({ orderId: z.string() }) }, handler: async () => ({ body: { orderId: "x" } }) })`
- **WHEN** the synthesised `outputSchema`'s JSON Schema representation is inspected
- **THEN** it SHALL describe an object whose `body` property is required
- **AND** the `body` sub-schema SHALL require `orderId: string` with `additionalProperties: false` (Zod default on the declared schema)
- **AND** a handler return of `{ body: { orderId: "x" } }` SHALL validate successfully
- **AND** a handler return of `{ status: 202 }` (body missing) SHALL NOT validate successfully
- **AND** a handler return of `{ body: { orderId: "x", debug: true } }` SHALL NOT validate successfully unless the tenant declared `response.body` with `.loose()`

#### Scenario: Declaring response.headers pins return-type headers shape

- **GIVEN** `const t = httpTrigger({ response: { headers: z.object({ "x-app-version": z.string() }) }, handler: async () => ({ headers: { "x-app-version": "1.0" } }) })`
- **WHEN** the synthesised `outputSchema`'s JSON Schema representation is inspected
- **THEN** the `headers` property's content sub-schema SHALL require `x-app-version: string`
- **AND** a handler return of `{ headers: { "x-app-version": "1.0" } }` SHALL validate successfully
- **AND** a handler return of `{ headers: {} }` SHALL NOT validate successfully
- **AND** a handler return of `{ headers: { "X-App-Version": "1.0" } }` SHALL NOT validate successfully (lowercase contract; see "Handler payload shape" requirement)

### Requirement: Handler payload shape

The HTTP trigger handler SHALL receive a single `payload` argument with exactly these fields: `body` (validated against the trigger's `request.body` schema), `headers` (validated against the trigger's `request.headers` schema; defaults to the empty object `{}` when no schema is declared), `url` (string, the raw request URL including any query string), `method` (string). The payload SHALL NOT contain `params` or `query` fields — the URL carries no structured data to the handler. The payload SHALL NOT contain `request` or `response` keys — the grouped form is a *config* concept only; the runtime payload remains flat. A handler that needs a value from the query string SHALL parse it explicitly via `new URL(payload.url).searchParams`.

The runtime SHALL lowercase incoming HTTP header names before validation against the headers schema. Authors SHALL write headers schemas using lowercase keys; uppercase keys (`"X-Foo"`) will not match incoming headers. Unknown header keys (incoming names not declared in the schema) SHALL be stripped silently — the handler SHALL NOT see them, and they SHALL NOT appear in the persisted `trigger.request` event payload.

The strip-silently behaviour for the `request.headers` slot SHALL be implemented via the `strip` meta marker contract (see "Object schema strip-mode marker (`strip`)" requirement). The SDK SHALL auto-attach `.meta({ strip: true })` to the author's `request.headers` zod schema (and to the empty-record default when no schema is declared) ONLY when the author has not already expressed an explicit mode preference: the auto-wrap SHALL be skipped when the author already attached `.meta({ strip: ... })` (any value, including `false`) or used `.loose()` / `.passthrough()` on the slot. Authors who explicitly opt out of strip on `request.headers` SHALL get the runtime mode they chose (strict from default `z.object`, passthrough from `.loose()`); the SDK SHALL NOT fail the build for any author choice.

#### Scenario: Payload carries body, headers, url, method only (flat at runtime)

- **GIVEN** a `POST /webhooks/acme/cronitor/cronitorWebhook?delivery=abc` request with body `{ "active": true }`
- **AND** a registered trigger `cronitorWebhook` with `request.body: z.object({ active: z.boolean() })` and no `request.headers` declared
- **WHEN** the handler is invoked
- **THEN** `payload.body` SHALL equal `{ active: true }`
- **AND** `payload.headers` SHALL equal `{}` (empty object — no headers schema declared)
- **AND** `payload.url` SHALL be `/webhooks/acme/cronitor/cronitorWebhook?delivery=abc`
- **AND** `payload.method` SHALL be `"POST"`
- **AND** `Object.keys(payload)` SHALL equal `["body", "headers", "url", "method"]` (in any order)
- **AND** `payload.request` SHALL be `undefined`
- **AND** `payload.response` SHALL be `undefined`
- **AND** `payload.params` SHALL be `undefined`
- **AND** `payload.query` SHALL be `undefined`

#### Scenario: Handler parses query string manually when needed

- **GIVEN** a `POST /webhooks/acme/w/t?foo=bar&x=1` request
- **AND** a handler that calls `new URL(payload.url).searchParams.get("foo")`
- **WHEN** the handler runs
- **THEN** the call SHALL return `"bar"`

#### Scenario: Header names are lowercased before reaching the handler

- **GIVEN** an incoming request with header `X-Trace-Id: abc` (uppercase)
- **AND** a registered trigger with `request.headers: z.object({ "x-trace-id": z.string() })`
- **WHEN** the handler is invoked
- **THEN** `payload.headers["x-trace-id"]` SHALL equal `"abc"`
- **AND** `payload.headers["X-Trace-Id"]` SHALL be `undefined`

#### Scenario: Unknown headers are stripped silently when a schema is declared

- **GIVEN** an incoming request with headers `x-trace-id: abc`, `user-agent: curl/8`, `accept-encoding: gzip`
- **AND** a registered trigger with `request.headers: z.object({ "x-trace-id": z.string() })`
- **WHEN** the handler is invoked
- **THEN** `Object.keys(payload.headers)` SHALL equal `["x-trace-id"]`
- **AND** the request SHALL succeed (200, not 422) — undeclared keys are stripped, not rejected

### Requirement: Trigger handler return value is the HTTP response

The HTTP trigger handler SHALL return a `Promise<HttpTriggerResult>` where `HttpTriggerResult = { status?, body?, headers? }`. The runtime SHALL use the returned object as the literal HTTP response, applying defaults: `status` = `200`, `body` = `""`, `headers` = `{}`.

The runtime SHALL fill the `content-type` response header when the handler did not set one (case-insensitive check):

- Object body and no author `content-type` → fill `content-type: application/json; charset=UTF-8`.
- String body and no author `content-type` → fill `content-type: text/plain; charset=UTF-8`.
- `null`/`undefined`/empty body → no `content-type` auto-fill.

An author-set `content-type` (any casing) SHALL always win. The runtime SHALL NOT add any other `content-type`-class header when the author already set one.

When the trigger declares a `response.headers` zod schema, the handler's returned `headers` SHALL be validated against it host-side (in the same `validateOutput` path that already validates `response.body`). Validation failure SHALL produce HTTP `500` + a `trigger.error` event; the response body SHALL be `{ "error": "internal_error" }` with no structured issues on the wire (handler bug, not a client fault).

#### Scenario: Handler controls status

- **GIVEN** a handler returning `{ status: 202 }`
- **WHEN** the trigger fires
- **THEN** the HTTP response SHALL be `202` with empty body and no `content-type` header (empty body case)

#### Scenario: Handler controls body

- **GIVEN** a handler returning `{ body: { ok: true } }`
- **WHEN** the trigger fires
- **THEN** the HTTP response SHALL be `200` with body `{"ok":true}` (JSON-serialized)
- **AND** the response `content-type` SHALL be `application/json; charset=UTF-8`

#### Scenario: Handler returns string body fills text/plain

- **GIVEN** a handler returning `{ body: "hello" }` and no author `content-type`
- **WHEN** the trigger fires
- **THEN** the response `content-type` SHALL be `text/plain; charset=UTF-8`

#### Scenario: Author content-type wins (case-insensitive)

- **GIVEN** a handler returning `{ body: { ok: true }, headers: { "Content-Type": "application/vnd.acme+json" } }`
- **WHEN** the trigger fires
- **THEN** the response `Content-Type` SHALL be `application/vnd.acme+json`
- **AND** the runtime SHALL NOT add a duplicate `content-type` header

#### Scenario: Handler controls headers

- **GIVEN** a handler returning `{ headers: { "x-trace": "abc" } }`
- **WHEN** the trigger fires
- **THEN** the HTTP response SHALL include header `x-trace: abc`

#### Scenario: response.headers validation failure yields 500

- **GIVEN** a trigger with `response: { headers: z.object({ "x-app-version": z.string() }) }` and a handler returning `{ headers: {} }`
- **WHEN** the trigger fires
- **THEN** the HTTP response SHALL be `500` with body `{ "error": "internal_error" }`
- **AND** a `trigger.error` event SHALL be emitted to the bus

## ADDED Requirements

### Requirement: Header lowercase normalization is an explicit contract

The HTTP `TriggerSource` SHALL lowercase all incoming HTTP header names via an explicit `String#toLowerCase()` call in `headersToRecord`, not relying on the WHATWG Fetch / undici `Headers#forEach` iteration order or any other implicit lowercasing behaviour of the underlying HTTP layer.

This contract SHALL be load-bearing: header schemas authored via `request.headers: z.object({...})` rely on it, and the contract SHALL survive any future swap of the HTTP layer (Hono, undici, polyfilled `Headers`) by being expressed in our code rather than in a spec reference.

#### Scenario: headersToRecord lowercases explicitly

- **GIVEN** any `Headers` object passed to `headersToRecord`
- **WHEN** the function runs
- **THEN** every key in the returned record SHALL be lowercase
- **AND** the implementation SHALL contain an explicit `k.toLowerCase()` call (not a comment promising the spec lowercases for us)

### Requirement: Object schema strip-mode marker (`strip`)

Workflow authors MAY annotate any zod object schema with `.meta({ strip: true })` to force `.strip()` mode at runtime; the runtime SHALL honour this marker by reconstructing the corresponding `ZodObject` in default strip mode, dropping undeclared keys silently from the validated value. Without the marker, the rehydrated schema's mode SHALL be whatever `z.fromJSONSchema` produces from the manifest's `additionalProperties` field: `false` → `.strict()` (reject), `true` / `{}` → `.loose()` (passthrough). The marker exists ONLY for the strip case because zod's strip-default `.object()` and `.strict()` both serialise to `additionalProperties: false`, making the round-trip lossy for strip-default schemas; reject and passthrough round-trip natively.

The SDK SHALL preserve `.meta()` end-to-end via zod v4's standard JSON Schema serialization (`toJSONSchema` flattens custom meta keys at the schema root; `fromJSONSchema` rehydrates them, callable via `.meta()` on the resulting zod schema). The runtime `WorkflowRegistry` rehydrator SHALL walk the rehydrated zod tree and, for each `ZodObject` whose `.meta().strip === true`, reconstruct the node in default `.strip()` mode while preserving any other meta keys.

The `httpTrigger` factory SHALL auto-attach `.meta({ strip: true })` to the author's `request.headers` zod schema (and to the empty-record default when no schema is declared) ONLY when the author has not already expressed an explicit mode preference: the auto-wrap SHALL be skipped when the author already attached `.meta({ strip: ... })` (any value) or used `.loose()` / `.passthrough()` on the slot. The SDK CLI SHALL NOT fail the build for any author choice on `request.headers` — the auto-wrap is overridable by an explicit author preference.

For every other slot (request.body, response.body, response.headers, action input/output, manual input/output), authors who want strip semantics MUST annotate explicitly with `.meta({ strip: true })`; without it they get the default mode `z.fromJSONSchema` produces (strict for `additionalProperties: false`, loose for `additionalProperties: true`).

#### Scenario: meta strip=true preserved through the manifest round-trip

- **GIVEN** an author schema `z.object({ "x-trace-id": z.string() }).meta({ strip: true })`
- **WHEN** the schema is built into the manifest and rehydrated by the runtime
- **THEN** `safeParse({ "x-trace-id": "abc", "user-agent": "curl/8" })` SHALL return `{ success: true, data: { "x-trace-id": "abc" } }`
- **AND** `"user-agent"` SHALL NOT appear in the validated payload

#### Scenario: reject mode round-trips natively without a marker

- **GIVEN** an author schema `z.strictObject({ x: z.string() })` (no `.meta` annotation)
- **WHEN** rehydrated and parsed against `{ x: "abc", y: "extra" }`
- **THEN** the result SHALL be a zod failure with an `unrecognized_keys` issue naming `"y"`
- **AND** no `strip` marker is required on the manifest JSON Schema

#### Scenario: passthrough mode round-trips natively without a marker

- **GIVEN** an author schema `z.object({ x: z.string() }).loose()` (no `.meta` annotation)
- **WHEN** rehydrated and parsed against `{ x: "abc", y: "extra" }`
- **THEN** the validated value SHALL equal `{ x: "abc", y: "extra" }`
- **AND** no `strip` marker is required on the manifest JSON Schema

#### Scenario: SDK auto-wraps request.headers with strip=true by default

- **GIVEN** `httpTrigger({ request: { headers: z.object({ "x-trace-id": z.string() }) }, handler })`
- **WHEN** the SDK builds the manifest entry
- **THEN** the request headers JSON Schema SHALL contain `"strip": true` at the top level
- **AND** the author's input schema does not need to write `.meta({ strip: true })` explicitly

#### Scenario: SDK skips auto-wrap when author already wrote .meta({ strip: ... })

- **GIVEN** `httpTrigger({ request: { headers: z.object({...}).meta({ strip: false }) }, handler })`
- **WHEN** the SDK builds the manifest entry
- **THEN** the request headers JSON Schema SHALL contain `"strip": false` (the author's value, not the SDK default)
- **AND** the SDK CLI SHALL NOT fail the build

#### Scenario: SDK skips auto-wrap when author wrote .loose() / .passthrough()

- **GIVEN** `httpTrigger({ request: { headers: z.object({...}).loose() }, handler })`
- **WHEN** the SDK builds the manifest entry
- **THEN** the request headers JSON Schema SHALL emit `additionalProperties: {}` (loose mode)
- **AND** the JSON Schema SHALL NOT contain a top-level `strip` key
- **AND** the SDK CLI SHALL NOT fail the build
- **AND** at runtime the rehydrated schema SHALL be in `.loose()` mode (extras flow through to the handler and event store)

#### Scenario: Default behaviour for slots without strip marker is whatever z.fromJSONSchema produces

- **GIVEN** an action `output: z.object({ x: z.number() })` (no `.meta({ strip })` annotation)
- **WHEN** the schema is rehydrated and the handler returns `{ x: 1, debug: "y" }`
- **THEN** the validation SHALL fail with an `unrecognized_keys` issue on `"debug"` (post-round-trip strict default)
- **AND** the runtime SHALL surface this as a 500 + `trigger.error` (handler-bug detection)
