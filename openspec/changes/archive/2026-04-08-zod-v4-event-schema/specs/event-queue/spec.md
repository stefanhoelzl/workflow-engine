## MODIFIED Requirements

### Requirement: Minimal Event type

An `Event` SHALL be defined as a Zod v4 schema (`EventSchema`) with the following properties:
- `id`: string — unique identifier prefixed with `evt_`
- `type`: string — dot-separated event type (e.g., `"order.received"`)
- `payload`: unknown — the event data, passed through without validation
- `targetAction`: exact optional string — the action this event is targeted at, absent for undispatched events
- `correlationId`: string — tracks related events across a chain
- `parentEventId`: exact optional string — the ID of the parent event for lineage
- `createdAt`: coerced Date — timestamp of event creation, accepts both `Date` and ISO 8601 strings

The `Event` type SHALL be derived via `z.infer<typeof EventSchema>`. Both the schema and the type SHALL be exported from the event-queue module.

#### Scenario: Trigger creates an event

- **GIVEN** an HTTP trigger with event `"order.received"` fires with body `{ orderId: "123" }`
- **WHEN** the event is created
- **THEN** `id` starts with `evt_`
- **AND** `type` is `"order.received"`
- **AND** `payload` is `{ orderId: "123" }`
- **AND** `targetAction` is absent
- **AND** `createdAt` is the current time

#### Scenario: Dispatch creates a targeted event

- **GIVEN** dispatch fans out an event for action `parseOrder`
- **WHEN** the targeted event is created
- **THEN** `targetAction` is `"parseOrder"`
- **AND** all other properties are copied from the original event (with a new `id`)

#### Scenario: EventSchema parses JSON with string dates

- **GIVEN** a JSON object with `createdAt` as an ISO 8601 string
- **WHEN** `EventSchema.parse(json)` is called
- **THEN** the resulting `createdAt` SHALL be a `Date` object

#### Scenario: EventSchema accepts Date objects

- **GIVEN** an object with `createdAt` as a `Date` instance
- **WHEN** `EventSchema.parse(obj)` is called
- **THEN** the resulting `createdAt` SHALL be the same `Date`

#### Scenario: exactOptionalPropertyTypes compatibility

- **GIVEN** the TypeScript compiler option `exactOptionalPropertyTypes: true`
- **WHEN** the inferred `Event` type is used
- **THEN** `targetAction` and `parentEventId` SHALL be typed as `?: string` (not `?: string | undefined`)
