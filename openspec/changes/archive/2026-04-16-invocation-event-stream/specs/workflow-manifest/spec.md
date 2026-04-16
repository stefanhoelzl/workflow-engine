## MODIFIED Requirements

### Requirement: Manifest JSON format (v1)

The manifest SHALL include a `sha` field containing the SHA-256 hex digest of the workflow bundle source. This field SHALL be computed at build time by the vite plugin.

#### Scenario: Manifest contains sha field
- **WHEN** a workflow is built
- **THEN** the manifest JSON SHALL include a `sha` field with a 64-character hex string (SHA-256 of the bundle source)

### Requirement: ManifestSchema validation (v1)

The `ManifestSchema` Zod schema SHALL include `sha: z.string()` as a required field.

#### Scenario: Manifest missing sha field fails validation
- **WHEN** a manifest JSON lacks the `sha` field
- **THEN** `ManifestSchema.parse()` SHALL throw a validation error
