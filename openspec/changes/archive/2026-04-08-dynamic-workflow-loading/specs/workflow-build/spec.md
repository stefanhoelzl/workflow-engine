## ADDED Requirements

### Requirement: Workflow source files in workflows directory
Each workflow SHALL be a single TypeScript file in the `workflows/` directory that default-exports a `WorkflowConfig` created via `defineWorkflow()`.

#### Scenario: Workflow file structure
- **WHEN** a developer creates `workflows/cronitor.ts`
- **THEN** it SHALL contain `export default defineWorkflow({...})` as its default export
- **AND** it SHALL import `defineWorkflow` and `z` from `@workflow-engine/sdk`

### Requirement: Vite builds workflows into self-contained ESM bundles
A `workflows/vite.config.ts` SHALL build each `.ts` file in the `workflows/` directory into a corresponding `.js` file in `workflows/dist/`, producing self-contained ESM bundles.

#### Scenario: Build produces one JS file per workflow
- **WHEN** `pnpm --filter workflows build` is run
- **AND** `workflows/` contains `cronitor.ts`
- **THEN** `workflows/dist/cronitor.js` SHALL be produced

#### Scenario: SDK is bundled into the output
- **WHEN** a workflow is built
- **THEN** the output `.js` file SHALL NOT contain import statements referencing `@workflow-engine/sdk`
- **AND** the file SHALL be loadable without `node_modules` present

#### Scenario: Node built-ins are externalized
- **WHEN** a workflow is built
- **THEN** Node.js built-in modules SHALL remain as external imports

### Requirement: Workflows directory is a pnpm workspace member
The `workflows/` directory SHALL have a `package.json` declaring `@workflow-engine/sdk` as a workspace dependency and SHALL be listed in `pnpm-workspace.yaml`.

#### Scenario: SDK dependency resolution
- **WHEN** `pnpm install` is run at the repository root
- **THEN** `@workflow-engine/sdk` SHALL be resolved as a workspace link for the workflows directory

### Requirement: Root build includes workflows
The root `pnpm build` script SHALL build both the runtime and the workflows.

#### Scenario: Full build
- **WHEN** `pnpm build` is run from the repository root
- **THEN** `dist/main.js` (runtime) SHALL be produced
- **AND** `workflows/dist/*.js` (workflow bundles) SHALL be produced
