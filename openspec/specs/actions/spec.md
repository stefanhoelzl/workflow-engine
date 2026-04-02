# Actions Specification

## Purpose

Define the contract for user-provided action handlers: plain TypeScript functions that receive typed event data and may emit new events, bundled into standalone JavaScript files at build time.

## Requirements

### Requirement: Plain function contract

Actions SHALL be default-exported functions. No metadata, no decorators, no `defineAction()` wrapper. All wiring is declared in `workflow.ts`.

#### Scenario: Minimal action

- GIVEN a file `actions/parseOrder.ts` with `export default function handler(ctx) { ... }`
- WHEN it is referenced in `workflow.ts` via `.on(OrderReceived, parseOrder)`
- THEN the build system bundles it as a standalone `.js` file
- AND the runtime loads and executes it in an isolate when `order.received` events arrive

### Requirement: Typed context

Actions SHALL receive an `ActionContext<TConsumes, TEmits>` providing typed `ctx.data` and typed `ctx.emit()`.

#### Scenario: Type-safe emit

- GIVEN an action typed as `ActionContext<typeof OrderReceived, [typeof OrderParsed]>`
- WHEN the action calls `ctx.emit(OrderParsed, { orderId: '123', total: 42 })`
- THEN TypeScript verifies the payload matches `OrderParsed`'s Zod schema type
- AND calling `ctx.emit()` with an undeclared event type is a compile-time error

### Requirement: Standalone bundle

Each action SHALL be bundled into a single self-contained `.js` file with no external dependencies or SDK imports at runtime.

#### Scenario: Bundle output

- GIVEN an action that imports types from `../events` and `@your-platform/sdk`
- WHEN Vite bundles the action
- THEN the output `.js` file contains only the handler logic
- AND all type imports are erased
- AND no SDK runtime code is included

### Requirement: No side effects at module scope

Actions SHOULD NOT perform side effects at module scope. The runtime loads the module to obtain the handler function; module-scope code runs inside the isolate on every invocation.

#### Scenario: Module-scope code

- GIVEN an action with `console.log('loaded')` at module scope
- WHEN the action is invoked
- THEN the log statement executes inside the isolate (no effect on host)
- AND it runs on every invocation (fresh isolate each time)

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
