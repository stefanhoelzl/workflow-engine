## MODIFIED Requirements

### Requirement: Trigger payload validated on ingress

The HTTP trigger middleware SHALL validate the incoming composite payload `{ body, headers, url, method }` against the trigger's declared `inputSchema` (composed from `request.body` + `request.headers` + the declared `method`) before invoking the executor. Validation failure SHALL produce a `422 Unprocessable Entity` response with `{ error: "payload_validation_failed", issues: [...] }`. The middleware SHALL NOT invoke the executor on validation failure, and no `trigger.request` event SHALL be emitted to the bus on a validation failure.

The headers slot in the composite payload SHALL be the lowercased `Record<string, string>` produced by `headersToRecord`. When the trigger declares no `request.headers` zod schema, the composed JSON Schema for the headers slot SHALL be `{ type: "object", properties: {}, additionalProperties: false }` — any incoming header keys SHALL be stripped before reaching the handler, but their presence SHALL NOT cause validation to fail.

#### Scenario: Valid payload passes

- **GIVEN** a trigger with `request: { body: z.object({ x: z.number() }) }`
- **WHEN** a request with body `{ x: 42 }` arrives
- **THEN** the middleware SHALL pass the validated payload to the executor

#### Scenario: Invalid body returns 422

- **GIVEN** a trigger with `request: { body: z.object({ x: z.number() }) }`
- **WHEN** a request with body `{ x: "not a number" }` arrives
- **THEN** the middleware SHALL return `422` with structured `issues` from Zod
- **AND** the executor SHALL NOT be invoked

#### Scenario: Missing required header returns 422

- **GIVEN** a trigger with `request: { headers: z.object({ "x-trace-id": z.string() }) }`
- **WHEN** a request arrives without an `x-trace-id` header
- **THEN** the middleware SHALL return `422` with structured `issues` indicating the missing header
- **AND** the executor SHALL NOT be invoked
- **AND** no `trigger.request` event SHALL be emitted to the bus

#### Scenario: Wrong header type returns 422

- **GIVEN** a trigger with `request: { headers: z.object({ "x-retry-count": z.coerce.number().int() }) }`
- **WHEN** a request arrives with `x-retry-count: not-a-number`
- **THEN** the middleware SHALL return `422`
- **AND** the executor SHALL NOT be invoked

#### Scenario: Persisted trigger.request payload contains only validated headers

- **GIVEN** a trigger with `request: { headers: z.object({ "x-trace-id": z.string() }) }` and an incoming request with headers `x-trace-id: abc`, `cookie: session=…`, `authorization: Bearer …`
- **WHEN** the middleware dispatches the trigger and the EventStore persists the resulting `trigger.request` event
- **THEN** the persisted event's payload `headers` slot SHALL equal `{ "x-trace-id": "abc" }`
- **AND** the persisted event's payload SHALL NOT contain a `cookie` or `authorization` key

#### Scenario: Invalid path params return 422

- **GIVEN** a trigger with `path: "users/:userId"` and `params: z.object({ userId: z.string().uuid() })`
- **WHEN** a request to `/webhooks/users/not-a-uuid` arrives
- **THEN** the middleware SHALL return `422` indicating the params validation issue

### Requirement: Trigger handler output validated host-side against descriptor.outputSchema

The registry's `buildFire` closure SHALL, after `executor.invoke` resolves with `{ok: true, output}`, validate `output` against the trigger's `descriptor.outputSchema` using an Ajv-compiled JSON Schema validator. The validator SHALL be compiled-and-cached (WeakMap keyed on the schema object, shared with the input-validation cache). Validation failure SHALL cause the `fire` closure to resolve with `{ok: false, error: {message: "output validation: <summary>"}}` — the error SHALL NOT carry an `issues` field. Validation SHALL run for every trigger kind (HTTP, cron, future) uniformly; cron-kind triggers whose outputSchema matches any value (e.g. the JSON Schema for `z.unknown()`) SHALL pass unconditionally. The executor SHALL NOT itself perform this validation — the wrapping SHALL live in `buildFire` so that every `TriggerSource` sees the already-enforced `InvokeResult`.

For HTTP triggers with a declared `response.headers` zod schema, the composed `outputSchema` SHALL include the headers content schema, and a handler that returns headers not matching the schema SHALL produce the same `output validation` failure as a `response.body` mismatch. When `response.headers` is omitted, the `outputSchema`'s `headers` slot SHALL accept any `Record<string, string>` value.

#### Scenario: Valid trigger output passes through

- **GIVEN** an HTTP trigger whose handler returns `{ status: 202, body: "ok" }`
- **AND** the trigger's descriptor.outputSchema describes the default envelope `{status?, body?, headers?}`
- **WHEN** the handler resolves
- **THEN** `buildFire` SHALL resolve with `{ok: true, output: {status: 202, body: "ok"}}`

#### Scenario: Invalid trigger output surfaces as non-issues failure (routes to 500)

- **GIVEN** an HTTP trigger whose handler returns `{ statusCode: 202 }` (typo for `status`)
- **AND** the trigger's descriptor.outputSchema describes the strict default envelope (`additionalProperties: false`)
- **WHEN** the handler resolves
- **THEN** `buildFire` SHALL resolve with `{ok: false, error: {message: "output validation: ..."}}` (no `issues` field)
- **AND** the HTTP trigger source SHALL render this as HTTP 500 with `{error: "internal_error"}` (handler bug, not a client fault)

#### Scenario: response.headers mismatch surfaces as non-issues failure (routes to 500)

- **GIVEN** an HTTP trigger with `response: { headers: z.object({ "x-app-version": z.string() }) }` whose handler returns `{ headers: {} }`
- **WHEN** the handler resolves
- **THEN** `buildFire` SHALL resolve with `{ok: false, error: {message: "output validation: ..."}}` (no `issues` field)
- **AND** the HTTP trigger source SHALL render this as HTTP 500
- **AND** a `trigger.error` event SHALL be emitted to the bus

#### Scenario: Handler throw still passes through untouched

- **GIVEN** an HTTP trigger whose handler throws `new Error("boom")`
- **WHEN** the executor surfaces the error
- **THEN** `buildFire` SHALL resolve with `{ok: false, error: {message: "boom", stack: <stack>}}` (no `issues` field; not output-validation)
- **AND** the HTTP trigger source SHALL render this as HTTP 500

#### Scenario: Cron handler output passes through trivially

- **GIVEN** a cron trigger whose handler returns any value (string, undefined, object)
- **AND** the descriptor.outputSchema is the JSON Schema for `z.unknown()`
- **WHEN** the handler resolves
- **THEN** `buildFire` SHALL resolve with `{ok: true, output: <value>}`

#### Scenario: Output-validation failures emit structured issues on the event bus

- **GIVEN** an HTTP trigger whose handler returns `{ statusCode: 202 }` (typo)
- **WHEN** `buildFire` detects the validation failure
- **THEN** the resulting `trigger.error` event payload SHALL carry the `output validation` summary message
- **AND** the HTTP response (for the HTTP trigger kind) SHALL remain 500 with no structured issues in the response body
