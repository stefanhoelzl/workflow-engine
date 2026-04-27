# Payload Validation Specification

## Purpose

Provide runtime validation of trigger payloads and action inputs/outputs against their Zod schemas, with structured error reporting and HTTP 422 responses at the trigger boundary.
## Requirements
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

### Requirement: Action input validated at host bridge

The runtime SHALL validate every action call's input against the action's declared input JSON Schema at the host bridge (inside the `__hostCallAction` implementation). Validation failure SHALL throw a serializable validation error back into the calling guest context; the action's handler SHALL NOT execute. Validation SHALL apply uniformly whether the call originated from a trigger handler, another action, or any other handler.

#### Scenario: Invalid action input throws into caller

- **GIVEN** action `b` with `input: z.object({ x: z.number() })`
- **WHEN** caller invokes `await b({ x: "wrong" })`
- **THEN** the SDK wrapper's first step (host bridge call) SHALL throw a validation error into the caller
- **AND** `b`'s handler SHALL NOT be invoked

### Requirement: Validation errors carry structured issues

Validation errors thrown across the bridge SHALL carry an `issues` array compatible with Zod's `.issues` shape, each entry containing `path` (array) and `message` (string). The error SHALL be JSON-serializable for transport across the host/sandbox boundary.

#### Scenario: Issues array preserved across bridge

- **GIVEN** a Zod error with two issues
- **WHEN** the validation error is thrown across the bridge
- **THEN** the rethrown error SHALL carry both issues with `path` and `message` preserved

### Requirement: HTTP 422 response for validation failures

The HTTP trigger middleware SHALL catch validation errors and return an HTTP 422 (Unprocessable Entity) response with a structured JSON body.

The response body SHALL contain:
- `error: "payload_validation_failed"` --- a stable error code
- `issues: { path: string; message: string }[]` --- the validation issues

The response SHALL NOT expose library-specific error details (e.g., Zod error codes, validation type identifiers).

#### Scenario: Malformed webhook payload returns 422

- **GIVEN** an HTTP trigger with a body schema `{ orderId: z.string() }`
- **WHEN** a POST request arrives at `/webhooks/order` with body `{ "orderId": 123 }`
- **THEN** the response status is 422
- **AND** the response body is `{ "error": "payload_validation_failed", "issues": [{ "path": "orderId", "message": "Expected string, received number" }] }`

#### Scenario: Valid webhook payload is accepted normally

- **GIVEN** an HTTP trigger with a body schema `{ orderId: z.string() }`
- **WHEN** a POST request arrives at `/webhooks/order` with body `{ "orderId": "abc" }`
- **THEN** the response is the handler's return value (not a 422)

#### Scenario: Invalid JSON still returns 422

- **GIVEN** an HTTP trigger for path `"order"`
- **WHEN** a POST request arrives with an unparseable body
- **THEN** the response status is 422

### Requirement: Security context

The implementation SHALL conform to the threat model documented at
`/SECURITY.md S3 Webhook Ingress`, which enumerates the trust level,
entry points, threats, current mitigations, residual risks, and rules
governing this capability. Zod-based payload validation is the only
pre-sandbox filter between attacker-controlled public input and the
action trust boundary; removing or narrowing it materially changes
the threat model.

Changes to this capability that introduce new threats, weaken or remove
a documented mitigation, bypass validation for any trigger type,
change what portions of an incoming request are validated, or conflict
with the rules listed in `/SECURITY.md S3` MUST update
`/SECURITY.md S3` in the same change proposal.

#### Scenario: Change alters behaviors covered by the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change affects a threat, mitigation, residual risk, or
  rule enumerated in `/SECURITY.md S3`
- **THEN** the proposal SHALL include the corresponding updates to
  `/SECURITY.md S3`
- **AND** the updates SHALL be reviewed before the change is archived

#### Scenario: Change is orthogonal to the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change does not affect any item enumerated in
  `/SECURITY.md S3`
- **THEN** no update to `/SECURITY.md S3` is required
- **AND** the proposal SHALL note that threat-model alignment was
  checked

### Requirement: Action output validated at the host-side bridge handler

The sdk-support plugin's guest-function-descriptor handler for `__sdkDispatchAction` SHALL, after the captured `handler(input)` guest callable resolves with a raw value, validate the raw value against the action's declared output schema using the host-side validator exported by the `host-call-action` plugin (`validateActionOutput(name, raw)`). The validator's underlying schema SHALL be a single instance constructed once at plugin boot from the manifest's per-action output schema, reused for every action invocation for the lifetime of the sandbox. Per-request validator construction is forbidden. Validation SHALL run on the host before the dispatcher handler resolves to the guest caller. Validation failure SHALL throw a `ValidationError` (carrying the same `issues` array shape used by input validation) back into the guest caller; the guest SHALL observe the throw as a rejection of its `await __sdk.dispatchAction(...)` call.

Output validation SHALL NOT run inside the sandbox. The SDK's `action()` callable SHALL NOT construct or pass a `completer` closure for output validation; the `__sdk.dispatchAction` surface SHALL accept `(name, input, handler)` and SHALL NOT accept a `completer` argument.

#### Scenario: Invalid action output throws into caller host-side

- **GIVEN** action `b` with `output: z.string()` whose handler returns `42`
- **WHEN** caller invokes `await b(validInput)`
- **THEN** the host-side input validation SHALL succeed (input is valid)
- **AND** `b`'s handler SHALL execute and return `42`
- **AND** the sdk-support plugin's dispatcher handler SHALL invoke `validateActionOutput("b", 42)` on the host
- **AND** the host-side validator SHALL throw a ValidationError whose `issues` array describes the type mismatch
- **AND** the rejection SHALL propagate to the guest caller before any value is returned from `__sdk.dispatchAction`

#### Scenario: Valid action output flows through unchanged

- **GIVEN** action `b` with `output: z.string()` whose handler returns `"ok"`
- **WHEN** caller invokes `await b(validInput)`
- **THEN** the host-side validator SHALL return the validated value
- **AND** the dispatcher handler SHALL resolve to `"ok"` and the caller SHALL receive `"ok"`

#### Scenario: Guest cannot supply a lenient validator

- **GIVEN** a tampered SDK bundle that attempts to pass a no-op closure as a fourth `completer` argument to `__sdk.dispatchAction`
- **WHEN** the call is dispatched
- **THEN** the sdk-support plugin's handler SHALL ignore any extra argument
- **AND** output validation SHALL still run host-side via `validateActionOutput(name, raw)`
- **AND** a return value that does not match the declared output schema SHALL still throw

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

