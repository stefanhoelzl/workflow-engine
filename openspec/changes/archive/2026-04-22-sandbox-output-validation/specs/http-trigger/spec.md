## MODIFIED Requirements

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
