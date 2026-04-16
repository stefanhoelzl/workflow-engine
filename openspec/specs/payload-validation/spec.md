# Payload Validation Specification

## Purpose

Provide runtime validation of trigger payloads and action inputs/outputs against their Zod schemas, with structured error reporting and HTTP 422 responses at the trigger boundary.

## Requirements

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
