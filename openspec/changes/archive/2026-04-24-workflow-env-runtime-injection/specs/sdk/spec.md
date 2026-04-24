## MODIFIED Requirements

### Requirement: defineWorkflow factory

The SDK SHALL export `defineWorkflow(config)` returning a `Workflow` object branded with `WORKFLOW_BRAND`. The config SHALL accept optional `name?: string` and optional `env?: Record<string, string | EnvRef>`. When `name` is omitted, the build system SHALL derive the workflow name from the file's filestem.

The returned `Workflow<Env>` SHALL extend `RuntimeWorkflow<Env>` from `@workflow-engine/core`, so `Workflow.env` is a `Readonly<Record<string, string>>` typed to the author's declared env shape. The `Workflow` type SHALL add the brand symbol but otherwise inherit `name` and `env` from `RuntimeWorkflow`.

```ts
interface Workflow<
  Env extends Readonly<Record<string, string>> = Readonly<Record<string, string>>,
> extends RuntimeWorkflow<Env> {
  readonly [WORKFLOW_BRAND]: true;
}
```

At runtime inside the guest VM, `defineWorkflow` SHALL read `globalThis.workflow` (typed via the ambient augmentation in core). It SHALL narrow the retrieved value's env shape to match the author's declared env via a cast, and MUST NOT call `resolveEnvRecord` at runtime. The `name` field SHALL be taken from `globalThis.workflow.name` if present, falling back to `config.name` if the global is absent (defensive for build-time Node-VM discovery before the plugin installs the global).

At build time inside the Vite plugin's Node-VM discovery context, the plugin SHALL pre-populate `globalThis.workflow = { name, env }` where `env` comes from `resolveEnvRecord(config.env, process.env)` before running the IIFE. `defineWorkflow` reads the same global consistently in both runtime and build-time contexts.

#### Scenario: Workflow defined with explicit name and env

- **WHEN** `defineWorkflow({ name: "cronitor", env: { URL: env({ default: "https://x" }) } })` is called inside the guest VM at invocation
- **THEN** the returned object SHALL have `name: "cronitor"` (from `globalThis.workflow.name`)
- **AND** SHALL have `env.URL: "<runtime-supplied value>"`
- **AND** SHALL be branded with `WORKFLOW_BRAND`

#### Scenario: Workflow defined with no config

- **WHEN** `defineWorkflow()` is called at invocation
- **THEN** the returned object SHALL be branded with `WORKFLOW_BRAND`
- **AND** SHALL have `name` equal to `globalThis.workflow.name` or `""` if absent
- **AND** SHALL have `env` equal to `globalThis.workflow.env` or `{}` if absent

#### Scenario: Multiple defineWorkflow calls in one file

- **GIVEN** a workflow file with two `defineWorkflow(...)` exports
- **WHEN** the build system processes the file
- **THEN** the build system SHALL fail with an error indicating "at most one defineWorkflow per file"

#### Scenario: Runtime env reflects build-time resolution

- **GIVEN** a workflow declaring `env: { TOKEN: env({ name: "TOKEN" }) }` and a build run with `process.env.TOKEN = "real_value"`
- **WHEN** the manifest is later loaded and the handler runs in the sandbox
- **THEN** `workflow.env.TOKEN` inside the handler SHALL equal `"real_value"`
- **AND** SHALL NOT equal any `default:` fallback

#### Scenario: defineWorkflow does not call resolveEnvRecord at runtime

- **GIVEN** the SDK's guest-side implementation of `defineWorkflow`
- **WHEN** the code path executed inside the QuickJS VM is inspected
- **THEN** there SHALL be no call to `resolveEnvRecord` or `getDefaultEnvSource` in the runtime path
- **AND** `resolveEnvRecord` SHALL remain used only from the Vite plugin's Node-VM discovery context

### Requirement: env() helper for environment references

The SDK SHALL export `env(opts?)` returning an `EnvRef` placeholder used in `defineWorkflow({ env })`. The opts SHALL accept optional `name?: string` (the env var name; defaults to the key it's assigned to) and optional `default?: string` (used when the env var is not set).

`EnvRef`s SHALL be resolved at build time by the Vite plugin. The plugin SHALL run `resolveEnvRecord(config.env, process.env)` during its Node-VM discovery pass to produce plaintext `manifest.env: Record<string, string>`. At invocation time, the runtime's env-installer plugin (from the `workflow-env-runtime` capability) SHALL populate `globalThis.workflow.env` from `manifest.env`, making the build-time-resolved values visible to guest code.

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
- **AND** `workflow.env.URL` at invocation SHALL be `"https://x"`

#### Scenario: Missing env without default fails build

- **GIVEN** `defineWorkflow({ env: { API_KEY: env() } })`
- **WHEN** `process.env.API_KEY` is unset and no default is provided
- **THEN** the build SHALL fail with `"Missing environment variable: API_KEY"`

#### Scenario: Build-time override reaches runtime

- **GIVEN** `defineWorkflow({ env: { TOKEN: env({ default: "fallback" }) } })` and a build run with `process.env.TOKEN = "ci_value"`
- **WHEN** the handler runs in the sandbox
- **THEN** `workflow.env.TOKEN` SHALL equal `"ci_value"`
