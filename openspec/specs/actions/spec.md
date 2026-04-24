# Actions Specification

## Purpose

Define the contract for user-provided action handlers: typed callable functions with input/output schemas that compose via direct function calls within a workflow's sandbox.
## Requirements
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

### Requirement: host-call-action plugin module

The runtime package SHALL provide a `host-call-action` plugin module at `packages/runtime/src/plugins/host-call-action.ts`. The plugin file SHALL be imported via the `?sandbox-plugin` vite query (which returns a `{ name, dependsOn?, workerSource, guestSource? }` record). The plugin's `worker()` SHALL accept a `Config` of shape `{ inputValidatorSources: Record<string, string>; outputValidatorSources: Record<string, string> }` and SHALL `new Function(...)`-instantiate each per-action Ajv `standaloneCode` source into a predicate. Ajv compilation itself runs on the main thread in `packages/runtime/src/host-call-action-config.ts` via `compileActionValidators(manifest)`, and the resulting sources are spread into `descriptor.config` when composing the descriptor list. The plugin SHALL return `exports: { validateAction, validateActionOutput }` where:

- `validateAction(name: string, input: unknown): void` — runs the compiled input validator for the given action name and throws a `ValidationError` carrying Ajv's `errors` array on validation failure.
- `validateActionOutput(name: string, output: unknown): unknown` — runs the compiled output validator and returns the validated value on success. On failure it SHALL throw a `ValidationError` carrying Ajv's `errors` array transformed into `ValidationIssue[]` (each entry with `path: (string|number)[]` and `message: string`).

Each direction SHALL have its own per-action validator source map. The main-thread Ajv instance MAY share its compile cache across directions so schema objects referenced by both the manifest and tenant-declared `responseBody` reuse their compiled validator at build time.

The plugin SHALL register no guest functions; actions reach it via `deps["host-call-action"].validateAction` and `deps["host-call-action"].validateActionOutput`, not directly via guest globals.

#### Scenario: Validators compiled per action for both directions

- **GIVEN** a manifest with `actions: [{ name: "a", inputSchema, outputSchema }, { name: "b", inputSchema, outputSchema }]`
- **WHEN** the plugin's `worker()` runs
- **THEN** four Ajv validators SHALL be compiled at init time (one per action per direction)
- **AND** they SHALL be keyed by `(action name, direction)`

#### Scenario: Valid input passes

- **GIVEN** action `a` with input schema `{type:"object", required:["foo"], properties:{foo:{type:"string"}}}`
- **WHEN** `validateAction("a", {foo: "bar"})` is called
- **THEN** it SHALL return without throwing

#### Scenario: Invalid input throws ValidationError with Ajv errors

- **WHEN** `validateAction("a", {foo: 42})` is called
- **THEN** it SHALL throw a `ValidationError`
- **AND** the error SHALL carry an `errors` array of Ajv error objects
- **AND** the message SHALL be human-readable

#### Scenario: Valid output returns the validated value

- **GIVEN** action `a` with output schema `{type: "string"}`
- **WHEN** `validateActionOutput("a", "ok")` is called
- **THEN** it SHALL return `"ok"` without throwing

#### Scenario: Invalid output throws ValidationError with issues

- **WHEN** `validateActionOutput("a", 42)` is called against a `{type: "string"}` schema
- **THEN** it SHALL throw a `ValidationError`
- **AND** the error SHALL carry an `issues` array with `path` + `message` entries

#### Scenario: Unknown action name throws for both directions

- **GIVEN** a manifest without action `z`
- **WHEN** `validateAction("z", x)` or `validateActionOutput("z", y)` is called
- **THEN** the call SHALL throw with an error naming the unknown action

### Requirement: host-call-action plugin depends on none

The `host-call-action` plugin module SHALL declare `dependsOn: []` (or omit it). It provides validation capability to downstream plugins via `exports`; the `sdk-support` plugin declares `dependsOn: ["host-call-action"]` and topo-sort guarantees host-call-action's `worker()` runs first.

#### Scenario: Plugin loads before sdk-support

- **GIVEN** a composition containing both the `host-call-action` and `sdk-support` plugins
- **WHEN** the sandbox is constructed
- **THEN** host-call-action's `worker()` SHALL run before sdk-support's
- **AND** sdk-support SHALL receive `validateAction` + `validateActionOutput` via `deps["host-call-action"]`

### Requirement: Per-sandbox manifest binding

The plugin's `config` (produced by `compileActionValidators(manifest)`) SHALL be computed once per cached `(tenant, sha)` sandbox at sandbox construction time, not per run. The `new Function(...)`-instantiated validators SHALL persist for the sandbox's lifetime; validators are not rehydrated between runs.

#### Scenario: Validators persist across runs

- **GIVEN** a sandbox cached for `(tenantA, sha123)` serving multiple runs
- **WHEN** consecutive runs each call `validateAction` / `validateActionOutput`
- **THEN** the same pre-compiled validator instances SHALL be used
- **AND** no recompilation SHALL occur between runs

