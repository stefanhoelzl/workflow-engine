# HTTP Trigger Specification

## Purpose

Define the HTTP trigger factory, handler return value contract, payload shape, HTTP middleware delegation to the executor, trigger registry routing rules, and public ingress security context.
## Requirements
### Requirement: httpTrigger factory creates branded HttpTrigger

The SDK SHALL export an `httpTrigger(config)` factory that returns an `HttpTrigger` value that is BOTH branded with `Symbol.for("@workflow-engine/http-trigger")` AND callable as `(payload) => Promise<HttpTriggerResult>`. Invoking the callable SHALL run the user-supplied `handler(payload)` and return its result. The config SHALL accept: `path` (required string), `method` (optional string, default `"POST"`), `body` (optional Zod schema, default `z.unknown()`), `query` (optional Zod object schema), `params` (optional Zod object schema), `handler` (required `(payload) => Promise<HttpTriggerResult>`).

The returned value SHALL expose `path`, `method`, `body`, `params`, `query`, `schema` as readonly own properties. The captured `handler` SHALL NOT be exposed as a public property — the callable IS the handler invocation path.

The runtime SHALL invoke the trigger by calling `Sandbox.run(triggerExportName, payload, ctx)` where `triggerExportName` is the user's export name from the workflow manifest. No additional bundle-level shim is required to bridge from the trigger value to a callable — the value is itself callable.

#### Scenario: httpTrigger returns branded callable

- **GIVEN** `const t = httpTrigger({ path: "x", body: z.object({}), handler: async () => ({}) })`
- **WHEN** the value is inspected
- **THEN** `t` SHALL be a function (callable)
- **AND** `t[HTTP_TRIGGER_BRAND]` SHALL be `true`
- **AND** `t.path`, `t.method`, `t.body`, `t.params`, `t.query`, `t.schema` SHALL be exposed as readonly properties
- **AND** `t.handler` SHALL NOT be defined as an own property

#### Scenario: httpTrigger callable invokes the handler

- **GIVEN** `const t = httpTrigger({ path: "x", handler: async (p) => ({ status: 202, body: p.body }) })`
- **WHEN** `await t({ body: { hello: "world" }, headers: {}, url: "/x", method: "POST", params: {}, query: {} })` is called
- **THEN** the result SHALL equal `{ status: 202, body: { hello: "world" } }`

#### Scenario: Default method is POST

- **WHEN** `httpTrigger({ path: "x", handler: ... })` is called without `method`
- **THEN** the returned value's `.method` property SHALL equal `"POST"`

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

### Requirement: Handler payload shape unchanged from prior model

The handler SHALL receive a single `payload` argument with fields: `body` (validated), `headers` (`Record<string, string>`), `url` (string), `method` (string), `params` (`Record<string, string>`), `query` (`Record<string, string | string[]>`).

#### Scenario: Payload carries body, headers, url, method, params, query

- **GIVEN** a `POST /webhooks/users/abc/status?x=1` request with body `{ "active": true }`
- **AND** a trigger with path `"users/:userId/status"`
- **WHEN** the handler is invoked
- **THEN** `payload.body` SHALL be `{ active: true }`
- **AND** `payload.headers` SHALL contain all request headers
- **AND** `payload.url` SHALL be the full request path with query string
- **AND** `payload.method` SHALL be `"POST"`
- **AND** `payload.params` SHALL be `{ userId: "abc" }`
- **AND** `payload.query` SHALL be `{ x: "1" }`

### Requirement: HTTP middleware delegates to executor

The HTTP trigger middleware SHALL match `/webhooks/*` requests against the HTTP `TriggerSource`'s internal routing index, normalize the request into an `input` object, and call `entry.fire(input)` on the matched entry. The middleware SHALL serialize the returned `InvokeResult<unknown>` into the HTTP response.

The HTTP `TriggerSource` SHALL NOT call `executor.invoke` directly. All executor interaction happens via the `fire` closure captured on the `TriggerEntry`, which is constructed by the `WorkflowRegistry`.

Normalization of the request into `input` SHALL produce `{body, headers, url, method, params, query}` (unchanged from today). The middleware SHALL NOT perform Zod/Ajv validation against the descriptor's `inputSchema` — that validation is performed inside the `fire` closure by the registry's `buildFire` helper.

#### Scenario: Successful trigger invocation

- **GIVEN** a registered HTTP trigger and a matching `POST /webhooks/<tenant>/<workflow>/<path>` request
- **WHEN** the middleware processes the request
- **THEN** the middleware SHALL resolve the matching `TriggerEntry` via its internal routing index
- **AND** the middleware SHALL call `entry.fire(input)` exactly once with the normalized input
- **AND** on `{ok: true, output}` the middleware SHALL serialize `output` as the HTTP response
- **AND** on `{ok: false, error}` the middleware SHALL return `500` with body `{error: "internal_error"}` (unchanged from today)

#### Scenario: No matching trigger returns 404

- **GIVEN** a request to `/webhooks/<tenant>/<workflow>/<path>` with no matching trigger in the HTTP source's index
- **WHEN** the middleware processes the request
- **THEN** the middleware SHALL return `404`

#### Scenario: Input validation failure does not reach the executor

- **GIVEN** a registered HTTP trigger with a body schema requiring `{name: string}`
- **WHEN** a request arrives with body `{}` (missing `name`)
- **THEN** the middleware SHALL call `entry.fire(input)` with the unnormalized input
- **AND** the `fire` closure SHALL resolve to `{ok: false, error: {message: <validation details>}}`
- **AND** the middleware SHALL return a `422` response with the validation details in the body
- **AND** `executor.invoke` SHALL NOT be called

#### Scenario: HTTP source implements the TriggerSource contract

- **GIVEN** the HTTP trigger source factory
- **WHEN** the returned value is inspected
- **THEN** it SHALL expose `kind: "http"`, `start()`, `stop()`, and `reconfigure(tenant, entries): Promise<ReconfigureResult>`
- **AND** its `reconfigure` SHALL store entries keyed by tenant (internally) so that `reconfigure("acme", [])` clears only `acme`'s entries and not any other tenant's

#### Scenario: HTTP source maps user-visible errors into {ok: false}

- **GIVEN** an HTTP source that detects an invalid configuration during reconfigure (e.g., two triggers for the same tenant/workflow share a routing key under today's configurable-path model)
- **WHEN** `reconfigure(tenant, entries)` is called with the offending entries
- **THEN** the source SHALL return `{ok: false, errors: [TriggerConfigError, …]}`
- **AND** entries that did not conflict SHALL NOT be partially applied (the whole tenant's replacement is atomic or not at all)

### Requirement: Trigger registry routing rules

The HTTP trigger registry SHALL match by path and method. Static paths SHALL take priority over parameterized ones. Path syntax supports static segments, named parameters (`:name`), and wildcard catch-all (`*name`). Multi-value query parameters SHALL be returned as arrays only when the query schema declares the field as an array; otherwise, the last value wins.

#### Scenario: Static path beats parameterized

- **GIVEN** trigger A with path `"users/admin"` and trigger B with path `"users/:userId"`
- **WHEN** `/webhooks/users/admin` is requested
- **THEN** trigger A SHALL be matched

#### Scenario: Parameterized path used when no static match

- **GIVEN** triggers A (`"users/admin"`) and B (`"users/:userId"`)
- **WHEN** `/webhooks/users/xyz` is requested
- **THEN** trigger B SHALL be matched with `params.userId = "xyz"`

#### Scenario: Wildcard catch-all extracts remaining path

- **GIVEN** a trigger with path `"files/*rest"`
- **WHEN** `/webhooks/files/docs/2024/report.pdf` is requested
- **THEN** the trigger SHALL be matched with `params.rest = "docs/2024/report.pdf"`

### Requirement: Public ingress security context

The HTTP trigger SHALL conform to the threat model documented at `/SECURITY.md S3 Webhook Ingress`. HTTP triggers are the project's PUBLIC ingress surface; the threat model treats all trigger input as attacker-controlled.

The HTTP trigger SHALL additionally conform to the tenant isolation invariant documented at `/SECURITY.md §1 "Tenant isolation invariants"` (I-T2). The `/webhooks/:tenant/:workflow/:path` route parses the `<tenant>` and `<workflow>` path parameters, validates both against the tenant identifier regex, and looks up the trigger in the registry keyed by `(tenant, workflow)`. A public caller cannot route a webhook into another tenant's workflow because the registry lookup requires an exact `(tenant, workflow)` pair match. The resulting `InvocationEvent` carries a `tenant` field stamped from the workflow's registration — not from the URL — so a request that matches a valid `(tenant, workflow)` pair produces an event whose `tenant` is correct by construction.

Changes that introduce new threats, weaken or remove a documented mitigation, add new trigger types, extend the payload shape passed to the sandbox, change trigger-to-route mapping semantics, relax the `(tenant, workflow)` lookup scoping, or conflict with the rules in `/SECURITY.md S3` or the invariant statement in `/SECURITY.md §1` MUST update the corresponding section(s) of `/SECURITY.md` in the same change proposal.

#### Scenario: Change alters threat model

- **GIVEN** a change to this capability that affects an item enumerated in `/SECURITY.md S3` or the tenant-isolation invariant in `/SECURITY.md §1`
- **WHEN** the change is proposed
- **THEN** the proposal SHALL include corresponding updates to `/SECURITY.md S3` and/or `/SECURITY.md §1`

