## MODIFIED Requirements

### Requirement: createHostCallActionPlugin factory

The runtime package SHALL export a `createHostCallActionPlugin(config: { manifest: Manifest; logger?: Logger }): Plugin` factory. The plugin's `worker()` SHALL construct an Ajv instance and compile input-validation and output-validation schemas for each action in `config.manifest.actions`. The plugin SHALL return `exports: { validateAction, validateActionOutput }` where:

- `validateAction(name: string, input: unknown): void` runs the compiled input validator for the given action name and throws a ValidationError carrying Ajv's `errors` array when validation fails.
- `validateActionOutput(name: string, output: unknown): unknown` runs the compiled output validator for the given action name and returns the validated value on success. On failure, it SHALL throw a ValidationError carrying Ajv's `errors` array transformed into `ValidationIssue[]` (each entry with `path` and `message`). Both validators SHALL share the same Ajv-compile WeakMap cache (keyed on the JSON Schema object), so schema objects referenced by both the manifest and tenant-declared `responseBody` reuse their compiled validator.

The plugin SHALL register no guest functions (actions reach it via the sdk-support plugin's `deps["host-call-action"].validateAction` and `deps["host-call-action"].validateActionOutput`, not directly via guest globals).

#### Scenario: Validators compiled per action for both input and output

- **GIVEN** a manifest with actions `[{ name: "a", inputSchema, outputSchema }, { name: "b", inputSchema, outputSchema }]`
- **WHEN** the plugin's `worker()` runs
- **THEN** four Ajv validators SHALL be compiled at init time (one per action per direction)
- **AND** they SHALL be keyed by `(action name, direction)`

#### Scenario: Valid input passes

- **GIVEN** an action `a` with input schema `{ type: "object", required: ["foo"], properties: { foo: { type: "string" } } }`
- **WHEN** `validateAction("a", { foo: "bar" })` is called
- **THEN** it SHALL return without throwing

#### Scenario: Invalid input throws ValidationError with Ajv errors

- **GIVEN** the same input schema
- **WHEN** `validateAction("a", { foo: 42 })` is called
- **THEN** it SHALL throw a ValidationError
- **AND** the error SHALL carry `errors` — an array of Ajv error objects describing the validation failure
- **AND** the error message SHALL be human-readable

#### Scenario: Valid output returns the validated value

- **GIVEN** an action `a` with output schema `{ type: "string" }`
- **WHEN** `validateActionOutput("a", "ok")` is called
- **THEN** it SHALL return `"ok"` without throwing

#### Scenario: Invalid output throws ValidationError with issues

- **GIVEN** the same output schema
- **WHEN** `validateActionOutput("a", 42)` is called
- **THEN** it SHALL throw a ValidationError
- **AND** the error SHALL carry an `issues` array with at least one entry describing the type mismatch
- **AND** each entry SHALL have `path: (string | number)[]` and `message: string`

#### Scenario: Unknown action name throws for both directions

- **GIVEN** a manifest without action `z`
- **WHEN** `validateAction("z", anyInput)` or `validateActionOutput("z", anyOutput)` is called
- **THEN** it SHALL throw with an error naming the unknown action
