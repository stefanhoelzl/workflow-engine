## MODIFIED Requirements

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
- **THEN** `ctx.event.payload` is typed as `{ body: { id: string }, headers: Record<string, string>, path: string, method: string }`

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

## REMOVED Requirements

### Requirement: Triggers reference events by key

**Reason:** Triggers now own their events. The trigger name IS the event name. There is no separate `event` field on trigger config.

**Migration:** Replace `.event("evt", schema).trigger("name", { type: "http", event: "evt", ... })` with `.trigger("evt", http({ ... }))`.

### Requirement: Duplicate event name

**Reason:** Replaced by the "Unique event names across pools" requirement which enforces uniqueness at compile-time instead of allowing last-write-wins.

**Migration:** Ensure all event and trigger names are unique.
