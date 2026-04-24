## ADDED Requirements

### Requirement: Vite plugin routes secret env bindings to secretBindings

During build-time workflow discovery, the Vite plugin SHALL walk each workflow's declared `env` entries and split them by type:

- `EnvRef` (non-secret) entries SHALL be resolved via `process.env` and written to `manifest.env[key]` as plaintext strings (existing behavior).
- `SecretEnvRef` (`env({...secret: true})`) entries SHALL NOT be resolved. The envName (either `opts.name` or the key when unset) SHALL be added to a new `manifest.secretBindings: string[]` field.

`manifest.secretBindings` SHALL be present (possibly empty) only when at least one secret binding is declared; it SHALL be absent otherwise.

`manifest.secrets` and `manifest.secretsKeyId` SHALL NOT be written by the Vite plugin; those fields are populated by the CLI at upload time.

No plaintext value from a secret binding SHALL be written into the bundle tarball. Specifically, `manifest.secretBindings` SHALL contain names only, never values, and no on-disk artifact SHALL reference the secret's plaintext.

#### Scenario: Workflow with a secret binding produces secretBindings

- **GIVEN** `defineWorkflow({ env: { TOKEN: env({ secret: true }), REGION: env({ default: "us-east-1" }) } })`
- **WHEN** the Vite plugin builds the workflow
- **THEN** `manifest.secretBindings` SHALL equal `["TOKEN"]`
- **AND** `manifest.env` SHALL equal `{ REGION: "us-east-1" }`
- **AND** `manifest.secrets` SHALL NOT be present
- **AND** `manifest.secretsKeyId` SHALL NOT be present

#### Scenario: Workflow with no secret bindings omits secretBindings

- **GIVEN** `defineWorkflow({ env: { REGION: env({ default: "us-east-1" }) } })`
- **WHEN** the Vite plugin builds
- **THEN** `manifest.secretBindings` SHALL NOT be present in the manifest

#### Scenario: Secret envName from explicit name opts

- **GIVEN** `defineWorkflow({ env: { tok: env({ name: "GITHUB_TOKEN", secret: true }) } })`
- **WHEN** the Vite plugin builds
- **THEN** `manifest.secretBindings` SHALL include `"GITHUB_TOKEN"` (the env var name, not the key)
- **AND** `manifest.env` SHALL NOT include `"tok"` or `"GITHUB_TOKEN"`

#### Scenario: No plaintext reaches disk

- **GIVEN** the build output `dist/bundle.tar.gz`
- **WHEN** the archive is unpacked and inspected
- **THEN** the manifest SHALL contain only the secretBindings list
- **AND** no file in the archive SHALL contain the secret's plaintext value
