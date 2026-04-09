## MODIFIED Requirements

### Requirement: defineWorkflow function

The SDK SHALL export a `createWorkflow()` function that returns a builder object. The builder SHALL use a single generic `WorkflowBuilder<E>` interface where `E` accumulates event definitions. `.event()` and `.trigger()` return `this` for chaining. `.action()` returns the handler function (not the builder). `.compile()` returns serializable metadata and handler references. There is no `.build()` method and no `WorkflowConfig` type.

#### Scenario: Define a workflow via builder
- **GIVEN** a call to `createWorkflow().event("order.received", z.object({ orderId: z.string() })).trigger("orders", { type: "http", path: "orders", event: "order.received" })`
- **WHEN** `.action({ on: "order.received", handler: async () => {} })` is called on the builder
- **THEN** it returns the handler function
- **AND** calling `.compile()` on the builder returns metadata containing the event definitions, triggers, and action entries

#### Scenario: All methods available on builder
- **GIVEN** a `createWorkflow()` call
- **WHEN** `.event()`, `.trigger()`, and `.action()` are called
- **THEN** TypeScript allows all three methods at any point after at least one event is defined
- **AND** generic constraints enforce that triggers and actions reference defined event keys

### Requirement: Events defined via builder method

Events SHALL be defined by calling `.event(name, schema)` on the builder. Each call adds the event to the builder's accumulated type and returns `this`. The event name is a string key and the schema is a Zod type.

#### Scenario: Event accumulation
- **GIVEN** `createWorkflow().event("a", z.object({ x: z.string() })).event("b", z.object({ y: z.number() }))`
- **WHEN** a subsequent `.action()` subscribes to `"a"`
- **THEN** `ctx.event.payload` is typed as `{ x: string }`
- **AND** the action can reference both `"a"` and `"b"` in its `emits` array

#### Scenario: Duplicate event name
- **GIVEN** `.event("a", s1).event("a", s2)`
- **WHEN** the builder executes
- **THEN** the second schema overwrites the first (last-write-wins, no runtime error)

### Requirement: Triggers reference events by key

Each trigger SHALL have an `event` field whose value MUST be a key from previously defined events. Invalid event references SHALL be compile-time errors. Triggers are added via `.trigger(name, config)` and return `this`. The `name` argument SHALL be stored as part of the trigger definition.

#### Scenario: Valid trigger event reference
- **GIVEN** `.event("order.received", schema).trigger("orders", { type: "http", path: "orders", event: "order.received" })`
- **WHEN** TypeScript checks the builder chain
- **THEN** the definition compiles without errors

#### Scenario: Invalid trigger event reference
- **GIVEN** `.event("order.received", schema).trigger("orders", { type: "http", path: "orders", event: "order.typo" })`
- **WHEN** TypeScript checks the builder chain
- **THEN** a compile-time error is raised because `"order.typo"` is not a defined event key

### Requirement: Actions reference events by key

Each action SHALL have an `on` field whose value MUST be a key from previously defined events. Invalid event references SHALL be compile-time errors. Actions are added via `.action(config)` on the builder, which returns the handler function.

#### Scenario: Valid action event reference
- **GIVEN** `createWorkflow().event("order.received", schema).trigger("t", config)`
- **WHEN** `.action({ on: "order.received", handler: async () => {} })` is called
- **THEN** the definition compiles without errors
- **AND** the returned value is the handler function

#### Scenario: Invalid action event reference
- **GIVEN** a builder with `"order.received"` defined
- **WHEN** `.action({ on: "order.typo", handler: async () => {} })` is called
- **THEN** a compile-time error is raised because `"order.typo"` is not a defined event key

### Requirement: Action names derived from export or explicit parameter

Action names SHALL be derived from the named export variable name by the Vite plugin. An optional `name` field in the `.action()` config overrides this. The `.action()` method itself does not require a name argument.

#### Scenario: Action name from export
- **GIVEN** `export const parseOrder = workflow.action({ on: "order.received", handler: async (ctx) => {} })`
- **WHEN** the Vite plugin processes the module
- **THEN** the action name in the manifest SHALL be `"parseOrder"`

#### Scenario: Explicit name override
- **GIVEN** `export const handle = workflow.action({ name: "parseOrder", on: "order.received", handler: async (ctx) => {} })`
- **WHEN** the Vite plugin processes the module
- **THEN** the action name in the manifest SHALL be `"parseOrder"`
- **AND** the handler field SHALL be `"handle"`

### Requirement: Action env declaration

Actions MAY declare an `env` field listing environment variable names they require. Within the builder, `ctx.env` SHALL be typed as `Readonly<Record<DeclaredKeys, string>>` where `DeclaredKeys` are the literal string types from the `env` array. When `env` is omitted, `ctx.env` SHALL be typed as `Readonly<{}>`.

#### Scenario: Env access with declared keys
- **GIVEN** `.action({ on: "alert", env: ["API_KEY", "API_URL"], handler: async (ctx) => {} })`
- **WHEN** the handler accesses `ctx.env.API_KEY`
- **THEN** TypeScript accepts the access with type `string`

#### Scenario: Env access with undeclared key
- **GIVEN** `.action({ on: "alert", env: ["API_KEY"], handler: async (ctx) => {} })`
- **WHEN** the handler accesses `ctx.env.SECRET`
- **THEN** TypeScript raises a compile-time error because `"SECRET"` is not a declared env key

#### Scenario: No env declaration
- **GIVEN** `.action({ on: "alert", handler: async (ctx) => {} })`
- **WHEN** the handler accesses `ctx.env.ANYTHING`
- **THEN** TypeScript raises a compile-time error because `ctx.env` is `Readonly<{}>`

### Requirement: Action emits declaration

Actions MAY declare an `emits` field listing event keys they may emit. The `ctx.emit()` method SHALL only accept event names listed in the action's `emits` array at compile-time. When `emits` is omitted, `ctx.emit()` SHALL accept `never` as the event name.

#### Scenario: Typed emit restricted to emits array
- **GIVEN** events `"order.received"` and `"order.parsed"` defined, and an action with `emits: ["order.parsed"]`
- **WHEN** the handler calls `ctx.emit("order.parsed", { total: 42 })`
- **THEN** TypeScript accepts the call and verifies the payload matches the event schema

#### Scenario: Emit of event not in emits array
- **GIVEN** events `"order.received"` and `"order.parsed"` defined, and an action with `emits: ["order.parsed"]`
- **WHEN** the handler calls `ctx.emit("order.received", { orderId: "123" })`
- **THEN** TypeScript raises a compile-time error because `"order.received"` is not in the action's `emits` array

#### Scenario: No emits declaration
- **GIVEN** an action without an `emits` field
- **WHEN** the handler calls `ctx.emit("order.parsed", { total: 1 })`
- **THEN** TypeScript raises a compile-time error because `ctx.emit` accepts `never` as the event name

### Requirement: Compile method replaces build

The builder SHALL expose a `.compile()` method that returns an object containing serializable event metadata (with JSON Schema via `z.toJSONSchema()`), trigger definitions, and action entries with handler function references. There SHALL be no `.build()` method and no `WorkflowConfig` type.

#### Scenario: Compile returns metadata and handlers
- **GIVEN** a builder with one event, one trigger, and one action
- **WHEN** `.compile()` is called
- **THEN** the result contains `events` (array of `{ name, schema }` where schema is JSON Schema), `triggers` (array of trigger definitions), and `actions` (array with `name`, `on`, `emits`, `env`, and `handler` reference)

#### Scenario: Compile validates consistency
- **WHEN** `.compile()` is called on a builder where an action references an undefined event
- **THEN** `.compile()` SHALL throw an error

### Requirement: Action handler return type

The `.action()` method SHALL return the handler function passed in via `config.handler`. The returned function SHALL have the same type signature as the handler parameter, preserving full `ctx` type inference.

#### Scenario: Returned handler is the same function
- **GIVEN** `const fn = async (ctx) => {}; const result = workflow.action({ on: "e", handler: fn })`
- **WHEN** the result is compared to `fn`
- **THEN** `result === fn` SHALL be `true`

### Requirement: SDK re-exports Zod

The SDK SHALL re-export `z` from Zod so workflow authors can import everything from a single package.

#### Scenario: Import z from SDK
- **GIVEN** a workflow file importing from `@workflow-engine/sdk`
- **WHEN** the author writes `import { createWorkflow, z } from "@workflow-engine/sdk"`
- **THEN** `z` is the same Zod namespace as `import { z } from "zod"`

## REMOVED Requirements

### Requirement: WorkflowConfig output
**Reason**: Replaced by `.compile()` which returns serializable metadata and handler references separately. The monolithic `WorkflowConfig` type is no longer needed.
**Migration**: Use `.compile()` instead of `.build()`. Consumers of `WorkflowConfig` should use the `Manifest` type for metadata.

### Requirement: build() requires all phases
**Reason**: `.build()` is removed. The single-phase builder exposes `.compile()` instead.
**Migration**: Remove `.build()` calls. Use `.compile()` in the Vite plugin.

### Requirement: Phase ordering enforced at compile-time
**Reason**: Single-phase builder replaces the 4-phase system. Generic constraints still enforce event key validity.
**Migration**: No migration needed — the single-phase builder is more permissive but equally safe.

## RENAMED Requirements

- **FROM:** `defineWorkflow function` **TO:** `defineWorkflow function` (name kept, content changed to use `createWorkflow()`)
- **FROM:** `Action names derived from builder method argument` **TO:** `Action names derived from export or explicit parameter`
