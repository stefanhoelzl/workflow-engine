## ADDED Requirements

### Requirement: PayloadValidationError type

The system SHALL provide a `PayloadValidationError` class extending `Error` that carries structured validation failure details. The error SHALL have the following properties:

- `eventType: string` — the event type that failed validation
- `issues: { path: string; message: string }[]` — validation issues in a library-agnostic format
- `cause: Error` — the original error from the schema's `.parse()` call

For unknown event types (no schema found), `issues` SHALL be an empty array and the message SHALL indicate the event type is not defined.

#### Scenario: Invalid payload produces PayloadValidationError

- **GIVEN** an event type `"order.received"` with a schema requiring `{ orderId: string }`
- **WHEN** `ctx.emit("order.received", { orderId: 123 })` is called with a numeric `orderId`
- **THEN** a `PayloadValidationError` is thrown
- **AND** `error.eventType` is `"order.received"`
- **AND** `error.issues` contains at least one entry with `path: "orderId"` and a descriptive message
- **AND** `error.cause` is the original error from `.parse()`

#### Scenario: Unknown event type produces PayloadValidationError

- **GIVEN** no schema is defined for event type `"order.unknown"`
- **WHEN** `ctx.emit("order.unknown", {})` is called
- **THEN** a `PayloadValidationError` is thrown
- **AND** `error.eventType` is `"order.unknown"`
- **AND** `error.issues` is an empty array
- **AND** `error.message` indicates the event type is not defined

### Requirement: HTTP 422 response for validation failures

The HTTP trigger middleware SHALL catch `PayloadValidationError` thrown during emit and return an HTTP 422 (Unprocessable Entity) response with a structured JSON body.

The response body SHALL contain:
- `error: "payload_validation_failed"` — a stable error code
- `event: string` — the event type that failed validation
- `issues: { path: string; message: string }[]` — the validation issues

The response SHALL NOT expose library-specific error details (e.g., Zod error codes, validation type identifiers).

#### Scenario: Malformed webhook payload returns 422

- **GIVEN** an HTTP trigger for path `"order"` mapped to event `"order.received"` with schema `{ orderId: z.string() }`
- **WHEN** a POST request arrives at `/webhooks/order` with body `{ "orderId": 123 }`
- **THEN** the response status is 422
- **AND** the response body is `{ "error": "payload_validation_failed", "event": "order.received", "issues": [{ "path": "orderId", "message": "Expected string, received number" }] }`

#### Scenario: Valid webhook payload is accepted normally

- **GIVEN** an HTTP trigger for path `"order"` mapped to event `"order.received"` with schema `{ orderId: z.string() }`
- **WHEN** a POST request arrives at `/webhooks/order` with body `{ "orderId": "abc" }`
- **THEN** the response is the trigger's configured response (not a 422)

#### Scenario: Invalid JSON still returns 400

- **GIVEN** an HTTP trigger for path `"order"`
- **WHEN** a POST request arrives with an unparseable body
- **THEN** the response status is 400 (unchanged from current behavior)
