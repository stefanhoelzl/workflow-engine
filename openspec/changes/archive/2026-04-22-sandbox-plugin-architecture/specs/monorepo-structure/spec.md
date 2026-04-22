## ADDED Requirements

### Requirement: sandbox-stdlib package in workspace

The monorepo SHALL include `packages/sandbox-stdlib` as a workspace member. The package SHALL:

- Declare `"name": "@workflow-engine/sandbox-stdlib"` in its `package.json`
- Declare a workspace dependency `"@workflow-engine/sandbox": "workspace:*"` (for plugin types)
- Declare standard dev dependencies matching other TypeScript packages (vitest, tsconfig references)
- Be included in `pnpm-workspace.yaml` via the existing `packages/*` glob
- Ship TypeScript source directly (no build step), matching conventions of `@workflow-engine/sandbox`

#### Scenario: Package discoverable

- **GIVEN** the monorepo at HEAD of the change branch
- **WHEN** `pnpm install` runs
- **THEN** `@workflow-engine/sandbox-stdlib` SHALL be discovered as a workspace package
- **AND** other packages MAY declare `"@workflow-engine/sandbox-stdlib": "workspace:*"` as a dependency

#### Scenario: Runtime declares dependency

- **GIVEN** `packages/runtime/package.json`
- **WHEN** inspecting after this change
- **THEN** `"@workflow-engine/sandbox-stdlib": "workspace:*"` SHALL be a dependency

#### Scenario: SDK declares dependency

- **GIVEN** `packages/sdk/package.json`
- **WHEN** inspecting after this change
- **THEN** `"@workflow-engine/sandbox": "workspace:*"` SHALL be a dependency (for the Plugin type used by `createSdkSupportPlugin`)
