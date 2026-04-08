## MODIFIED Requirements

### Requirement: create method for new event chains

The `create` method SHALL accept `(type: string, payload: unknown)`, validate the payload against the schema for the given type, generate a `corr_`-prefixed correlation ID using `crypto.randomUUID()`, and return a new `RuntimeEvent` with no `parentEventId` and no `targetAction`.

#### Scenario: Create a root event with auto-generated correlation ID

- **GIVEN** an `EventFactory` with schemas `{ "order.received": z.object({ orderId: z.string() }) }`
- **WHEN** `create("order.received", { orderId: "abc" })` is called
- **THEN** a `RuntimeEvent` is returned with `type: "order.received"`, `payload: { orderId: "abc" }`, `state: "pending"`, a unique `evt_`-prefixed `id`, a unique `corr_`-prefixed `correlationId`, and a `createdAt` timestamp
- **AND** `parentEventId` is `undefined`
- **AND** `targetAction` is `undefined`

#### Scenario: Each create call generates a distinct correlation ID

- **GIVEN** an `EventFactory` with schemas `{ "order.received": z.object({ orderId: z.string() }) }`
- **WHEN** `create("order.received", { orderId: "a" })` is called twice
- **THEN** the two returned events have different `correlationId` values

#### Scenario: Create rejects invalid payload

- **GIVEN** an `EventFactory` with schemas `{ "order.received": z.object({ orderId: z.string() }) }`
- **WHEN** `create("order.received", { orderId: 123 })` is called
- **THEN** a `PayloadValidationError` is thrown

#### Scenario: Create rejects unknown event type

- **GIVEN** an `EventFactory` with schemas that do not include `"order.unknown"`
- **WHEN** `create("order.unknown", {})` is called
- **THEN** a `PayloadValidationError` is thrown with an empty issues array
