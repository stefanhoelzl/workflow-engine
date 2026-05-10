## MODIFIED Requirements

### Requirement: Validation errors carry structured issues

Validation errors thrown across the bridge SHALL carry an `issues` array whose entries conform to the engine-stable `ValidationIssue` shape:

- `path: (string | number)[]` — required; the access path into the validated input.
- `message: string` — required; human-readable failure description.
- `received?: unknown` — OPTIONAL; the value at `path` in the validated input. Lifted by the validator mapper from the input passed to `safeParse`. For non-primitive values the field carries the value verbatim; no truncation, no stringification.
- `expected?: string` — OPTIONAL; engine-stable description of the constraint that was violated (e.g. `"one of [\"A\", \"B\"]"`, `"string"`, `"number"`).
- `code?: string` — OPTIONAL; engine-stable issue code (e.g. `"invalid_enum_value"`, `"invalid_type"`). Codes are engine-defined; they mirror the underlying validator's vocabulary today but are NOT a public API surface of any specific validator library.

The error SHALL be JSON-serialisable for transport across the host/sandbox boundary. New consumers SHALL treat `received`, `expected`, and `code` as optional and SHALL render gracefully when they are absent.

#### Scenario: Issues array preserved across bridge

- **GIVEN** a Zod error with two issues
- **WHEN** the validation error is thrown across the bridge
- **THEN** the rethrown error SHALL carry both issues with `path` and `message` preserved
- **AND** when the underlying validator supplies them, each issue SHALL also carry `received`, `expected`, and `code`

#### Scenario: Enum failure includes received value

- **GIVEN** an HTTP trigger with body schema `z.object({ type: z.enum(["A", "B"]) })`
- **WHEN** a POST request arrives with body `{ "type": "a" }`
- **THEN** the validation error issue SHALL carry `path: ["body", "type"]`, a `message` string, `received: "a"`, an `expected` string describing the enum options, and `code: "invalid_value"` (or the engine-stable code that mirrors the underlying validator's enum-failure code)

### Requirement: HTTP 422 response for validation failures

The HTTP trigger middleware SHALL catch validation errors and return an HTTP 422 (Unprocessable Entity) response with a structured JSON body.

The response body SHALL contain:

- `error: "payload_validation_failed"` — a stable error code
- `issues: { path: (string | number)[]; message: string }[]` — the validation issues projected to a minimal shape

The middleware SHALL project the engine-internal `ValidationIssue` array to the minimal wire shape at the response boundary. The wire shape SHALL NOT include `received`, `expected`, `code`, or any other field that exposes library-specific error vocabulary on the public-by-design `/webhooks/*` surface. The minimal projection applies equally to the manual-fire 422 response served by the `/trigger/*` UI route.

The response SHALL NOT expose library-specific error details (e.g., Zod error codes, validation type identifiers).

#### Scenario: Malformed webhook payload returns 422

- **GIVEN** an HTTP trigger with a body schema `z.object({ orderId: z.string() })`
- **WHEN** a POST request arrives at `/webhooks/.../order` with body `{ "orderId": 123 }`
- **THEN** the response status is 422
- **AND** the response body is `{ "error": "payload_validation_failed", "issues": [{ "path": ["body", "orderId"], "message": "Expected string, received number" }] }`
- **AND** the response body issue objects SHALL NOT include `received`, `expected`, or `code`

#### Scenario: Valid webhook payload is accepted normally

- **GIVEN** an HTTP trigger with a body schema `z.object({ orderId: z.string() })`
- **WHEN** a POST request arrives at `/webhooks/.../order` with body `{ "orderId": "abc" }`
- **THEN** the response is the handler's return value (not a 422)

#### Scenario: Manual-fire 422 uses the same minimal projection

- **GIVEN** a manual trigger with input schema `z.object({ count: z.number() })`
- **WHEN** an authenticated dashboard user POSTs `/trigger/...` with body `{ "count": "bad" }`
- **THEN** the response status is 422
- **AND** the response body issues are `{path, message}` only — no `received`, `expected`, or `code`

#### Scenario: Persisted rejection events carry the enriched shape

- **GIVEN** the same malformed HTTP request from the prior scenario
- **WHEN** the runtime emits the `trigger.rejection` event
- **THEN** the event's `input.issues` SHALL carry the full engine-internal shape including `received`, `expected`, and `code` when the underlying validator supplied them

## ADDED Requirements

### Requirement: Validation issues describe the failing field only, not the whole payload

The validator mapper SHALL populate each issue's `received` field by lifting the value at that issue's `path` from the input. The mapper SHALL NOT attach the whole input to any issue. When `issue.path` is empty (top-level type mismatch), `received` is the whole input — this case is reachable only when the trigger's input schema does not wrap the body in an enclosing object; for the engine's webhook and manual trigger sources, the input is always wrapped (e.g. `{body, headers, url, method}`) so `issue.path` is non-empty in practice for caller-supplied payloads.

#### Scenario: Multi-field failure persists only failing field values

- **GIVEN** an HTTP trigger whose body schema requires `name: z.string()` and `age: z.number()`
- **WHEN** a POST arrives with body `{ "name": 42, "age": "old", "notes": "<10MB string>" }`
- **THEN** the persisted `trigger.rejection` event SHALL contain two issues
- **AND** the first issue's `received` SHALL be `42`
- **AND** the second issue's `received` SHALL be `"old"`
- **AND** neither issue SHALL contain the `notes` field's value
