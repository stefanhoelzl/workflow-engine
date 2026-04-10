# Define Workflow Specification

## Purpose

Provide a builder API for defining workflows with typed events, triggers, and actions using a `createWorkflow()` function that returns a phase-typed builder with `TriggerPhase`, `EventPhase`, and `ActionPhase`. Triggers own their events, action events are separate, and unique name enforcement prevents collisions across both pools. Actions are exported as named constants, `.compile()` returns serializable metadata, and `.action()` returns the handler function.

## Requirements

### Requirement: defineWorkflow function

The SDK SHALL export a `createWorkflow()` function that returns a phase-typed builder. The builder SHALL use two generic type pools: `T` for trigger-owned events and `E` for action-owned events.

The builder SHALL progress through three phases, each restricting available methods:
- **TriggerPhase\<T\>**: `trigger()`, `event()`, `action()`, `compile()` available
- **EventPhase\<T, E\>**: `event()`, `action()`, `compile()` available
- **ActionPhase\<T, E\>**: `action()`, `compile()` available

Calling `.trigger()` stays in `TriggerPhase`. Calling `.event()` transitions to `EventPhase`. Calling `.action()` transitions to `ActionPhase`. Phases can be skipped (zero triggers or zero action events are valid).

`.action()` returns the handler function (not the builder). `.compile()` returns serializable metadata and handler references.

#### Scenario: Define a workflow with triggers, events, and actions

- **GIVEN** a call to `createWorkflow().trigger("webhook.order", http({ path: "order", body: z.object({ orderId: z.string() }) })).event("order.validated", z.object({ orderId: z.string() }))`
- **WHEN** `.action({ on: "webhook.order", emits: ["order.validated"], handler: async (ctx) => {} })` is called
- **THEN** it returns the handler function
- **AND** calling `.compile()` returns metadata containing trigger-owned events, action-owned events, triggers, and action entries

#### Scenario: Phase transitions restrict methods

- **GIVEN** `createWorkflow().event("a", z.object({}))`
- **WHEN** the builder is in `EventPhase`
- **THEN** `.trigger()` SHALL NOT be available (compile-time error)
- **AND** `.event()`, `.action()`, `.compile()` SHALL be available

#### Scenario: Skip trigger phase

- **GIVEN** `createWorkflow().event("a", z.object({}))`
- **WHEN** the builder transitions directly to `EventPhase`
- **THEN** the workflow compiles without errors with zero triggers

#### Scenario: Skip event phase

- **GIVEN** `createWorkflow().trigger("t", http({ path: "t" })).action({ on: "t", handler: async () => {} })`
- **WHEN** the builder transitions from `TriggerPhase` to `ActionPhase`
- **THEN** the workflow compiles without errors with zero action-owned events

### Requirement: Triggers own their events

Triggers SHALL implicitly define their own events. The trigger name SHALL be the event name. Calling `.trigger(name, triggerDef)` SHALL add the trigger's schema to the `T` type pool. There SHALL be no separate `event` field on trigger config — the trigger name is used as the event name.

#### Scenario: Trigger name is the event name

- **GIVEN** `createWorkflow().trigger("webhook.cronitor", http({ path: "cronitor", body: z.object({ id: z.string() }) }))`
- **WHEN** an action subscribes with `on: "webhook.cronitor"`
- **THEN** `ctx.event.payload` is typed as `{ body: { id: string }, headers: Record<string, string>, url: string, method: string }`

#### Scenario: Trigger event appears in compile output

- **GIVEN** a builder with `.trigger("webhook.order", http({ path: "order", body: z.object({ orderId: z.string() }) }))`
- **WHEN** `.compile()` is called
- **THEN** the `events` array SHALL contain an entry with `name: "webhook.order"` and a JSON Schema describing the full HTTP payload shape

### Requirement: Events defined via builder method

Events SHALL be defined by calling `.event(name, schema)` on the builder. Each call adds the event to the `E` type pool and transitions to `EventPhase`. The event name is a string key and the schema is a Zod type.

#### Scenario: Event accumulation

- **GIVEN** `createWorkflow().event("a", z.object({ x: z.string() })).event("b", z.object({ y: z.number() }))`
- **WHEN** a subsequent `.action()` subscribes to `"a"`
- **THEN** `ctx.event.payload` is typed as `{ x: string }`
- **AND** the action can reference both `"a"` and `"b"` in its `emits` array

### Requirement: Unique event names across pools

Event names SHALL be unique across both trigger events (`T`) and action events (`E`). The builder SHALL enforce this at compile-time using conditional types that collapse duplicate names to `never`.

#### Scenario: Duplicate name between trigger and event

- **GIVEN** `createWorkflow().trigger("order.received", http({ path: "order" }))`
- **WHEN** `.event("order.received", z.object({}))` is called
- **THEN** a compile-time error SHALL be raised because `"order.received"` already exists in `T`

#### Scenario: Duplicate trigger names

- **GIVEN** `createWorkflow().trigger("webhook.order", http({ path: "order" }))`
- **WHEN** `.trigger("webhook.order", http({ path: "order2" }))` is called
- **THEN** a compile-time error SHALL be raised because `"webhook.order"` already exists in `T`

#### Scenario: Duplicate event names

- **GIVEN** `createWorkflow().event("a", z.object({}))`
- **WHEN** `.event("a", z.object({}))` is called
- **THEN** a compile-time error SHALL be raised because `"a"` already exists in `E`

### Requirement: Actions reference events by key

Each action SHALL have an `on` field whose value MUST be a key from either `T` or `E` (i.e. `keyof (T & E)`). Invalid event references SHALL be compile-time errors.

#### Scenario: Action listens to trigger event

- **GIVEN** `createWorkflow().trigger("webhook.order", http({ path: "order", body: z.object({ orderId: z.string() }) }))`
- **WHEN** `.action({ on: "webhook.order", handler: async (ctx) => {} })` is called
- **THEN** the definition compiles without errors
- **AND** `ctx.event.payload` is typed as the HTTP payload shape

#### Scenario: Action listens to action event

- **GIVEN** a builder with `.event("order.validated", z.object({ orderId: z.string() }))`
- **WHEN** `.action({ on: "order.validated", handler: async (ctx) => {} })` is called
- **THEN** the definition compiles without errors
- **AND** `ctx.event.payload` is typed as `{ orderId: string }`

#### Scenario: Invalid action event reference

- **GIVEN** a builder with `"webhook.order"` defined as a trigger event
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

Actions MAY declare an `env` field as `Record<string, string | EnvRef>` providing key-value pairs. The builder SHALL resolve `EnvRef` markers eagerly and merge the action env with the workflow env (action wins on key conflict). Within the handler, `ctx.env` SHALL be typed as `Readonly<Record<AllKeys, string>>` where `AllKeys` are the union of workflow env keys and action env keys. When neither workflow nor action declares env, `ctx.env` SHALL be typed as `Readonly<{}>`.

#### Scenario: Action env with resolved values
- **GIVEN** a workflow with `.env({ BASE_URL: "https://example.com" })`
- **AND** an action with `env: { API_KEY: env() }` and `process.env.API_KEY` is `"secret"`
- **WHEN** the handler accesses `ctx.env`
- **THEN** `ctx.env.BASE_URL` is `"https://example.com"` and `ctx.env.API_KEY` is `"secret"`

#### Scenario: Action env overrides workflow env on conflict
- **GIVEN** a workflow with `.env({ URL: "https://default.com" })`
- **AND** an action with `env: { URL: "https://override.com" }`
- **WHEN** the handler accesses `ctx.env.URL`
- **THEN** the value is `"https://override.com"`

#### Scenario: Action with no env inherits workflow env
- **GIVEN** a workflow with `.env({ BASE_URL: "https://example.com" })`
- **AND** an action with no `env` field
- **WHEN** the handler accesses `ctx.env.BASE_URL`
- **THEN** TypeScript accepts the access with type `string`
- **AND** the value is `"https://example.com"`

#### Scenario: Access undeclared env key is a compile-time error
- **GIVEN** a workflow with `.env({ A: "1" })` and an action with `env: { B: "2" }`
- **WHEN** the handler accesses `ctx.env.C`
- **THEN** TypeScript raises a compile-time error because `"C"` is not in the declared env keys

#### Scenario: No env at any level
- **GIVEN** a workflow with no `.env()` call and an action with no `env` field
- **WHEN** the handler accesses `ctx.env.ANYTHING`
- **THEN** TypeScript raises a compile-time error because `ctx.env` is `Readonly<{}>`

### Requirement: Action emits declaration

Actions MAY declare an `emits` field listing event keys they may emit. The `emits` array SHALL only accept keys from the action events pool `E`, NOT from the trigger events pool `T`. The `ctx.emit()` method SHALL only accept event names listed in the action's `emits` array at compile-time. When `emits` is omitted, `ctx.emit()` SHALL accept `never` as the event name.

#### Scenario: Typed emit restricted to action events

- **GIVEN** trigger `"webhook.order"` and action event `"order.parsed"` defined, and an action with `emits: ["order.parsed"]`
- **WHEN** the handler calls `ctx.emit("order.parsed", { total: 42 })`
- **THEN** TypeScript accepts the call and verifies the payload matches the event schema

#### Scenario: Emit of trigger event rejected

- **GIVEN** trigger `"webhook.order"` and action event `"order.parsed"` defined, and an action with `on: "webhook.order"`
- **WHEN** the action tries to declare `emits: ["webhook.order"]`
- **THEN** a compile-time error SHALL be raised because `"webhook.order"` is a trigger event, not an action event

#### Scenario: Emit of event not in emits array

- **GIVEN** action events `"order.parsed"` and `"order.shipped"` defined, and an action with `emits: ["order.parsed"]`
- **WHEN** the handler calls `ctx.emit("order.shipped", {})`
- **THEN** TypeScript raises a compile-time error because `"order.shipped"` is not in the action's `emits` array

#### Scenario: No emits declaration

- **GIVEN** an action without an `emits` field
- **WHEN** the handler calls `ctx.emit("order.parsed", { total: 1 })`
- **THEN** TypeScript raises a compile-time error because `ctx.emit` accepts `never` as the event name

### Requirement: Compile method replaces build

The builder SHALL expose a `.compile()` method that returns an object containing serializable event metadata (with JSON Schema via `z.toJSONSchema()`), trigger definitions, and action entries with handler function references. Each action entry SHALL include an `env` field of type `Record<string, string>` containing the merged workflow + action env with all values resolved. There SHALL be no `.build()` method and no `WorkflowConfig` type.

#### Scenario: Compile returns metadata and handlers
- **GIVEN** a builder with one event, one trigger, and one action
- **WHEN** `.compile()` is called
- **THEN** the result contains `events` (array of `{ name, schema }` where schema is JSON Schema), `triggers` (array of trigger definitions), and `actions` (array with `name`, `on`, `emits`, `env`, and `handler` reference)
- **AND** `env` is a `Record<string, string>` with resolved values

#### Scenario: Compile merges workflow and action env
- **GIVEN** a builder with `.env({ A: "1" })` and an action with `env: { B: "2", A: "override" }`
- **WHEN** `.compile()` is called
- **THEN** the action entry's `env` is `{ A: "override", B: "2" }`

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

### Requirement: env helper function

The SDK SHALL export an `env()` function that returns a Symbol-branded `EnvRef` marker object. The marker SHALL carry an optional `name` (string) and optional `default` (string). The Symbol used for branding SHALL be exported as `ENV_REF` for marker detection.

`env()` SHALL support the following call signatures:
- `env()` — name is `undefined`, no default
- `env(name: string)` — explicit name, no default
- `env(opts: { default: string })` — name is `undefined`, with default
- `env(name: string, opts: { default: string })` — explicit name and default

#### Scenario: env() with no arguments
- **WHEN** `env()` is called
- **THEN** it returns `{ [ENV_REF]: true, name: undefined, default: undefined }`

#### Scenario: env() with explicit name
- **WHEN** `env("MY_VAR")` is called
- **THEN** it returns `{ [ENV_REF]: true, name: "MY_VAR", default: undefined }`

#### Scenario: env() with default only
- **WHEN** `env({ default: "fallback" })` is called
- **THEN** it returns `{ [ENV_REF]: true, name: undefined, default: "fallback" }`

#### Scenario: env() with name and default
- **WHEN** `env("MY_VAR", { default: "fallback" })` is called
- **THEN** it returns `{ [ENV_REF]: true, name: "MY_VAR", default: "fallback" }`

### Requirement: EnvRef resolution

EnvRef markers SHALL be resolved by the workflow builder when processing env objects (in `.env()` and `.action()` env fields). Resolution SHALL use `process.env` to look up the value.

When resolving an `EnvRef`:
- If `name` is `undefined`, the object key SHALL be used as the env var name
- If `process.env[resolvedName]` exists, its value SHALL be used
- If `process.env[resolvedName]` is `undefined` and `default` is defined, the default SHALL be used
- If `process.env[resolvedName]` is `undefined` and no default is defined, resolution SHALL throw an `Error`

Plain string values in env objects SHALL be kept as-is without resolution.

#### Scenario: Resolve env() with no name uses object key
- **GIVEN** `.env({ API_URL: env() })` and `process.env.API_URL` is `"https://api.example.com"`
- **WHEN** the builder processes the env object
- **THEN** `API_URL` resolves to `"https://api.example.com"`

#### Scenario: Resolve env() with explicit name
- **GIVEN** `.env({ API_URL: env("MY_API_URL") })` and `process.env.MY_API_URL` is `"https://api.example.com"`
- **WHEN** the builder processes the env object
- **THEN** `API_URL` resolves to `"https://api.example.com"`

#### Scenario: Resolve env() with default when var is missing
- **GIVEN** `.env({ API_URL: env({ default: "http://localhost" }) })` and `process.env.API_URL` is `undefined`
- **WHEN** the builder processes the env object
- **THEN** `API_URL` resolves to `"http://localhost"`

#### Scenario: Resolve env() without default when var is missing
- **GIVEN** `.env({ API_URL: env() })` and `process.env.API_URL` is `undefined`
- **WHEN** the builder processes the env object
- **THEN** resolution SHALL throw an Error with a message containing `"API_URL"`

#### Scenario: Plain string value kept as-is
- **GIVEN** `.env({ API_URL: "https://hardcoded.example.com" })`
- **WHEN** the builder processes the env object
- **THEN** `API_URL` resolves to `"https://hardcoded.example.com"`

#### Scenario: EnvRef detection uses Symbol
- **GIVEN** a plain object `{ name: "FOO" }` (without the `ENV_REF` Symbol)
- **WHEN** the builder checks if it is an `EnvRef`
- **THEN** it SHALL NOT be treated as an `EnvRef` marker

### Requirement: Workflow-level env declaration

The builder SHALL expose an `.env(config)` method that accepts `Record<string, string | EnvRef>`. The method SHALL resolve all `EnvRef` markers eagerly from `process.env` and store the resolved `Record<string, string>` as the workflow's env. The method SHALL return `this` for chaining. The workflow env SHALL be available to all actions defined on the builder.

#### Scenario: Define workflow-level env with literals and env refs
- **GIVEN** `createWorkflow().env({ BASE_URL: "https://example.com", API_KEY: env() })`
- **AND** `process.env.API_KEY` is `"secret123"`
- **WHEN** `.compile()` is called
- **THEN** all actions SHALL have `BASE_URL: "https://example.com"` and `API_KEY: "secret123"` in their env

#### Scenario: Workflow env chaining
- **GIVEN** `createWorkflow().env({ A: "1" }).event("e", schema)`
- **WHEN** the builder chain continues
- **THEN** `.env()` returns the builder for further chaining
