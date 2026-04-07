## MODIFIED Requirements

### Requirement: ContextFactory

The system SHALL provide a `ContextFactory` class that holds a queue reference, an injected fetch function, a schemas map, and a Logger instance. It SHALL expose `httpTrigger` and `action` as arrow properties for creating context objects. The Logger SHALL be passed via the constructor.

The schemas map SHALL be typed as `Record<string, { parse(data: unknown): unknown }>` (structural typing, no direct Zod import). The `ContextFactory` SHALL use the schemas map to validate event payloads in `#createAndEnqueue` before enqueuing.

#### Scenario: Create HttpTriggerContext via factory

- **GIVEN** a `ContextFactory` initialized with an event queue, a schemas map, a fetch function, and a Logger
- **WHEN** `factory.httpTrigger(body, definition)` is called
- **THEN** an `HttpTriggerContext` is returned with the request body, definition, and a working `emit()` method that validates payloads

#### Scenario: Create ActionContext via factory

- **GIVEN** a `ContextFactory` initialized with an event queue, a schemas map, a fetch function, and a Logger
- **WHEN** `factory.action(event)` is called
- **THEN** an `ActionContext` is returned with the source event, a working `emit()` method that validates payloads, and the injected fetch function

#### Scenario: Factory properties can be passed as standalone references

- **GIVEN** a `ContextFactory` instance
- **WHEN** `factory.httpTrigger` is assigned to a variable and called
- **THEN** it works correctly without explicit binding (arrow property captures `this`)

#### Scenario: Emit with valid payload enqueues parsed event

- **GIVEN** a `ContextFactory` with schemas `{ "order.received": z.object({ orderId: z.string() }) }`
- **WHEN** `ctx.emit("order.received", { orderId: "abc" })` is called
- **THEN** the event is enqueued with `payload: { orderId: "abc" }`

#### Scenario: Emit with invalid payload throws PayloadValidationError

- **GIVEN** a `ContextFactory` with schemas `{ "order.received": z.object({ orderId: z.string() }) }`
- **WHEN** `ctx.emit("order.received", { orderId: 123 })` is called
- **THEN** a `PayloadValidationError` is thrown
- **AND** the event is NOT enqueued

#### Scenario: Emit with unknown event type throws PayloadValidationError

- **GIVEN** a `ContextFactory` with schemas that do not include `"order.unknown"`
- **WHEN** `ctx.emit("order.unknown", {})` is called
- **THEN** a `PayloadValidationError` is thrown
- **AND** the event is NOT enqueued
