## ADDED Requirements

### Requirement: Upload handler rejects manifests containing secretBindings

The upload handler SHALL reject any uploaded bundle whose manifest contains a `secretBindings` field. `secretBindings` is an intermediate build-artifact field consumed and dropped by the CLI during `wfe upload`; the server-side `ManifestSchema` SHALL NOT accept it.

Response on such uploads SHALL be 422 with `{ "error": "invalid manifest: secretBindings must be consumed by wfe upload before POST" }` (or an equivalent descriptive message). The existing `ManifestSchema` validation path handles this by rejecting the out-of-schema field.

#### Scenario: Upload with secretBindings is rejected

- **GIVEN** a raw bundle whose manifest still contains `secretBindings: ["TOKEN"]` (i.e., the CLI sealing step was skipped)
- **WHEN** `POST /api/workflows/:tenant` receives it
- **THEN** the response SHALL be 422
- **AND** the body SHALL name the extraneous `secretBindings` field

#### Scenario: Upload with secrets but no secretBindings is accepted

- **GIVEN** a bundle whose manifest has `secrets` and `secretsKeyId` but NO `secretBindings`
- **WHEN** the upload is submitted
- **THEN** the handler SHALL accept the bundle (per the secrets-crypto-foundation upload decrypt-verify flow)

#### Scenario: Upload with neither field is accepted

- **GIVEN** a bundle whose manifest has neither `secrets`, `secretsKeyId`, nor `secretBindings` (no secrets used)
- **WHEN** the upload is submitted
- **THEN** the handler SHALL accept the bundle per existing behavior
