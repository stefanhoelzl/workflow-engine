### Requirement: Workflow source files in workflows directory
Each workflow SHALL be a single TypeScript file in the `workflows/` directory that exports branded SDK products (`defineWorkflow`, `action`, `httpTrigger`). Action and trigger identity SHALL be determined by export names.

#### Scenario: Workflow file structure
- **WHEN** a developer creates `workflows/cronitor.ts`
- **THEN** it SHALL export branded SDK products as named constants
- **AND** it SHALL import `defineWorkflow`, `action`, `httpTrigger`, and `z` from `@workflow-engine/sdk`

### Requirement: Vite plugin builds workflows into manifest and bundle
A `workflows/vite.config.ts` SHALL use the `@workflow-engine/vite-plugin` with an explicit list of workflow source files. The plugin SHALL produce a subdirectory per workflow in `workflows/dist/` containing `manifest.json` and the per-workflow bundle.

#### Scenario: Build produces directory per workflow
- **WHEN** `pnpm --filter workflows build` is run
- **AND** `workflows/vite.config.ts` lists `"./cronitor.ts"` in the workflow configuration
- **THEN** `workflows/dist/cronitor/manifest.json` and `workflows/dist/cronitor/cronitor.js` SHALL be produced

#### Scenario: Bundle has no SDK dependency
- **WHEN** a workflow is built
- **THEN** the output bundle SHALL NOT contain import statements referencing `@workflow-engine/sdk` or `zod`

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
- **AND** `workflows/dist/*/manifest.json` and `workflows/dist/*/*.js` (workflow artifacts) SHALL be produced

### Requirement: Vite plugin package
A new `packages/vite-plugin` package SHALL exist as a pnpm workspace member, exporting the workflow compilation Vite plugin.

#### Scenario: Plugin package structure
- **WHEN** a consumer imports from `@workflow-engine/vite-plugin`
- **THEN** it SHALL receive the `workflowPlugin` function for use in Vite config

### Requirement: Per-workflow bundle output

The build SHALL produce one bundled JS module per workflow file. The bundle SHALL contain all action handlers, the trigger handler(s), and module-scoped imports/constants as named exports under their original names.

#### Scenario: Single bundle per workflow

- **GIVEN** a workflow file `cronitor.ts` with two actions and one trigger
- **WHEN** the build runs
- **THEN** the build SHALL produce exactly one JS bundle `dist/cronitor/cronitor.js`
- **AND** the bundle SHALL export each action and the trigger by their original export names

#### Scenario: Bundle includes module-scoped npm imports

- **GIVEN** a handler importing `format` from `date-fns`
- **WHEN** the build runs
- **THEN** the bundle SHALL inline the `format` function

### Requirement: Build emits manifest alongside bundle

For each workflow, the build SHALL emit `dist/<name>/manifest.json` and `dist/<name>/<name>.js`. The manifest format follows the `workflow-manifest` capability spec.

#### Scenario: Manifest and bundle in same directory

- **GIVEN** a workflow named `cronitor`
- **WHEN** the build runs
- **THEN** `dist/cronitor/manifest.json` and `dist/cronitor/cronitor.js` SHALL both exist
