## ADDED Requirements

### Requirement: SecretEnvRef build-time resolution emits sentinel strings

The SDK's build-time env resolver (`resolveEnvRecord` in `packages/sdk/src/index.ts`, invoked from `defineWorkflow`'s build-time branch when `globalThis.workflow` is absent) SHALL emit a sentinel string for every `SecretEnvRef` entry in `config.env` instead of skipping the entry.

The sentinel value SHALL be `encodeSentinel(ref.name ?? key)`, where `ref` is the `SecretEnvRef` object and `key` is its property key in `config.env`. The sentinel SHALL be imported from `@workflow-engine/core`'s `secret-sentinel` module; the SDK SHALL NOT inline the `\x00secret:NAME\x00` byte sequence.

After this change, at build time:

- Author code `wf.env.MY_SECRET` where `MY_SECRET: env({secret: true})` SHALL yield the string `encodeSentinel("MY_SECRET")`.
- Author code `` `Bearer ${wf.env.TOKEN}` `` SHALL yield a string whose value is `"Bearer "` concatenated with `encodeSentinel("TOKEN")`.
- Any such sentinel-bearing string passed as a trigger descriptor field SHALL be serialized into the manifest verbatim, with the sentinel bytes preserved.

The runtime behavior of `defineWorkflow` (reading `globalThis.workflow.env` installed by the secrets plugin, which contains plaintext for secret entries) SHALL be unchanged.

The effective binding name emitted into `manifest.secretBindings` (already `ref.name ?? key` today) SHALL be unchanged.

#### Scenario: Build-time access to a secret yields the sentinel string

- **GIVEN** a workflow `const wf = defineWorkflow({ env: { TOKEN: env({ secret: true }) } })` evaluated in the Vite plugin's Node VM with `process.env.TOKEN` unset
- **WHEN** the build code reads `wf.env.TOKEN`
- **THEN** the returned value SHALL equal `encodeSentinel("TOKEN")`
- **AND** the returned value SHALL be a `string`

#### Scenario: Build-time access to a secret with a name override

- **GIVEN** `defineWorkflow({ env: { LOCAL_KEY: env({ secret: true, name: "PROD_NAME" }) } })` evaluated at build time
- **WHEN** the build code reads `wf.env.LOCAL_KEY`
- **THEN** the returned value SHALL equal `encodeSentinel("PROD_NAME")`

#### Scenario: Runtime access to a secret yields plaintext (unchanged)

- **GIVEN** a workflow with `env: { TOKEN: env({ secret: true }) }` executing inside the sandbox after the secrets plugin has installed `globalThis.workflow = { name, env: { TOKEN: "real_value" } }`
- **WHEN** handler code reads `wf.env.TOKEN`
- **THEN** the returned value SHALL equal `"real_value"`

#### Scenario: Template-literal composition with a secret produces an embedded sentinel at build time

- **GIVEN** `const wf = defineWorkflow({ env: { SCHEDULE: env({ secret: true }) } })` at build time
- **WHEN** the build evaluates `` `every ${wf.env.SCHEDULE}` ``
- **THEN** the resulting string SHALL equal `"every " + encodeSentinel("SCHEDULE")`

#### Scenario: Trigger descriptor serialized with sentinel

- **GIVEN** a workflow at build time using `cronTrigger({ name: "tick", schedule: wf.env.SCHEDULE, tz: "UTC", handler: async () => {} })` where `SCHEDULE` is a `SecretEnvRef`
- **WHEN** the Vite plugin builds the manifest
- **THEN** `manifest.triggers[0].schedule` SHALL equal `encodeSentinel("SCHEDULE")`
- **AND** `manifest.secretBindings` SHALL contain `"SCHEDULE"`
