## MODIFIED Requirements

### Requirement: Action type

An `Action` SHALL be a plain object with the following properties:
- `name`: string — unique identifier for the action
- `match`: `(event: Event) => boolean` — predicate that determines whether this action handles a given event
- `handler`: `(ctx: ActionContext) => Promise<void>` — async function that processes the event via the context object

#### Scenario: Define an action

- **GIVEN** an action `{ name: "parseOrder", match: (e) => e.type === "order.received" && e.targetAction === "parseOrder", handler: async (ctx) => { ... } }`
- **WHEN** the action is registered
- **THEN** the scheduler can match events to it using the `match` predicate

#### Scenario: Match predicate receives full event

- **GIVEN** an action with `match: (e) => e.type === "order.received" && e.targetAction === "parseOrder"`
- **WHEN** an event `{ type: "order.received", targetAction: "parseOrder" }` is evaluated
- **THEN** `match` returns `true`
- **AND** for an event `{ type: "order.received", targetAction: "sendEmail" }`, `match` returns `false`

### Requirement: Action handler receives ActionContext

The action handler SHALL receive an `ActionContext` object providing access to the source event and an `emit()` method for creating downstream events.

#### Scenario: Handler invocation

- **GIVEN** a registered action with handler `parseOrderFn`
- **WHEN** the scheduler matches an event to this action
- **THEN** the handler is called with an `ActionContext`
- **AND** `ctx.event` provides the full source event object
- **AND** `ctx.emit(type, payload)` enqueues a new event that goes through the dispatch pipeline

#### Scenario: Handler emits downstream event

- **GIVEN** an action handler that calls `ctx.emit("order.validated", { valid: true })`
- **WHEN** the handler executes
- **THEN** a new event with `type: "order.validated"` is enqueued
- **AND** the new event has `targetAction: undefined` (enters dispatch)
- **AND** the new event inherits `correlationId` from the source event

## REMOVED Requirements

### Requirement: Action handler receives event

**Reason**: Replaced by "Action handler receives ActionContext". Handlers now receive a context object instead of the raw event.
**Migration**: Change `handler: (event) => { ... }` to `handler: async (ctx) => { ... }`. Access event data via `ctx.event`.
