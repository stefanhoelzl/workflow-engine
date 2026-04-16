## MODIFIED Requirements

### Requirement: Plugin accepts explicit workflow list
The vite plugin SHALL be importable from `@workflow-engine/sdk/plugin` (previously `@workflow-engine/vite-plugin`). Configuration accepts a `workflows` field listing workflow source file paths. Does not scan directories. Each path corresponds to exactly one workflow.

#### Scenario: Importing plugin from new path
- **WHEN** a vite config imports `{ workflowPlugin } from "@workflow-engine/sdk/plugin"`
- **THEN** it receives the same plugin factory as the previous `@workflow-engine/vite-plugin` package

### Requirement: Vite plugin package
The vite plugin code SHALL live inside the `@workflow-engine/sdk` package at `src/plugin/`. It is no longer a standalone package. The standalone `@workflow-engine/vite-plugin` package SHALL be deleted.

#### Scenario: Standalone package removed
- **WHEN** inspecting the packages directory
- **THEN** `packages/vite-plugin/` does not exist

#### Scenario: Plugin source lives in SDK
- **WHEN** inspecting the SDK package
- **THEN** `packages/sdk/src/plugin/index.ts` exports the `workflowPlugin` function
