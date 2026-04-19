## MODIFIED Requirements

### Requirement: httpTrigger factory creates branded HttpTrigger

The SDK SHALL export an `httpTrigger(config)` factory that returns an `HttpTrigger` object carrying the brand symbol `Symbol.for("@workflow-engine/http-trigger")`. The config SHALL accept: `path` (required string), `method` (optional string, default `"POST"`), `body` (optional Zod schema, default `z.unknown()`), `query` (optional Zod object schema), `params` (optional Zod object schema), `handler` (required `(payload) => Promise<HttpTriggerResult>`).

The factory SHALL synthesise `inputSchema` and `outputSchema` on the returned trigger object:

- `inputSchema` SHALL be a Zod object schema describing `{ body, headers, url, method, params, query }` composed from the config's `body`, the declared `method`, the path-derived `params`, and the optional `query` schema.
- `outputSchema` SHALL be a Zod schema describing `HttpTriggerResult` (`{ status?: number, body?: unknown, headers?: Record<string, string> }`).

The author-facing API SHALL be unchanged — authors do not specify `inputSchema`/`outputSchema` directly.

#### Scenario: httpTrigger returns branded object

- **GIVEN** `httpTrigger({ path: "x", body: z.object({}), handler: async () => ({}) })`
- **WHEN** the returned value is inspected
- **THEN** the returned value SHALL have `[Symbol.for("@workflow-engine/http-trigger")]: true`
- **AND** SHALL expose `path`, `method`, `body`, `handler` as readonly properties
- **AND** SHALL expose `inputSchema` and `outputSchema` as Zod schemas

#### Scenario: Method defaults to POST

- **WHEN** `httpTrigger({ path: "x", handler: ... })` is called without `method`
- **THEN** the returned object SHALL have `method: "POST"`

#### Scenario: inputSchema composes body + headers + url + method + params + query

- **GIVEN** `httpTrigger({ path: "users/:userId", body: z.object({ x: z.number() }), query: z.object({ filter: z.string() }), handler })`
- **WHEN** `inputSchema.parse(x)` is called against a matching request shape
- **THEN** validation SHALL succeed for `{ body: { x: 42 }, headers: {...}, url: "...", method: "POST", params: { userId: "abc" }, query: { filter: "z" } }`

### Requirement: HTTP middleware delegates to executor

The HTTP `TriggerSource` SHALL expose a Hono middleware mounted at `/webhooks/*`. The middleware SHALL parse the URL as `/webhooks/<tenant>/<workflow-name>/<trigger-path>`, validate the tenant name against the tenant regex, look up the matching descriptor in the source's internal index, assemble the raw input `{ body, headers, url, method, params, query }`, invoke the shared validator `validate(descriptor, rawInput)`, and — on success — call `executor.invoke(workflow, descriptor, input)`. The middleware SHALL serialize the executor's `output` (on success) as the HTTP response.

The HTTP source SHALL be the only component that parses `/webhooks/*` URLs and the only component that converts handler output to an HTTP response.

#### Scenario: Successful trigger invocation

- **GIVEN** a registered HTTP trigger and a matching `POST /webhooks/<tenant>/<workflow>/<path>` request with valid payload
- **WHEN** the middleware processes the request
- **THEN** the middleware SHALL call `executor.invoke(workflow, descriptor, input)` exactly once with the validated composite input
- **AND** the middleware SHALL serialize the executor's `output` as the HTTP response

#### Scenario: Payload validation failure returns 422

- **GIVEN** a registered HTTP trigger with a body schema
- **WHEN** the request body fails schema validation via the shared validator
- **THEN** the middleware SHALL return a `422` response with `{ error: "payload_validation_failed", issues: [...] }`
- **AND** the middleware SHALL NOT call the executor

#### Scenario: No matching trigger returns 404

- **GIVEN** a request to `/webhooks/<tenant>/<workflow>/<path>` with no matching trigger
- **WHEN** the middleware processes the request
- **THEN** the middleware SHALL return `404`

#### Scenario: Non-JSON body returns 422

- **GIVEN** a request with a non-JSON body to a registered HTTP trigger
- **WHEN** the middleware tries to parse the body
- **THEN** the middleware SHALL return `422`

#### Scenario: Executor error returns 500

- **GIVEN** a registered HTTP trigger whose handler throws
- **WHEN** the middleware processes the request
- **THEN** `executor.invoke` SHALL return an error sentinel (not throw)
- **AND** the middleware SHALL serialize a `500` response with `{ error: "internal_error" }`

## ADDED Requirements

### Requirement: HTTP trigger is a TriggerSource

The HTTP trigger implementation SHALL conform to the `TriggerSource` interface defined in the `triggers` capability. The source SHALL be constructed in `main.ts` with `{ executor, logger }`, passed into `createWorkflowRegistry({ sources: [...] })`, and its exposed Hono middleware mounted in the server's middleware chain. `start()` and `stop()` SHALL be no-ops; the middleware is the active component and lives with the Hono server.

On `reconfigure(view)` the HTTP source SHALL replace its internal URL-pattern map atomically, keyed by `(tenant, workflow, method, path)`.

#### Scenario: HTTP source is wired through the registry

- **WHEN** the runtime boots
- **THEN** `main.ts` SHALL construct an `HttpTriggerSource` and pass it into `createWorkflowRegistry({ sources: [httpSource] })`
- **AND** `app.use(httpSource.middleware)` SHALL mount the middleware

#### Scenario: Reconfigure rebuilds the URL-pattern map atomically

- **GIVEN** the HTTP source is currently serving triggers from tenant `a`
- **WHEN** tenant `b` is registered with additional HTTP triggers
- **THEN** `reconfigure(newView)` SHALL rebuild the internal URL-pattern map so that after the call all triggers from `a` and `b` resolve correctly
- **AND** no request in flight SHALL observe a partially-updated map

## REMOVED Requirements

### Requirement: Trigger handler return value is the HTTP response

**Reason**: Merged into the new "HTTP middleware delegates to executor" requirement. The handler return value is still the basis for the HTTP response but is no longer a direct contract — it flows through `executor.invoke` and is serialised by the HTTP source. Response-shaping semantics (status/body/headers defaults) are retained in the executor spec.

**Migration**: No workflow-author-visible change. The `HttpTriggerResult` shape is unchanged; its serialization into an HTTP response is now split between the executor (wrapping) and the HTTP source (response construction).

### Requirement: Handler payload shape unchanged from prior model

**Reason**: Merged into the `httpTrigger factory` requirement, which now explicitly describes `inputSchema` as the composite of `{ body, headers, url, method, params, query }`. The payload shape is still identical; the description has been consolidated.

**Migration**: No workflow-author-visible change.
