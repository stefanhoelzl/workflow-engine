## MODIFIED Requirements

### Requirement: Build emits manifest alongside bundle

The vite plugin SHALL compute `SHA-256(bundleSource)` during `generateBundle` and include the hex digest as the `sha` field in the emitted manifest JSON.

#### Scenario: Manifest includes bundle SHA
- **WHEN** the vite plugin builds a workflow
- **THEN** the emitted `manifest.json` SHALL contain a `sha` field whose value is the SHA-256 hex digest of the bundle source code

#### Scenario: SHA is deterministic
- **WHEN** the same workflow source is built twice
- **THEN** the `sha` field SHALL be identical in both manifests
