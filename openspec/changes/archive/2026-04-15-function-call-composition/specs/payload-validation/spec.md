## ADDED Requirements

### Requirement: Trigger payload validated on ingress

The HTTP trigger middleware SHALL validate the incoming payload (`body`, `headers`, `url`, `method`, `params`, `query`) against the trigger's declared Zod schema before invoking the executor. Validation failure SHALL produce a `422 Unprocessable Entity` response with `{ error: "payload_validation_failed", issues: [...] }`. The middleware SHALL NOT invoke the executor on validation failure.

#### Scenario: Valid payload passes

- **GIVEN** a trigger with `body: z.object({ x: z.number() })`
- **WHEN** a request with body `{ x: 42 }` arrives
- **THEN** the middleware SHALL pass the validated payload to the executor

#### Scenario: Invalid body returns 422

- **GIVEN** a trigger with `body: z.object({ x: z.number() })`
- **WHEN** a request with body `{ x: "not a number" }` arrives
- **THEN** the middleware SHALL return `422` with structured `issues` from Zod
- **AND** the executor SHALL NOT be invoked

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

### Requirement: Action output validated in-sandbox by the SDK wrapper

The SDK callable returned by `action({...})` SHALL, after the handler returns, validate the return value against the captured output Zod schema using the Zod bundle inlined in the workflow bundle. Validation failure SHALL throw a rejection to the caller before any value is returned.

Output validation runs inside the sandbox, not at the host bridge. This is a deliberate consequence of the in-sandbox dispatch model (design D11): the handler's return is already a guest-side value, so performing validation in-sandbox saves a bridge round-trip. The host-side input validation remains the canonical contract boundary for the workflow's manifest.

#### Scenario: Invalid action output throws into caller

- **GIVEN** action `b` with `output: z.string()` whose handler returns `42`
- **WHEN** caller invokes `await b(validInput)`
- **THEN** the host bridge call SHALL succeed (input is valid)
- **AND** `b`'s handler SHALL execute and return `42`
- **AND** the SDK wrapper SHALL call the captured output schema's `.parse(42)`, which throws
- **AND** the rejection SHALL propagate to the caller before any value is returned

### Requirement: Validation errors carry structured issues

Validation errors thrown across the bridge SHALL carry an `issues` array compatible with Zod's `.issues` shape, each entry containing `path` (array) and `message` (string). The error SHALL be JSON-serializable for transport across the host/sandbox boundary.

#### Scenario: Issues array preserved across bridge

- **GIVEN** a Zod error with two issues
- **WHEN** the validation error is thrown across the bridge
- **THEN** the rethrown error SHALL carry both issues with `path` and `message` preserved

## REMOVED Requirements

### Requirement: Event payload validated on emit

**Reason**: Events are removed in v1; there is no `emit()` to validate against. Action input/output validation at the bridge replaces it.

**Migration**: Replace event-emit validation with action-call validation at the bridge.
