## MODIFIED Requirements

### Requirement: env() helper for environment references

The SDK SHALL export `env(opts?)` returning an `EnvRef` or `SecretEnvRef` depending on the `secret` flag. The opts SHALL accept:

- `name?: string` — the env var name; defaults to the key it's assigned to.
- `default?: string` — used when the env var is not set; INCOMPATIBLE with `secret: true`.
- `secret?: true` — marks the binding as a secret; rejected alongside `default` at the type level.

Function overloads SHALL make `env({ secret: true, default: "..." })` a TypeScript compile-time error.

`EnvRef`s SHALL be resolved at build time by the Vite plugin against `process.env` and written to `manifest.env`. `SecretEnvRef`s SHALL NOT be resolved at build time; instead, the plugin records the envName in `manifest.secretBindings: string[]`. The CLI fetches the server public key, seals each secret plaintext from its own `process.env` at upload, and rewrites the manifest to replace `secretBindings` with `secrets: Record<string, base64>` and `secretsKeyId: string`.

At invocation time, the runtime's secrets plugin decrypts `manifest.secrets` and merges the plaintexts into `workflow.env` alongside `manifest.env` values. Both secret and non-secret bindings appear as plain strings in `workflow.env`.

#### Scenario: env() defaults to key as name

- **GIVEN** `defineWorkflow({ env: { API_KEY: env() } })`
- **WHEN** the build resolves env
- **THEN** the plugin SHALL read `process.env.API_KEY` and write the value to `manifest.env.API_KEY`

#### Scenario: env() with explicit name

- **GIVEN** `defineWorkflow({ env: { url: env({ name: "MY_URL" }) } })`
- **WHEN** the build resolves env
- **THEN** the plugin SHALL read `process.env.MY_URL` and write the value to `manifest.env.url`

#### Scenario: env() with default

- **GIVEN** `defineWorkflow({ env: { URL: env({ default: "https://x" }) } })`
- **WHEN** `process.env.URL` is unset at build time
- **THEN** `manifest.env.URL` SHALL be `"https://x"`

#### Scenario: env() with secret true rejects default

- **GIVEN** `env({ name: "TOKEN", secret: true, default: "fallback" })`
- **WHEN** the workflow is type-checked
- **THEN** TypeScript SHALL emit a compile-time error

#### Scenario: env() with secret true routes to secretBindings

- **GIVEN** `defineWorkflow({ env: { TOKEN: env({ name: "TOKEN", secret: true }) } })`
- **WHEN** the build runs
- **THEN** `manifest.secretBindings` SHALL include `"TOKEN"`
- **AND** `manifest.env.TOKEN` SHALL NOT be present

#### Scenario: Secret value reaches runtime

- **GIVEN** `env({ name: "TOKEN", secret: true })` with `process.env.TOKEN = "ghp_xxx"` at CLI upload
- **WHEN** the CLI seals and the runtime decrypts per invocation
- **THEN** `workflow.env.TOKEN` inside the handler SHALL equal `"ghp_xxx"`

#### Scenario: Missing env without default fails build

- **GIVEN** `defineWorkflow({ env: { API_KEY: env() } })`
- **WHEN** `process.env.API_KEY` is unset and no default is provided
- **THEN** the build SHALL fail with `"Missing environment variable: API_KEY"`

#### Scenario: Missing secret env at CLI time fails upload

- **GIVEN** `env({ name: "TOKEN", secret: true })` and `process.env.TOKEN` is unset when `wfe upload` runs
- **WHEN** the CLI attempts to seal
- **THEN** upload SHALL fail with a clear error naming `TOKEN`

## ADDED Requirements

### Requirement: secret() export from SDK

The SDK SHALL export `secret(value: string): string`. The function SHALL invoke `globalThis.$secrets.addSecret(value)` and return `value` unchanged. Semantics:

- Adds `value` to the runtime's plaintext scrubber set.
- Subsequent outbound `WorkerToMain` messages SHALL have any literal occurrence of `value` replaced with `[secret]`.
- The call is a no-op if the runtime's secrets plugin is not active (e.g., in build-time Node-VM discovery where `globalThis.$secrets` may be absent); in that case, the function SHALL return `value` without throwing.

#### Scenario: secret called at runtime adds to scrubber

- **GIVEN** a handler that calls `secret("abc123")`
- **WHEN** the call completes
- **THEN** `globalThis.$secrets.addSecret("abc123")` SHALL have been invoked
- **AND** the return value SHALL equal `"abc123"`

#### Scenario: secret called at build-time Node VM is a no-op

- **GIVEN** the Vite plugin's Node-VM discovery context where `globalThis.$secrets` is undefined
- **WHEN** a workflow module evaluates `secret("x")` at top-level
- **THEN** the function SHALL return `"x"` without throwing
- **AND** no error SHALL be logged
