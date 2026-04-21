## MODIFIED Requirements

### Requirement: httpTrigger factory creates branded HttpTrigger

The SDK SHALL export an `httpTrigger(config)` factory that returns an `HttpTrigger` value that is BOTH branded with `Symbol.for("@workflow-engine/http-trigger")` AND callable as `(payload) => Promise<HttpTriggerResult>`. Invoking the callable SHALL run the user-supplied `handler(payload)` and return its result. The config SHALL accept: `method` (optional string, default `"POST"`), `body` (optional Zod schema, default `z.unknown()`), `handler` (required `(payload) => Promise<HttpTriggerResult>`). The config SHALL NOT accept `path`, `params`, or `query` fields; passing any of them is a TypeScript error.

The returned value SHALL expose `method`, `body`, `inputSchema`, `outputSchema` as readonly own properties. The captured `handler` SHALL NOT be exposed as a public property — the callable IS the handler invocation path.

The factory SHALL synthesise `inputSchema` and `outputSchema` on the returned callable:
- `inputSchema` SHALL be a Zod schema describing the composite payload `{ body, headers, url, method }` composed from the config's `body` and the declared `method`.
- `outputSchema` SHALL be a Zod schema describing `HttpTriggerResult` (`{ status?: number, body?: unknown, headers?: Record<string, string> }`).

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

### Requirement: HTTP middleware delegates to executor

The HTTP `TriggerSource` SHALL expose a Hono middleware mounted at `/webhooks/*`. The middleware SHALL parse the URL as exactly three segments after the `/webhooks/` prefix: `<tenant>`, `<workflow-name>`, `<trigger-name>`. URLs with more or fewer segments SHALL return `404`. Each segment SHALL be validated against the tenant/trigger identifier regex; non-matching segments SHALL return `404`. Query strings on the URL SHALL be tolerated (they pass through unchanged in `payload.url`) but SHALL NOT be parsed into a structured payload field.

The middleware SHALL look up the matching descriptor via a constant-time `Map<string, SourceEntry>` keyed by `${tenant}/${workflow}/${trigger-name}`. If no entry is found, or the entry's `method` does not equal the request's method, the middleware SHALL return `404` (identical to "no matching trigger" to prevent enumeration per `/SECURITY.md §3 R-W5`).

On match, the middleware SHALL parse the JSON body (422 on invalid JSON), assemble the raw input `{ body, headers, url, method }`, invoke the shared validator `validate(descriptor, rawInput)` (422 on invalid), and call `executor.invoke(tenant, workflow, descriptor, input, bundleSource)`. The middleware SHALL serialize the executor's `output` (on success) as the HTTP response; on executor error it SHALL return `500` with `{ error: "internal_error" }`.

The HTTP source SHALL be the only component that parses `/webhooks/*` URLs and the only component that converts handler output to an HTTP response.

#### Scenario: Successful trigger invocation

- **GIVEN** a registered HTTP trigger and a matching `POST /webhooks/<tenant>/<workflow>/<trigger-name>` request with valid payload
- **WHEN** the middleware processes the request
- **THEN** the middleware SHALL call `executor.invoke(tenant, workflow, descriptor, input, bundleSource)` exactly once with the validated composite input
- **AND** the middleware SHALL serialize the executor's `output` as the HTTP response

#### Scenario: Payload validation failure returns 422

- **GIVEN** a registered HTTP trigger with a body schema
- **WHEN** the request body fails schema validation via the shared validator
- **THEN** the middleware SHALL return a `422` response with `{ error: "payload_validation_failed", issues: [...] }`
- **AND** the middleware SHALL NOT call the executor

#### Scenario: No matching trigger returns 404

- **GIVEN** a request to `/webhooks/<tenant>/<workflow>/<unknown-trigger-name>` with a valid three-segment shape but no registered trigger with that name
- **WHEN** the middleware processes the request
- **THEN** the middleware SHALL return `404`

#### Scenario: URL with extra segments returns 404

- **GIVEN** a request to `/webhooks/<tenant>/<workflow>/<trigger-name>/extra`
- **WHEN** the middleware processes the request
- **THEN** the middleware SHALL return `404`
- **AND** the middleware SHALL NOT call the executor

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
- **AND** the middleware SHALL NOT call the executor

#### Scenario: Query string passes through to payload.url unparsed

- **GIVEN** a request `POST /webhooks/<tenant>/<workflow>/<trigger-name>?delivery=abc&x=1` with valid body
- **WHEN** the middleware assembles the composite input
- **THEN** the `payload.url` SHALL contain the full URL including `?delivery=abc&x=1`
- **AND** the payload SHALL NOT contain a `query` field
- **AND** the payload SHALL NOT contain a `params` field

#### Scenario: Non-JSON body returns 422

- **GIVEN** a request with a non-JSON body to a registered HTTP trigger
- **WHEN** the middleware tries to parse the body
- **THEN** the middleware SHALL return `422`

#### Scenario: Executor error returns 500

- **GIVEN** a registered HTTP trigger whose handler throws
- **WHEN** the middleware processes the request
- **THEN** `executor.invoke` SHALL return an error sentinel (not throw)
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

## REMOVED Requirements

### Requirement: Trigger registry routing rules

**Reason**: The HTTP trigger URL is now mechanically derived from the trigger's export name (`/webhooks/<tenant>/<workflow>/<trigger-name>`). There is no author-chosen path component, no parameterized-segment syntax (`:name`), and no wildcard-segment syntax (`*rest`). Static-vs-parameterized precedence has no meaning when all URLs are static by construction. The lookup data structure becomes a constant-time `Map<string, SourceEntry>.get()` with no ordering concerns.

**Migration**: Workflow authors who previously used `:param` or `*wildcard` syntax to extract dynamic values from the URL SHALL move the dynamic data into the request body or query string. Handlers that read the old `payload.params` field SHALL read from `payload.body` or parse `new URL(payload.url).searchParams` instead. Authors who relied on a specific literal URL suffix SHALL rename the exported trigger to match (e.g., `export const callback = httpTrigger({...})` produces `/webhooks/<tenant>/<workflow>/callback`), subject to the identifier regex `/^[A-Za-z_][A-Za-z0-9_]{0,62}$/`. The trailing-slash-plus-suffix patterns (`"/v1/callback"`) are not representable as a single trigger; fan out across multiple exports or a dedicated workflow if the literal URL is required.

## ADDED Requirements

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
