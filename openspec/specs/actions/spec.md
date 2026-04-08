# Actions Specification

## Purpose

Define the contract for user-provided action handlers: plain TypeScript functions that receive typed event data and may emit new events, bundled into standalone JavaScript files at build time.

## Requirements

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

### Requirement: No side effects at module scope

Actions SHOULD NOT perform side effects at module scope. The runtime loads the module to obtain the handler function; module-scope code runs inside the isolate on every invocation.

#### Scenario: Module-scope code

- GIVEN an action with `console.log('loaded')` at module scope
- WHEN the action is invoked
- THEN the log statement executes inside the isolate (no effect on host)
- AND it runs on every invocation (fresh isolate each time)

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
