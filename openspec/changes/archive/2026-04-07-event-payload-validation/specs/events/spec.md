## MODIFIED Requirements

### Requirement: Compile-time only validation

The system SHALL validate event payloads at runtime against their Zod schema before enqueuing. The parsed output (with transforms, defaults, and stripping applied) SHALL be used as the event payload. Zod schemas continue to provide compile-time TypeScript type inference via `z.infer<>`.

#### Scenario: Valid payload is parsed and enqueued

- **GIVEN** an event type `"order.received"` with a Zod schema `z.object({ orderId: z.string() })`
- **WHEN** `ctx.emit("order.received", { orderId: "abc", extra: true })` is called
- **THEN** the event is enqueued with `payload: { orderId: "abc" }` (extra field stripped by Zod's default behavior)

#### Scenario: Invalid payload is rejected

- **GIVEN** an event type `"order.received"` with a Zod schema requiring `{ orderId: z.string() }`
- **WHEN** `ctx.emit("order.received", { orderId: 123 })` is called with an invalid payload
- **THEN** the event is NOT enqueued
- **AND** a `PayloadValidationError` is thrown

#### Scenario: Unknown event type is rejected

- **GIVEN** no schema is defined for event type `"order.unknown"`
- **WHEN** `ctx.emit("order.unknown", {})` is called
- **THEN** the event is NOT enqueued
- **AND** a `PayloadValidationError` is thrown with an empty issues array
