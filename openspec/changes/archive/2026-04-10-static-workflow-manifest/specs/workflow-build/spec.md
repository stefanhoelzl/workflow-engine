## MODIFIED Requirements

### Requirement: Workflow source files in workflows directory
Each workflow SHALL be a single TypeScript file in the `workflows/` directory that default-exports a `WorkflowBuilder` created via `createWorkflow()`. Action handlers SHALL be exported as named `const`s via calls to `workflow.action()`.

#### Scenario: Workflow file structure
- **WHEN** a developer creates `workflows/cronitor.ts`
- **THEN** it SHALL contain `export default createWorkflow().event(...).trigger(...)` as its default export
- **AND** it SHALL export action handlers as named constants: `export const handleEvent = workflow.action({...})`
- **AND** it SHALL import `createWorkflow` and `z` from `@workflow-engine/sdk`

### Requirement: Vite plugin builds workflows into manifest and actions
A `workflows/vite.config.ts` SHALL use the `@workflow-engine/vite-plugin` with an explicit list of workflow source files. The plugin SHALL produce a subdirectory per workflow in `workflows/dist/` containing `manifest.json` and `actions.js`.

#### Scenario: Build produces directory per workflow
- **WHEN** `pnpm --filter workflows build` is run
- **AND** `workflows/vite.config.ts` lists `"./cronitor.ts"` in the workflow configuration
- **THEN** `workflows/dist/cronitor/manifest.json` and `workflows/dist/cronitor/actions.js` SHALL be produced

#### Scenario: Actions module has no SDK dependency
- **WHEN** a workflow is built
- **THEN** the output `actions.js` SHALL NOT contain import statements referencing `@workflow-engine/sdk` or `zod`

#### Scenario: Node built-ins are externalized
- **WHEN** a workflow is built
- **THEN** Node.js built-in modules SHALL remain as external imports

### Requirement: Workflows directory is a pnpm workspace member
The `workflows/` directory SHALL have a `package.json` declaring `@workflow-engine/sdk` and `@workflow-engine/vite-plugin` as workspace dependencies and SHALL be listed in `pnpm-workspace.yaml`.

#### Scenario: Plugin dependency resolution
- **WHEN** `pnpm install` is run at the repository root
- **THEN** both `@workflow-engine/sdk` and `@workflow-engine/vite-plugin` SHALL be resolved as workspace links for the workflows directory

### Requirement: Root build includes workflows
The root `pnpm build` script SHALL build both the runtime and the workflows.

#### Scenario: Full build
- **WHEN** `pnpm build` is run from the repository root
- **THEN** `dist/main.js` (runtime) SHALL be produced
- **AND** `workflows/dist/*/manifest.json` and `workflows/dist/*/actions.js` (workflow artifacts) SHALL be produced

## MODIFIED Requirements

### Requirement: Vite plugin package
A new `packages/vite-plugin` package SHALL exist as a pnpm workspace member, exporting the workflow compilation Vite plugin.

#### Scenario: Plugin package structure
- **WHEN** a consumer imports from `@workflow-engine/vite-plugin`
- **THEN** it SHALL receive the `workflowPlugin` function for use in Vite config
