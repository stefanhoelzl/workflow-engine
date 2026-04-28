# HTTP Trigger Specification

## Purpose

Define the HTTP trigger factory, handler return value contract, payload shape, HTTP middleware delegation to the executor, trigger registry routing rules, and public ingress security context.
## Requirements
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

### Requirement: Response-shaping pipeline

The HTTP response the public caller receives SHALL be produced by a three-stage pipeline that clearly separates each component's responsibility:

1. **Handler** — the user's `httpTrigger({ handler })` returns a plain object shaped like `HttpTriggerResult = { status?, body?, headers? }`. The handler has no knowledge of the transport envelope; it just returns data.
2. **Executor** — wraps the handler's return value in a kind-agnostic `InvokeResult<unknown>` (see `executor/spec.md` "Requirement: Executor return shape is kind-agnostic"). On success the wrapper is `{ ok: true, output: <handler-return> }`; on thrown error it is `{ ok: false, error: { message, stack } }` (or `{ ok: false, error: { issues, … } }` for input-schema validation failures). The executor SHALL NOT construct HTTP status codes, response bodies, or header maps.
3. **HTTP `TriggerSource`** — receives the `InvokeResult`, unwraps it, and serialises to the on-the-wire HTTP response: `{ ok: true, output }` → `output` interpreted as `HttpTriggerResult` with defaults applied (see below); `{ ok: false, error: { issues } }` → `422` with `{ error: "payload_validation_failed", issues }`; `{ ok: false, error }` without `issues` → `500` with `{ error: "internal_error" }`.

Stage 3 is the only stage that constructs an HTTP envelope. Adding a new trigger kind (e.g. cron, queue) reuses stages 1–2 unchanged and supplies its own stage-3 serialiser — the `InvokeResult` boundary is the contract.

#### Scenario: Handler return flows through executor unchanged

- **GIVEN** a handler that returns `{ status: 202, body: { ok: true } }`
- **WHEN** the executor resolves the invocation
- **THEN** the executor SHALL return `{ ok: true, output: { status: 202, body: { ok: true } } }`
- **AND** the HTTP `TriggerSource` SHALL serialise this `output` as HTTP `202` with JSON body `{"ok":true}`

#### Scenario: Handler throw yields 500 at the HTTP boundary

- **GIVEN** a handler that throws `new Error("boom")`
- **WHEN** the executor resolves the invocation
- **THEN** the executor SHALL return `{ ok: false, error: { message: "boom", stack: <stack> } }` with no `issues` field
- **AND** the HTTP `TriggerSource` SHALL serialise this as HTTP `500` with body `{ "error": "internal_error" }`

#### Scenario: Payload validation failure yields 422 at the HTTP boundary

- **GIVEN** a request whose body fails the trigger's `body` schema
- **WHEN** the `fire` closure returns `{ ok: false, error: { issues: [...] } }`
- **THEN** the HTTP `TriggerSource` SHALL serialise this as HTTP `422` with body `{ "error": "payload_validation_failed", "issues": [...] }`
- **AND** the handler SHALL NOT have been called

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

### Requirement: HTTP middleware delegates to executor

The HTTP `TriggerSource` SHALL expose a Hono middleware mounted at `/webhooks/*`. The middleware SHALL parse the URL as exactly four segments after the `/webhooks/` prefix: `<owner>`, `<repo>`, `<workflow-name>`, `<trigger-name>`. URLs with a different number of segments SHALL return `404`. `<owner>` and `<workflow-name>` SHALL match the owner regex `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`; `<repo>` SHALL match the repo regex `^[a-zA-Z0-9._-]{1,100}$`; `<trigger-name>` SHALL match the trigger-name regex `^[A-Za-z_][A-Za-z0-9_]{0,62}$`. Query strings on the URL SHALL be tolerated (they pass through unchanged in `payload.url`) but SHALL NOT be parsed into a structured payload field.

The middleware SHALL look up the matching entry via a per-(owner, repo) constant-time `Map` keyed by `(workflow-name, trigger-name)`. If no entry is found, or the entry's `descriptor.method` does not equal the request's method, the middleware SHALL return `404` (identical to "no matching trigger" to prevent enumeration per `/SECURITY.md §3 R-W5`). The middleware SHALL NOT emit any event for 404 responses.

On match, the middleware SHALL parse the JSON body (422 on invalid JSON), assemble the raw input `{ body, headers, url, method }`, and call `entry.fire(input)` on the matched `TriggerEntry`. The HTTP source SHALL NOT call `executor.invoke` directly; all executor interaction happens inside the `fire` closure captured on the `TriggerEntry`, which is constructed by the `WorkflowRegistry` via `buildFire` and performs input-schema validation + executor dispatch.

The middleware SHALL serialize the returned `InvokeResult<unknown>` into the HTTP response: `{ok: true, output}` → serialize `output`; `{ok: false, error: {issues, ...}}` → `422` with the validation issues; `{ok: false, error: {...}}` without `issues` → `500` with `{ error: "internal_error" }`.

When the middleware emits a `422` for body validation issues (i.e. `error.issues` is present), the middleware SHALL — in addition to returning the response — invoke `entry.exception({ kind: "trigger.rejection", name: "http.body-validation", input: { issues, method: <request method>, path: <pathname only, no query string> } })` exactly once per rejected request. The HTTP request body SHALL NOT be persisted on the event. `entry.exception` is the per-trigger callable bound to `executor.fail` by the registry's `buildException` helper (see `executor/spec.md` "Executor.fail emits trigger.exception leaf events").

When the middleware emits a `500` (handler threw), it SHALL NOT emit a `trigger.rejection` event — handler throws are already covered by `trigger.error` close events emitted from inside the sandbox.

When the middleware emits a `422` due to invalid JSON (body could not be parsed at all), it SHALL NOT emit a `trigger.rejection` event — invalid JSON is treated as a transport-level error indistinguishable from scanner noise.

The HTTP source SHALL be the only component that parses `/webhooks/*` URLs and the only component that converts handler output to an HTTP response.

#### Scenario: Successful trigger invocation

- **GIVEN** a registered HTTP trigger and a matching `POST /webhooks/<owner>/<repo>/<workflow>/<trigger-name>` request with valid body
- **WHEN** the middleware processes the request
- **THEN** the middleware SHALL resolve the matching `TriggerEntry` via its per-(owner, repo) routing index
- **AND** the middleware SHALL call `entry.fire(input)` exactly once with `{body, headers, url, method}`
- **AND** on `{ok: true, output}` the middleware SHALL serialize `output` as the HTTP response
- **AND** the middleware SHALL NOT emit a `trigger.rejection` event

#### Scenario: Body validation failure returns 422 and emits trigger.rejection

- **GIVEN** a registered HTTP trigger with a body schema requiring `{name: string}`
- **WHEN** a request arrives with body `{}` (missing `name`)
- **THEN** the middleware SHALL call `entry.fire(input)`
- **AND** the `fire` closure SHALL resolve to `{ok: false, error: {issues: [...]}}`
- **AND** the middleware SHALL return a `422` response with `{ error: "payload_validation_failed", issues: [...] }`
- **AND** the middleware SHALL invoke `entry.exception({ kind: "trigger.rejection", name: "http.body-validation", input: { issues: [...], method: "POST", path: "/webhooks/<owner>/<repo>/<workflow>/<trigger-name>" } })` exactly once
- **AND** the emitted event SHALL NOT carry the request body
- **AND** `executor.invoke` SHALL NOT be called

#### Scenario: No matching trigger returns 404 and emits no event

- **GIVEN** a request to `/webhooks/<owner>/<repo>/<workflow>/<unknown-trigger-name>` with a valid four-segment shape but no registered trigger with that name
- **WHEN** the middleware processes the request
- **THEN** the middleware SHALL return `404`
- **AND** the middleware SHALL NOT emit a `trigger.rejection` event

#### Scenario: URL with wrong segment count returns 404 and emits no event

- **GIVEN** a request to `/webhooks/<owner>/<repo>/<workflow>/<trigger-name>/extra` (extra segment) or `/webhooks/<owner>/<repo>/<workflow>` (missing segment)
- **WHEN** the middleware processes the request
- **THEN** the middleware SHALL return `404`
- **AND** `entry.fire` SHALL NOT be called
- **AND** the middleware SHALL NOT emit a `trigger.rejection` event

#### Scenario: Method mismatch returns 404 and emits no event

- **GIVEN** a registered HTTP trigger with `method: "POST"`
- **WHEN** a `GET` request to the trigger's URL is processed
- **THEN** the middleware SHALL return `404`
- **AND** `entry.fire` SHALL NOT be called
- **AND** the middleware SHALL NOT emit a `trigger.rejection` event

#### Scenario: Non-JSON body returns 422 and emits no trigger.rejection

- **GIVEN** a registered HTTP trigger
- **WHEN** the request body is not valid JSON
- **THEN** the middleware SHALL return `422` without calling `entry.fire`
- **AND** the middleware SHALL NOT emit a `trigger.rejection` event (JSON-parse failures are treated as transport-level noise)

#### Scenario: Handler throw returns 500 and emits no trigger.rejection

- **GIVEN** a registered HTTP trigger whose handler throws
- **WHEN** the middleware processes the request
- **THEN** `entry.fire` SHALL return `{ok: false, error: {message, stack}}` without `issues`
- **AND** the middleware SHALL serialize a `500` response with `{ error: "internal_error" }`
- **AND** the middleware SHALL NOT emit a `trigger.rejection` event (the handler-throw path emits `trigger.error` from inside the sandbox)

#### Scenario: Path field carries pathname only, no query string

- **GIVEN** a request `POST /webhooks/<owner>/<repo>/<workflow>/<trigger-name>?delivery=abc&x=1` whose body fails validation
- **WHEN** the middleware emits the `trigger.rejection` event
- **THEN** the event's `input.path` SHALL be `/webhooks/<owner>/<repo>/<workflow>/<trigger-name>` (pathname only)
- **AND** the event's `input.path` SHALL NOT contain the query string

### Requirement: Public ingress security context

The HTTP trigger SHALL conform to the threat model documented at `/SECURITY.md §3 Webhook Ingress`. HTTP triggers are the project's PUBLIC ingress surface; the threat model treats all trigger input as attacker-controlled.

The HTTP trigger SHALL additionally conform to the tenant isolation invariant documented at `/SECURITY.md §1 "Tenant isolation invariants"` (I-T2). The `/webhooks/<tenant>/<workflow>/<trigger-name>` route parses the three path segments, validates each against the tenant/trigger identifier regex (`<tenant>` and `<workflow>` permit the existing tenant regex `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`; `<trigger-name>` matches `^[A-Za-z_][A-Za-z0-9_]{0,62}$`), and looks up the trigger via constant-time Map lookup keyed by `(tenant, workflow, trigger-name)`. A public caller cannot route a webhook into another tenant's workflow because the Map lookup requires an exact three-tuple match. The resulting `InvocationEvent` carries a `tenant` field stamped from the workflow's registration — not from the URL — so a request that matches a valid `(tenant, workflow, trigger-name)` triple produces an event whose `tenant` is correct by construction.

The URL carries no structured data to the handler: the payload exposes `{ body, headers, url, method }` only. Query strings on the URL pass through unchanged in `payload.url` for handler-side parsing (via `new URL(payload.url).searchParams`) but do NOT produce a structured payload field.

Changes that introduce new threats, weaken or remove a documented mitigation, add new trigger types, extend the payload shape passed to the sandbox, change trigger-to-route mapping semantics, relax the `(tenant, workflow, trigger-name)` lookup scoping, or conflict with the rules in `/SECURITY.md §3` or the invariant statement in `/SECURITY.md §1` MUST update the corresponding section(s) of `/SECURITY.md` in the same change proposal.

#### Scenario: Change alters threat model

- **GIVEN** a change to this capability that affects an item enumerated in `/SECURITY.md §3` or the tenant-isolation invariant in `/SECURITY.md §1`
- **WHEN** the change is proposed
- **THEN** the proposal SHALL include corresponding updates to `/SECURITY.md §3` and/or `/SECURITY.md §1`

#### Scenario: This change updates SECURITY.md §3

- **GIVEN** this change modifies trigger-to-route mapping semantics (URLPattern → Map lookup) and narrows the payload (drops `params`, drops `query`)
- **WHEN** the change lands
- **THEN** `/SECURITY.md §3` SHALL be updated in the same PR to delete the W8 threat row, delete the R-W6 residual-risk row, replace the URLPattern-based "Deterministic path matching" mitigation with a "Closed URL vocabulary" mitigation, and narrow the documented payload snippet to `{ body, headers, url, method }`

### Requirement: Trigger URL is derived from export name

The webhook URL for an HTTP trigger SHALL be exactly `/webhooks/<tenant>/<workflow>/<export-name>`, where `<export-name>` is the trigger's exported identifier in its workflow source file. There is no other routing mechanism. The export name SHALL match `/^[A-Za-z_][A-Za-z0-9_]{0,62}$/`, validated at build time by the vite plugin and at upload time by `ManifestSchema`.

#### Scenario: URL equals export name

- **GIVEN** a workflow `cronitor` in tenant `acme` containing `export const cronitorWebhook = httpTrigger({...})`
- **WHEN** the trigger is registered
- **THEN** the trigger's webhook URL SHALL be exactly `/webhooks/acme/cronitor/cronitorWebhook`
- **AND** no other URL SHALL route to this trigger

#### Scenario: Two triggers in one workflow have distinct URLs

- **GIVEN** a workflow `hub` with `export const stripeHook = httpTrigger({...})` and `export const githubHook = httpTrigger({...})`
- **WHEN** the workflow is registered
- **THEN** `stripeHook` SHALL be reachable at `/webhooks/<tenant>/hub/stripeHook`
- **AND** `githubHook` SHALL be reachable at `/webhooks/<tenant>/hub/githubHook`
- **AND** no ordering-sensitive precedence rule SHALL govern which trigger matches a request

#### Scenario: Duplicate export names are impossible

- **WHEN** a workflow source file attempts `export const webhook = httpTrigger({...}); export const webhook = httpTrigger({...});`
- **THEN** the JavaScript/TypeScript parser SHALL reject the source before the plugin runs
- **AND** no route collision SHALL be representable

### Requirement: URL carries no structured data

The HTTP trigger payload delivered to the handler SHALL contain no structured field derived from the request URL beyond `url` (the raw URL string) and `method`. The payload SHALL NOT contain `params` or `query`. A handler that needs a value encoded in the query string SHALL parse it explicitly from `payload.url`.

#### Scenario: No params field on payload

- **GIVEN** any valid HTTP trigger invocation
- **WHEN** the handler receives the payload
- **THEN** `payload.params` SHALL be `undefined`
- **AND** TypeScript SHALL refuse to compile a handler that reads `payload.params` (the field does not exist on `HttpTriggerPayload<Body>`)

#### Scenario: No query field on payload

- **GIVEN** any valid HTTP trigger invocation, including requests with query strings
- **WHEN** the handler receives the payload
- **THEN** `payload.query` SHALL be `undefined`
- **AND** TypeScript SHALL refuse to compile a handler that reads `payload.query`

#### Scenario: Query string remains parseable via payload.url

- **GIVEN** a request `POST /webhooks/<tenant>/<workflow>/<trigger-name>?foo=bar` with valid body
- **WHEN** a handler calls `new URL(payload.url).searchParams.get("foo")`
- **THEN** the call SHALL return `"bar"`

### Requirement: GET /webhooks/ readiness endpoint

The HTTP trigger middleware SHALL handle `GET /webhooks/` and return HTTP `204 No Content` when the trigger registry has at least one registered HTTP trigger across all tenants, or HTTP `503 Service Unavailable` when no HTTP triggers are registered. The response body SHALL be empty in both cases. `POST /webhooks/*` traffic (the actual trigger invocation path) SHALL NOT be affected by this endpoint — individual trigger routes continue to resolve independently.

The readiness endpoint exists so liveness/readiness probes can distinguish "runtime is up but has not yet loaded any workflows" (503) from "runtime is up with workflows loaded" (204). The endpoint SHALL NOT be authenticated (it is part of the public `/webhooks/*` prefix).

#### Scenario: 204 when at least one HTTP trigger is registered

- **GIVEN** the HTTP trigger registry has one or more registered HTTP triggers
- **WHEN** `GET /webhooks/` is requested
- **THEN** the response status SHALL be `204 No Content`
- **AND** the response body SHALL be empty

#### Scenario: 503 when no HTTP triggers are registered

- **GIVEN** the HTTP trigger registry has no registered HTTP triggers
- **WHEN** `GET /webhooks/` is requested
- **THEN** the response status SHALL be `503 Service Unavailable`
- **AND** the response body SHALL be empty

#### Scenario: POST traffic unaffected by readiness semantics

- **GIVEN** an HTTP trigger registered at `/webhooks/<tenant>/<workflow>/myHook`
- **WHEN** `POST /webhooks/<tenant>/<workflow>/myHook` is requested
- **THEN** the trigger SHALL fire as normal
- **AND** the 204/503 semantics of `GET /webhooks/` SHALL NOT apply to POST


### Requirement: HTTP trigger descriptor string fields support secret sentinels

Any `string`-typed field of an `HttpTriggerDescriptor` in the manifest MAY carry sentinel substrings produced by the SDK's build-time `SecretEnvRef` resolution. Today such string fields are limited to the `name` and (indirectly) the `method` literal; however, fields that are typed as literal unions (e.g. `method: "GET" | "POST"`) SHALL NOT accept sentinels in practice, because the SDK's `httpTrigger` factory types those fields as unions incompatible with the `SecretEnvRef`-built sentinel strings. Any future `string`-typed addition to the descriptor SHALL receive resolved plaintext from the workflow-registry before the HTTP TriggerSource observes it.

The HTTP TriggerSource SHALL NOT itself parse, match, or recognize sentinel substrings. Its contract remains "receive already-resolved descriptor strings and mount webhook routes accordingly." The webhook URL is derived from trigger `name` (see existing "Trigger URL is derived from export name" requirement); because `name` is not generated via `env({ secret: true })` in author code paths, `name` in practice remains a non-secret identifier surfaced in dashboards and events.

#### Scenario: HTTP TriggerSource never observes sentinel bytes

- **GIVEN** any manifest with sentinel substrings anywhere in HTTP trigger descriptors (including future `string`-typed fields)
- **WHEN** `httpTriggerSource.reconfigure` is called by the registry
- **THEN** no string field reachable from the entries argument SHALL contain the byte sequence `\x00secret:`

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

### Requirement: Reserved response header names are platform-owned

The platform SHALL reserve a fixed list of HTTP response header names that workflow handlers MUST NOT set on `/webhooks/*` responses. The list SHALL be exported from `@workflow-engine/core` as `RESERVED_RESPONSE_HEADERS: ReadonlySet<string>` and consumed by both the SDK build pipeline and the runtime HTTP `TriggerSource`.

The reserved list SHALL contain (lowercased canonical form):

- Cross-origin / cross-tenant attack class: `set-cookie`, `set-cookie2`, `location`, `refresh`, `clear-site-data`, `authorization`, `proxy-authenticate`, `www-authenticate`.
- Platform security/transport invariants (the platform sets these via `secureHeadersMiddleware` and the workflow MUST NOT override them): `content-security-policy`, `content-security-policy-report-only`, `strict-transport-security`, `x-content-type-options`, `x-frame-options`, `referrer-policy`, `cross-origin-opener-policy`, `cross-origin-resource-policy`, `cross-origin-embedder-policy`, `permissions-policy`, `server`, `x-powered-by`.

The core SHALL also export `isReservedResponseHeader(name: string): boolean` which lowercases its argument before lookup. `Content-Type` SHALL NOT be reserved (workflow-controlled by design, default-injected by the runtime when omitted). `Cache-Control` SHALL NOT be reserved (workflow-controlled).

#### Scenario: Lookup is case-insensitive

- **GIVEN** the exported `isReservedResponseHeader` helper
- **WHEN** called with `"Set-Cookie"`, `"SET-COOKIE"`, or `"set-cookie"`
- **THEN** every call SHALL return `true`

#### Scenario: Non-reserved names return false

- **GIVEN** a header name not in the reserved set, e.g. `"x-app-version"`, `"content-type"`, `"cache-control"`
- **WHEN** `isReservedResponseHeader` is called
- **THEN** the call SHALL return `false`

### Requirement: Build-time rejection of reserved response-header schemas

The SDK workflow build pipeline (the `buildWorkflows` core invoked by `wfe upload` and `wfe build`) SHALL reject any `httpTrigger` whose `response.headers` zod schema declares a property whose name is a reserved response header (case-insensitive). The rejection SHALL fail the build with a `BuildWorkflowsError` whose message names the workflow file, the trigger export name, and the offending header name. No bundle and no manifest SHALL be emitted for a workflow that fails this check.

The build check SHALL inspect the JSON Schema produced from the `response.headers` zod schema (the same JSON Schema that ships in the manifest) by walking `properties.*` keys and lowercasing each before comparison. Schemas without a `properties` object (e.g. `z.record(z.string(), z.string())` or other open-record forms) SHALL pass the build check unchanged; the runtime strip remains load-bearing for those cases.

#### Scenario: Schema declaring lowercase reserved name fails build

- **GIVEN** a workflow with `httpTrigger({ response: { headers: z.object({ "set-cookie": z.string() }) }, ... })`
- **WHEN** `buildWorkflows` runs
- **THEN** the build SHALL throw `BuildWorkflowsError`
- **AND** the message SHALL name the workflow, the trigger export name, and `"set-cookie"`
- **AND** no `<workflow>.js` artifact SHALL be returned in the build result

#### Scenario: Schema declaring capitalized reserved name fails build

- **GIVEN** a workflow with `httpTrigger({ response: { headers: z.object({ "Set-Cookie": z.string() }) }, ... })`
- **WHEN** `buildWorkflows` runs
- **THEN** the build SHALL throw `BuildWorkflowsError` mentioning `"Set-Cookie"` (or its lowercased form) as a reserved header

#### Scenario: Schema with non-reserved keys passes build

- **GIVEN** a workflow with `httpTrigger({ response: { headers: z.object({ "x-app-version": z.string() }) }, ... })`
- **WHEN** `buildWorkflows` runs
- **THEN** the build SHALL succeed and the manifest SHALL contain the `response.headers` JSON Schema

#### Scenario: Open-record response-headers schema bypasses static check

- **GIVEN** a workflow whose `response.headers` zod schema produces a JSON Schema without a `properties` object (e.g. a `z.record(...)` form)
- **WHEN** `buildWorkflows` runs
- **THEN** the build SHALL succeed (no static keys to check)
- **AND** the runtime strip SHALL still remove reserved names from any handler response that includes them

### Requirement: Runtime stripping of reserved response headers

The HTTP `TriggerSource` SHALL strip reserved response headers from the workflow handler's returned `headers` before writing the HTTP response. The strip SHALL be performed in the response-shaping path that constructs the wire envelope (currently `serializeHttpResult`), AFTER the existing default-`content-type` injection logic. Comparison SHALL be case-insensitive.

When at least one reserved header is stripped, the `TriggerSource` SHALL invoke `entry.exception({ kind: "trigger.exception", name: "http.response-header-stripped", input: { stripped: <sorted lowercased names> } })` exactly once per response. `entry.exception` is the per-trigger callable bound to `executor.fail` by the registry's `buildException` helper. The HTTP response SHALL be written and returned to the caller regardless of the exception emission's outcome — the strip succeeds first.

The HTTP response status, body, and non-reserved headers SHALL be unchanged by the strip. Stripping SHALL NOT cause the response to become a `500`; the caller observes a successful response that simply lacks the reserved headers the workflow attempted to set.

#### Scenario: Single reserved header stripped, exception emitted

- **GIVEN** a handler returning `{ status: 200, body: { ok: true }, headers: { "set-cookie": "session=x", "x-app": "v1" } }`
- **WHEN** the response is serialised
- **THEN** the wire response SHALL be `200` with body `{"ok":true}`, header `x-app: v1`, and NO `set-cookie` header
- **AND** `entry.exception` SHALL be invoked exactly once with `{ kind: "trigger.exception", name: "http.response-header-stripped", input: { stripped: ["set-cookie"] } }`

#### Scenario: Multiple reserved headers produce one exception

- **GIVEN** a handler returning `{ headers: { "set-cookie": "x", "location": "https://evil/", "x-frame-options": "ALLOWALL", "x-trace": "abc" } }`
- **WHEN** the response is serialised
- **THEN** the wire response SHALL include `x-trace: abc` and SHALL NOT include `set-cookie`, `location`, or `x-frame-options`
- **AND** `entry.exception` SHALL be invoked exactly once with `input.stripped` equal to `["location", "set-cookie", "x-frame-options"]` (sorted, lowercased)

#### Scenario: Case-insensitive strip

- **GIVEN** a handler returning `{ headers: { "Set-Cookie": "x", "LOCATION": "https://evil/" } }`
- **WHEN** the response is serialised
- **THEN** the wire response SHALL include neither `Set-Cookie` nor `LOCATION`
- **AND** `input.stripped` SHALL be `["location", "set-cookie"]`

#### Scenario: No reserved headers means no exception

- **GIVEN** a handler returning `{ headers: { "x-app-version": "1.0", "x-trace": "abc" } }`
- **WHEN** the response is serialised
- **THEN** both headers SHALL be on the wire response
- **AND** `entry.exception` SHALL NOT be invoked for this response

#### Scenario: Strip preserves status, body, content-type

- **GIVEN** a handler returning `{ status: 201, body: "ok", headers: { "set-cookie": "x" } }` and no author content-type
- **WHEN** the response is serialised
- **THEN** the wire response SHALL be `201` with body `"ok"` and `content-type: text/plain; charset=UTF-8`
- **AND** `set-cookie` SHALL NOT be present
