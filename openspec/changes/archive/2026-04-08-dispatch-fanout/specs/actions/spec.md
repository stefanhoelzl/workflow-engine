## MODIFIED Requirements

### Requirement: Action type

An `Action` SHALL be a plain object with the following properties:
- `name`: string — unique identifier for the action, derived from the `.action(name, config)` builder call
- `on`: string — the event type this action subscribes to, derived from the action's `on` field in the builder
- `handler`: `(ctx: ActionContext) => Promise<void>` — async function that processes the event via the context object

#### Scenario: Define an action

- **GIVEN** a builder chain with `.action("parseOrder", { on: "order.received", handler: async (ctx) => { ... } })`
- **WHEN** the runtime extracts actions from the config produced by `.build()`
- **THEN** the action has `name: "parseOrder"`, `on: "order.received"`, and a `handler` function

#### Scenario: Action does not have a match predicate

- **GIVEN** an action object extracted from a workflow config
- **WHEN** the action's properties are inspected
- **THEN** the action has `name`, `on`, and `handler` properties
- **AND** the action does NOT have a `match` property
