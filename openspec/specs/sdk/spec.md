# SDK Specification

## Purpose

Provide the TypeScript API for defining events, wiring workflows, and typing action handlers. The SDK is a build-time-only dependency — no SDK code ships in the bundled action files.

## Requirements

### Requirement: defineEvent helper

The SDK SHALL export a `defineEvent(name, zodSchema)` function that returns an event definition object carrying both the string name and the Zod schema for type inference.

#### Scenario: Type inference from event definition

- GIVEN `const OrderReceived = defineEvent('order.received', z.object({ orderId: z.string() }))`
- WHEN a developer writes `type Payload = z.infer<typeof OrderReceived.schema>`
- THEN `Payload` resolves to `{ orderId: string }`

### Requirement: Workflow DSL builder

The SDK SHALL export a `workflow(name)` function that returns a chainable builder with `.trigger()` and `.on()` methods.

#### Scenario: Wiring a workflow

- GIVEN `workflow('order-processing').trigger(httpTrigger(...), OrderReceived).on(OrderReceived, parseOrder).on(OrderParsed, sendEmail)`
- WHEN the builder is evaluated
- THEN it produces a plain config object containing: workflow name, trigger definitions with event mappings, and event-to-action subscriptions

### Requirement: httpTrigger factory

The SDK SHALL export an `httpTrigger(path, method, options)` function that returns a trigger configuration object.

#### Scenario: HTTP trigger with static response

- GIVEN `httpTrigger('/orders', 'POST', { response: { status: 202, body: { accepted: true } } })`
- WHEN included in the workflow via `.trigger()`
- THEN the manifest records: type `http`, method `POST`, path `/orders`, and the static response config

### Requirement: ActionContext type

The SDK SHALL export an `ActionContext<TConsumes, TEmits>` generic type that provides typed `ctx.data` and typed `ctx.emit()`.

#### Scenario: Type-safe action handler

- GIVEN `handler(ctx: ActionContext<typeof OrderReceived, [typeof OrderParsed]>)`
- THEN `ctx.data` is typed as the Zod-inferred type of `OrderReceived`
- AND `ctx.emit(OrderParsed, payload)` type-checks `payload` against `OrderParsed`'s schema
- AND `ctx.emit(UnrelatedEvent, payload)` is a compile-time error

### Requirement: SystemError event

The SDK SHALL export a built-in `SystemError` event definition with a fixed schema: `{ originalEventId: string, actionName: string, errorMessage: string, stackTrace: string, correlationId: string }`.

#### Scenario: Subscribe to system errors

- GIVEN a workflow with `.on(SystemError, notifyAdmin)`
- WHEN any action fails
- THEN `notifyAdmin` receives the typed system error payload

### Requirement: No runtime footprint

SDK exports used in action files (types, event definitions) SHALL be erased during bundling. No SDK code appears in the bundled `.js` output.

#### Scenario: Bundle contains no SDK

- GIVEN an action that imports `ActionContext` and `OrderReceived` from the SDK
- WHEN Vite bundles the action
- THEN the output `.js` file contains zero references to `@your-platform/sdk`
