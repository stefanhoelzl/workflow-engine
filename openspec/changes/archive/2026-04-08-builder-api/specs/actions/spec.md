## MODIFIED Requirements

### Requirement: Typed context

Actions SHALL receive an `ActionContext` providing typed `ctx.event.payload`, typed `ctx.emit()`, and typed `ctx.env`. The `emit()` method SHALL only accept event names listed in the action's `emits` declaration at compile-time. When `emits` is omitted, `ctx.emit()` SHALL accept `never`. The `ctx.env` property SHALL be typed as `Readonly<Record<DeclaredKeys, string>>` based on the action's `env` declaration. When `env` is omitted, `ctx.env` SHALL be `Readonly<{}>`.

#### Scenario: Type-safe emit restricted to emits

- **GIVEN** a workflow with events `"order.parsed"` and `"order.received"`, and an action with `emits: ["order.parsed"]`
- **WHEN** the action calls `ctx.emit("order.parsed", { orderId: "123", total: 42 })`
- **THEN** TypeScript verifies the payload matches the event's Zod schema type
- **AND** calling `ctx.emit("order.received", ...)` is a compile-time error (not in `emits`)
- **AND** calling `ctx.emit("order.typo", ...)` is a compile-time error (not a defined event)
- **AND** calling `ctx.emit()` with a wrong payload type is a compile-time error

#### Scenario: No emits means emit accepts never

- **GIVEN** an action without an `emits` declaration
- **WHEN** the handler calls `ctx.emit("order.parsed", { total: 1 })`
- **THEN** TypeScript raises a compile-time error because `ctx.emit` accepts `never`

#### Scenario: Type-safe env access

- **GIVEN** an action with `env: ["API_KEY"]`
- **WHEN** the handler accesses `ctx.env.API_KEY`
- **THEN** TypeScript accepts the access with type `string`
- **AND** accessing `ctx.env.SECRET` is a compile-time error
- **AND** assigning `ctx.env.API_KEY = "x"` is a compile-time error (`Readonly`)

### Requirement: Action type

An `Action` SHALL be a plain object with the following properties:
- `name`: string — unique identifier for the action, derived from the `.action(name, config)` builder call
- `match`: `(event: Event) => boolean` — predicate generated from the action's `on` field and the action name (`e.type === on && e.targetAction === name`)
- `handler`: `(ctx: ActionContext) => Promise<void>` — async function that processes the event via the context object

#### Scenario: Define an action

- **GIVEN** a builder chain with `.action("parseOrder", { on: "order.received", handler: async (ctx) => { ... } })`
- **WHEN** the runtime extracts actions from the config produced by `.build()`
- **THEN** the action has `name: "parseOrder"` and a `match` predicate that returns `true` for events with `type: "order.received"` and `targetAction: "parseOrder"`

#### Scenario: Match predicate receives full event

- **GIVEN** an action with name `"parseOrder"` derived from a builder with `on: "order.received"`
- **WHEN** an event `{ type: "order.received", targetAction: "parseOrder" }` is evaluated
- **THEN** `match` returns `true`
- **AND** for an event `{ type: "order.received", targetAction: "sendEmail" }`, `match` returns `false`
