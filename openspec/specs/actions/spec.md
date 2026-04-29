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

The runtime package SHALL provide a `host-call-action` plugin module at `packages/runtime/src/plugins/host-call-action.ts`. The plugin file SHALL be imported via the `?sandbox-plugin` vite query (which returns a `{ name, dependsOn?, workerSource, guestSource? }` record). The plugin's `worker()` SHALL accept a `Config` of shape `{ inputSchemas: Record<string, JSONSchema>; outputSchemas: Record<string, JSONSchema> }` and SHALL rehydrate each per-action JSON Schema into a schema validator at `worker()` boot. The validators SHALL be constructed once per sandbox and reused for every invocation; per-call validator construction is forbidden. Schema rehydration runs in the Node `worker_thread`; the plugin's `worker()` MAY import any npm package available to the worker, including the schema-validation engine. The `Config` payload SHALL be JSON-serialisable to survive the main-thread → worker-thread `postMessage` boundary.

The main-thread builder lives at `packages/runtime/src/host-call-action-config.ts` and exports `compileActionValidators(manifest)`. Under this contract the builder SHALL be a pass-through: it SHALL extract each action's `input` and `output` JSON Schema from the manifest into the `inputSchemas` and `outputSchemas` records, and SHALL NOT compile, generate source code for, or otherwise pre-process the schemas on the main thread.

The plugin SHALL return `exports: { validateAction, validateActionOutput }` where:

- `validateAction(name: string, input: unknown): void` — runs the rehydrated input validator for the given action name and throws a `ValidationError` carrying the underlying validator's raw issues array (as the `errors` field) plus a normalised `issues` field of `{path: (string|number)[], message: string}` entries on validation failure.
- `validateActionOutput(name: string, output: unknown): unknown` — runs the rehydrated output validator and returns the validated value on success. On failure it SHALL throw a `ValidationError` carrying the underlying validator's raw issues array (`errors`) plus a normalised `issues` array (`{path, message}[]`).

The plugin SHALL register no guest functions; actions reach it via `deps["host-call-action"].validateAction` and `deps["host-call-action"].validateActionOutput`, not directly via guest globals.

#### Scenario: Validators rehydrated per action for both directions

- **GIVEN** a manifest with `actions: [{ name: "a", input, output }, { name: "b", input, output }]`
- **WHEN** the plugin's `worker()` runs
- **THEN** four schema validators SHALL be rehydrated at sandbox boot (one per action per direction)
- **AND** they SHALL be keyed by `(action name, direction)`
- **AND** the same validator instances SHALL serve every subsequent invocation of the sandbox

#### Scenario: Valid input passes

- **GIVEN** action `a` with input schema `{type:"object", required:["foo"], properties:{foo:{type:"string"}}}`
- **WHEN** `validateAction("a", {foo: "bar"})` is called
- **THEN** it SHALL return without throwing

#### Scenario: Invalid input throws ValidationError with raw issues

- **WHEN** `validateAction("a", {foo: 42})` is called against the schema above
- **THEN** it SHALL throw a `ValidationError`
- **AND** the error SHALL carry an `errors` field with the underlying validator's raw issues array
- **AND** the error SHALL carry an `issues` field of `{path, message}` entries derived from the raw issues
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

The plugin's `config` (produced by `compileActionValidators(manifest)`) SHALL be computed once per cached `(tenant, sha)` sandbox at sandbox construction time, not per run. The rehydrated validators SHALL persist for the sandbox's lifetime; validators are not rehydrated between runs.

#### Scenario: Validators persist across runs

- **GIVEN** a sandbox cached for `(tenantA, sha123)` serving multiple runs
- **WHEN** consecutive runs each call `validateAction` / `validateActionOutput`
- **THEN** the same rehydrated validator instances SHALL be used
- **AND** no rehydration SHALL occur between runs


### Requirement: dispatchAction surfaces failures via GuestSafeError hierarchy

The `__sdk.dispatchAction` host-callback descriptor SHALL convert every failure path into an instance of the `GuestSafeError` hierarchy before letting it propagate toward the guest VM trampoline:

1. **Unknown action name.** The host-side handler in `host-call-action.ts` SHALL throw `new GuestSafeError("action \"X\" is not declared")`.
2. **Input/output validation failure.** The dispatcher SHALL catch the host-side `ValidationError` and rethrow as `new GuestSafeError(<formatted issue summary>)`. The original `ValidationError` shape (`.errors`, `.issues`) SHALL NOT be exposed across the bridge.
3. **Action handler throws.** When the action's own guest VM throws, the host's `callGuestFn` / `awaitGuestResult` paths surface the throw as a `GuestThrownError`. The dispatcher SHALL allow that `GuestThrownError` to propagate unchanged; the closure rule's pass-through branch handles the cross-bridge stamping.

#### Scenario: Unknown action name reaches guest as GuestSafeError

- **GIVEN** a manifest containing actions `["a", "b"]` and a guest call to `__sdk.dispatchAction("nope", {}, () => {})`
- **WHEN** the host-side handler detects the unknown name
- **THEN** the guest-observed `e.name === "GuestSafeError"`, `e.message === "__sdk.dispatchAction failed: action \"nope\" is not declared"`
- **AND** `e.stack` SHALL contain `"<bridge:__sdk.dispatchAction>"` and SHALL NOT contain any of `"/var/"`, `"node_modules"`, `"data:text/javascript"`

#### Scenario: Action handler TypeError reaches calling guest with original name and message

- **GIVEN** an action `a` whose handler does `throw new TypeError("oops")`
- **WHEN** guest calls `__sdk.dispatchAction("a", {}, ...)` and the action handler throws
- **THEN** `e.name === "TypeError"`, `e.message === "oops"` (no `"__sdk.dispatchAction failed:"` prefix)
- **AND** `e.stack` SHALL contain frames originating from the action's own guest source
- **AND** `e.stack` SHALL contain a single appended frame `at <bridge:__sdk.dispatchAction>`
