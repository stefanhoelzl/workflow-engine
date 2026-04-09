## ADDED Requirements

### Requirement: env helper function

The SDK SHALL export an `env()` function that returns a Symbol-branded `EnvRef` marker object. The marker SHALL carry an optional `name` (string) and optional `default` (string). The Symbol used for branding SHALL be exported as `ENV_REF` for marker detection.

`env()` SHALL support the following call signatures:
- `env()` — name is `undefined`, no default
- `env(name: string)` — explicit name, no default
- `env(opts: { default: string })` — name is `undefined`, with default
- `env(name: string, opts: { default: string })` — explicit name and default

#### Scenario: env() with no arguments
- **WHEN** `env()` is called
- **THEN** it returns `{ [ENV_REF]: true, name: undefined, default: undefined }`

#### Scenario: env() with explicit name
- **WHEN** `env("MY_VAR")` is called
- **THEN** it returns `{ [ENV_REF]: true, name: "MY_VAR", default: undefined }`

#### Scenario: env() with default only
- **WHEN** `env({ default: "fallback" })` is called
- **THEN** it returns `{ [ENV_REF]: true, name: undefined, default: "fallback" }`

#### Scenario: env() with name and default
- **WHEN** `env("MY_VAR", { default: "fallback" })` is called
- **THEN** it returns `{ [ENV_REF]: true, name: "MY_VAR", default: "fallback" }`

### Requirement: EnvRef resolution

EnvRef markers SHALL be resolved by the workflow builder when processing env objects (in `.env()` and `.action()` env fields). Resolution SHALL use `process.env` to look up the value.

When resolving an `EnvRef`:
- If `name` is `undefined`, the object key SHALL be used as the env var name
- If `process.env[resolvedName]` exists, its value SHALL be used
- If `process.env[resolvedName]` is `undefined` and `default` is defined, the default SHALL be used
- If `process.env[resolvedName]` is `undefined` and no default is defined, resolution SHALL throw an `Error`

Plain string values in env objects SHALL be kept as-is without resolution.

#### Scenario: Resolve env() with no name uses object key
- **GIVEN** `.env({ API_URL: env() })` and `process.env.API_URL` is `"https://api.example.com"`
- **WHEN** the builder processes the env object
- **THEN** `API_URL` resolves to `"https://api.example.com"`

#### Scenario: Resolve env() with explicit name
- **GIVEN** `.env({ API_URL: env("MY_API_URL") })` and `process.env.MY_API_URL` is `"https://api.example.com"`
- **WHEN** the builder processes the env object
- **THEN** `API_URL` resolves to `"https://api.example.com"`

#### Scenario: Resolve env() with default when var is missing
- **GIVEN** `.env({ API_URL: env({ default: "http://localhost" }) })` and `process.env.API_URL` is `undefined`
- **WHEN** the builder processes the env object
- **THEN** `API_URL` resolves to `"http://localhost"`

#### Scenario: Resolve env() without default when var is missing
- **GIVEN** `.env({ API_URL: env() })` and `process.env.API_URL` is `undefined`
- **WHEN** the builder processes the env object
- **THEN** resolution SHALL throw an Error with a message containing `"API_URL"`

#### Scenario: Plain string value kept as-is
- **GIVEN** `.env({ API_URL: "https://hardcoded.example.com" })`
- **WHEN** the builder processes the env object
- **THEN** `API_URL` resolves to `"https://hardcoded.example.com"`

#### Scenario: EnvRef detection uses Symbol
- **GIVEN** a plain object `{ name: "FOO" }` (without the `ENV_REF` Symbol)
- **WHEN** the builder checks if it is an `EnvRef`
- **THEN** it SHALL NOT be treated as an `EnvRef` marker

### Requirement: Workflow-level env declaration

The builder SHALL expose an `.env(config)` method that accepts `Record<string, string | EnvRef>`. The method SHALL resolve all `EnvRef` markers eagerly from `process.env` and store the resolved `Record<string, string>` as the workflow's env. The method SHALL return `this` for chaining. The workflow env SHALL be available to all actions defined on the builder.

#### Scenario: Define workflow-level env with literals and env refs
- **GIVEN** `createWorkflow().env({ BASE_URL: "https://example.com", API_KEY: env() })`
- **AND** `process.env.API_KEY` is `"secret123"`
- **WHEN** `.compile()` is called
- **THEN** all actions SHALL have `BASE_URL: "https://example.com"` and `API_KEY: "secret123"` in their env

#### Scenario: Workflow env chaining
- **GIVEN** `createWorkflow().env({ A: "1" }).event("e", schema)`
- **WHEN** the builder chain continues
- **THEN** `.env()` returns the builder for further chaining

## MODIFIED Requirements

### Requirement: Action env declaration

Actions MAY declare an `env` field as `Record<string, string | EnvRef>` providing key-value pairs. The builder SHALL resolve `EnvRef` markers eagerly and merge the action env with the workflow env (action wins on key conflict). Within the handler, `ctx.env` SHALL be typed as `Readonly<Record<AllKeys, string>>` where `AllKeys` are the union of workflow env keys and action env keys. When neither workflow nor action declares env, `ctx.env` SHALL be typed as `Readonly<{}>`.

#### Scenario: Action env with resolved values
- **GIVEN** a workflow with `.env({ BASE_URL: "https://example.com" })`
- **AND** an action with `env: { API_KEY: env() }` and `process.env.API_KEY` is `"secret"`
- **WHEN** the handler accesses `ctx.env`
- **THEN** `ctx.env.BASE_URL` is `"https://example.com"` and `ctx.env.API_KEY` is `"secret"`

#### Scenario: Action env overrides workflow env on conflict
- **GIVEN** a workflow with `.env({ URL: "https://default.com" })`
- **AND** an action with `env: { URL: "https://override.com" }`
- **WHEN** the handler accesses `ctx.env.URL`
- **THEN** the value is `"https://override.com"`

#### Scenario: Action with no env inherits workflow env
- **GIVEN** a workflow with `.env({ BASE_URL: "https://example.com" })`
- **AND** an action with no `env` field
- **WHEN** the handler accesses `ctx.env.BASE_URL`
- **THEN** TypeScript accepts the access with type `string`
- **AND** the value is `"https://example.com"`

#### Scenario: Access undeclared env key is a compile-time error
- **GIVEN** a workflow with `.env({ A: "1" })` and an action with `env: { B: "2" }`
- **WHEN** the handler accesses `ctx.env.C`
- **THEN** TypeScript raises a compile-time error because `"C"` is not in the declared env keys

#### Scenario: No env at any level
- **GIVEN** a workflow with no `.env()` call and an action with no `env` field
- **WHEN** the handler accesses `ctx.env.ANYTHING`
- **THEN** TypeScript raises a compile-time error because `ctx.env` is `Readonly<{}>`

### Requirement: Compile method replaces build

The builder SHALL expose a `.compile()` method that returns an object containing serializable event metadata (with JSON Schema via `z.toJSONSchema()`), trigger definitions, and action entries with handler function references. Each action entry SHALL include an `env` field of type `Record<string, string>` containing the merged workflow + action env with all values resolved. There SHALL be no `.build()` method and no `WorkflowConfig` type.

#### Scenario: Compile returns metadata and handlers
- **GIVEN** a builder with one event, one trigger, and one action
- **WHEN** `.compile()` is called
- **THEN** the result contains `events` (array of `{ name, schema }` where schema is JSON Schema), `triggers` (array of trigger definitions), and `actions` (array with `name`, `on`, `emits`, `env`, and `handler` reference)
- **AND** `env` is a `Record<string, string>` with resolved values

#### Scenario: Compile merges workflow and action env
- **GIVEN** a builder with `.env({ A: "1" })` and an action with `env: { B: "2", A: "override" }`
- **WHEN** `.compile()` is called
- **THEN** the action entry's `env` is `{ A: "override", B: "2" }`

#### Scenario: Compile validates consistency
- **WHEN** `.compile()` is called on a builder where an action references an undefined event
- **THEN** `.compile()` SHALL throw an error
