## ADDED Requirements

### Requirement: createHostCallActionPlugin factory

The runtime package SHALL export a `createHostCallActionPlugin(config: { manifest: Manifest; logger?: Logger }): Plugin` factory. The plugin's `worker()` SHALL construct an Ajv instance and compile input-validation schemas for each action in `config.manifest.actions`. The plugin SHALL return `exports: { validateAction }` where `validateAction(name: string, input: unknown): void` runs the compiled validator for the given action name and throws a ValidationError carrying Ajv's `errors` array when validation fails.

The plugin SHALL register no guest functions (actions reach it via the sdk-support plugin's `deps["host-call-action"].validateAction`, not directly via guest globals).

#### Scenario: Validator compiled per action

- **GIVEN** a manifest with actions `[{ name: "a", inputSchema: ... }, { name: "b", inputSchema: ... }]`
- **WHEN** the plugin's `worker()` runs
- **THEN** two Ajv validators SHALL be compiled at init time (one per action)
- **AND** they SHALL be keyed by action name

#### Scenario: Valid input passes

- **GIVEN** an action `a` with schema `{ type: "object", required: ["foo"], properties: { foo: { type: "string" } } }`
- **WHEN** `validateAction("a", { foo: "bar" })` is called
- **THEN** it SHALL return without throwing

#### Scenario: Invalid input throws ValidationError with Ajv errors

- **GIVEN** the same schema
- **WHEN** `validateAction("a", { foo: 42 })` is called
- **THEN** it SHALL throw a ValidationError
- **AND** the error SHALL carry `errors` — an array of Ajv error objects describing the validation failure
- **AND** the error message SHALL be human-readable

#### Scenario: Unknown action name throws

- **GIVEN** a manifest without action `z`
- **WHEN** `validateAction("z", anyInput)` is called
- **THEN** it SHALL throw with an error naming the unknown action

### Requirement: Plugin depends on none

`createHostCallActionPlugin` SHALL declare `dependsOn: []` (or omit it). It provides validation capability to downstream plugins via exports but depends on nothing.

#### Scenario: Plugin loads before sdk-support

- **GIVEN** a composition with `createHostCallActionPlugin` and `createSdkSupportPlugin` (whose `dependsOn: ["host-call-action"]`)
- **WHEN** the sandbox is constructed
- **THEN** host-call-action's `worker()` SHALL be invoked before sdk-support's
- **AND** sdk-support SHALL receive the validateAction function via its `deps["host-call-action"].validateAction`

### Requirement: Per-sandbox manifest binding

The plugin SHALL be constructed with its `{manifest}` config at sandbox construction time (once per cached `(tenant, sha)` sandbox, not per run). The compiled validators SHALL persist for the sandbox's lifetime.

#### Scenario: Validators persist across runs

- **GIVEN** a sandbox cached for `(tenantA, sha123)` serving multiple runs
- **WHEN** consecutive runs each call `validateAction`
- **THEN** the same pre-compiled validator instances SHALL be used
- **AND** no recompilation SHALL occur between runs
