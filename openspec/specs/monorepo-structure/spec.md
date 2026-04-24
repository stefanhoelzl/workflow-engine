# Monorepo Structure Specification

## Purpose

Establish the pnpm workspace layout and per-package conventions for the workflow-engine monorepo.
## Requirements
### Requirement: pnpm workspace configuration
The project SHALL use a `pnpm-workspace.yaml` at the repository root that declares `packages/*` as the workspace glob.

#### Scenario: Workspace discovery
- **WHEN** a developer runs `pnpm install` at the repository root
- **THEN** pnpm SHALL discover and link all packages under `packages/`

#### Scenario: Cross-package dependency resolution
- **WHEN** a package declares a workspace dependency (e.g., `"@workflow-engine/sdk": "workspace:*"`)
- **THEN** pnpm SHALL resolve it to the local workspace package

### Requirement: Runtime package layout

The monorepo SHALL contain the following packages under `packages/`:
- `packages/core` — `@workflow-engine/core` (internal, private)
- `packages/runtime` — `@workflow-engine/runtime`
- `packages/sdk` — `@workflow-engine/sdk`
- `packages/sandbox` — `@workflow-engine/sandbox`

Each package SHALL have a valid `package.json` and follow the conventions established by this capability (ESM, scoped npm name under `@workflow-engine/`, TypeScript source as entry point where applicable).

#### Scenario: Package directory listing

- **WHEN** listing directories under `packages/`
- **THEN** exactly `core`, `runtime`, `sdk`, and `sandbox` exist
- **THEN** `vite-plugin` and `cli` directories do not exist

#### Scenario: Runtime package directory exists

- **WHEN** the repository is cloned and `pnpm install` is run
- **THEN** the directory `packages/runtime` SHALL exist with a valid `package.json`

#### Scenario: Runtime package has a source entry point

- **WHEN** a developer opens the runtime package
- **THEN** it SHALL contain a `src/index.ts` file as the entry point

#### Scenario: Sandbox package exists

- **WHEN** the repository is cloned and `pnpm install` is run
- **THEN** the directory `packages/sandbox` SHALL exist with a valid `package.json`
- **AND** its `name` field SHALL be `@workflow-engine/sandbox`
- **AND** it SHALL ship TypeScript source directly (no build step)

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
The root `package.json` SHALL declare a `devEngines` field requiring Node.js `^25.9.0` with `onFail: "download"`, so pnpm automatically downloads the correct version if the system Node doesn't match.

#### Scenario: System Node matches
- **WHEN** a developer with Node.js `^25.9.0` runs `pnpm install`
- **THEN** installation SHALL succeed using the system Node

#### Scenario: System Node too old
- **WHEN** a developer with a Node.js version outside `^25.9.0` runs `pnpm install`
- **THEN** pnpm SHALL automatically download a matching Node.js version and use it

#### Scenario: devEngines configuration
- **WHEN** inspecting the root `package.json`
- **THEN** it SHALL contain `devEngines.runtime` with `name: "node"`, `version: "^25.9.0"`, and `onFail: "download"`

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

