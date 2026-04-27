## MODIFIED Requirements

### Requirement: Action output validated at the host-side bridge handler

The sdk-support plugin's guest-function-descriptor handler for `__sdkDispatchAction` SHALL, after the captured `handler(input)` guest callable resolves with a raw value, validate the raw value against the action's declared output schema using the host-side validator exported by the `host-call-action` plugin (`validateActionOutput(name, raw)`). The validator's underlying schema SHALL be a single instance constructed once at plugin boot from the manifest's per-action output schema, reused for every action invocation for the lifetime of the sandbox. Per-request validator construction is forbidden. Validation SHALL run on the host before the dispatcher handler resolves to the guest caller. Validation failure SHALL throw a `ValidationError` (carrying the same `issues` array shape used by input validation) back into the guest caller; the guest SHALL observe the throw as a rejection of its `await __sdk.dispatchAction(...)` call.

Output validation SHALL NOT run inside the sandbox. The SDK's `action()` callable SHALL NOT construct or pass a `completer` closure for output validation; the `__sdk.dispatchAction` surface SHALL accept `(name, input, handler)` and SHALL NOT accept a `completer` argument.

#### Scenario: Invalid action output throws into caller host-side

- **GIVEN** action `b` with `output: z.string()` whose handler returns `42`
- **WHEN** caller invokes `await b(validInput)`
- **THEN** the host-side input validation SHALL succeed (input is valid)
- **AND** `b`'s handler SHALL execute and return `42`
- **AND** the sdk-support plugin's dispatcher handler SHALL invoke `validateActionOutput("b", 42)` on the host
- **AND** the host-side validator SHALL throw a `ValidationError` whose `issues` array describes the type mismatch
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

The registry's `buildFire` closure SHALL, after `executor.invoke` resolves with `{ok: true, output}`, validate `output` against the trigger's `descriptor.outputSchema` using a schema validator attached to the registered workflow at `WorkflowRegistry` registration time. The same validator instance SHALL serve every invocation of the workflow until the workflow is unregistered or replaced; per-request validator construction is NOT permitted. Cache abstractions are permitted but not required. Validation failure SHALL cause the `fire` closure to resolve with `{ok: false, error: {message: "output validation: <summary>"}}` — the error SHALL NOT carry an `issues` field. Validation SHALL run for every trigger kind (HTTP, cron, future) uniformly; cron-kind triggers whose outputSchema accepts any value (e.g. the schema rehydrated from the JSON Schema `{}`) SHALL pass unconditionally. The executor SHALL NOT itself perform this validation — the wrapping SHALL live in `buildFire` so that every `TriggerSource` sees the already-enforced `InvokeResult`.

#### Scenario: Valid trigger output passes through

- **GIVEN** an HTTP trigger whose handler returns `{ status: 202, body: "ok" }`
- **AND** the trigger's descriptor.outputSchema describes the default envelope `{status?, body?, headers?}`
- **WHEN** the `fire` closure resolves
- **THEN** the `fire` closure SHALL resolve with `{ok: true, output: {status: 202, body: "ok"}}`

#### Scenario: Invalid trigger output surfaces as non-issues failure (routes to 500)

- **GIVEN** an HTTP trigger whose handler returns `{ statusCode: 202 }` (typo for `status`)
- **AND** the trigger's descriptor.outputSchema describes the default envelope with `additionalProperties: false`
- **WHEN** the `fire` closure resolves
- **THEN** the `fire` closure SHALL resolve with `{ok: false, error: {message}}`
- **AND** `error.message` SHALL begin with `"output validation:"` and include at least one `ValidationIssue`-style summary field reference
- **AND** `error.issues` SHALL be undefined
- **AND** the HTTP trigger source SHALL render this as HTTP 500 with `{error: "internal_error"}` (handler bug, not a client fault)

#### Scenario: Handler throw still passes through untouched

- **GIVEN** an HTTP trigger whose handler throws `new Error("boom")`
- **WHEN** the `fire` closure resolves
- **THEN** the `fire` closure SHALL resolve with `{ok: false, error: {message: "boom", stack}}`
- **AND** `buildFire` SHALL NOT attempt to run output validation on a failed executor result
- **AND** the HTTP trigger source SHALL render this as HTTP 500

#### Scenario: Cron handler output passes through trivially

- **GIVEN** a cron trigger whose handler returns `undefined`
- **AND** the trigger's descriptor.outputSchema is the schema rehydrated from the JSON Schema `{}` (matches any value)
- **WHEN** the `fire` closure resolves
- **THEN** validation SHALL succeed and the `fire` closure SHALL resolve with `{ok: true, output: undefined}`
- **AND** the cron source SHALL discard the output as it already does

#### Scenario: Output-validation failures emit structured issues on the event bus

- **GIVEN** a trigger handler whose return violates its declared outputSchema in two places
- **WHEN** output validation fails
- **THEN** the runtime SHALL emit an invocation lifecycle event carrying a `ValidationIssue[]` describing both failures (each with `path` and `message`)
- **AND** that event SHALL be visible to persistence, event-store, and logging consumers via the existing event bus
- **AND** the HTTP response (for the HTTP trigger kind) SHALL remain 500 with no structured issues in the response body

#### Scenario: Per-request validator construction is forbidden

- **GIVEN** a registered workflow with at least one trigger
- **WHEN** the same trigger is invoked twice
- **THEN** both invocations SHALL use the same pre-rehydrated validator instance attached to the registered workflow
- **AND** no schema rehydration SHALL occur between requests
