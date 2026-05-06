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

The `host-call-action` plugin module SHALL declare `dependsOn: []` (or omit it). It provides validation capability to downstream plugins via `exports`; the `action-dispatch` plugin declares `dependsOn: ["host-call-action"]` and topo-sort guarantees host-call-action's `worker()` runs first.

#### Scenario: Plugin loads before action-dispatch

- **GIVEN** a composition containing both the `host-call-action` and `action-dispatch` plugins
- **WHEN** the sandbox is constructed
- **THEN** host-call-action's `worker()` SHALL run before action-dispatch's
- **AND** action-dispatch SHALL receive `validateAction` + `validateActionOutput` via `deps["host-call-action"]`

### Requirement: Runtime hosts the action-dispatch plugin module

The runtime package SHALL host the action-dispatch plugin module at `packages/runtime/src/plugins/action-dispatch.ts`. The module SHALL export the plugin's `name`, `dependsOn`, `worker`, and `guest` symbols (consumed by the `?sandbox-plugin` vite query when composing the production plugin catalog). The plugin encapsulates all action-dispatch lifecycle logic. Runtime compositions SHALL include this plugin. (Detailed plugin behavior: see the "action-dispatch plugin shape" requirement below.)

The plugin module SHALL NOT live in the SDK package. The `@workflow-engine/sdk` package SHALL NOT declare `@workflow-engine/sandbox` as a dependency or as a TypeScript project reference.

#### Scenario: Plugin lives in the runtime package

- **GIVEN** the workspace
- **WHEN** the runtime imports `./plugins/action-dispatch.ts?sandbox-plugin` from `packages/runtime/src/sandbox-store.ts`
- **THEN** the resulting plugin descriptor's `name` SHALL be `"action-dispatch"`
- **AND** its `dependsOn` SHALL include `"host-call-action"`
- **AND** `packages/sdk/package.json` `dependencies` SHALL NOT contain `@workflow-engine/sandbox`
- **AND** `packages/sdk/package.json` `exports` SHALL NOT contain a `"./sdk-support"` (or `"./action-dispatch"`) entry
- **AND** `packages/sdk/tsconfig.json` `references` SHALL NOT contain `{ "path": "../sandbox" }`

### Requirement: action-dispatch plugin shape

The action-dispatch plugin module SHALL declare `dependsOn: ["host-call-action"]`, consuming both `validateAction` and `validateActionOutput` from the host-call-action plugin's exports.

The plugin SHALL register a private guest function descriptor `__sdkDispatchAction` with signature `(name: string, input: unknown, handler: Callable) => unknown`. The descriptor's `log` SHALL be `{ request: "action" }`, so the sandbox auto-wraps each call in an `action.request` / `action.response` / `action.error` frame. Within that wrap the handler SHALL:

1. Invoke `validateAction(name, input)` (via `deps["host-call-action"].validateAction`); on throw, the rejection propagates out of the auto-wrap and `action.error` fires.
2. Invoke the captured guest `handler(input)` callable; inspect the returned `CallableResult` envelope (per `sandbox/spec.md` "Guest→host boundary opacity (Callable envelope contract)"). When `result.ok === false`, the handler SHALL `throw result.error;` so that the underlying `GuestThrownError` flows back through the surrounding `buildHandler` closure rule's pass-through branch (per `sandbox/spec.md` "Host/sandbox boundary opacity for thrown errors") and reaches the calling guest VM as the action's throw with `.name`, `.message`, and structured own-properties intact. When `result.ok === true`, the handler SHALL bind `raw = result.value` and continue.
3. Invoke `validateActionOutput(name, raw)` on the host (via `deps["host-call-action"].validateActionOutput`) and return its validated result.
4. Dispose the captured `handler` in a `finally` block.

The handler SHALL NOT use a `try/catch` around `await handler(input)` to recover from guest throws; rejection-as-control-flow is no longer the surfacing mechanism for guest throws under the envelope contract. The `try/catch` previously needed for output validation translation (`translateValidatorThrow`) remains, applied only to the `validateActionOutput` call.

The dispatcher signature SHALL NOT accept a `completer` callable. Any extra positional argument passed by a stale guest SHALL be ignored; validation SHALL run host-side regardless. This keeps the security property intact even if a tenant bundle lags behind the new SDK shape (per `sandbox-output-validation`).

The plugin's `guest()` export (bundled as `descriptor.guestSource` by the vite plugin) SHALL install a locked `__sdk` object via `Object.defineProperty(globalThis, "__sdk", { value: Object.freeze({ dispatchAction: (name, input, handler) => raw(name, input, handler) }), writable: false, configurable: false, enumerable: false })` where `raw` is the captured `__sdkDispatchAction` private global. This is the canonical example of SECURITY.md §2 R-2 (locked host-callable global).

The guest-facing surface (`__sdk.dispatchAction`, the private `__sdkDispatchAction` descriptor name) is the SDK↔runtime ABI baked into emitted tenant bundles and SHALL remain stable across plugin renames or relocations.

#### Scenario: __sdk.dispatchAction is the guest surface

- **GIVEN** a sandbox with the `action-dispatch` plugin composed
- **WHEN** user source evaluates `typeof globalThis.__sdk.dispatchAction`
- **THEN** the result SHALL be `"function"`
- **AND** `typeof globalThis.__sdkDispatchAction` SHALL be `"undefined"`

#### Scenario: __sdk binding is locked

- **WHEN** user source evaluates `globalThis.__sdk = { dispatchAction: () => {} }`
- **THEN** the assignment SHALL throw in strict mode or silently no-op in sloppy mode
- **AND** `delete globalThis.__sdk` SHALL return false (non-configurable)

#### Scenario: __sdk object is frozen

- **GIVEN** the `__sdk` global as installed by action-dispatch
- **WHEN** user source evaluates `globalThis.__sdk.dispatchAction = () => {}`
- **THEN** the assignment SHALL fail (frozen object)
- **AND** the original `dispatchAction` reference SHALL remain callable

#### Scenario: Action handler throw surfaces via envelope and rethrow

- **GIVEN** an `action` whose handler does `throw new Error("auth-fail")`
- **WHEN** the action is invoked from within another action via `__sdk.dispatchAction`
- **THEN** the `await handler(input)` call inside the dispatcher SHALL resolve with `{ ok: false, error: { name: "Error", message: "auth-fail", stack: <guest-stack> } }`
- **AND** the dispatcher SHALL throw `result.error` after envelope inspection
- **AND** the surrounding `buildHandler` closure SHALL pass the `GuestThrownError` through unchanged onto the calling guest VM
- **AND** the calling guest's `try { await action() } catch (err) { ... }` SHALL receive an error whose `.name === "Error"` and `.message === "auth-fail"`
- **AND** the outer wrap's `action.error` close event SHALL be emitted with the same error shape

#### Scenario: Successful action emits request/response with host-validated output

- **GIVEN** an action with input schema `{foo: string}` and input `{foo: "bar"}` whose handler returns `{result: 42}`
- **WHEN** `__sdk.dispatchAction("processOrder", {foo: "bar"}, handler)` is called
- **THEN** `action.request` SHALL be emitted with `createsFrame: true` and `input: {foo: "bar"}`
- **AND** `validateAction("processOrder", {foo: "bar"})` SHALL be invoked (no throw)
- **AND** the captured `handler` SHALL be invoked with `{foo: "bar"}`
- **AND** `validateActionOutput("processOrder", {result: 42})` SHALL be invoked host-side (no throw)
- **AND** `action.response` SHALL be emitted with `closesFrame: true` and `output: {result: 42}`
- **AND** `action.response.ref` SHALL equal `action.request.seq`

#### Scenario: Handler throws — action.error emitted

- **GIVEN** an action whose handler throws
- **WHEN** `__sdk.dispatchAction(...)` is called
- **THEN** `action.request` (createsFrame) SHALL fire first
- **AND** `action.error` SHALL be emitted with `closesFrame: true` and the serialized error
- **AND** the original error SHALL propagate back through `__sdk.dispatchAction`

#### Scenario: Input validation failure emits action.error

- **GIVEN** an action whose input fails schema validation
- **WHEN** `__sdk.dispatchAction(...)` is called
- **THEN** `action.request` SHALL fire with `createsFrame: true`
- **AND** `validateAction` SHALL throw
- **AND** `action.error` SHALL fire with `closesFrame: true` and the validation payload
- **AND** the guest `handler` SHALL NOT be invoked

#### Scenario: Output validation failure emits action.error

- **GIVEN** an action with output schema `z.string()` whose handler returns `42`
- **WHEN** `__sdk.dispatchAction(...)` is called
- **THEN** `action.request` SHALL fire with `createsFrame: true`
- **AND** the handler SHALL execute returning `42`
- **AND** `validateActionOutput` SHALL throw a ValidationError with `issues` on the host
- **AND** `action.error` SHALL fire with `closesFrame: true` and the validation payload
- **AND** the rejection SHALL propagate back before any value is returned

#### Scenario: Callable handler auto-disposed

- **GIVEN** an action dispatch where `handler` is captured as `Callable` via `Guest.callable()`
- **WHEN** the dispatch completes (success or failure)
- **THEN** `handler.dispose()` SHALL have been called exactly once

#### Scenario: Extra positional argument from a stale guest is ignored

- **GIVEN** a stale tenant bundle whose `action()` wrapper passes a fourth completer argument
- **WHEN** the dispatch fires
- **THEN** the plugin handler SHALL ignore the extra argument
- **AND** host-side `validateActionOutput(name, raw)` SHALL still run
- **AND** the dispatch outcome SHALL reflect only the host-side validator result

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
