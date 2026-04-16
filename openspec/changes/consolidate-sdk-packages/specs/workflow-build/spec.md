## MODIFIED Requirements

### Requirement: Workflows directory is a pnpm workspace member
`workflows/` has `package.json` declaring only `@workflow-engine/sdk` as a workspace dependency. Listed in `pnpm-workspace.yaml`. The separate `@workflow-engine/cli` dependency is no longer needed.

#### Scenario: workflows/package.json dependencies
- **WHEN** inspecting `workflows/package.json`
- **THEN** it lists `@workflow-engine/sdk` as a dependency
- **THEN** it does NOT list `@workflow-engine/cli` or `@workflow-engine/vite-plugin`

### Requirement: Vite plugin builds workflows into manifest and bundle
`workflows/vite.config.ts` (if used) SHALL import the plugin from `@workflow-engine/sdk/plugin` instead of `@workflow-engine/vite-plugin`. Plugin produces subdirectory per workflow in `workflows/dist/` containing `manifest.json` and per-workflow bundle. Bundle does NOT contain SDK or Zod imports. Node built-ins remain as external imports.

#### Scenario: Plugin import path in vite config
- **WHEN** a vite config imports the workflow plugin
- **THEN** it uses `import { workflowPlugin } from "@workflow-engine/sdk/plugin"`

## REMOVED Requirements

### Requirement: Vite plugin package
**Reason**: The vite plugin is now part of the SDK package, not a standalone package.
**Migration**: Import from `@workflow-engine/sdk/plugin` instead of `@workflow-engine/vite-plugin`.
