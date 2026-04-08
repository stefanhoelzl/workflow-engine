## MODIFIED Requirements

### Requirement: defineWorkflow function

The SDK SHALL export a `workflow()` function that returns a builder object. The builder progresses through typed phases — `StartPhase`, `EventPhase`, `TriggerPhase`, `ActionPhase` — each exposing only the methods valid for that phase. Calling `.build()` on `ActionPhase` SHALL return a `WorkflowConfig`.

#### Scenario: Define a workflow via builder

- **GIVEN** a call to `workflow().event("order.received", z.object({ orderId: z.string() })).trigger("orders", { type: "http", path: "orders", event: "order.received" }).action("parseOrder", { on: "order.received", handler: async () => {} }).build()`
- **WHEN** the builder executes
- **THEN** it returns a `WorkflowConfig` containing the event definitions, a triggers array with one entry, and an actions array with one entry

#### Scenario: Phase ordering enforced at compile-time

- **GIVEN** a `workflow()` call
- **WHEN** `.trigger()` is called before any `.event()` call
- **THEN** TypeScript raises a compile-time error because `StartPhase` does not expose `.trigger()`

#### Scenario: build() requires all phases

- **GIVEN** a builder with events defined but no triggers or actions
- **WHEN** `.build()` is called
- **THEN** TypeScript raises a compile-time error because `.build()` is only available on `ActionPhase`

### Requirement: Events defined via builder method

Events SHALL be defined by calling `.event(name, schema)` on the builder. Each call adds the event to the builder's accumulated type and returns the builder in `EventPhase`. The event name is a string key and the schema is a Zod type.

#### Scenario: Event accumulation

- **GIVEN** `workflow().event("a", z.object({ x: z.string() })).event("b", z.object({ y: z.number() }))`
- **WHEN** a subsequent `.action()` subscribes to `"a"`
- **THEN** `ctx.event.payload` is typed as `{ x: string }`
- **AND** the action can reference both `"a"` and `"b"` in its `emits` array

#### Scenario: Duplicate event name

- **GIVEN** `.event("a", s1).event("a", s2)`
- **WHEN** the builder executes
- **THEN** the second schema overwrites the first (last-write-wins, no runtime error)

### Requirement: Triggers reference events by key

Each trigger SHALL have an `event` field whose value MUST be a key from previously defined events. Invalid event references SHALL be compile-time errors. Triggers are added via `.trigger(name, config)` on `EventPhase` or `TriggerPhase`.

#### Scenario: Valid trigger event reference

- **GIVEN** `.event("order.received", schema).trigger("orders", { type: "http", path: "orders", event: "order.received" })`
- **WHEN** TypeScript checks the builder chain
- **THEN** the definition compiles without errors

#### Scenario: Invalid trigger event reference

- **GIVEN** `.event("order.received", schema).trigger("orders", { type: "http", path: "orders", event: "order.typo" })`
- **WHEN** TypeScript checks the builder chain
- **THEN** a compile-time error is raised because `"order.typo"` is not a defined event key

### Requirement: Actions reference events by key

Each action SHALL have an `on` field whose value MUST be a key from previously defined events. Invalid event references SHALL be compile-time errors. Actions are added via `.action(name, config)` on `TriggerPhase` or `ActionPhase`.

#### Scenario: Valid action event reference

- **GIVEN** `.event("order.received", schema).trigger("t", config).action("parseOrder", { on: "order.received", handler: async () => {} })`
- **WHEN** TypeScript checks the builder chain
- **THEN** the definition compiles without errors

#### Scenario: Invalid action event reference

- **GIVEN** a builder with `"order.received"` defined
- **WHEN** `.action("parseOrder", { on: "order.typo", handler: async () => {} })` is called
- **THEN** a compile-time error is raised because `"order.typo"` is not a defined event key

### Requirement: Action names derived from builder method argument

Action names SHALL be derived from the first argument to `.action(name, config)`. The name is used as the action's unique identifier for routing and manifest generation.

#### Scenario: Action name from builder argument

- **GIVEN** `.action("notifyCronitor", { on: "cronitor.webhook", handler: async (ctx) => {} })`
- **WHEN** the `WorkflowConfig` is produced via `.build()`
- **THEN** the action's name is `"notifyCronitor"`

### Requirement: Action env declaration

Actions MAY declare an `env` field listing environment variable names they require. Within the builder, `ctx.env` SHALL be typed as `Readonly<Record<DeclaredKeys, string>>` where `DeclaredKeys` are the literal string types from the `env` array. When `env` is omitted, `ctx.env` SHALL be typed as `Readonly<{}>`.

#### Scenario: Env access with declared keys

- **GIVEN** `.action("notify", { on: "alert", env: ["API_KEY", "API_URL"], handler: async (ctx) => {} })`
- **WHEN** the handler accesses `ctx.env.API_KEY`
- **THEN** TypeScript accepts the access with type `string`

#### Scenario: Env access with undeclared key

- **GIVEN** `.action("notify", { on: "alert", env: ["API_KEY"], handler: async (ctx) => {} })`
- **WHEN** the handler accesses `ctx.env.SECRET`
- **THEN** TypeScript raises a compile-time error because `"SECRET"` is not a declared env key

#### Scenario: Env readonly

- **GIVEN** `.action("notify", { on: "alert", env: ["API_KEY"], handler: async (ctx) => {} })`
- **WHEN** the handler assigns `ctx.env.API_KEY = "x"`
- **THEN** TypeScript raises a compile-time error because `ctx.env` is `Readonly`

#### Scenario: No env declaration

- **GIVEN** `.action("sink", { on: "alert", handler: async (ctx) => {} })`
- **WHEN** the handler accesses `ctx.env.ANYTHING`
- **THEN** TypeScript raises a compile-time error because `ctx.env` is `Readonly<{}>`

#### Scenario: Env metadata preserved in config

- **GIVEN** an action with `env: ["API_KEY"]`
- **WHEN** `.build()` produces the `WorkflowConfig`
- **THEN** the action's `env` array is `["API_KEY"]`

#### Scenario: No env declaration defaults to empty array

- **GIVEN** an action without an `env` field
- **WHEN** `.build()` produces the `WorkflowConfig`
- **THEN** the action's `env` array is `[]`

### Requirement: Action emits declaration

Actions MAY declare an `emits` field listing event keys they may emit. The `ctx.emit()` method SHALL only accept event names listed in the action's `emits` array at compile-time. When `emits` is omitted, `ctx.emit()` SHALL accept `never` as the event name — the method exists but no valid call is possible.

#### Scenario: Typed emit restricted to emits array

- **GIVEN** events `"order.received"` and `"order.parsed"` defined, and an action with `emits: ["order.parsed"]`
- **WHEN** the handler calls `ctx.emit("order.parsed", { total: 42 })`
- **THEN** TypeScript accepts the call and verifies the payload matches the event schema

#### Scenario: Emit of event not in emits array

- **GIVEN** events `"order.received"` and `"order.parsed"` defined, and an action with `emits: ["order.parsed"]`
- **WHEN** the handler calls `ctx.emit("order.received", { orderId: "123" })`
- **THEN** TypeScript raises a compile-time error because `"order.received"` is not in the action's `emits` array

#### Scenario: Emit with invalid event name

- **GIVEN** events `"order.received"` and `"order.parsed"` defined
- **WHEN** the handler calls `ctx.emit("order.typo", {})`
- **THEN** a compile-time error is raised because `"order.typo"` is not a defined event key

#### Scenario: Emit with wrong payload type

- **GIVEN** an action with `emits: ["order.parsed"]` where `"order.parsed"` has schema `z.object({ total: z.number() })`
- **WHEN** the handler calls `ctx.emit("order.parsed", { orderId: "abc" })`
- **THEN** a compile-time error is raised because the payload does not match the event schema

#### Scenario: No emits declaration

- **GIVEN** an action without an `emits` field
- **WHEN** the handler calls `ctx.emit("order.parsed", { total: 1 })`
- **THEN** TypeScript raises a compile-time error because `ctx.emit` accepts `never` as the event name

#### Scenario: Emits metadata preserved in config

- **GIVEN** an action with `emits: ["order.parsed"]`
- **WHEN** `.build()` produces the `WorkflowConfig`
- **THEN** the action's `emits` array is `["order.parsed"]`

#### Scenario: No emits declaration defaults to empty array

- **GIVEN** an action without an `emits` field
- **WHEN** `.build()` produces the `WorkflowConfig`
- **THEN** the action's `emits` array is `[]`

### Requirement: HTTP trigger type

Triggers with `type: "http"` SHALL include `path` (string) and `event` (event key). The `method` field SHALL be optional. The `response` field SHALL be optional. Defaults for `method` and `response` are applied by the runtime's `HttpTriggerRegistry`, not the SDK — the SDK passes trigger definitions through as-is.

#### Scenario: Minimal HTTP trigger

- **GIVEN** `.trigger("orders", { type: "http", path: "orders", event: "order.received" })`
- **WHEN** `.build()` produces the `WorkflowConfig`
- **THEN** the trigger is passed through with `method` and `response` undefined (runtime applies defaults)

#### Scenario: HTTP trigger with explicit options

- **GIVEN** `.trigger("orders", { type: "http", path: "orders", method: "PUT", event: "order.received", response: { status: 202 } })`
- **WHEN** `.build()` produces the `WorkflowConfig`
- **THEN** the trigger is passed through with `method: "PUT"` and `response: { status: 202 }`

### Requirement: WorkflowConfig output

`.build()` SHALL return a `WorkflowConfig` object containing the workflow's events, triggers, and actions in a form consumable by the runtime. The config SHALL include handler functions so the runtime can execute actions. The `WorkflowConfig` type is unchanged from the previous `defineWorkflow` API.

#### Scenario: WorkflowConfig structure

- **GIVEN** a builder with one event, one trigger, and one action
- **WHEN** `.build()` returns
- **THEN** the result contains `events` (map of type string to Zod schema), `triggers` (array of trigger definitions), and `actions` (array of action definitions with name, resolved event `on: { name, schema }`, handler, env, and emits)

### Requirement: SDK re-exports Zod

The SDK SHALL re-export `z` from Zod so workflow authors can import everything from a single package.

#### Scenario: Import z from SDK

- **GIVEN** a workflow file importing from `@workflow-engine/sdk`
- **WHEN** the author writes `import { workflow, z } from "@workflow-engine/sdk"`
- **THEN** `z` is the same Zod namespace as `import { z } from "zod"`

## REMOVED Requirements

### Requirement: defineWorkflow function
**Reason**: Replaced by `workflow()` builder API to enable compile-time narrowing of `ctx.emit()` and `ctx.env`.
**Migration**: Replace `defineWorkflow({ events, triggers, actions })` with `workflow().event(...).trigger(...).action(...).build()`.

### Requirement: Events defined as Zod schemas keyed by type string
**Reason**: Events are now defined via `.event(name, schema)` builder method instead of as a config object.
**Migration**: Move each event from the `events: { ... }` object to a `.event(name, schema)` call.

### Requirement: Action names derived from object keys
**Reason**: Actions are now defined via `.action(name, config)` where the name is the first argument.
**Migration**: The action name moves from the object key to the first argument of `.action()`.
