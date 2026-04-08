## ADDED Requirements

### Requirement: pnpm workspace configuration
The project SHALL use a `pnpm-workspace.yaml` at the repository root that declares `packages/*` as the workspace glob.

#### Scenario: Workspace discovery
- **WHEN** a developer runs `pnpm install` at the repository root
- **THEN** pnpm SHALL discover and link all packages under `packages/`

#### Scenario: Cross-package dependency resolution
- **WHEN** a package declares a workspace dependency (e.g., `"@workflow-engine/sdk": "workspace:*"`)
- **THEN** pnpm SHALL resolve it to the local workspace package

### Requirement: Runtime package layout
The monorepo SHALL contain `packages/runtime` as the initial package. Additional packages (`sdk`, `vite-plugin`) will be added in later changes.

#### Scenario: Runtime package directory exists
- **WHEN** the repository is cloned and `pnpm install` is run
- **THEN** the directory `packages/runtime` SHALL exist with a valid `package.json`

#### Scenario: Runtime package has a source entry point
- **WHEN** a developer opens the runtime package
- **THEN** it SHALL contain a `src/index.ts` file as the entry point

### Requirement: Package naming convention
Each package SHALL use a scoped npm name under `@workflow-engine/`.

#### Scenario: Runtime package name
- **WHEN** inspecting `packages/runtime/package.json`
- **THEN** the `name` field SHALL be `@workflow-engine/runtime`

### Requirement: ESM module system
All packages SHALL use ES modules exclusively.

#### Scenario: Module type declaration
- **WHEN** inspecting any package's `package.json`
- **THEN** the `type` field SHALL be `"module"`

### Requirement: Node.js version management via devEngines
The root `package.json` SHALL declare a `devEngines` field requiring Node.js >=24.0.0 with `onFail: "download"`, so pnpm automatically downloads the correct version if the system Node doesn't match.

#### Scenario: System Node matches
- **WHEN** a developer with Node.js >=24.0.0 runs `pnpm install`
- **THEN** installation SHALL succeed using the system Node

#### Scenario: System Node too old
- **WHEN** a developer with a Node.js version below 24.0.0 runs `pnpm install`
- **THEN** pnpm SHALL automatically download a matching Node.js version and use it

#### Scenario: devEngines configuration
- **WHEN** inspecting the root `package.json`
- **THEN** it SHALL contain `devEngines.runtime` with `name: "node"`, `version: ">=24.0.0"`, and `onFail: "download"`

### Requirement: Root workspace scripts
The root `package.json` SHALL provide scripts that run tooling across all packages.

#### Scenario: Available root scripts
- **WHEN** inspecting the root `package.json` scripts
- **THEN** it SHALL include `check`, `lint`, `format`, and `test` scripts

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
