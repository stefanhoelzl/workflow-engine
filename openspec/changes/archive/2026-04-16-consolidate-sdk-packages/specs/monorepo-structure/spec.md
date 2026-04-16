## MODIFIED Requirements

### Requirement: Runtime package layout
Contains these packages under `packages/`:
- `packages/core` — `@workflow-engine/core` (internal, private)
- `packages/runtime` — `@workflow-engine/runtime`
- `packages/sdk` — `@workflow-engine/sdk`
- `packages/sandbox` — `@workflow-engine/sandbox`

Each has valid `package.json`, ESM, and TypeScript source as entry point where applicable.

#### Scenario: Package directory listing
- **WHEN** listing directories under `packages/`
- **THEN** exactly `core`, `runtime`, `sdk`, and `sandbox` exist
- **THEN** `vite-plugin` and `cli` directories do not exist

## REMOVED Requirements

### Requirement: vite-plugin and cli as separate packages
**Reason**: The vite-plugin and cli code have been absorbed into the SDK package. They are no longer standalone packages.
**Migration**: Import the plugin from `@workflow-engine/sdk/plugin` and the CLI API from `@workflow-engine/sdk/cli`.
