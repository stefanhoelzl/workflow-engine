# HTTP Trigger Specification

## Purpose

Define the HTTP trigger factory, handler return value contract, payload shape, HTTP middleware delegation to the executor, trigger registry routing rules, and public ingress security context.
## Requirements
### Requirement: httpTrigger factory creates branded HttpTrigger

The SDK SHALL export an `httpTrigger(config)` factory that returns an `HttpTrigger` value that is BOTH branded with `Symbol.for("@workflow-engine/http-trigger")` AND callable as `(payload) => Promise<HttpTriggerResult>`. Invoking the callable SHALL run the user-supplied `handler(payload)` and return its result. The config SHALL accept: `method` (optional string, default `"POST"`), `body` (optional Zod schema, default `z.unknown()`), `responseBody` (optional Zod schema, default absent), `handler` (required `(payload) => Promise<HttpTriggerResult>`). The config SHALL NOT accept `path`, `params`, or `query` fields; passing any of them is a TypeScript error.

The returned value SHALL expose `method`, `body`, `inputSchema`, `outputSchema` as readonly own properties. The captured `handler` SHALL NOT be exposed as a public property — the callable IS the handler invocation path.

The factory SHALL synthesise `inputSchema` and `outputSchema` on the returned callable:
- `inputSchema` SHALL be a Zod schema describing the composite payload `{ body, headers, url, method }` composed from the config's `body` and the declared `method`.
- `outputSchema` SHALL be a Zod schema describing `HttpTriggerResult`. When `responseBody` is omitted, `outputSchema` SHALL describe `{ status?: number, body?: unknown, headers?: Record<string, string> }` with no required fields. When `responseBody` is declared, `outputSchema` SHALL describe `{ status?: number, body: <responseBody>, headers?: Record<string, string> }` — `body` becomes required and carries the declared schema's content constraint. Both shapes SHALL emit with `additionalProperties: false` at the envelope (Zod v4 default); tenants opting into a passthrough body SHALL apply `.loose()` on their own `responseBody` schema.

The runtime SHALL invoke the trigger by calling `Sandbox.run(triggerExportName, payload, ctx)` where `triggerExportName` is the user's export name from the workflow manifest.

#### Scenario: httpTrigger returns branded callable

- **GIVEN** `const t = httpTrigger({ body: z.object({}), handler: async () => ({}) })`
- **WHEN** the value is inspected
- **THEN** `t` SHALL be a function (callable)
- **AND** `t[HTTP_TRIGGER_BRAND]` SHALL be `true`
- **AND** `t.method`, `t.body`, `t.inputSchema`, `t.outputSchema` SHALL be exposed as readonly properties
- **AND** `t.handler`, `t.path`, `t.params`, `t.query` SHALL NOT be defined as own properties

#### Scenario: httpTrigger callable invokes the handler

- **GIVEN** `const t = httpTrigger({ handler: async (p) => ({ status: 202, body: p.body }) })`
- **WHEN** `await t({ body: { hello: "world" }, headers: {}, url: "/webhooks/t/w/x", method: "POST" })` is called
- **THEN** the result SHALL equal `{ status: 202, body: { hello: "world" } }`

#### Scenario: Default method is POST

- **WHEN** `httpTrigger({ handler: ... })` is called without `method`
- **THEN** the returned value's `.method` property SHALL equal `"POST"`

#### Scenario: Default body schema is z.unknown

- **WHEN** `httpTrigger({ handler: ... })` is called without `body`
- **THEN** the returned value's `.body` property SHALL be a Zod schema that accepts any value

#### Scenario: outputSchema envelope is strict by default

- **GIVEN** `const t = httpTrigger({ handler: async () => ({ status: 202 }) })` with no `responseBody` declared
- **WHEN** the synthesised `outputSchema`'s JSON Schema representation is inspected
- **THEN** it SHALL describe an object whose `status`, `body`, and `headers` properties are all optional
- **AND** it SHALL set `additionalProperties: false` at the envelope
- **AND** a handler return of `{ status: 202 }` SHALL validate successfully against it
- **AND** a handler return of `{ statusCode: 202 }` (typo) SHALL NOT validate successfully against it

#### Scenario: Declaring responseBody makes body required and content-strict

- **GIVEN** `const t = httpTrigger({ responseBody: z.object({ orderId: z.string() }), handler: async () => ({ body: { orderId: "x" } }) })`
- **WHEN** the synthesised `outputSchema`'s JSON Schema representation is inspected
- **THEN** it SHALL describe an object whose `body` property is required
- **AND** the `body` sub-schema SHALL require `orderId: string` with `additionalProperties: false` (Zod default on the declared schema)
- **AND** a handler return of `{ body: { orderId: "x" } }` SHALL validate successfully
- **AND** a handler return of `{ status: 202 }` (body missing) SHALL NOT validate successfully
- **AND** a handler return of `{ body: { orderId: "x", debug: true } }` SHALL NOT validate successfully unless the tenant declared `responseBody` with `.loose()`

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

#### Scenario: Handler controls status

- **GIVEN** a handler returning `{ status: 202 }`
- **WHEN** the trigger fires
- **THEN** the HTTP response SHALL be `202` with empty body and no extra headers

#### Scenario: Handler controls body

- **GIVEN** a handler returning `{ body: { ok: true } }`
- **WHEN** the trigger fires
- **THEN** the HTTP response SHALL be `200` with body `{"ok":true}` (JSON-serialized)

#### Scenario: Handler controls headers

- **GIVEN** a handler returning `{ headers: { "X-Trace": "abc" } }`
- **WHEN** the trigger fires
- **THEN** the HTTP response SHALL include header `X-Trace: abc`

### Requirement: Handler payload shape

The HTTP trigger handler SHALL receive a single `payload` argument with exactly these fields: `body` (validated against the trigger's body schema), `headers` (`Record<string, string>`), `url` (string, the raw request URL including any query string), `method` (string). The payload SHALL NOT contain `params` or `query` fields — the URL carries no structured data to the handler. A handler that needs a value from the query string SHALL parse it explicitly via `new URL(payload.url).searchParams`.

#### Scenario: Payload carries body, headers, url, method only

- **GIVEN** a `POST /webhooks/acme/cronitor/cronitorWebhook?delivery=abc` request with body `{ "active": true }`
- **AND** a registered trigger `cronitorWebhook` with body schema `z.object({ active: z.boolean() })`
- **WHEN** the handler is invoked
- **THEN** `payload.body` SHALL equal `{ active: true }`
- **AND** `payload.headers` SHALL contain all request headers
- **AND** `payload.url` SHALL be `/webhooks/acme/cronitor/cronitorWebhook?delivery=abc`
- **AND** `payload.method` SHALL be `"POST"`
- **AND** `Object.keys(payload)` SHALL equal `["body", "headers", "url", "method"]` (in any order)
- **AND** `payload.params` SHALL be `undefined`
- **AND** `payload.query` SHALL be `undefined`

#### Scenario: Handler parses query string manually when needed

- **GIVEN** a `POST /webhooks/acme/w/t?foo=bar&x=1` request
- **AND** a handler that calls `new URL(payload.url).searchParams.get("foo")`
- **WHEN** the handler runs
- **THEN** the call SHALL return `"bar"`

### Requirement: HTTP middleware delegates to executor

The HTTP `TriggerSource` SHALL expose a Hono middleware mounted at `/webhooks/*`. The middleware SHALL parse the URL as exactly three segments after the `/webhooks/` prefix: `<tenant>`, `<workflow-name>`, `<trigger-name>`. URLs with more or fewer segments SHALL return `404`. `<tenant>` and `<workflow-name>` SHALL match the tenant regex `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`; `<trigger-name>` SHALL match the trigger-name regex `^[A-Za-z_][A-Za-z0-9_]{0,62}$`. Query strings on the URL SHALL be tolerated (they pass through unchanged in `payload.url`) but SHALL NOT be parsed into a structured payload field.

The middleware SHALL look up the matching entry via a per-tenant constant-time `Map` keyed by `(workflow-name, trigger-name)`. If no entry is found, or the entry's `descriptor.method` does not equal the request's method, the middleware SHALL return `404` (identical to "no matching trigger" to prevent enumeration per `/SECURITY.md §3 R-W5`).

On match, the middleware SHALL parse the JSON body (422 on invalid JSON), assemble the raw input `{ body, headers, url, method }`, and call `entry.fire(input)` on the matched `TriggerEntry`. The HTTP source SHALL NOT call `executor.invoke` directly; all executor interaction happens inside the `fire` closure captured on the `TriggerEntry`, which is constructed by the `WorkflowRegistry` via `buildFire` and performs input-schema validation + executor dispatch. The middleware SHALL serialize the returned `InvokeResult<unknown>` into the HTTP response: `{ok: true, output}` → serialize `output`; `{ok: false, error: {issues, ...}}` → `422` with the validation issues; `{ok: false, error: {...}}` without `issues` → `500` with `{ error: "internal_error" }`.

The HTTP source SHALL be the only component that parses `/webhooks/*` URLs and the only component that converts handler output to an HTTP response.

#### Scenario: Successful trigger invocation

- **GIVEN** a registered HTTP trigger and a matching `POST /webhooks/<tenant>/<workflow>/<trigger-name>` request with valid body
- **WHEN** the middleware processes the request
- **THEN** the middleware SHALL resolve the matching `TriggerEntry` via its per-tenant routing index
- **AND** the middleware SHALL call `entry.fire(input)` exactly once with `{body, headers, url, method}`
- **AND** on `{ok: true, output}` the middleware SHALL serialize `output` as the HTTP response

#### Scenario: Payload validation failure returns 422

- **GIVEN** a registered HTTP trigger with a body schema requiring `{name: string}`
- **WHEN** a request arrives with body `{}` (missing `name`)
- **THEN** the middleware SHALL call `entry.fire(input)`
- **AND** the `fire` closure SHALL resolve to `{ok: false, error: {issues: [...]}}`
- **AND** the middleware SHALL return a `422` response with `{ error: "payload_validation_failed", issues: [...] }`
- **AND** `executor.invoke` SHALL NOT be called

#### Scenario: No matching trigger returns 404

- **GIVEN** a request to `/webhooks/<tenant>/<workflow>/<unknown-trigger-name>` with a valid three-segment shape but no registered trigger with that name
- **WHEN** the middleware processes the request
- **THEN** the middleware SHALL return `404`

#### Scenario: URL with extra segments returns 404

- **GIVEN** a request to `/webhooks/<tenant>/<workflow>/<trigger-name>/extra`
- **WHEN** the middleware processes the request
- **THEN** the middleware SHALL return `404`
- **AND** `entry.fire` SHALL NOT be called

#### Scenario: URL with missing segments returns 404

- **GIVEN** a request to `/webhooks/<tenant>/<workflow>` (only two segments)
- **WHEN** the middleware processes the request
- **THEN** the middleware SHALL return `404`

#### Scenario: URL segment fails identifier regex returns 404

- **GIVEN** a request to `/webhooks/<tenant>/<workflow>/weird$name`
- **WHEN** the middleware processes the request
- **THEN** the middleware SHALL return `404`

#### Scenario: Method mismatch returns 404

- **GIVEN** a registered HTTP trigger with `method: "POST"`
- **WHEN** a `GET` request to the trigger's URL is processed
- **THEN** the middleware SHALL return `404`
- **AND** `entry.fire` SHALL NOT be called

#### Scenario: Query string passes through to payload.url unparsed

- **GIVEN** a request `POST /webhooks/<tenant>/<workflow>/<trigger-name>?delivery=abc&x=1` with valid body
- **WHEN** the middleware assembles the composite input
- **THEN** the `payload.url` SHALL contain the full URL including `?delivery=abc&x=1`
- **AND** the payload SHALL NOT contain a `query` field
- **AND** the payload SHALL NOT contain a `params` field

#### Scenario: Non-JSON body returns 422

- **GIVEN** a registered HTTP trigger
- **WHEN** the request body is not valid JSON
- **THEN** the middleware SHALL return `422` without calling `entry.fire`

#### Scenario: HTTP source implements the TriggerSource contract

- **GIVEN** the HTTP trigger source factory
- **WHEN** the returned value is inspected
- **THEN** it SHALL expose `kind: "http"`, `start()`, `stop()`, and `reconfigure(tenant, entries): Promise<ReconfigureResult>`
- **AND** its `reconfigure` SHALL store entries keyed by tenant (internally) so that `reconfigure("acme", [])` clears only `acme`'s entries and not any other tenant's

#### Scenario: Executor error returns 500

- **GIVEN** a registered HTTP trigger whose handler throws
- **WHEN** the middleware processes the request
- **THEN** `entry.fire` SHALL return `{ok: false, error: {message, stack}}` without `issues`
- **AND** the middleware SHALL serialize a `500` response with `{ error: "internal_error" }`

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
