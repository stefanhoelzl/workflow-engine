## MODIFIED Requirements

### Requirement: Action type

An `Action` SHALL be a plain object with the following properties:
- `name`: string — unique identifier for the action, derived from the `defineWorkflow` actions object key
- `match`: `(event: Event) => boolean` — predicate generated from the action's `on` field and the action name (`e.type === on && e.targetAction === name`)
- `handler`: `(ctx: ActionContext) => Promise<void>` — async function that processes the event via the context object

#### Scenario: Define an action

- **GIVEN** a `WorkflowConfig` produced by `defineWorkflow` with `actions: { parseOrder: { on: 'order.received', handler: async (ctx) => { ... } } }`
- **WHEN** the runtime extracts actions from the config
- **THEN** the action has `name: "parseOrder"` and a `match` predicate that returns `true` for events with `type: "order.received"` and `targetAction: "parseOrder"`

#### Scenario: Match predicate receives full event

- **GIVEN** an action with name `"parseOrder"` derived from a `WorkflowConfig` with `on: "order.received"`
- **WHEN** an event `{ type: "order.received", targetAction: "parseOrder" }` is evaluated
- **THEN** `match` returns `true`
- **AND** for an event `{ type: "order.received", targetAction: "sendEmail" }`, `match` returns `false`

## REMOVED Requirements

### Requirement: Plain function contract
**Reason**: Actions are no longer standalone default-exported functions in separate files. In the `defineWorkflow` API, action handlers are defined inline or as named functions within the workflow definition object. Build-time bundling into separate files is deferred to the future sandbox architecture.
**Migration**: Define actions within `defineWorkflow({ actions: { name: { on, handler } } })`.

### Requirement: Standalone bundle
**Reason**: Deferred to the future sandbox/build tooling work. For now, the SDK and runtime run in-process without bundling individual actions.
**Migration**: None — will be re-introduced when the Vite plugin and sandbox architecture are implemented.
