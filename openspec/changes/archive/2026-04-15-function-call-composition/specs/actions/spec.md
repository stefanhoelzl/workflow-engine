## ADDED Requirements

### Requirement: Action is a typed callable with input/output schemas

An action SHALL be a typed callable function created via `action({ input, output, handler })`. The action SHALL have required Zod schemas for `input` and `output`. The action SHALL be invocable as `await myAction(input)` from any other action's handler or any trigger handler within the same workflow.

#### Scenario: Action callable from another action

- **GIVEN** `const a = action({ input: z.object({ x: z.number() }), output: z.string(), handler: async ({ x }) => String(x) })`
- **AND** another action `b` whose handler calls `await a({ x: 42 })`
- **WHEN** `b` is invoked
- **THEN** `a` SHALL be invoked via the host bridge with the validated input
- **AND** `a`'s return value SHALL be returned to `b`'s handler

#### Scenario: Action callable from trigger handler

- **GIVEN** an action `a` and a trigger handler that calls `await a(input)`
- **WHEN** the trigger fires
- **THEN** the trigger handler SHALL receive `a`'s return value

### Requirement: Action input validated at bridge boundary

The runtime SHALL validate action input against the declared input Zod schema each time the action is called. Validation failures SHALL throw a validation error inside the calling handler.

#### Scenario: Valid input passes validation

- **GIVEN** an action with `input: z.object({ x: z.number() })`
- **WHEN** invoked with `{ x: 42 }`
- **THEN** the handler SHALL receive the validated input

#### Scenario: Invalid input throws

- **GIVEN** an action with `input: z.object({ x: z.number() })`
- **WHEN** invoked with `{ x: "not a number" }`
- **THEN** the bridge SHALL throw a validation error into the calling handler
- **AND** the action's `handler` function SHALL NOT execute

### Requirement: Action output validated at bridge boundary

The runtime SHALL validate the action handler's return value against the declared output Zod schema before returning to the caller. Output validation failures SHALL surface as a thrown error inside the calling handler.

#### Scenario: Valid output passes validation

- **GIVEN** an action with `output: z.string()` whose handler returns `"hello"`
- **WHEN** invoked
- **THEN** the caller SHALL receive `"hello"`

#### Scenario: Invalid output throws

- **GIVEN** an action with `output: z.string()` whose handler returns `42`
- **WHEN** invoked
- **THEN** the bridge SHALL throw a validation error into the calling handler

### Requirement: Action identity is the export name

The action's `name` SHALL be the export name from the workflow file. The build system SHALL discover actions by walking workflow file exports and matching `ACTION_BRAND`.

#### Scenario: Export name becomes action name

- **GIVEN** `export const sendNotification = action({...})` in a workflow file
- **WHEN** the workflow is built
- **THEN** the manifest SHALL contain an action entry with `name: "sendNotification"`

### Requirement: Action handler receives only input

Action handlers SHALL be invoked as `handler(input)` with a single argument. Handlers SHALL NOT receive a `ctx` parameter. Workflow-level env SHALL be accessed via the module-scoped `workflow.env` object imported at file scope.

#### Scenario: Handler signature is single-argument

- **GIVEN** an action declared with `handler: async (input) => { ... }`
- **WHEN** the runtime invokes the action
- **THEN** exactly one argument (the validated input) SHALL be passed

#### Scenario: Env access via module-scoped workflow

- **GIVEN** a handler accessing `workflow.env.NEXTCLOUD_URL`
- **WHEN** the handler executes
- **THEN** `workflow.env.NEXTCLOUD_URL` SHALL contain the resolved env value declared on `defineWorkflow({ env })`

## REMOVED Requirements

### Requirement: Typed context

**Reason**: The `ActionContext` (`ctx.event`, `ctx.emit`, `ctx.env`) is removed entirely. Handlers now receive `(input)` directly; env is module-scoped via `workflow.env`; `emit()` is removed because events are gone.

**Migration**: Replace `handler: async (ctx) => { ctx.event.payload; ctx.env.X; ctx.emit(...) }` with `handler: async (input) => { input; workflow.env.X; await otherAction(...) }`.

### Requirement: Action type

**Reason**: The `Action` shape changes substantially. Old shape: `{ name, on, handler }`. New shape: branded callable carrying `{ name, input, output, handler }`. The `on:` field no longer exists because there are no events to subscribe to; the `name` field now derives from the export name rather than a builder argument.

**Migration**: Replace `.action("name", { on: "event.type", handler })` with `export const name = action({ input: zodSchema, output: zodSchema, handler })`.

### Requirement: Action handler receives ActionContext

**Reason**: Replaced by "Action handler receives only input" above. No `ctx` parameter.

**Migration**: See the new requirement.

### Requirement: No side effects at module scope

**Reason**: This was a soft `SHOULD NOT` constraint about per-isolate-load behavior. With one sandbox per workflow reused across invocations, module scope runs once at workflow load. The constraint is preserved as documented determinism guidance for future durable execution but is not enforced as a v1 requirement.

**Migration**: No author action required for v1; module-scope code runs once per workflow load. Authors expecting per-invocation execution should move that code into handlers.
