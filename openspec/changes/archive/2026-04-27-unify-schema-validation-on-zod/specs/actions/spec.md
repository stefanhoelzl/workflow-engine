## MODIFIED Requirements

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

### Requirement: Per-sandbox manifest binding

The plugin's `config` (produced by `compileActionValidators(manifest)`) SHALL be computed once per cached `(tenant, sha)` sandbox at sandbox construction time, not per run. The rehydrated validators SHALL persist for the sandbox's lifetime; validators are not rehydrated between runs.

#### Scenario: Validators persist across runs

- **GIVEN** a sandbox cached for `(tenantA, sha123)` serving multiple runs
- **WHEN** consecutive runs each call `validateAction` / `validateActionOutput`
- **THEN** the same rehydrated validator instances SHALL be used
- **AND** no rehydration SHALL occur between runs
