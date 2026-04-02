## MODIFIED Requirements

### Requirement: HttpTriggerDefinition includes event type

`HttpTriggerDefinition` SHALL include an `event` property (string) that declares the event type the trigger produces.

#### Scenario: Trigger definition declares its event type
- **GIVEN** an `HttpTriggerDefinition` with path `"order"`, method `"POST"`, and event `"order.received"`
- **THEN** the definition's `event` field is `"order.received"`

## ADDED Requirements

### Requirement: Minimal Event type

An `Event` SHALL be a plain object with the following properties:
- `id`: string — unique identifier prefixed with `evt_`
- `type`: string — dot-separated event type (e.g., `"http.order.POST"`)
- `payload`: unknown — the event data, passed through without validation
- `createdAt`: Date — timestamp of event creation

#### Scenario: Trigger creates an event
- **GIVEN** an HTTP trigger with event `"order.received"` fires with body `{ orderId: "123" }`
- **WHEN** the event is created
- **THEN** `id` starts with `evt_`
- **AND** `type` is `"order.received"` (from the trigger definition's `event` field)
- **AND** `payload` is `{ orderId: "123" }`
- **AND** `createdAt` is the current time

### Requirement: EventQueue interface with enqueue

The `EventQueue` interface SHALL expose a single method:
- `enqueue(event: Event): void` — adds an event to the queue

#### Scenario: Enqueue an event
- **GIVEN** an `EventQueue` implementation
- **WHEN** `enqueue(event)` is called with a valid event
- **THEN** the event is stored in the queue

### Requirement: InMemoryEventQueue implementation

`InMemoryEventQueue` SHALL implement the `EventQueue` interface using an in-memory array.

#### Scenario: Events accumulate in memory
- **GIVEN** an `InMemoryEventQueue`
- **WHEN** three events are enqueued
- **THEN** all three events are stored in order

### Requirement: Trigger callback enqueues events

The `onTrigger` callback in the runtime entry point SHALL construct an `Event` from the trigger definition and request body, then enqueue it via the `EventQueue`.

#### Scenario: HTTP request becomes queued event
- **GIVEN** a running runtime with an HTTP trigger for `"order"` / `"POST"` with event `"order.received"`
- **WHEN** `POST /webhooks/order` is received with body `{ orderId: "123" }`
- **THEN** an event with type `"order.received"` and payload `{ orderId: "123" }` is enqueued
- **AND** the HTTP response is the trigger's configured static response
