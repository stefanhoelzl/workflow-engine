## ADDED Requirements

### Requirement: Workflows directory in workspace
The `pnpm-workspace.yaml` SHALL include `workflows` as a workspace entry so that its dependencies are resolved during `pnpm install`.

#### Scenario: Workspace discovery includes workflows
- **WHEN** a developer runs `pnpm install` at the repository root
- **THEN** pnpm SHALL resolve `@workflow-engine/sdk` as a workspace link for the workflows directory

### Requirement: Workflows directory is not a scoped package
The `workflows/package.json` SHALL use an unscoped package name (e.g., `workflows`), not the `@workflow-engine/` scope. It is a build target for dependency resolution, not a publishable package.

#### Scenario: Workflows package name
- **WHEN** inspecting `workflows/package.json`
- **THEN** the `name` field SHALL NOT start with `@workflow-engine/`
