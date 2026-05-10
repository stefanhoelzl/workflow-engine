## MODIFIED Requirements

### Requirement: host-call-action plugin module

The runtime package SHALL provide a `host-call-action` plugin module at `packages/runtime/src/plugins/host-call-action.ts`. The plugin file SHALL be imported via the `?sandbox-plugin` vite query (which returns a `{ name, dependsOn?, workerSource, guestSource? }` record). The plugin's `worker()` SHALL accept a `Config` of shape `{ inputSchemas: Record<string, JSONSchema>; outputSchemas: Record<string, JSONSchema> }` and SHALL rehydrate each per-action JSON Schema into a schema validator at `worker()` boot. The validators SHALL be constructed once per sandbox and reused for every invocation; per-call validator construction is forbidden. Schema rehydration runs in the Node `worker_thread`; the plugin's `worker()` MAY import any npm package available to the worker, including the schema-validation engine. The `Config` payload SHALL be JSON-serialisable to survive the main-thread → worker-thread `postMessage` boundary.

The main-thread builder lives at `packages/runtime/src/host-call-action-config.ts` and exports `compileActionValidators(manifest)`. Under this contract the builder SHALL be a pass-through: it SHALL extract each action's `input` and `output` JSON Schema from the manifest into the `inputSchemas` and `outputSchemas` records, and SHALL NOT compile, generate source code for, or otherwise pre-process the schemas on the main thread.

The plugin SHALL return `exports: { validateAction, validateActionOutput }` where:

- `validateAction(name: string, input: unknown): void` — runs the rehydrated input validator for the given action name and throws a `ValidationError` carrying the underlying validator's raw issues array (as the `errors` field) plus a normalised `issues` field of `ValidationIssue[]` entries on validation failure. Each `ValidationIssue` SHALL carry `path: (string|number)[]` and `message: string`; on validation failure where the underlying validator supplies them, each issue SHALL also carry `received: unknown` (the value lifted from the input at the issue's path), `expected: string`, and `code: string`.
- `validateActionOutput(name: string, output: unknown): unknown` — runs the rehydrated output validator and returns the validated value on success. On failure it SHALL throw a `ValidationError` carrying the underlying validator's raw issues array (`errors`) plus a normalised `issues` array of `ValidationIssue[]` entries with the same shape described above (including the optional enriched fields when supplied by the underlying validator).

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

#### Scenario: Invalid input throws ValidationError with enriched issues

- **WHEN** `validateAction("a", {foo: 42})` is called against the schema above
- **THEN** it SHALL throw a `ValidationError`
- **AND** the error SHALL carry an `errors` field with the underlying validator's raw issues array
- **AND** the error SHALL carry an `issues` field of `ValidationIssue` entries derived from the raw issues
- **AND** each issue's `path` SHALL be `["foo"]`, `message` SHALL be human-readable, `received` SHALL be `42`, `expected` SHALL describe the string-type constraint, and `code` SHALL identify the type-mismatch case

#### Scenario: Valid output returns the validated value

- **GIVEN** action `a` with output schema `{type: "string"}`
- **WHEN** `validateActionOutput("a", "ok")` is called
- **THEN** it SHALL return `"ok"` without throwing

#### Scenario: Invalid output throws ValidationError with enriched issues

- **WHEN** `validateActionOutput("a", 42)` is called against a `{type: "string"}` schema
- **THEN** it SHALL throw a `ValidationError`
- **AND** the error SHALL carry an `issues` array with `path` + `message` entries
- **AND** each issue SHALL also carry `received: 42`, an `expected` string, and a `code` string when supplied by the underlying validator

#### Scenario: Unknown action name throws for both directions

- **GIVEN** a manifest without action `z`
- **WHEN** `validateAction("z", x)` or `validateActionOutput("z", y)` is called
- **THEN** the call SHALL throw with an error naming the unknown action

### Requirement: dispatchAction surfaces failures via GuestSafeError hierarchy

The `__sdk.dispatchAction` host-callback descriptor SHALL convert every failure path into an instance of the `GuestSafeError` hierarchy before letting it propagate toward the guest VM trampoline:

1. **Unknown action name.** The host-side handler in `host-call-action.ts` SHALL throw `new GuestSafeError("action \"X\" is not declared")`.
2. **Input/output validation failure.** The dispatcher SHALL catch the host-side `ValidationError` and rethrow as a `GuestSafeError` carrying both a formatted issue summary as its `message` AND a `.issues` own-property of normalised `ValidationIssue[]` entries (`{path, message, received?, expected?, code?}`). The `ValidationError`'s underlying `.errors` field (raw validator issues) SHALL NOT be exposed across the bridge — it is host implementation detail. The normalised `.issues` field MAY cross the bridge because every component of the shape (the schema, the value, the path, and the engine-stable codes) originates from author code or guest input, not from host-internal state.
3. **Action handler throws.** When the action's own guest VM throws, the host's `callGuestFn` / `awaitGuestResult` paths surface the throw as a `GuestThrownError`. The dispatcher SHALL allow that `GuestThrownError` to propagate unchanged; the closure rule's pass-through branch handles the cross-bridge stamping.

#### Scenario: Unknown action name reaches guest as GuestSafeError

- **GIVEN** a manifest containing actions `["a", "b"]` and a guest call to `__sdk.dispatchAction("nope", {}, () => {})`
- **WHEN** the host-side handler detects the unknown name
- **THEN** the guest-observed `e.name === "GuestSafeError"`, `e.message === "__sdk.dispatchAction failed: action \"nope\" is not declared"`
- **AND** `e.stack` SHALL contain `"<bridge:__sdk.dispatchAction>"` and SHALL NOT contain any of `"/var/"`, `"node_modules"`, `"data:text/javascript"`

#### Scenario: Validation failure reaches guest with enriched issues but without raw errors

- **GIVEN** an action `a` with input schema `{type: "object", properties: {foo: {type: "string"}}, required: ["foo"]}` and a guest call `await __sdk.dispatchAction("a", {foo: 42}, ...)`
- **WHEN** the host-side validator rejects the input
- **THEN** the guest-observed error `e.name === "GuestSafeError"` and `e.message` SHALL be a human-readable formatted issue summary
- **AND** `e.issues` SHALL be a defined array with at least one entry carrying `path`, `message`, and (when the underlying validator supplied them) `received`, `expected`, `code`
- **AND** `e.errors` SHALL be `undefined` — the raw validator issues array SHALL NOT cross the bridge

#### Scenario: Action handler TypeError reaches calling guest with original name and message

- **GIVEN** an action `a` whose handler does `throw new TypeError("oops")`
- **WHEN** guest calls `__sdk.dispatchAction("a", {}, ...)` and the action handler throws
- **THEN** `e.name === "TypeError"`, `e.message === "oops"` (no `"__sdk.dispatchAction failed:"` prefix)
- **AND** `e.stack` SHALL contain frames originating from the action's own guest source
- **AND** `e.stack` SHALL contain a single appended frame `at <bridge:__sdk.dispatchAction>`

#### Scenario: Persisted action.error event carries enriched issues

- **GIVEN** the validation-failure scenario above
- **WHEN** the executor records the `action.error` event
- **THEN** the event's serialised error SHALL include the `issues` array with the enriched fields
- **AND** the event SHALL NOT include the underlying validator's raw `errors` array
