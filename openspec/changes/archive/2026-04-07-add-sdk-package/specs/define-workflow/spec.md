## ADDED Requirements

### Requirement: defineWorkflow function

The SDK SHALL export a `defineWorkflow(config)` function that accepts an object with `events`, `triggers`, and `actions` sections and returns a `WorkflowConfig`.

#### Scenario: Define a minimal workflow

- **GIVEN** a call to `defineWorkflow({ events: { 'order.received': z.object({ orderId: z.string() }) }, triggers: {}, actions: {} })`
- **WHEN** the function executes
- **THEN** it returns a `WorkflowConfig` containing the event definitions, an empty triggers list, and an empty actions list

### Requirement: Events defined as Zod schemas keyed by type string

The `events` section SHALL be a record mapping event type strings to Zod schemas. Each key is the event type used at runtime, and the schema provides compile-time type inference for payloads.

#### Scenario: Event type inference

- **GIVEN** `events: { 'order.received': z.object({ orderId: z.string() }) }`
- **WHEN** an action subscribes to `'order.received'`
- **THEN** the action handler's `ctx.event.payload` is typed as `{ orderId: string }` and `ctx.event.name` is typed as `string`

### Requirement: Triggers reference events by key

Each trigger in the `triggers` section SHALL have an `event` field whose value MUST be a key from the `events` section. Invalid event references SHALL be compile-time errors.

#### Scenario: Valid trigger event reference

- **GIVEN** `events: { 'order.received': schema }` and `triggers: { orders: { type: 'http', path: 'orders', event: 'order.received', response: { status: 202, body: { ok: true } } } }`
- **WHEN** TypeScript checks the workflow definition
- **THEN** the definition compiles without errors

#### Scenario: Invalid trigger event reference

- **GIVEN** `events: { 'order.received': schema }` and `triggers: { orders: { type: 'http', path: 'orders', event: 'order.typo', response: { status: 202, body: { ok: true } } } }`
- **WHEN** TypeScript checks the workflow definition
- **THEN** a compile-time error is raised because `'order.typo'` is not a key in `events`

### Requirement: Actions reference events by key

Each action in the `actions` section SHALL have an `on` field whose value MUST be a key from the `events` section. Invalid event references SHALL be compile-time errors.

#### Scenario: Valid action event reference

- **GIVEN** `events: { 'order.received': z.object({ orderId: z.string() }) }` and `actions: { parseOrder: { on: 'order.received', handler: async (ctx) => {} } }`
- **WHEN** TypeScript checks the workflow definition
- **THEN** the definition compiles without errors

#### Scenario: Invalid action event reference

- **GIVEN** `events: { 'order.received': schema }` and `actions: { parseOrder: { on: 'order.typo', handler: async (ctx) => {} } }`
- **WHEN** TypeScript checks the workflow definition
- **THEN** a compile-time error is raised because `'order.typo'` is not a key in `events`

### Requirement: Action names derived from object keys

Action names SHALL be derived from the keys of the `actions` object. The key is used as the action's unique identifier for routing and manifest generation.

#### Scenario: Action name from key

- **GIVEN** `actions: { notifyCronitor: { on: 'cronitor.webhook', handler: async (ctx) => {} } }`
- **WHEN** the `WorkflowConfig` is produced
- **THEN** the action's name is `'notifyCronitor'`

### Requirement: Action env declaration

Actions MAY declare an `env` field listing the environment variable names they require. The `env` array serves as runtime metadata for the future sandbox to restrict which environment variables are exposed (least privilege). Within `defineWorkflow`, `ctx.env` is typed as `Record<string, string | undefined>` regardless of whether `env` is declared, because TypeScript cannot flow array literal values into generic type parameters across sibling object fields.

#### Scenario: Env access in handler

- **GIVEN** `actions: { notify: { on: 'alert', env: ['API_KEY', 'API_URL'], handler: async (ctx) => {} } }`
- **WHEN** the handler accesses `ctx.env.API_KEY`
- **THEN** TypeScript accepts the access with type `string | undefined`

#### Scenario: Env metadata preserved in config

- **GIVEN** an action with `env: ['API_KEY']`
- **WHEN** the `WorkflowConfig` is produced
- **THEN** the action's `env` array is `['API_KEY']`

#### Scenario: No env declaration

- **GIVEN** an action without an `env` field
- **WHEN** the `WorkflowConfig` is produced
- **THEN** the action's `env` array is `[]`

### Requirement: Action emits declaration

Actions MAY declare an `emits` field listing event keys they may emit. When declared, `ctx.emit()` SHALL only accept those event types. When omitted, `ctx.emit()` SHALL be typed as `never`.

#### Scenario: Typed emit

- **GIVEN** `events: { 'order.parsed': z.object({ orderId: z.string() }) }` and an action with `emits: ['order.parsed']`
- **WHEN** the handler calls `ctx.emit('order.parsed', { orderId: '123' })`
- **THEN** TypeScript accepts the call and verifies the payload matches the event schema

#### Scenario: Emit with undeclared event

- **GIVEN** an action with `emits: ['order.parsed']`
- **WHEN** the handler calls `ctx.emit('order.failed', { reason: 'invalid' })`
- **THEN** a compile-time error is raised because `'order.failed'` is not in `emits`

#### Scenario: No emits declaration

- **GIVEN** an action without an `emits` field
- **WHEN** the handler calls `ctx.emit('anything', {})`
- **THEN** a compile-time error is raised because `ctx.emit` is typed as `never`

### Requirement: HTTP trigger type

Triggers with `type: 'http'` SHALL include `path` (string) and `event` (event key). The `method` field SHALL be optional. The `response` field SHALL be optional. Defaults for `method` and `response` are applied by the runtime's `HttpTriggerRegistry`, not the SDK — the SDK passes trigger definitions through as-is.

#### Scenario: Minimal HTTP trigger

- **GIVEN** `triggers: { orders: { type: 'http', path: 'orders', event: 'order.received' } }`
- **WHEN** the `WorkflowConfig` is produced
- **THEN** the trigger is passed through with `method` and `response` undefined (runtime applies defaults)

#### Scenario: HTTP trigger with explicit options

- **GIVEN** `triggers: { orders: { type: 'http', path: 'orders', method: 'PUT', event: 'order.received', response: { status: 202 } } }`
- **WHEN** the `WorkflowConfig` is produced
- **THEN** the trigger is passed through with `method: 'PUT'` and `response: { status: 202 }`

### Requirement: WorkflowConfig output

`defineWorkflow` SHALL return a `WorkflowConfig` object containing the workflow's events, triggers, and actions in a form consumable by the runtime. The config SHALL include handler functions so the runtime can execute actions.

#### Scenario: WorkflowConfig structure

- **GIVEN** a workflow with one event, one trigger, and one action
- **WHEN** `defineWorkflow(...)` returns
- **THEN** the result contains `events` (map of type string → Zod schema), `triggers` (array of trigger definitions passed through as-is), and `actions` (array of action definitions with name, resolved event `on: { name, schema }`, handler, env, and emits)
