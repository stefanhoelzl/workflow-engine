### Requirement: Workflow source files in workflows directory
Each workflow SHALL be a single TypeScript file in the `workflows/` directory that exports branded SDK products (`defineWorkflow`, `action`, `httpTrigger`). Action and trigger identity SHALL be determined by export names.

#### Scenario: Workflow file structure
- **WHEN** a developer creates `workflows/cronitor.ts`
- **THEN** it SHALL export branded SDK products as named constants
- **AND** it SHALL import `defineWorkflow`, `action`, `httpTrigger`, and `z` from `@workflow-engine/sdk`

### Requirement: Vite plugin builds workflows into manifest and bundle
`workflows/vite.config.ts` (if used) SHALL import the plugin from `@workflow-engine/sdk/plugin` instead of `@workflow-engine/vite-plugin`. Plugin produces subdirectory per workflow in `workflows/dist/` containing `manifest.json` and per-workflow bundle. Bundle does NOT contain SDK or Zod imports. Node built-ins remain as external imports.

#### Scenario: Plugin import path in vite config
- **WHEN** a vite config imports the workflow plugin
- **THEN** it uses `import { workflowPlugin } from "@workflow-engine/sdk/plugin"`

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
The `workflows/` directory SHALL have a `package.json` declaring only `@workflow-engine/sdk` as a workspace dependency and SHALL be listed in `pnpm-workspace.yaml`. The separate `@workflow-engine/cli` dependency is no longer needed.

#### Scenario: workflows/package.json dependencies
- **WHEN** inspecting `workflows/package.json`
- **THEN** it lists `@workflow-engine/sdk` as a dependency
- **THEN** it does NOT list `@workflow-engine/cli` or `@workflow-engine/vite-plugin`

#### Scenario: Plugin dependency resolution
- **WHEN** `pnpm install` is run at the repository root
- **THEN** `@workflow-engine/sdk` SHALL be resolved as a workspace link for the workflows directory

### Requirement: Root build includes workflows
The root `pnpm build` script SHALL build both the runtime and the workflows.

#### Scenario: Full build
- **WHEN** `pnpm build` is run from the repository root
- **THEN** `dist/main.js` (runtime) SHALL be produced
- **AND** `workflows/dist/*/manifest.json` and `workflows/dist/*/*.js` (workflow artifacts) SHALL be produced

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
