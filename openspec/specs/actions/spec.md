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
