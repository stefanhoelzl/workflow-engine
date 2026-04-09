# Define Workflow Specification

## Purpose

Provide a builder API for defining workflows with typed events, triggers, and actions using a `createWorkflow()` function that returns a single-phase `WorkflowBuilder<E>`. Actions are exported as named constants, `.compile()` returns serializable metadata, and `.action()` returns the handler function.

## Requirements

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
