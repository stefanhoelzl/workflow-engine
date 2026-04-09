## MODIFIED Requirements

### Requirement: Triggers reference events by key

Each trigger SHALL have an `event` field whose value MUST be a key from previously defined events. Invalid event references SHALL be compile-time errors. Triggers are added via `.trigger(name, config)` on `EventPhase` or `TriggerPhase`. The `name` argument SHALL be stored as part of the trigger definition in `WorkflowConfig`.

#### Scenario: Valid trigger event reference

- **GIVEN** `.event("order.received", schema).trigger("orders", { type: "http", path: "orders", event: "order.received" })`
- **WHEN** TypeScript checks the builder chain
- **THEN** the definition compiles without errors

#### Scenario: Invalid trigger event reference

- **GIVEN** `.event("order.received", schema).trigger("orders", { type: "http", path: "orders", event: "order.typo" })`
- **WHEN** TypeScript checks the builder chain
- **THEN** a compile-time error is raised because `"order.typo"` is not a defined event key

#### Scenario: Trigger name is stored in WorkflowConfig

- **GIVEN** `.event("order.received", schema).trigger("orders", { type: "http", path: "orders", event: "order.received" })`
- **WHEN** `.build()` produces the `WorkflowConfig`
- **THEN** the trigger entry in `triggers` has `name: "orders"`

### Requirement: HTTP trigger type

Triggers with `type: "http"` SHALL include `path` (string) and `event` (event key). The `method` field SHALL be optional. The `response` field SHALL be optional. Defaults for `method` and `response` are applied by the runtime's `HttpTriggerRegistry`, not the SDK — the SDK passes trigger definitions through as-is. The trigger `name` from the builder's first argument SHALL be included in the trigger definition.

#### Scenario: Minimal HTTP trigger

- **GIVEN** `.trigger("orders", { type: "http", path: "orders", event: "order.received" })`
- **WHEN** `.build()` produces the `WorkflowConfig`
- **THEN** the trigger is passed through with `name: "orders"`, `method` and `response` undefined (runtime applies defaults)

#### Scenario: HTTP trigger with explicit options

- **GIVEN** `.trigger("orders", { type: "http", path: "orders", method: "PUT", event: "order.received", response: { status: 202 } })`
- **WHEN** `.build()` produces the `WorkflowConfig`
- **THEN** the trigger is passed through with `name: "orders"`, `method: "PUT"`, and `response: { status: 202 }`

### Requirement: WorkflowConfig output

`.build()` SHALL return a `WorkflowConfig` object containing the workflow's events, triggers, and actions in a form consumable by the runtime. The config SHALL include handler functions so the runtime can execute actions. The `triggers` array entries SHALL include the `name` field from the builder's `.trigger(name, config)` call.

#### Scenario: WorkflowConfig structure

- **GIVEN** a builder with one event, one trigger, and one action
- **WHEN** `.build()` returns
- **THEN** the result contains `events` (map of type string to Zod schema), `triggers` (array of trigger definitions including `name`), and `actions` (array of action definitions with name, resolved event `on: { name, schema }`, handler, env, and emits)
