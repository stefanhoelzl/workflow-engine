## ADDED Requirements

### Requirement: Build-time globalThis.workflow.env carries sentinel strings for secret entries

In the Vite plugin's Node VM discovery context (where the workflow IIFE is evaluated to extract the manifest), the SDK's `defineWorkflow` build-time branch SHALL populate each secret entry of the returned `wf.env` record with a sentinel string produced by `encodeSentinel(ref.name ?? key)`, where `ref` is the `SecretEnvRef` from `config.env` and `key` is its property-key.

This replaces the current build-time behavior of skipping secret entries (which left `wf.env.SECRET_X === undefined`). The change is localized to the SDK's build-time env resolver; no new runtime global is introduced and the sandbox-side `globalThis.workflow` installation (performed by the `secrets` plugin with decrypted plaintext values for secret entries) is unchanged.

The `RuntimeWorkflow<Env>` interface in `@workflow-engine/core` is unchanged: `env` is still typed `Readonly<Record<string, string>>`. Sentinel values are valid `string` instances; no type-system changes are required.

#### Scenario: Build-time access returns a sentinel string

- **GIVEN** a workflow `defineWorkflow({ env: { TOKEN: env({ secret: true }) } })` evaluated in the Vite plugin's Node VM
- **WHEN** the build-time code reads `wf.env.TOKEN`
- **THEN** the returned value SHALL be a `string`
- **AND** the returned value SHALL equal `encodeSentinel("TOKEN")` (byte-for-byte `"\x00secret:TOKEN\x00"`)

#### Scenario: Sandbox runtime access is unchanged

- **GIVEN** the `secrets` plugin has installed `globalThis.workflow = { name, env: { TOKEN: "plaintext_value" } }` (frozen, non-configurable) in the sandbox
- **WHEN** guest code reads `workflow.env.TOKEN` or `wf.env.TOKEN` (the latter via `defineWorkflow`'s runtime branch)
- **THEN** the returned value SHALL equal `"plaintext_value"`
- **AND** the value SHALL NOT contain the byte sequence `\x00secret:`
