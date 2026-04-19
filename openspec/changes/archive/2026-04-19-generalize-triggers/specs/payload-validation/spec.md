## MODIFIED Requirements

### Requirement: Trigger payload validated on ingress

The runtime SHALL provide a single shared validator `validate(descriptor, rawInput): { ok: true, input } | { ok: false, issues: ZodIssue[] }` that parses `rawInput` against `descriptor.inputSchema`. Every `TriggerSource` SHALL assemble a raw input object from its native protocol event and call this shared validator before dispatching to the executor. On validation failure the source SHALL produce a protocol-appropriate response (for HTTP: a `422 Unprocessable Entity` with `{ error: "payload_validation_failed", issues: [...] }`). Sources SHALL NOT invoke `executor.invoke` on validation failure.

The shared validator SHALL be kind-agnostic — it SHALL NOT contain HTTP-specific logic. HTTP-specific concerns (JSON body parsing, header folding, query parsing) live in the HTTP `TriggerSource` and happen before the call to `validate`.

#### Scenario: Valid payload passes

- **GIVEN** an HTTP trigger with `body: z.object({ x: z.number() })`
- **WHEN** a request with body `{ x: 42 }` arrives
- **THEN** the HTTP source SHALL assemble `rawInput = { body: { x: 42 }, headers, url, method, params, query }`
- **AND** `validate(descriptor, rawInput)` SHALL return `{ ok: true, input }`
- **AND** the source SHALL pass the validated input to the executor

#### Scenario: Invalid body returns 422

- **GIVEN** an HTTP trigger with `body: z.object({ x: z.number() })`
- **WHEN** a request with body `{ x: "not a number" }` arrives
- **THEN** `validate(descriptor, rawInput)` SHALL return `{ ok: false, issues }` where `issues` come from Zod
- **AND** the HTTP source SHALL respond `422` with the structured `issues`
- **AND** the executor SHALL NOT be invoked

#### Scenario: Invalid path params return 422

- **GIVEN** an HTTP trigger with `path: "users/:userId"` and `params: z.object({ userId: z.string().uuid() })`
- **WHEN** a request to `/webhooks/<tenant>/<workflow>/users/not-a-uuid` arrives
- **THEN** `validate` SHALL return `{ ok: false, issues }` indicating the params validation issue
- **AND** the HTTP source SHALL respond `422`

### Requirement: HTTP 422 response for validation failures

The HTTP `TriggerSource` SHALL catch validation failures from the shared validator and return an HTTP 422 (Unprocessable Entity) response with a structured JSON body.

The response body SHALL contain:
- `error: "payload_validation_failed"` — a stable error code
- `issues: { path: string; message: string }[]` — the validation issues

The response SHALL NOT expose library-specific error details (e.g., Zod error codes, validation type identifiers).

#### Scenario: Malformed webhook payload returns 422

- **GIVEN** an HTTP trigger with a body schema `{ orderId: z.string() }`
- **WHEN** a POST request arrives at `/webhooks/<tenant>/<workflow>/order` with body `{ "orderId": 123 }`
- **THEN** the response status is 422
- **AND** the response body is `{ "error": "payload_validation_failed", "issues": [{ "path": "orderId", "message": "Expected string, received number" }] }`

#### Scenario: Valid webhook payload is accepted normally

- **GIVEN** an HTTP trigger with a body schema `{ orderId: z.string() }`
- **WHEN** a POST request arrives with body `{ "orderId": "abc" }`
- **THEN** the response is the handler's return value wrapped by the HTTP source (not a 422)

#### Scenario: Invalid JSON still returns 422

- **GIVEN** an HTTP trigger for path `"order"`
- **WHEN** a POST request arrives with an unparseable body
- **THEN** the HTTP source SHALL detect the JSON parse failure before invoking the shared validator
- **AND** SHALL return response status 422

### Requirement: Security context

The implementation SHALL conform to the threat model documented at
`/SECURITY.md S3 Webhook Ingress`, which enumerates the trust level,
entry points, threats, current mitigations, residual risks, and rules
governing this capability. The shared-validator approach does not
change the threat model — each `TriggerSource` still filters attacker-
controlled input through its declared `inputSchema` before the
executor dispatches into the sandbox.

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
