## MODIFIED Requirements

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
