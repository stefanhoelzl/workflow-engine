## ADDED Requirements

### Requirement: Action type

An `Action` SHALL be a plain object with the following properties:
- `name`: string — unique identifier for the action
- `match`: `(event: Event) => boolean` — predicate that determines whether this action handles a given event
- `handler`: `(event: Event) => void` — function that processes the event

#### Scenario: Define an action

- **GIVEN** an action `{ name: "parseOrder", match: (e) => e.type === "order.received" && e.targetAction === "parseOrder", handler: parseOrderFn }`
- **WHEN** the action is registered
- **THEN** the scheduler can match events to it using the `match` predicate

#### Scenario: Match predicate receives full event

- **GIVEN** an action with `match: (e) => e.type === "order.received" && e.targetAction === "parseOrder"`
- **WHEN** an event `{ type: "order.received", targetAction: "parseOrder" }` is evaluated
- **THEN** `match` returns `true`
- **AND** for an event `{ type: "order.received", targetAction: "sendEmail" }`, `match` returns `false`

### Requirement: Action handler receives event

The action handler SHALL receive the full `Event` object as its argument.

#### Scenario: Handler invocation

- **GIVEN** a registered action with handler `parseOrderFn`
- **WHEN** the scheduler matches an event to this action
- **THEN** the handler is called with the event object
- **AND** the handler has access to `event.type`, `event.payload`, `event.targetAction`, and all other event properties
